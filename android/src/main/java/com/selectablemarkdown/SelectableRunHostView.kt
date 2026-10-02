package com.selectablemarkdown

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.view.ActionMode
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityManager
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.RootView
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
 *           `selectable`, `exclusiveSelection`, `selectionActions`
 *   events: `onSelectionAction({ start, end, action, selectedText })` —
 *           UTF-16 code-unit offsets into the CURRENT `text`,
 *           end-exclusive, clamped, start <= end; `action` names the menu
 *           item the user tapped.
 *           `onInlinePress({ start, end, pressableId, x, y, width, height })`
 *           — a single tap (or accessibility activation) landed inside one of
 *           `pressables`; same offset guarantees, `pressableId` is JS's
 *           identifier for the range, echoed verbatim, and the rect is the
 *           range's bounds in dp, in the space of a touch's `pageX`/`pageY`.
 *           `onSelectionChange({ start, end })` — deduped; same offset
 *           guarantees, except that an EMPTY range means nothing is selected.
 *   commands: `clearSelection()`, `setSelection(start, end)`, in the same offsets.
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
 * fixtures, an Android-selectable run's text changes several times per
 * streamed message, and each one costs the user their selection and the
 * open action mode.
 *
 * Nothing here can copy the wrong markdown — the offsets are always read from
 * the current text — so this is a UX defect, not a correctness one. It is
 * pre-existing and unfixed; docs/SELECTION.md ("Android: no preservation, and
 * a known gap") carries the measurement and the candidate fixes.
 *
 * Fabric recycles views, so `prepareToRecycle` is a correctness requirement, not hygiene.
 */
class SelectableRunHostView(context: ReactContext) : FrameLayout(context) {

    /**
     * The host's text widget. A subclass for the behaviours the platform only
     * offers to a TextView subclass, mirroring the iOS host:
     * `onSelectionChanged` feeds the one-active-selection coordination (see
     * `activeHost`), the only selection-change signal a TextView exposes, and
     * the dispatch overrides below feed `ExploreByTouchHelper`.
     *
     * Everything else stays the stock widget — the decorator design's whole
     * point — and every override degrades to `super` whenever it has nothing
     * to do.
     */
    private inner class RunTextView(context: android.content.Context) : TextView(context) {

        override fun onSelectionChanged(selStart: Int, selEnd: Int) {
            super.onSelectionChanged(selStart, selEnd)
            // TextView's own constructor reaches this before the host's fields exist.
            if (!readyForEvents) return
            // Report before coordinating, so a hand-off reaches JS as the new range, then the old run's empty one.
            emitSelectionChange()
            if (selEnd > selStart) setPressedPressable(null)
            if (selEnd > selStart && exclusiveSelection) {
                becomeActiveSelectionHost()
            }
        }

        /** Over the text, as the platform's own lines are, so a `BackgroundColorSpan` cannot hide them. */
        override fun onDraw(canvas: android.graphics.Canvas) {
            super.onDraw(canvas)
            val textLayout = layout ?: return
            drawDecorationLines(canvas, textLayout, totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
        }

        // The feeds ExploreByTouchHelper cannot install for itself.
        override fun dispatchHoverEvent(event: MotionEvent): Boolean {
            if (accessibilityHelper?.dispatchHoverEvent(event) == true) return true
            return super.dispatchHoverEvent(event)
        }

        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            if (accessibilityHelper?.dispatchLinkKeyEvent(event) == true) return true
            return super.dispatchKeyEvent(event)
        }

        override fun onFocusChanged(
            focused: Boolean,
            direction: Int,
            previouslyFocusedRect: android.graphics.Rect?,
        ) {
            super.onFocusChanged(focused, direction, previouslyFocusedRect)
            accessibilityHelper?.onHostFocusChanged(focused, direction, previouslyFocusedRect)
        }
    }

    private val textView: TextView = RunTextView(context)

    /** Nullable: `RunTextView`'s dispatch overrides can run before `init` assigns it. */
    private var accessibilityHelper: RunAccessibilityHelper? = null

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
    private var allowFontScaling = true
    private var maxFontSizeMultiplier = 0f
    private var pendingScaling: RunFontScaling = RunFontScaling.DEFAULT
    private var textDirty = false

    /** Separate from `textDirty`: a pressables-only update changes the accessibility ranges, never the text. */
    private var accessibilityDirty = false
    private val accessibilityManager = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
    private val accessibilityStateListener = AccessibilityManager.AccessibilityStateChangeListener { enabled ->
        accessibilityDirty = true
        if (enabled) commitProps() else accessibilityHelper?.setNodes(emptyList())
    }

    /** Read inside `RunTextView`'s constructor, where only the JVM default false makes that safe. */
    private var readyForEvents = false

    private var exclusiveSelection = true

    /** Empty selections are normalised to (0, 0), so both of Android's spellings dedupe and a never-selected host reports nothing. */
    private var lastReportedStart = 0
    private var lastReportedEnd = 0

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
    private val decorationTextPaint = android.text.TextPaint(android.text.TextPaint.ANTI_ALIAS_FLAG)
    private val decorationBounds = android.graphics.Rect()
    private var cachedDashEffect: android.graphics.DashPathEffect? = null
    private var dashEffectOn = 0f
    private var dashEffectOff = 0f

    /** The pressable a live touch began on, painted with its `pressedColor` until the touch ends. */
    private var pressedPressable: Pressable? = null
    private var pressDownX = 0f
    private var pressDownY = 0f
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop

    private var selectionActions: List<ResolvedAction> = defaultSelectionActions()

    private val addedMenuItemIds = ArrayList<Int>(2)

    private val menuItemActions = HashMap<Int, String>()

    /** Tappable ranges over the text, parsed from the `pressables` prop.
     * Empty whenever JS has no listener, which is what keeps every touch
     * below on its stock path in the common no-links case. */
    private var pressables: List<Pressable> = emptyList()
    private var bandPressables: List<Pressable> = emptyList()

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

            // A long press is the selection gesture, never a press.
            override fun onLongPress(e: MotionEvent) = setPressedPressable(null)
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
            for (index in addedMenuItemIds.indices) {
                menu.removeItem(addedMenuItemIds[index])
            }
            addedMenuItemIds.clear()
            menuItemActions.clear()
            var order = Menu.CATEGORY_SECONDARY
            for (action in selectionActions) {
                // Sequential from the base, so the default two-item menu keeps its ids.
                val itemId = ITEM_ID_BASE + addedMenuItemIds.size
                menu.add(Menu.NONE, itemId, order, action.title)
                addedMenuItemIds.add(itemId)
                menuItemActions[itemId] = action.id
                order += 1
            }
            return true
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            // Only ids this callback added are in the map, so system and OEM items decline by missing.
            val action = menuItemActions[item.itemId] ?: return false
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
        // text size, font padding, line spacing, line breaking, paragraph
        // direction, fallback line spacing — is set here
        // and only here. RunTextMeasure owns them because the two things that
        // must agree about them are this TextView and the StaticLayout built
        // by the measure path (the C++ shadow node, through
        // SelectableRunHostViewManager.measure). Setting any of them
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
        // ExploreByTouchHelper's constructor forces `focusable` and importantForAccessibility YES;
        // both are restored, as React Native's ReactAccessibilityDelegate does.
        val focusableBefore = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) textView.focusable
            else if (textView.isFocusable) View.FOCUSABLE else View.NOT_FOCUSABLE
        val importanceBefore = textView.importantForAccessibility
        val helper = RunAccessibilityHelper(textView) { pressable -> emitInlinePress(pressable) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) textView.setFocusable(focusableBefore)
        else textView.isFocusable = focusableBefore == View.FOCUSABLE
        textView.importantForAccessibility = importanceBefore
        ViewCompat.setAccessibilityDelegate(textView, helper)
        accessibilityHelper = helper
        addView(
            textView,
            LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        )
        // A ViewGroup skips its own onDraw by default; block chrome (boxes,
        // rules) is painted there, behind the child TextView — which is the
        // stacking the design needs, since the platform draws the selection
        // highlight inside the TextView, above whatever this layer painted.
        setWillNotDraw(false)
        // Last in `init`: everything `onSelectionChanged` touches is assigned by now.
        readyForEvents = true
    }

    // ---- Props -------------------------------------------------------------

    fun setText(value: String) {
        if (value == pendingText) return
        pendingText = value
        textDirty = true
        accessibilityDirty = true
    }

    /**
     * THE EQUALITY GUARD IS NOT AN OPTIMISATION — IT IS WHAT KEEPS A LIVE
     * SELECTION ALIVE ON FABRIC. Setting `textDirty` makes `commitProps` run
     * `textView.text = …`, and `TextView#setText` drops the selection and
     * dismisses the ActionMode even when the new value is character-identical
     * to the old one.
     *
     * Fabric does not diff props. `FabricMountingManager::getProps`
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
        val layoutChanged = spec.layoutAttributes != pendingAttributes.layoutAttributes
        pendingAttributes = spec
        textDirty = textDirty || layoutChanged
        accessibilityDirty = true
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
        updateBandPressables()
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

    fun setAllowFontScaling(value: Boolean) {
        allowFontScaling = value
        updateScaling()
    }

    fun setMaxFontSizeMultiplier(value: Float) {
        maxFontSizeMultiplier = value
        updateScaling()
    }

    /** Every SP conversion in the build reads it, so a change rebuilds the text, as a font-scale change would. */
    private fun updateScaling() {
        val scaling = RunFontScaling.of(allowFontScaling, maxFontSizeMultiplier)
        if (scaling == pendingScaling) return
        pendingScaling = scaling
        textDirty = true
    }

    /** Applied once per prop batch, from the view manager. */
    fun commitProps() {
        // Before the early return: a pressables-only batch leaves `textDirty` false.
        if (accessibilityDirty && accessibilityManager.isEnabled) {
            accessibilityDirty = false
            accessibilityHelper?.setNodes(
                RunAccessibility.resolve(pendingText, pendingAttributes, pressables)
            )
        }
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
        RunTextMeasure.updateTextViewBaseSize(textView, pendingText, pendingAttributes, pendingScaling)
        // Padding, so every `totalPaddingTop` conversion here moves with it; `RunTextMeasure.measure` reserved the same pixels.
        val edge = RunDecorations.edgePaddingPx(pendingDecorations, pendingText.length)
        textView.setPadding(0, edge.top, 0, edge.bottom)
        textView.text = RunLayoutCache.styledText(
            RunLayoutCache.key(pendingText, pendingAttributes, pendingDecorations, pendingEmbeds, pendingScaling)
        )
        // The chrome is positioned off the text layout, so this ViewGroup's
        // own display list is stale the moment the text moves — and a child
        // invalidation alone does not rebuild the parent's.
        invalidate()
        // Called directly: whether `setText` re-notifies `onSelectionChanged` varies by version, and the dedupe makes a duplicate free.
        emitSelectionChange()
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
     * False opts out both ways: this host never clears another's selection and is never recorded, so none clears its.
     * Its selection stays live but unhighlighted once another view takes focus.
     */
    fun setExclusiveSelection(value: Boolean) {
        if (value == exclusiveSelection) return
        exclusiveSelection = value
        if (!value && activeHost?.get() === this) {
            activeHost = null
        }
    }

    /**
     * Takes focus, since a `TextView` draws its highlight only while focused, so a scrolling ancestor may follow.
     * A range that clamps to empty is a no-op: it means a raced text swap, so the existing selection stays.
     */
    fun setSelection(start: Int, end: Int) {
        if (!textView.isTextSelectable) return
        val spannable = textView.text as? android.text.Spannable ?: return
        val length = spannable.length
        val low = minOf(start, end).coerceIn(0, length)
        val high = maxOf(start, end).coerceIn(0, length)
        if (high <= low) return
        textView.requestFocus()
        android.text.Selection.setSelection(spannable, low, high)
    }

    /**
     * Deliberately independent of `text`/`attributes` and of `textDirty`:
     * what is tappable and what is drawn are separate channels, so a
     * pressables-only update never costs a `setText` — which on this platform
     * would drop a live selection (see setAttributes above for why that guard
     * discipline exists).
     */
    /** Internal: `Pressable` is, and a public signature may not expose it. */
    internal fun setPressables(value: List<Pressable>) {
        if (value == pressables) return
        pressables = value
        updateBandPressables()
        accessibilityDirty = true
        setPressedPressable(null)
    }

    private fun updateBandPressables() {
        val chips = pendingDecorations.decorations.filter { it.kind == "chip" }
        bandPressables = pressables.filter { pressable ->
            pressable.hitSlop > 0f || chips.any { it.start == pressable.start && it.end == pressable.end }
        }
    }

    /** Resolved on arrival because OEM skins call `onPrepareActionMode` repeatedly while a selection is live. */
    fun setSelectionActions(actions: List<String>) {
        val resolved = ArrayList<ResolvedAction>(actions.size)
        for (index in actions.indices) {
            val action = parseSelectionAction(actions[index])
            if (action != null) {
                resolved.add(action)
            }
        }
        if (resolved == selectionActions) {
            return
        }
        selectionActions = resolved
        // An open menu rebuilds through onPrepareActionMode.
        activeActionMode?.invalidate()
    }

    /** Splits at the first U+001F, so a title may contain one; an entry titled by neither JS nor this library is dropped. */
    private fun parseSelectionAction(encoded: String): ResolvedAction? {
        val separator = encoded.indexOf(ACTION_TITLE_SEPARATOR)
        val id = if (separator < 0) encoded else encoded.substring(0, separator)
        if (id.isEmpty()) {
            return null
        }
        val sent = if (separator < 0) "" else encoded.substring(separator + 1)
        val title = if (sent.isNotEmpty()) sent else defaultTitleFor(id)
        if (title == null) {
            return null
        }
        return ResolvedAction(id, title)
    }

    /** A resource, not a literal, so a host app can override or translate the built-in titles. */
    private fun defaultTitleFor(id: String): String? = when (id) {
        ACTION_COPY_TEXT -> context.getString(R.string.selectable_markdown_copy_text)
        ACTION_COPY_MARKDOWN -> context.getString(R.string.selectable_markdown_copy_markdown)
        else -> null
    }

    private fun defaultSelectionActions(): List<ResolvedAction> = listOfNotNull(
        parseSelectionAction(ACTION_COPY_TEXT),
        parseSelectionAction(ACTION_COPY_MARKDOWN),
    )

    // ---- Selection coordination ---------------------------------------------


    /**
     * One active selection across the document: Android never clears one
     * TextView's selection because another began one, so a transcript of
     * per-run hosts would keep several live selections, all but one invisible.
     *
     * Every non-empty selection passes here, so the predecessor is the only host that can hold one.
     */
    private fun becomeActiveSelectionHost() {
        val previous = activeHost?.get()
        if (previous === this) return
        activeHost = java.lang.ref.WeakReference(this)
        previous?.clearSelection()
    }

    /** Selection before the mode, since finishing is the platform's response; a backward selection has start > end. */
    fun clearSelection() {
        val start = textView.selectionStart
        val end = textView.selectionEnd
        if (start < 0 || end < 0 || start == end) return
        val spannable = textView.text as? android.text.Spannable ?: return
        android.text.Selection.removeSelection(spannable)
        activeActionMode?.finish()
    }

    // ---- Event emission ----------------------------------------------------

    /** Unlike iOS, no forced re-announcement after a text swap: `setText` drops the selection here. */
    private fun emitSelectionChange() {
        val length = textView.text?.length ?: 0
        val rawStart = textView.selectionStart
        val rawEnd = textView.selectionEnd
        var start = 0
        var end = 0
        if (rawStart >= 0 && rawEnd >= 0) {
            start = minOf(rawStart, rawEnd).coerceIn(0, length)
            end = maxOf(rawStart, rawEnd).coerceIn(0, length)
            if (end <= start) {
                start = 0
                end = 0
            }
        }
        if (start == lastReportedStart && end == lastReportedEnd) return
        lastReportedStart = start
        lastReportedEnd = end

        // Recorded before dispatch, so an undeliverable report still moves the dedupe off the previous range.
        val reactContext = context as ReactContext
        val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id) ?: return
        dispatcher.dispatchEvent(
            SelectionChangeEvent(UIManagerHelper.getSurfaceId(this), id, start, end)
        )
    }

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
        exactPressableAt(layout, x, y)?.let { return it }
        // By band too: `getOffsetForHorizontal` answers a chip's (atomic
        // ReplacementSpan's) trailing half with its end offset. `hitSlop`
        // widens only the tap target, per line the range covers.
        for (pressable in bandPressables) {
            val slop = PixelUtil.toPixelFromDIP(pressable.hitSlop)
            val hit = anyLineRect(layout, pressable.start, pressable.end) { _, rect ->
                rect.inset(-slop, -slop)
                rect.contains(x, y)
            }
            if (hit) return pressable
        }
        return null
    }

    /** `x`/`y` in layout coordinates. */
    private fun exactPressableAt(layout: android.text.Layout, x: Float, y: Float): Pressable? {
        if (y < 0f || y > layout.height.toFloat()) return null
        val line = layout.getLineForVertical(y.toInt())
        if (y < layout.getLineTop(line).toFloat() || y >= layout.getLineBottom(line).toFloat()) {
            return null
        }
        if (x < layout.getLineLeft(line) || x > layout.getLineRight(line)) return null
        val offset = layout.getOffsetForHorizontal(line, x)
        // Half-open containment, matching how LinkMovementMethod queries
        // spans at an insertion offset: JS's resolveRunPressables keeps the
        // ranges disjoint, so the first hit is the only hit.
        return pressables.firstOrNull { offset >= it.start && offset < it.end }
    }

    /**
     * Calls `test` with each line's band of `[start, end)` in layout
     * coordinates (into the shared `decorationRect`), stopping at the first
     * true. An end at a wrapped line's break resolves to the next line, so
     * that line's edge stands in for it.
     */
    private inline fun anyLineRect(
        layout: android.text.Layout,
        start: Int,
        end: Int,
        test: (Int, android.graphics.RectF) -> Boolean,
    ): Boolean {
        val length = layout.text.length
        val from = start.coerceIn(0, length)
        val to = end.coerceIn(from, length)
        if (to <= from) return false
        val rect = decorationRect
        for (line in layout.getLineForOffset(from)..layout.getLineForOffset(to - 1)) {
            val lineStart = maxOf(from, layout.getLineStart(line))
            val lineEnd = minOf(to, layout.getLineVisibleEnd(line))
            if (lineEnd <= lineStart) continue
            val a = layout.getPrimaryHorizontal(lineStart)
            val b = if (lineEnd < layout.getLineEnd(line) || line == layout.lineCount - 1) {
                layout.getPrimaryHorizontal(lineEnd)
            } else if (layout.getParagraphDirection(line) == android.text.Layout.DIR_RIGHT_TO_LEFT) {
                layout.getLineLeft(line)
            } else {
                layout.getLineRight(line)
            }
            rect.set(
                minOf(a, b),
                layout.getLineTop(line).toFloat(),
                maxOf(a, b),
                layout.getLineBottom(line).toFloat(),
            )
            if (test(line, rect)) return true
        }
        return false
    }

    private fun setPressedPressable(value: Pressable?) {
        if (value === pressedPressable) return
        pressedPressable = value
        invalidate()
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
        // Empty bounds (no layout yet) report as zeros rather than dropping the press.
        val bounds = android.graphics.RectF()
        textView.layout?.let { pressableBounds(it, pressable, start, end, bounds) }
        val origin = rootOrigin()
        dispatcher.dispatchEvent(
            InlinePressEvent(
                UIManagerHelper.getSurfaceId(this),
                id,
                start,
                end,
                pressable.id,
                PixelUtil.toDIPFromPixel(bounds.left + origin[0]),
                PixelUtil.toDIPFromPixel(bounds.top + origin[1]),
                PixelUtil.toDIPFromPixel(bounds.width()),
                PixelUtil.toDIPFromPixel(bounds.height()),
            )
        )
    }

    /**
     * The pressed range's bounds in this view's px coordinates, into `out`:
     * the chip rect when a 'chip' covers exactly the range (as drawPressed
     * paints it), else the union of its per-line rects.
     */
    private fun pressableBounds(
        layout: android.text.Layout,
        pressable: Pressable,
        start: Int,
        end: Int,
        out: android.graphics.RectF,
    ) {
        val chip = pendingDecorations.decorations.firstOrNull {
            it.kind == "chip" && it.start == pressable.start && it.end == pressable.end
        }
        val radius = PixelUtil.toPixelFromDIP(
            if (pressed.pressedRadius > 0f) pressed.pressedRadius else chip?.borderRadius ?: 0f,
        )
        val text = textView.text as? android.text.Spanned
        if (chip != null && text != null &&
            RunDecorations.chipRect(layout, text, chip, textView.paint, decorationTextPaint, decorationRect)
        ) {
            out.set(decorationRect)
        } else {
            out.setEmpty()
            anyLineRect(layout, start, end) { _, rect ->
                if (out.isEmpty) out.set(rect) else out.union(rect)
                false
            }
        }
        if (!out.isEmpty) out.offset(textOriginX(), textOriginY())
    }

    /**
     * This view's px origin relative to its React root view (ReactSurfaceView,
     * or a Modal's DialogRootViewGroup): RN's TouchesHelper reports `pageX`/
     * `pageY` as the root's own MotionEvent coordinates, so the press bounds
     * share that space. Window-location deltas fold in every ancestor's
     * scroll, translation and inset; with no root found, window coordinates.
     * Walked by hand: RootViewUtil.getRootView asserts on a non-View parent
     * (ViewRootImpl) instead of returning null.
     */
    private fun rootOrigin(): FloatArray {
        val here = IntArray(2)
        getLocationInWindow(here)
        var root: View? = null
        var current: View? = this
        while (current != null) {
            if (current is RootView) {
                root = current
                break
            }
            current = current.parent as? View
        }
        val rootAt = IntArray(2)
        root?.getLocationInWindow(rootAt)
        return floatArrayOf((here[0] - rootAt[0]).toFloat(), (here[1] - rootAt[1]).toFloat())
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
     * the `RunLineHeightSpan` from `RunEmbeds.applyLineHeights`, whose surplus
     * branch can move the baseline, so `getLineBaseline - height` can point
     * above the line's top.
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
            // The guards `RunEmbeds.forEachReserved` applied at build time:
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
        val layout = textView.layout ?: return
        val length = textView.text?.length ?: 0
        if (length == 0) return
        val decorations = pendingDecorations.decorations

        for (pass in 0..2) {
            for (decoration in decorations) {
                when (decoration.kind) {
                    "box" -> drawBox(canvas, layout, decoration, length, pass)
                    "rule" -> if (pass == 2) drawRule(canvas, layout, decoration, length)
                    "chip" -> if (pass != 1) drawChip(canvas, layout, decoration, pass == 2)
                    // 'columns', 'indent', 'marker' and 'spacing' are
                    // layout-only (a marker's dot draws in its span); unknown
                    // kinds are newer JS.
                }
            }
            if (pass == 1) drawPressed(canvas, layout)
        }
    }

    private fun textOriginX(): Float = (textView.left + textView.totalPaddingLeft - textView.scrollX).toFloat()

    private fun textOriginY(): Float = (textView.top + textView.totalPaddingTop - textView.scrollY).toFloat()

    /** Behind the text the span draws; pass 0 fills, the stroke pass borders. */
    private fun drawChip(
        canvas: android.graphics.Canvas,
        layout: android.text.Layout,
        decoration: RunDecorations.Decoration,
        stroke: Boolean,
    ) {
        val color = (if (stroke) decoration.borderColor else decoration.color) ?: return
        val strokeWidth = PixelUtil.toPixelFromDIP(decoration.borderWidth)
        if (stroke && strokeWidth <= 0f) return
        val text = textView.text as? android.text.Spanned ?: return
        if (!RunDecorations.chipRect(
                layout, text, decoration, textView.paint, decorationTextPaint, decorationRect,
            )
        ) {
            return
        }
        decorationRect.offset(textOriginX(), textOriginY())
        decorationPaint.color = color
        if (stroke) {
            decorationPaint.style = android.graphics.Paint.Style.STROKE
            decorationPaint.strokeWidth = strokeWidth
            decorationRect.inset(strokeWidth / 2f, strokeWidth / 2f)
        } else {
            decorationPaint.style = android.graphics.Paint.Style.FILL
        }
        val radius = PixelUtil.toPixelFromDIP(decoration.borderRadius)
        canvas.drawRoundRect(decorationRect, radius, radius, decorationPaint)
    }

    /** Over the fills (a chip's included), under the text. */
    private fun drawPressed(canvas: android.graphics.Canvas, layout: android.text.Layout) {
        val pressed = pressedPressable ?: return
        val color = pressed.pressedColor ?: return
        decorationPaint.style = android.graphics.Paint.Style.FILL
        decorationPaint.color = color
        val chip = pendingDecorations.decorations.firstOrNull {
            it.kind == "chip" && it.start == pressed.start && it.end == pressed.end
        }
        val radius = PixelUtil.toPixelFromDIP(
            if (pressed.pressedRadius > 0f) pressed.pressedRadius else chip?.borderRadius ?: 0f,
        )
        val text = textView.text as? android.text.Spanned
        if (chip != null && text != null &&
            RunDecorations.chipRect(layout, text, chip, textView.paint, decorationTextPaint, decorationRect)
        ) {
            decorationRect.offset(textOriginX(), textOriginY())
            canvas.drawRoundRect(decorationRect, radius, radius, decorationPaint)
            return
        }
        val dx = textOriginX()
        val dy = textOriginY()
        anyLineRect(layout, pressed.start, pressed.end) { _, rect ->
            rect.offset(dx, dy)
            canvas.drawRoundRect(rect, radius, radius, decorationPaint)
            false
        }
    }

    /**
     * Underlines and strike lines with a colour or a non-solid style
     * (`RunDecorationLineSpan`), which the text stack cannot draw. Sized off
     * the range's own text size. Called from the TextView's own `onDraw`, so
     * `dx`/`dy` are the layout's origin in that view's (scrolled) canvas.
     */
    private fun drawDecorationLines(
        canvas: android.graphics.Canvas,
        layout: android.text.Layout,
        dx: Float,
        dy: Float,
    ) {
        val text = layout.text as? android.text.Spanned ?: return
        val spans = text.getSpans(0, text.length, RunDecorationLineSpan::class.java)
        if (spans.isEmpty()) return
        for (span in spans) {
            val start = text.getSpanStart(span)
            val end = text.getSpanEnd(span)
            if (end <= start) continue
            RunDecorations.styleLike(text, start, end, textView.paint, decorationTextPaint)
            val textSize = decorationTextPaint.textSize
            val thickness = maxOf(1f, textSize / 18f)
            decorationTextPaint.getTextBounds("x", 0, 1, decorationBounds)
            val offset = if (span.strike) decorationBounds.top / 2f else maxOf(1f, textSize * 0.11f)
            decorationPaint.color =
                span.color ?: RunDecorations.foregroundAt(text, start, end, textView.currentTextColor)
            decorationPaint.style = android.graphics.Paint.Style.STROKE
            decorationPaint.strokeWidth = thickness
            decorationPaint.pathEffect = when (span.style) {
                "dashed" -> dashEffect(thickness * 3f, thickness * 2f)
                "dotted" -> dashEffect(thickness, thickness * 1.5f)
                else -> null
            }
            anyLineRect(layout, start, end) { line, rect ->
                val y = dy + layout.getLineBaseline(line) + offset
                val left = dx + rect.left
                val right = dx + rect.right
                if (span.style == "double") {
                    canvas.drawLine(left, y, right, y, decorationPaint)
                    canvas.drawLine(left, y + thickness * 2f, right, y + thickness * 2f, decorationPaint)
                } else {
                    canvas.drawLine(left, y, right, y, decorationPaint)
                }
                false
            }
            decorationPaint.pathEffect = null
        }
    }

    /** Reused across frames: the thickness is stable per run, and onDraw must not allocate per frame. */
    private fun dashEffect(on: Float, off: Float): android.graphics.DashPathEffect {
        cachedDashEffect?.let { if (dashEffectOn == on && dashEffectOff == off) return it }
        val effect = android.graphics.DashPathEffect(floatArrayOf(on, off), 0f)
        cachedDashEffect = effect
        dashEffectOn = on
        dashEffectOff = off
        return effect
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
        // Clamped: a newer bundle may name more padding than `edgePaddingPx` reserved, and painting over a neighbour is worse.
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
        // Geometry, not a prop: `commitProps` recomputes it for the next run.
        textView.setPadding(0, 0, 0, 0)
        // Embeds and their report ledger go together: a recycled host that
        // kept either could report the PREVIOUS run's rects against the next
        // run's embedIds — the embed cousin of the stale-selection failure
        // this method exists to prevent.
        pendingEmbeds = RunEmbeds.Spec.EMPTY
        lastEmbedRects.clear()
        textDirty = false
        selectionActions = defaultSelectionActions()
        addedMenuItemIds.clear()
        menuItemActions.clear()
        // A fresh host has no tappable ranges; a recycled one keeping the
        // previous run's would turn arbitrary spots of the next run's prose
        // into links — the pressable cousin of the stale-selection failure
        // this method exists to prevent.
        pressables = emptyList()
        bandPressables = emptyList()
        pressedPressable = null
        allowFontScaling = true
        maxFontSizeMultiplier = 0f
        pendingScaling = RunFontScaling.DEFAULT
        accessibilityDirty = false
        accessibilityHelper?.setNodes(emptyList())
        if (activeHost?.get() === this) {
            activeHost = null
        }
        // A kept dedupe could swallow the next run's first selection report.
        lastReportedStart = 0
        lastReportedEnd = 0
        exclusiveSelection = true
    }

    // ---- Lifecycle & platform-bug containment -------------------------------

    override fun onDetachedFromWindow() {
        accessibilityManager.removeAccessibilityStateChangeListener(accessibilityStateListener)
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
        accessibilityManager.addAccessibilityStateChangeListener(accessibilityStateListener)
        accessibilityDirty = true
        commitProps()
        // Detach is not unmount. A ScrollView or FlatList with
        // `removeClippedSubviews` detaches and re-attaches the very same view
        // as it scrolls, and without this the callback uninstalled above was
        // gone for good: the run stayed selectable but permanently lost
        // every item `selectionActions` asked for, with no error to notice.
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
            trackPressed(event)
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

    /** Pressed feedback follows only a touch that began on a pressable, and drops once it moves past the slop. */
    private fun trackPressed(event: MotionEvent) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pressDownX = event.x
                pressDownY = event.y
                setPressedPressable(pressableAt(event.x, event.y)?.takeIf { it.pressedColor != null })
            }
            MotionEvent.ACTION_MOVE -> if (pressedPressable != null &&
                (kotlin.math.abs(event.x - pressDownX) > touchSlop ||
                    kotlin.math.abs(event.y - pressDownY) > touchSlop)
            ) {
                setPressedPressable(null)
            }
            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_CANCEL,
            MotionEvent.ACTION_POINTER_DOWN -> setPressedPressable(null)
        }
    }

    /**
     * One tappable range: UTF-16 offsets into the projected text, plus JS's
     * identifier for the range (its index into the `pressables` prop as
     * sent), echoed back verbatim in the event, and its presentation.
     * Lengths in dp.
     */
    internal data class Pressable(
        val start: Int,
        val end: Int,
        val id: Int,
        val accessibilityLabel: String? = null,
        /** "button", "text" (tappable, no accessibility node), or null for a link. */
        val accessibilityRole: String? = null,
        val pressedColor: Int? = null,
        val pressedRadius: Float = 0f,
        val hitSlop: Float = 0f,
    )

    /** A data class: `setSelectionActions` compares lists by value to skip invalidating an open menu. */
    internal data class ResolvedAction(val id: String, val title: String)

    companion object {
        const val ACTION_COPY_TEXT = "copy-text"
        const val ACTION_COPY_MARKDOWN = "copy-markdown"

        /**
         * Main thread only, so unsynchronized; weak, so an unmounted host is collected.
         * Process-wide: separate trees clear each other unless one sets `exclusiveSelection={false}`.
         */
        private var activeHost: java.lang.ref.WeakReference<SelectableRunHostView>? = null

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
                parsed.add(
                    Pressable(
                        start,
                        end,
                        id,
                        accessibilityLabel = optString(entry, "accessibilityLabel")?.takeIf { it.isNotEmpty() },
                        accessibilityRole = optString(entry, "accessibilityRole")?.takeIf { it == "button" || it == "text" },
                        // Through Long: a packed colour arrives as the signed 32-bit pattern.
                        pressedColor = if (entry.hasKey("pressedColor") &&
                            entry.getType("pressedColor") == ReadableType.Number
                        ) {
                            entry.getDouble("pressedColor").toLong().toInt()
                        } else {
                            null
                        },
                        pressedRadius = optFloat(entry, "pressedRadius"),
                        hitSlop = optFloat(entry, "hitSlop"),
                    )
                )
            }
            return parsed
        }

        private fun optInt(entry: ReadableMap, key: String): Int? =
            if (entry.hasKey(key) && entry.getType(key) == ReadableType.Number) {
                entry.getDouble(key).toInt()
            } else {
                null
            }

        private fun optString(entry: ReadableMap, key: String): String? =
            if (entry.hasKey(key) && entry.getType(key) == ReadableType.String) {
                entry.getString(key)
            } else {
                null
            }

        /** Non-finite and negative values read as absent. */
        private fun optFloat(entry: ReadableMap, key: String): Float =
            if (entry.hasKey(key) && entry.getType(key) == ReadableType.Number) {
                entry.getDouble(key).toFloat().takeIf { it.isFinite() && it > 0f } ?: 0f
            } else {
                0f
            }

        /** "SM" + index: clear of the small OEM and ACTION_PROCESS_TEXT ids and of android.R.id's 0x0102xxxx. */
        private const val ITEM_ID_BASE = 0x53_4D_01

        /** Must match the separator `src/view/selectionActions.ts` packs with. */
        private const val ACTION_TITLE_SEPARATOR = '\u001F'
    }
}
