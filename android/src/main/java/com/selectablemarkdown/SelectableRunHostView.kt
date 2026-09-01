package com.selectablemarkdown

import android.annotation.SuppressLint
import android.os.Build
import android.view.ActionMode
import android.view.GestureDetector
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper

/**
 * Native host for one selectable markdown "run": a FrameLayout DECORATOR
 * around a child TextView, not a TextView subclass — selection behavior is
 * added around the platform widget so OEM TextView quirks stay contained in
 * the child.
 *
 * JS contract (see docs/SELECTION.md):
 *   props:  `text` (projected run text), `attributes` (styled ranges over
 *           that text), `pressables` (tappable ranges over that text),
 *           `selectable`, `selectionActions` (ordered action identifiers:
 *           "copy-text" | "copy-markdown")
 *   events: `onSelectionAction({ start, end, action, selectedText })` —
 *           UTF-16 code-unit offsets into the CURRENT `text`,
 *           end-exclusive, clamped, start <= end; `action` names the menu
 *           item the user tapped.
 *           `onInlinePress({ start, end, pressableId })` — a single tap
 *           landed inside one of `pressables`; same offset guarantees, and
 *           `pressableId` is JS's identifier for the range, echoed verbatim.
 *
 * The system Copy item (android.R.id.copy) is never intercepted, replaced,
 * or reordered: stock plain-text copy keeps working with no JS involvement.
 * The custom items only EMIT the event — JS builds the payload and writes
 * the clipboard.
 *
 * `attributes` is what makes this host render markdown rather than a wall of
 * system text. Each entry is a range of `text` plus the parts of a text style
 * it changes, derived by JS from the same projection that produced `text`.
 * Styling changes how the text LOOKS and never what it IS — no character is
 * added, removed or reordered — so the offsets this view reports back still
 * index the projected text the way JS expects.
 *
 * Android-specific policy this class assumes (enforced JS-side): a run whose
 * text is obviously still changing — the streaming tail — is mounted with
 * `selectable=false`, because TextView#setText drops any active selection and
 * dismisses the action mode.
 *
 * THAT POLICY IS NOT AIRTIGHT, AND THIS CLASS USED TO CLAIM IT WAS. The
 * comment here said "settled runs never change text (identity guarantee), so
 * no selection-preservation logic is needed" — which is true of settled
 * *blocks* and false of settled *runs*. `segmentRuns` merges every adjacent
 * settled flowing block into one run keyed on its start offset, so when the
 * next block settles it lands in the same run: same key, same mounted view,
 * still `selectable=true`, longer text. Measured across the eight shipped
 * fixtures, an Android-selectable run's text changes about four times per
 * streamed message, and each one costs the user their selection and the open
 * action mode.
 *
 * Nothing here can copy the wrong markdown — the offsets are always read from
 * the current text — so this is a UX defect, not a correctness one. It is
 * pre-existing and unfixed; docs/SELECTION.md ("Android — no preservation, and
 * a known gap") carries the measurement and the two candidate fixes, both of
 * which are larger than this file.
 *
 * THE SAME OBJECT BACKS BOTH ARCHITECTURES. Nothing in this class is
 * conditional on paper or Fabric: the view manager creates it either way, the
 * props arrive either way (Fabric hands the Java ViewManager the raw props, so
 * `RunAttributedText.parse` reads them unchanged), and both events go out
 * through a dispatcher that resolves per architecture. What Fabric adds is
 * recycling — see `prepareToRecycle`, which is a correctness requirement here
 * and not hygiene.
 */
class SelectableRunHostView(context: ReactContext) : FrameLayout(context) {

    /**
     * The host's text widget. A subclass for one behaviour the platform only
     * offers to a TextView subclass, mirroring the iOS host:
     * `onSelectionChanged` feeds the one-active-selection coordination (see
     * `liveHosts`), the only selection-change signal a TextView exposes.
     *
     * Everything else stays the stock widget — the decorator design's whole
     * point — and the override degrades to `super` whenever it has nothing
     * to do.
     */
    private inner class RunTextView(context: android.content.Context) : TextView(context) {

        override fun onSelectionChanged(selStart: Int, selEnd: Int) {
            super.onSelectionChanged(selStart, selEnd)
            // The guard is also the constructor guard: TextView's own init
            // reaches this override before the host's fields exist, always
            // with an empty selection.
            if (selEnd > selStart) {
                clearOtherHostSelections()
            }
        }
    }

    private val textView: TextView = RunTextView(context)

    /** The three props the rendered text is built from, plus a dirty flag.
     * React Native delivers a whole prop batch and then calls
     * `onAfterUpdateTransaction`, so applying them there costs one setText
     * per batch instead of one per prop — and never renders new text under
     * the previous batch's styling. `decorations` is among them because its
     * layout-affecting half (leading margins, tab stops) lives in the
     * spannable; its drawn half is painted from the same parsed spec in
     * `onDraw` below. */
    private var pendingText: String = ""
    private var pendingAttributes: RunAttributedText.Spec = RunAttributedText.Spec.EMPTY
    private var pendingDecorations: RunDecorations.Spec = RunDecorations.Spec.EMPTY
    private var pendingEmbeds: RunEmbeds.Spec = RunEmbeds.Spec.EMPTY
    private var textDirty = false

    /** Last rect reported per embedId, in dp — the dedupe that keeps
     * streaming appends past a settled embed from re-announcing it on every
     * snapshot. Values only ever compared against the next report. */
    private val lastEmbedRects = HashMap<Int, android.graphics.RectF>()

    /** Reused per draw pass; a run redraws on every scroll frame under a
     * selection, and allocating in onDraw is the canonical Android jank. */
    private val decorationPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    private val decorationRect = android.graphics.RectF()
    private val decorationPath = android.graphics.Path()
    private val decorationRadii = FloatArray(8)

    /** Configured menu actions, in prop order (identifiers from JS). */
    private var selectionActions: List<String> =
        listOf(ACTION_COPY_TEXT, ACTION_COPY_MARKDOWN)

    /** Tappable ranges over the text, parsed from the `pressables` prop.
     * Empty whenever JS has no listener, which is what keeps every touch
     * below on its stock path in the common no-links case. */
    private var pressables: List<Pressable> = emptyList()

    /**
     * Detects the single taps `pressables` is hit-tested against. It only
     * OBSERVES the stream — `dispatchTouchEvent` feeds it and then lets the
     * platform proceed as if it were not there — so text selection
     * (long-press, handle drags) and the tap-to-dismiss behaviour of a
     * selectable TextView are untouched. That is the deliberate trade against
     * ClickableSpan + LinkMovementMethod, which take over the TextView's
     * movement/touch handling and are a known source of selection breakage on
     * exactly the widget this class exists to keep stock.
     */
    private val inlineTapDetector = GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                pressableAt(e.x, e.y)?.let { emitInlinePress(it) }
                // The detector's verdict is not consumed by anyone — the
                // event stream already went to the platform regardless.
                return false
            }
        },
    )

    /** The live selection action mode, if any — invalidated on prop change
     * so an open menu reflects the current `selectionActions`. */
    private var activeActionMode: ActionMode? = null

    private val selectionCallback = object : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            // Returning true keeps the SYSTEM menu; items must not be added
            // here — several OEM skins rebuild the menu after create, so the
            // reliable insertion point is onPrepareActionMode.
            activeActionMode = mode
            return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
            // Remove-first, then re-add per the current prop: repeated
            // prepare calls (OEM skins invoke it more than once) and prop
            // updates both converge on the same menu with no duplicates.
            // System items (android.R.id.copy and friends) stay exactly
            // where the platform put them.
            menu.removeItem(ITEM_ID_COPY_TEXT)
            menu.removeItem(ITEM_ID_COPY_MARKDOWN)
            var order = Menu.CATEGORY_SECONDARY
            for (action in selectionActions) {
                val itemId = when (action) {
                    ACTION_COPY_TEXT -> ITEM_ID_COPY_TEXT
                    ACTION_COPY_MARKDOWN -> ITEM_ID_COPY_MARKDOWN
                    // Forward-compat: identifiers this binary does not know
                    // are ignored, never rendered as dead items.
                    else -> continue
                }
                menu.add(Menu.NONE, itemId, order, titleFor(action))
                order += 1
            }
            return true
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            val action = when (item.itemId) {
                ITEM_ID_COPY_TEXT -> ACTION_COPY_TEXT
                ITEM_ID_COPY_MARKDOWN -> ACTION_COPY_MARKDOWN
                // Never intercept system items (android.R.id.copy etc.);
                // plain copy must keep its stock behavior.
                else -> return false
            }
            emitSelectionAction(action)
            mode.finish()
            return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {
            if (activeActionMode === mode) {
                activeActionMode = null
            }
        }
    }

    init {
        textView.setTextIsSelectable(true)
        // Every knob that appears on both sides of the measure/draw boundary —
        // text size, font padding, line spacing, line breaking — is set here
        // and only here. RunTextMeasure owns them because the two things that
        // must agree about them are this TextView and the StaticLayout built
        // by the measure path (paper's shadow node, or the C++ shadow node
        // through SelectableRunHostViewManager.measure). Setting any of them
        // directly on this view again would be the drift that file exists to
        // prevent, and the symptom is text clipped at the bottom of a run.
        RunTextMeasure.configureTextView(textView)
        textView.customSelectionActionModeCallback = selectionCallback
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // The default TextClassifier binds an on-device service per
            // selection (latency) and is a known NPE source on some OEM
            // builds; markdown runs need none of its smart-selection output.
            textView.textClassifier = android.view.textclassifier.TextClassifier.NO_OP
        }
        addView(
            textView,
            LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        )
        // One-active-selection coordination — see `liveHosts`. Registered
        // last, so a host in the registry always has fully initialised
        // fields.
        liveHosts.add(this)
        // A ViewGroup skips its own onDraw by default; block chrome (boxes,
        // rules) is painted there, behind the child TextView — which is the
        // stacking the design needs, since the platform draws the selection
        // highlight inside the TextView, above whatever this layer painted.
        setWillNotDraw(false)
    }

    // ---- Props -------------------------------------------------------------

    fun setText(value: String) {
        if (value == pendingText) return
        pendingText = value
        textDirty = true
    }

    /**
     * THE EQUALITY GUARD IS NOT AN OPTIMISATION — IT IS WHAT KEEPS A LIVE
     * SELECTION ALIVE ON FABRIC. Setting `textDirty` makes `commitProps` run
     * `textView.text = …`, and `TextView#setText` drops the selection and
     * dismisses the ActionMode even when the new value is character-identical
     * to the old one.
     *
     * On the old architecture an unguarded setter was harmless: paper sends
     * only the props JS diffed as changed, so this ran when `attributes`
     * actually changed. Fabric does not diff. `FabricMountingManager::getProps`
     * returns `newShadowView.props->rawProps` whole
     * (ReactAndroid/src/main/jni/react/fabric/FabricMountingManager.cpp:222-226),
     * `SurfaceMountingManager` wraps that entire map, and
     * `ViewManager.updateProperties` (ViewManager.java:82-90) pushes every key
     * in it through the delegate on every commit. So without this line a theme
     * switch, a changed `onSelectionCopy` identity, or any other prop that
     * `runPropsEqual` (src/view/SelectableMarkdown.tsx) lets through would kill
     * the user's selection mid-stream while the text never moved.
     *
     * `Spec` is a plain class, so it is compared by its list: `Attribute` is a
     * data class and `List.equals` is element-wise, which makes this a value
     * comparison rather than an identity one. An identity comparison would
     * never be true — `RunAttributedText.parse` builds a fresh `Spec` from the
     * incoming `ReadableArray` on every commit.
     */
    fun setAttributes(spec: RunAttributedText.Spec) {
        if (spec.attributes == pendingAttributes.attributes) return
        pendingAttributes = spec
        textDirty = true
    }

    /**
     * Guarded by value like `setAttributes`, and for the same
     * selection-preserving reason: Fabric re-delivers the whole prop map on
     * every commit, and an unguarded set here would rebuild the text — and
     * drop a live selection — every time anything else changed.
     */
    fun setDecorations(spec: RunDecorations.Spec) {
        if (spec.decorations == pendingDecorations.decorations) return
        pendingDecorations = spec
        textDirty = true
        invalidate()
    }

    /**
     * Guarded by value like `setAttributes` (same Fabric re-delivery
     * reason), and layout-affecting like `setDecorations`: each reservation
     * is a ReplacementSpan in the styled string, so a changed list must
     * rebuild the text. The rect dedupe map is cleared on a real change
     * because embedIds are per-list ordinals — id 0 of the new list is not
     * id 0 of the old one, and a stale "already reported" entry would
     * swallow the first report the new list deserves.
     */
    fun setEmbeds(spec: RunEmbeds.Spec) {
        if (spec.embeds == pendingEmbeds.embeds) return
        pendingEmbeds = spec
        lastEmbedRects.clear()
        textDirty = true
    }

    /** Applied once per prop batch, from the view manager. */
    fun commitProps() {
        if (!textDirty) return
        textDirty = false
        // No selection preservation, and the class comment is honest about
        // what that costs: JS does not in fact guarantee that a selectable
        // run's text never changes, because a settled run grows as adjacent
        // blocks settle into it. Every `textView.text =` here that follows a
        // real change therefore drops whatever the user had selected. The
        // guards on setText, setAttributes and setDecorations are what keep
        // this line from running when nothing actually changed — which under
        // Fabric is most commits, since Fabric re-delivers the whole prop map
        // every time.
        //
        // The styled string comes through RunLayoutCache, so a run the measure
        // path just built on the shadow/layout thread is not built a second
        // time here — same builder, same instance, one construction per
        // distinct run. Handing the CACHED instance to setText is safe because
        // TextView never keeps a Spanned it is given: with the SPANNABLE
        // buffer (selectable, this host's default) it copies through
        // Spannable.Factory.newSpannable, and with the NORMAL buffer (the
        // non-selectable streaming tail) TextUtils.stringOrSpannedString
        // copies into a SpannedString. Selection spans and the ChangeWatcher
        // land on the widget's private copy, never on the shared cached one —
        // RunLayoutCache.styledText documents the boundary of that guarantee.
        // Base size first, text second: the setText below rebuilds the
        // widget's layout from the paint, so a run is never laid out under
        // the previous run's base size. The measure paths derive the same
        // value from the same two props (RunTextMeasure.baseTextSizeSp).
        RunTextMeasure.updateTextViewBaseSize(textView, pendingText, pendingAttributes)
        textView.text = RunLayoutCache.styledText(
            RunLayoutCache.key(pendingText, pendingAttributes, pendingDecorations, pendingEmbeds)
        )
        // The chrome is positioned off the text layout, so this ViewGroup's
        // own display list is stale the moment the text moves — and a child
        // invalidation alone does not rebuild the parent's.
        invalidate()
        // Embed rects are read off the TextView's Layout, which does not
        // exist until the layout pass the setText above requested. onLayout
        // is the primary report point; the post is the belt for commits the
        // framework decides not to relayout (the dedupe map makes a double
        // report free).
        if (pendingEmbeds.embeds.isNotEmpty()) {
            post { reportEmbedRects() }
        }
    }

    fun setSelectable(value: Boolean) {
        textView.setTextIsSelectable(value)
    }

    /**
     * Deliberately independent of `text`/`attributes` and of `textDirty`:
     * what is tappable and what is drawn are separate channels, so a
     * pressables-only update never costs a `setText` — which on this platform
     * would drop a live selection (see setAttributes above for why that guard
     * discipline exists).
     */
    fun setPressables(value: List<Pressable>) {
        pressables = value
    }

    fun setSelectionActions(actions: List<String>) {
        if (actions == selectionActions) {
            return
        }
        selectionActions = actions
        // An open menu rebuilds through onPrepareActionMode.
        activeActionMode?.invalidate()
    }

    // ---- Selection coordination ---------------------------------------------


    /**
     * One active selection across the document: Android never clears one
     * TextView's selection because another began one, so a transcript of
     * per-run hosts could show two highlights at once — only the newest with
     * a live action mode. Called from `RunTextView.onSelectionChanged` the
     * moment a non-empty selection lands here. Recursion-safe: clearing
     * another host fires its `onSelectionChanged` with an empty selection,
     * which returns at the guard.
     */
    private fun clearOtherHostSelections() {
        for (host in liveHosts.toList()) {
            if (host === this) continue
            val other = host.textView.text as? android.text.Spannable ?: continue
            if (host.textView.selectionEnd > host.textView.selectionStart) {
                android.text.Selection.removeSelection(other)
                host.activeActionMode?.finish()
            }
        }
    }

    // ---- Event emission ----------------------------------------------------

    private fun emitSelectionAction(action: String) {
        val length = textView.text?.length ?: 0
        // TextView reports UTF-16 offsets; they may be -1 (no selection) or
        // reversed (RTL / handle-crossing), so clamp and order before JS
        // ever sees them.
        val rawStart = textView.selectionStart
        val rawEnd = textView.selectionEnd
        val start = minOf(rawStart, rawEnd).coerceIn(0, length)
        val end = maxOf(rawStart, rawEnd).coerceIn(0, length)
        if (end <= start) return

        // One dispatch for both architectures.
        // UIManagerHelper.getEventDispatcherForReactTag reads the UIManager
        // type out of the react tag and returns ReactEventEmitter on paper and
        // FabricEventEmitter on Fabric, so there is no branch here to get
        // wrong — and no repeat of the failure this replaced, where the host
        // posted to getJSModule(RCTEventEmitter) and Fabric silently dropped
        // it, leaving both custom copy items dead with nothing in logcat.
        //
        // getSurfaceId returns -1 for a paper view by design, and Event's own
        // dispatchModern falls back to the legacy path on exactly that value,
        // so passing it through is correct rather than merely tolerated.
        val reactContext = context as ReactContext
        val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id) ?: return
        dispatcher.dispatchEvent(
            SelectionActionEvent(
                UIManagerHelper.getSurfaceId(this),
                id,
                start,
                end,
                action,
                textView.text.subSequence(start, end).toString(),
            )
        )
    }

    /**
     * The pressable range under a point in this FrameLayout's coordinates, or
     * null — and null is the load-bearing answer: it is what keeps a tap on
     * plain prose from emitting anything.
     *
     * The offset lookup is the same `getLineForVertical` + `getOffsetForHorizontal`
     * pair LinkMovementMethod uses, with the guard it famously lacks: the
     * point must actually lie within the line's vertical band and horizontal
     * extent, otherwise a tap in the empty space past a short line — or below
     * the last line — "hits" the nearest character and turns the padding
     * around a trailing link into a tap target.
     */
    private fun pressableAt(viewX: Float, viewY: Float): Pressable? {
        if (pressables.isEmpty()) return null
        val layout = textView.layout ?: return null
        val x = viewX - textView.left - textView.totalPaddingLeft + textView.scrollX
        val y = viewY - textView.top - textView.totalPaddingTop + textView.scrollY
        if (y < 0f || y > layout.height.toFloat()) return null
        val line = layout.getLineForVertical(y.toInt())
        if (y < layout.getLineTop(line).toFloat() || y >= layout.getLineBottom(line).toFloat()) {
            return null
        }
        if (x < layout.getLineLeft(line) || x > layout.getLineRight(line)) return null
        val offset = layout.getOffsetForHorizontal(line, x)
        // Half-open containment, matching how LinkMovementMethod queries
        // spans at an insertion offset: ranges never overlap (links cannot
        // nest), so the first hit is the only hit.
        return pressables.firstOrNull { offset >= it.start && offset < it.end }
    }

    private fun emitInlinePress(pressable: Pressable) {
        // Same clamp discipline as emitSelectionAction below: the range was
        // computed against the text JS sent, which under prop skew can differ
        // from the text in hand, and JS must be able to trust the offsets
        // unconditionally.
        val length = textView.text?.length ?: 0
        val start = pressable.start.coerceIn(0, length)
        val end = pressable.end.coerceIn(start, length)
        if (end <= start) return

        val reactContext = context as ReactContext
        val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id) ?: return
        dispatcher.dispatchEvent(
            InlinePressEvent(
                UIManagerHelper.getSurfaceId(this),
                id,
                start,
                end,
                pressable.id,
            )
        )
    }

    // ---- Embed rect reporting ------------------------------------------------

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        // The primary report point: by the time a FrameLayout's own onLayout
        // runs, the child TextView has been measured and laid out, so its
        // internal Layout — the geometry source below — exists and is
        // current. commitProps posts a second call for commits the framework
        // decides need no relayout; the dedupe map makes the overlap free.
        reportEmbedRects()
    }

    /**
     * Reports where each embed's reserved space landed, in this host's
     * coordinate space, dp, through `onEmbedLayout`. Re-fired only when a
     * rect actually moved (> 0.5dp on any edge) — streaming appends past a
     * settled embed recommit the view constantly, and a settled embed's
     * geometry never moves (a settled run only ever grows at its end), so
     * without the dedupe JS would be re-told the same rect every snapshot.
     *
     * GEOMETRY IS ANCHORED ON THE LINE, NOT THE BASELINE. The reservation is
     * ascent-shaped in `RunEmbedSpan`, but the final line extents belong to
     * the embed-height `RunLineHeightSpan` JS sends over the same character,
     * and its surplus branch re-centres the extra room around the baseline —
     * so `getLineBaseline - height` can point above the line's top. The top
     * of the placeholder's line IS the top of the reserved band, whatever
     * the baseline did.
     *
     * The horizontal edge takes the smaller of the two `getPrimaryHorizontal`
     * answers: in an RTL paragraph the placeholder's leading edge is its
     * RIGHT edge, and the overlay is positioned by physical left.
     */
    private fun reportEmbedRects() {
        val embeds = pendingEmbeds.embeds
        if (embeds.isEmpty()) return
        val layout = textView.layout ?: return
        val text = textView.text ?: return
        val length = text.length

        val reactContext = context as ReactContext
        val dispatcher =
            UIManagerHelper.getEventDispatcherForReactTag(reactContext, id) ?: return
        val surfaceId = UIManagerHelper.getSurfaceId(this)

        val textLeft = (textView.left + textView.totalPaddingLeft - textView.scrollX).toFloat()
        val textTop = (textView.top + textView.totalPaddingTop - textView.scrollY).toFloat()

        for (embed in embeds) {
            // The same guards `RunEmbeds.applySpans` applied to the string:
            // an entry that reserved nothing must report nothing.
            if (embed.start >= length || embed.end > length) continue
            if (text[embed.start] != RunEmbeds.PLACEHOLDER) continue

            val line = layout.getLineForOffset(embed.start)
            val xPx = textLeft + minOf(
                layout.getPrimaryHorizontal(embed.start),
                layout.getPrimaryHorizontal(embed.end),
            )
            val yPx = textTop + layout.getLineTop(line)

            val x = PixelUtil.toDIPFromPixel(xPx)
            val y = PixelUtil.toDIPFromPixel(yPx)
            // Size is the declared reservation, echoed back in the unit it
            // arrived in rather than round-tripped through pixels: the span
            // reserved exactly this box, and JS positions an overlay it
            // already knows the size of.
            val rect = android.graphics.RectF(x, y, x + embed.widthDp, y + embed.heightDp)
            val last = lastEmbedRects[embed.embedId]
            if (last != null &&
                kotlin.math.abs(last.left - rect.left) <= 0.5f &&
                kotlin.math.abs(last.top - rect.top) <= 0.5f &&
                kotlin.math.abs(last.right - rect.right) <= 0.5f &&
                kotlin.math.abs(last.bottom - rect.bottom) <= 0.5f
            ) {
                continue
            }
            lastEmbedRects[embed.embedId] = rect

            dispatcher.dispatchEvent(
                EmbedLayoutEvent(
                    surfaceId,
                    id,
                    embed.embedId,
                    x,
                    y,
                    embed.widthDp,
                    embed.heightDp,
                )
            )
        }
    }

    // ---- Decorations ---------------------------------------------------------

    /**
     * Paints the block chrome behind the child TextView: code boxes, table
     * borders and row rules, thematic breaks. Three passes — every fill,
     * then every blockquote bar, then every stroke — so a table's header
     * band never covers the border drawn around it and an island's opaque
     * fill inside a quote never severs the quote's bar (the marks sort
     * quote-first, so the island's fill would otherwise land on top of it),
     * whatever order JS emitted the entries in.
     *
     * Geometry is read off the TextView's own Layout, so a box hugs exactly
     * the lines its range wrapped to; the layout-affecting half of each
     * decoration (margins, tab stops) is already inside that layout via
     * `RunAttributedText.build`. Everything arrives in dp and is converted
     * here, at the point of use, like every other dimension prop.
     */
    override fun onDraw(canvas: android.graphics.Canvas) {
        super.onDraw(canvas)
        val decorations = pendingDecorations.decorations
        if (decorations.isEmpty()) return
        val layout = textView.layout ?: return
        val length = textView.text?.length ?: 0
        if (length == 0) return

        for (pass in 0..2) {
            for (decoration in decorations) {
                when (decoration.kind) {
                    "box" -> drawBox(canvas, layout, decoration, length, pass)
                    "rule" -> if (pass == 2) drawRule(canvas, layout, decoration, length)
                    // 'columns' and 'indent' are layout-only; unknown kinds
                    // are newer JS.
                }
            }
        }
    }

    /** Pass 0 paints the box's fill, pass 1 its blockquote bar, pass 2 its
     * border stroke; see `onDraw` for why the three are separate sweeps. */
    private fun drawBox(
        canvas: android.graphics.Canvas,
        layout: android.text.Layout,
        decoration: RunDecorations.Decoration,
        length: Int,
        pass: Int,
    ) {
        val stroke = pass == 2
        val color = if (stroke) decoration.borderColor else decoration.color
        // The bar's pass carries only band geometry, independent of the fill:
        // a quote themed without a background is bar-only, so a null fill
        // colour must not skip the band computation below.
        val barColor =
            if (pass == 1 && decoration.barWidth > 0f) decoration.barColor else null
        when (pass) {
            0 -> if (color == null) return
            1 -> if (barColor == null) return
        }
        val strokeWidth = PixelUtil.toPixelFromDIP(decoration.borderWidth)
        if (stroke && (color == null || strokeWidth <= 0f)) return
        val start = decoration.start.coerceIn(0, length)
        val end = decoration.end.coerceIn(start, length)
        if (end <= start) return

        val textTop = textView.top.toFloat() + textView.totalPaddingTop
        val firstLine = layout.getLineForOffset(start)
        val lastLine = layout.getLineForOffset(end - 1)
        // Padding extends into the blank separator lines around the block;
        // the clamp keeps a box at the run's very edge inside this view
        // instead of painted over a neighbour (the parent clips anyway).
        val top = (textTop + layout.getLineTop(firstLine) -
            PixelUtil.toPixelFromDIP(decoration.paddingTop)).coerceAtLeast(0f)
        val bottom = (textTop + layout.getLineBottom(lastLine) +
            PixelUtil.toPixelFromDIP(decoration.paddingBottom)).coerceAtMost(height.toFloat())
        if (bottom <= top) return
        // `inset` pulls the band off both edges — an island box inside a
        // blockquote starts at the quote body's edge instead of crossing the
        // bar at x = 0 (runDecorations.ts documents the field).
        val insetPx = PixelUtil.toPixelFromDIP(decoration.inset)
        if (width - insetPx * 2 <= 0f) return

        if (barColor != null) {
            // The blockquote bar: a capsule at the box's leading edge,
            // spanning the padded band (the box's own corner radius does not
            // apply to it). Its own pass, above every fill: an island's
            // opaque background inside the quote must not sever it. The
            // half-width radii clamp to a circle on a band shorter than the
            // bar is wide, matching iOS's min(barWidth, height) / 2.
            val barWidth = PixelUtil.toPixelFromDIP(decoration.barWidth)
            decorationRect.set(insetPx, top, insetPx + barWidth, bottom)
            decorationPaint.style = android.graphics.Paint.Style.FILL
            decorationPaint.color = barColor
            canvas.drawRoundRect(decorationRect, barWidth / 2f, barWidth / 2f, decorationPaint)
            return
        }

        if (color != null) {
            decorationRect.set(insetPx, top, width.toFloat() - insetPx, bottom)
            decorationPaint.color = color
            if (stroke) {
                decorationPaint.style = android.graphics.Paint.Style.STROKE
                decorationPaint.strokeWidth = strokeWidth
                // Inset by half the stroke so the border draws fully inside.
                decorationRect.inset(strokeWidth / 2f, strokeWidth / 2f)
            } else {
                decorationPaint.style = android.graphics.Paint.Style.FILL
            }

            val radius = PixelUtil.toPixelFromDIP(decoration.borderRadius)
            if (radius <= 0f) {
                canvas.drawRect(decorationRect, decorationPaint)
            } else if (decoration.topCornersOnly) {
                // The table header band: it shares the table box's top corners,
                // and its bottom edge sits mid-table on the first row rule where
                // a rounded corner would read as a gap in the border.
                for (index in decorationRadii.indices) {
                    decorationRadii[index] = if (index < 4) radius else 0f
                }
                decorationPath.reset()
                decorationPath.addRoundRect(
                    decorationRect, decorationRadii, android.graphics.Path.Direction.CW
                )
                canvas.drawPath(decorationPath, decorationPaint)
            } else {
                canvas.drawRoundRect(decorationRect, radius, radius, decorationPaint)
            }
        }
    }

    private fun drawRule(
        canvas: android.graphics.Canvas,
        layout: android.text.Layout,
        decoration: RunDecorations.Decoration,
        length: Int,
    ) {
        val color = decoration.color ?: return
        val thickness = PixelUtil.toPixelFromDIP(decoration.thickness)
        if (thickness <= 0f) return
        // A rule is an anchor, not a range: the line containing its offset
        // decides where it sits. Clamped, because a zero-length anchor may
        // sit at text end (a trailing thematic break).
        val anchor = decoration.start.coerceIn(0, length - 1)
        val line = layout.getLineForOffset(anchor)
        val textTop = textView.top.toFloat() + textView.totalPaddingTop
        val y = textTop + if (decoration.alignTop) {
            layout.getLineTop(line).toFloat()
        } else {
            (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f
        }
        val inset = PixelUtil.toPixelFromDIP(decoration.inset)
        if (width - inset * 2 <= 0f) return
        decorationPaint.style = android.graphics.Paint.Style.FILL
        decorationPaint.color = color
        canvas.drawRect(
            inset, y - thickness / 2f, width - inset, y + thickness / 2f, decorationPaint
        )
    }

    // ---- Recycling ----------------------------------------------------------

    /**
     * Strip this host of everything belonging to the run it just showed.
     *
     * A RECYCLED HOST THAT KEPT ITS SELECTION IS THIS LIBRARY'S WORST FAILURE.
     * Fabric pools component views and hands a used one to a different run
     * (`ViewManager.prepareToRecycleView`, ViewManager.java:236-238, is where
     * this is called from). If the old selection and its action mode survived
     * that, the user could tap "Copy Markdown" on handles left over from the
     * previous run: the offsets are in range, so nothing throws, they are just
     * mapped through the *new* run's piece table, and the app receives a
     * well-formed payload of markdown the user never selected. It fails
     * silently and the payload looks correct.
     *
     * Order matters. The action mode is finished first, because clearing the
     * text under a live one is what leaves an orphaned menu floating over the
     * next run; `setText` then drops the selection, which on Android is
     * unconditional and is the same platform behaviour the tail policy is
     * built around. `clearFocus` is not decoration either — a selectable
     * TextView that keeps focus keeps the insertion handle with it.
     *
     * The prop-side fields are reset to the same values a freshly constructed
     * host has, so a recycled view and a new one are indistinguishable to the
     * prop batch that follows. `selectable` is deliberately restored to true:
     * it is the safe default (docs/SELECTION.md), and the tail policy always
     * sends the prop explicitly on the runs where it matters.
     */
    fun prepareToRecycle() {
        activeActionMode?.finish()
        activeActionMode = null
        textView.text = ""
        textView.clearFocus()
        textView.setTextIsSelectable(true)
        pendingText = ""
        pendingAttributes = RunAttributedText.Spec.EMPTY
        pendingDecorations = RunDecorations.Spec.EMPTY
        // Embeds and their report ledger go together: a recycled host that
        // kept either could report the PREVIOUS run's rects against the next
        // run's embedIds — the embed cousin of the stale-selection failure
        // this method exists to prevent.
        pendingEmbeds = RunEmbeds.Spec.EMPTY
        lastEmbedRects.clear()
        textDirty = false
        selectionActions = listOf(ACTION_COPY_TEXT, ACTION_COPY_MARKDOWN)
        // A fresh host has no tappable ranges; a recycled one keeping the
        // previous run's would turn arbitrary spots of the next run's prose
        // into links — the pressable cousin of the stale-selection failure
        // this method exists to prevent.
        pressables = emptyList()
    }

    // ---- Lifecycle & platform-bug containment -------------------------------

    override fun onDetachedFromWindow() {
        // Close any live menu and uninstall the callback so a lingering
        // ActionMode cannot hold this view (and its ReactContext) after
        // unmount.
        activeActionMode?.finish()
        activeActionMode = null
        textView.customSelectionActionModeCallback = null
        super.onDetachedFromWindow()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        // Detach is not unmount. A ScrollView or FlatList with
        // `removeClippedSubviews` detaches and re-attaches the very same view
        // as it scrolls, and without this the callback uninstalled above was
        // gone for good: the run stayed selectable but permanently lost
        // "Copy Text" and "Copy Markdown", with no error to notice.
        textView.customSelectionActionModeCallback = selectionCallback
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        // The inline-press detector observes the stream before the platform
        // handles it, and its verdict is discarded: whatever it recognizes,
        // the touch continues to the TextView unchanged, so selection
        // gestures and tap-to-dismiss behave exactly as they would with no
        // pressables at all. Gated on the list so the common no-links run
        // does not pay for gesture bookkeeping per touch.
        if (pressables.isNotEmpty()) {
            inlineTapDetector.onTouchEvent(event)
        }
        // Selection-handle touches inside TextView/Editor throw
        // IndexOutOfBoundsException on a family of Samsung builds. Swallowing
        // the crash loses at worst one gesture; propagating it kills the app.
        val handled = try {
            super.dispatchTouchEvent(event)
        } catch (e: IndexOutOfBoundsException) {
            true
        }
        if (handled) return true
        // A selectable TextView consumes every gesture, so this line is only
        // reached when the child is NOT selectable — the Android tail policy
        // mounts the streaming tail that way, and a settled link inside that
        // tail still has pressables. An unconsumed ACTION_DOWN ends the
        // stream (the platform stops delivering MOVE/UP to a view that
        // declined the DOWN), so the detector above would never see the tap
        // complete. Claiming a DOWN that lands on a pressable keeps the
        // stream alive; everything else stays declined, exactly as before.
        return event.actionMasked == MotionEvent.ACTION_DOWN &&
            pressableAt(event.x, event.y) != null
    }

    /**
     * One tappable range: UTF-16 offsets into the projected text, plus JS's
     * identifier for the range (its index into the `pressables` prop as
     * sent), echoed back verbatim in the event.
     */
    internal data class Pressable(val start: Int, val end: Int, val id: Int)

    companion object {
        const val ACTION_COPY_TEXT = "copy-text"
        const val ACTION_COPY_MARKDOWN = "copy-markdown"

        /**
         * Every live host, weakly, for one-active-selection coordination —
         * the Android twin of the iOS `liveHosts` NSHashTable. A weak set,
         * so unmounted hosts fall out on their own; touched from the main
         * thread only (selection changes and clears are both UI-thread
         * events), so no synchronization is needed.
         */
        private val liveHosts: MutableSet<SelectableRunHostView> =
            java.util.Collections.newSetFromMap(java.util.WeakHashMap())

        /**
         * Parses the `pressables` prop, with `RunAttributedText.parse`'s
         * discipline: total, on arrival, into plain values. Total because a
         * malformed entry must degrade to an untappable link, never to a
         * crash; on arrival because a ReadableArray is a handle onto memory
         * the bridge may recycle after the prop batch; and through getDouble
         * because a JS number crosses the bridge as a double and getInt
         * throws when it finds one.
         */
        internal fun parsePressables(source: ReadableArray?): List<Pressable> {
            if (source == null || source.size() == 0) return emptyList()
            val parsed = ArrayList<Pressable>(source.size())
            for (index in 0 until source.size()) {
                if (source.getType(index) != ReadableType.Map) continue
                val entry = source.getMap(index) ?: continue
                val start = optInt(entry, "start") ?: continue
                val end = optInt(entry, "end") ?: continue
                val id = optInt(entry, "pressableId") ?: continue
                if (start < 0 || end <= start) continue
                parsed.add(Pressable(start, end, id))
            }
            return parsed
        }

        private fun optInt(entry: ReadableMap, key: String): Int? =
            if (entry.hasKey(key) && entry.getType(key) == ReadableType.Number) {
                entry.getDouble(key).toInt()
            } else {
                null
            }

        /** Distinctive high item ids ("SM" + index). They can never equal
         * the small sequential ids OEM menus and ACTION_PROCESS_TEXT items
         * use, nor any android.R.id constant (those live in 0x0102xxxx). */
        private const val ITEM_ID_COPY_TEXT = 0x53_4D_01
        private const val ITEM_ID_COPY_MARKDOWN = 0x53_4D_02

        private fun titleFor(action: String): String = when (action) {
            ACTION_COPY_TEXT -> "Copy Text"
            else -> "Copy Markdown"
        }
    }
}
