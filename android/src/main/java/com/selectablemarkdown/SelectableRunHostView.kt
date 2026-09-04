package com.selectablemarkdown

import android.annotation.SuppressLint
import android.os.Build
import android.view.ActionMode
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
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
 *           `selectable`, `exclusiveSelection` (whether this host takes part
 *           in the one-active-selection coordination), `selectionActions`
 *           (the ordered menu, one string per item: an action identifier, or
 *           `identifier + U+001F + title`)
 *   events: `onSelectionAction({ start, end, action, selectedText })` —
 *           UTF-16 code-unit offsets into the CURRENT `text`,
 *           end-exclusive, clamped, start <= end; `action` names the menu
 *           item the user tapped.
 *           `onInlinePress({ start, end, pressableId })` — a single tap
 *           landed inside one of `pressables`; same offset guarantees, and
 *           `pressableId` is JS's identifier for the range, echoed verbatim.
 *           `onSelectionChange({ start, end })` — where the selection stands
 *           now, deduped; same offset guarantees except that an EMPTY range
 *           is a real payload and means "nothing is selected here".
 *   commands: `clearSelection()`, `setSelection(start, end)` — JS telling one
 *           mounted host what to select, in the same offsets the events
 *           report. Routed through the codegen'd ViewManager delegate.
 *
 * The system Copy item (android.R.id.copy) is never intercepted, replaced,
 * or reordered: stock plain-text copy keeps working with no JS involvement.
 * The custom items only EMIT the event — JS builds the payload and writes
 * the clipboard.
 *
 * THE MENU'S STRINGS COME FROM JS WHEN JS SENDS THEM, and from this module's
 * resources otherwise. An entry with no U+001F is a bare identifier, titled
 * from `R.string.selectable_markdown_copy_text` /
 * `..._copy_markdown` — which a host app overrides by declaring the same
 * names, and translates with a `values-<locale>` folder. An entry that
 * carries a title uses it verbatim, which is what lets one JS i18n call
 * localise both platforms and what lets a consumer define items this file
 * has never heard of. An identifier this view cannot title (unknown, and no
 * title sent) is dropped rather than added as a blank menu item — the same
 * forward-compatibility rule as before, now with the escape hatch that a
 * title makes any identifier renderable.
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
 * fixtures, an Android-selectable run's text changes four to ten times per
 * streamed message — 47 changes across the eight, streamed in 5-character
 * chunks under `presets.llmChat` — and each one costs the user their
 * selection and the open action mode.
 *
 * Nothing here can copy the wrong markdown — the offsets are always read from
 * the current text — so this is a UX defect, not a correctness one. It is
 * pre-existing and unfixed; docs/SELECTION.md ("Android: no preservation, and
 * a known gap") carries the per-fixture measurement and the candidate fixes,
 * every one of which is larger than this file.
 *
 * NOTHING HERE IS CONDITIONAL ON AN ARCHITECTURE, because there is only one
 * left: the peer range starts at react-native 0.82. Fabric hands the Java
 * ViewManager the raw props, so `RunAttributedText.parse` reads them
 * unchanged, and events go out through `UIManagerHelper`'s dispatcher rather
 * than a path of their own. What Fabric brings that the old architecture did
 * not is recycling — see `prepareToRecycle`, which is a correctness
 * requirement here and not hygiene.
 */
class SelectableRunHostView(context: ReactContext) : FrameLayout(context) {

    /**
     * The host's text widget. A subclass for the behaviours the platform only
     * offers to a TextView subclass, mirroring the iOS host:
     * `onSelectionChanged` feeds the one-active-selection coordination (see
     * `activeHost`), the only selection-change signal a TextView exposes, and
     * the three dispatch overrides below are the plumbing
     * `ExploreByTouchHelper` documents as the caller's job.
     *
     * Everything else stays the stock widget — the decorator design's whole
     * point — and every override degrades to `super` whenever it has nothing
     * to do.
     */
    private inner class RunTextView(context: android.content.Context) : TextView(context) {

        override fun onSelectionChanged(selStart: Int, selEnd: Int) {
            super.onSelectionChanged(selStart, selEnd)
            // THE CONSTRUCTOR GUARD. TextView's own init reaches this override
            // before the host's fields exist — `textView` itself is still
            // null, so anything that reads it would NPE. It used to be
            // implicit in `selEnd > selStart` (the selection is always empty
            // that early); it has to be explicit now that an empty selection
            // is something this view reports rather than ignores.
            if (!readyForEvents) return
            // Self first, coordination second, and the order is load-bearing:
            // a hand-off must reach JS as "this run holds [4,9)" followed by
            // "the other run holds nothing", which JS can drop as stale.
            // Coordinating first would deliver a null and then the real
            // selection — one visible toolbar flicker per hand-off. The iOS
            // delegate is ordered the same way for the same reason.
            emitSelectionChange()
            // A host that opted out of exclusivity still REPORTS; it only
            // skips the coordination.
            if (selEnd > selStart && exclusiveSelection) {
                becomeActiveSelectionHost()
            }
        }

        // The three feeds ExploreByTouchHelper cannot install for itself.
        // Hover drives explore-by-touch (a finger dragged over the text with
        // TalkBack on), keys drive arrow navigation between virtual views,
        // and focus keeps the helper's idea of the focused node in step. All
        // three are null-safe against construction order: this subclass is
        // built while the host's own fields are still being initialised, and
        // `accessibilityHelper` is the last of them.
        override fun dispatchHoverEvent(event: MotionEvent): Boolean {
            if (accessibilityHelper?.dispatchHoverEvent(event) == true) return true
            return super.dispatchHoverEvent(event)
        }

        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            if (accessibilityHelper?.dispatchKeyEvent(event) == true) return true
            return super.dispatchKeyEvent(event)
        }

        override fun onFocusChanged(
            focused: Boolean,
            direction: Int,
            previouslyFocusedRect: android.graphics.Rect?,
        ) {
            super.onFocusChanged(focused, direction, previouslyFocusedRect)
            accessibilityHelper?.onFocusChanged(focused, direction, previouslyFocusedRect)
        }
    }

    private val textView: TextView = RunTextView(context)

    /**
     * The screen-reader channel over `pressables` and the run's block roles —
     * heading, list item, table cell; see `RunAccessibility.kt`. Nullable and
     * assigned in `init`
     * rather than initialised here, because `RunTextView` reads it from three
     * dispatch overrides that the platform can in principle reach before this
     * object finishes constructing.
     */
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
    private var textDirty = false

    /** The accessibility ranges' own dirty flag, and it cannot be folded into
     * `textDirty`: they are derived from `text`, `attributes` AND
     * `pressables`, and a pressables-only update deliberately never sets
     * `textDirty` (see `setPressables`). Same purpose as `textDirty` though —
     * under Fabric the whole prop map arrives on every commit, and this is
     * what keeps a batch that changed none of the three from rebuilding the
     * list. */
    private var accessibilityDirty = false

    /** False until `init` finishes. `RunTextView`'s own constructor reaches
     * `onSelectionChanged` before this object's fields are assigned — before
     * `textView` itself exists — so the emitter there has to know when it is
     * safe to touch them. The JVM default of a Boolean field is false, which
     * is what makes reading it from inside that constructor correct rather
     * than merely lucky. */
    private var readyForEvents = false

    /** Whether this host takes part in the one-active-selection coordination;
     * see `becomeActiveSelectionHost` and the `exclusiveSelection` prop. */
    private var exclusiveSelection = true

    /** The last range handed to `onSelectionChange`, so an unchanged selection
     * is never re-announced.
     *
     * IT MATTERS BECAUSE `onSelectionChanged` IS NOISY: the platform calls it
     * on every step of a handle drag and on every `Selection` write, and
     * `commitProps` performs one of those on every commit that changes the
     * text. An empty selection is normalised to (0, 0) before it lands here,
     * so the two ways Android spells "nothing selected" — (-1, -1) and a
     * collapsed cursor — dedupe against each other instead of alternating.
     *
     * Starting at (0, 0) means a host that has never held a selection emits
     * nothing at all: an empty report is meaningful only as the END of a
     * selection this host previously announced. */
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

    /** Configured menu actions, in prop order: the identifier to report and
     * the title to draw, both resolved when the prop arrived. Defaults to
     * the built-in menu, matching the JS default. */
    private var selectionActions: List<ResolvedAction> = defaultSelectionActions()

    /** The menu item ids added by the last `onPrepareActionMode`.
     *
     * Tracked rather than assumed because the menu is no longer a fixed two
     * items: the prop can shrink, grow or be reordered between prepares, and
     * removing exactly what was added is what leaves nothing behind. */
    private val addedMenuItemIds = ArrayList<Int>(2)

    /** Item id -> action identifier for the items currently on the menu.
     *
     * This map IS the "never intercept a system item" rule: only ids this
     * class put on the menu are in it, so `onActionItemClicked` declines
     * android.R.id.copy and every OEM addition by finding nothing. */
    private val menuItemActions = HashMap<Int, String>()

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
     *
     * IT IS NOT THE ONLY WAY IN ANY MORE, and it could not be: a screen
     * reader activates a node with ACTION_CLICK through the accessibility
     * API, never by injecting a touch stream, so while this detector was the
     * only path a link inside a run was unreachable with TalkBack on — and
     * unannounced. `accessibilityHelper` adds that path (RunAccessibility.kt)
     * without giving up anything above: it installs no movement method, and
     * both routes end in the same `emitInlinePress`.
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
            // What gets removed is exactly what was added last time, not a
            // fixed pair — the list is consumer-sized now. System items
            // (android.R.id.copy and friends) stay exactly where the
            // platform put them.
            for (index in addedMenuItemIds.indices) {
                menu.removeItem(addedMenuItemIds[index])
            }
            addedMenuItemIds.clear()
            menuItemActions.clear()
            var order = Menu.CATEGORY_SECONDARY
            for (action in selectionActions) {
                // Sequential from the base, so the default two-item menu
                // still gets the same two ids it always had. Every entry in
                // `selectionActions` is renderable — an identifier this
                // binary cannot title was already dropped by
                // `parseSelectionAction` — so there is nothing to skip here.
                val itemId = ITEM_ID_BASE + addedMenuItemIds.size
                menu.add(Menu.NONE, itemId, order, action.title)
                addedMenuItemIds.add(itemId)
                menuItemActions[itemId] = action.id
                order += 1
            }
            return true
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            // Never intercept system items (android.R.id.copy etc.); plain
            // copy must keep its stock behavior. Only the ids this callback
            // added are in the map, so anything else declines by missing.
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
        // The screen-reader channel, installed once and for the life of the
        // view: it offers no node provider at all while the run has no links
        // and no block roles
        // (RunAccessibilityHelper.getAccessibilityNodeProvider), so there is
        // nothing to attach and detach as props change.
        //
        // ExploreByTouchHelper's constructor forces `focusable` on and lifts
        // importantForAccessibility from AUTO to YES; both are restored here,
        // exactly as React Native's own ReactAccessibilityDelegate restores
        // them (ReactAccessibilityDelegate.java:403-407), so a run keeps the
        // focus behaviour and the announcement coalescing the stock widget
        // had. `setTextIsSelectable` above owns `focusable` on this widget,
        // and `setSelectable` keeps owning it afterwards.
        val focusableBefore = textView.isFocusable
        val importanceBefore = textView.importantForAccessibility
        val helper = RunAccessibilityHelper(textView) { pressable -> emitInlinePress(pressable) }
        textView.isFocusable = focusableBefore
        textView.importantForAccessibility = importanceBefore
        // ViewCompat, not View#setAccessibilityDelegate: the helper is an
        // AccessibilityDelegateCompat, which the framework setter does not
        // take.
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
        // LAST LINE OF `init`, deliberately: everything `onSelectionChanged`
        // touches — `textView`, the dedupe fields, `exclusiveSelection` — is
        // assigned by now, so the guard in that override can stop refusing.
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
     * An unguarded setter used to be harmless, because the old architecture
     * sent only the props JS had diffed as changed, so this ran when
     * `attributes` actually changed. Fabric does not diff, and Fabric is the
     * only architecture this package supports. `FabricMountingManager::getProps`
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
        // Headings, list items and table cells are read back out of these
        // ranges (RunAccessibility.kt).
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
        // Ahead of the early return below, because the accessibility ranges
        // have their own dirty flag: `pressables` changing on its own is the
        // case that must not be missed, and it deliberately leaves `text`
        // alone. Offsets only — the node bounds are read from the layout at
        // the moment a screen reader asks for them, so this does not care
        // that the text below has not been installed yet.
        if (accessibilityDirty) {
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
        RunTextMeasure.updateTextViewBaseSize(textView, pendingText, pendingAttributes)
        // And the room a box at the very edge of this run needs, as the child
        // TextView's vertical padding.
        //
        // WHY PADDING RATHER THAN A LAYOUT OFFSET. `totalPaddingTop` is
        // already what every text-to-view coordinate conversion in this file
        // goes through — the box and rule geometry in `onDraw`, the embed
        // rects, the pressable hit test, the screen reader's node bounds — so
        // pushing the text down this way moves all of them together and none
        // of them has to learn why. The measure path reserved exactly these
        // two values — the same `RunDecorations.edgePaddingPx` call, added to
        // the height in `RunTextMeasure.measure`, so the rounding to whole
        // pixels `setPadding` needs happens once and both sides spend the
        // identical integers. The taller view Fabric framed is therefore the
        // room this padding fills; without it the padding would grow the
        // TextView past the host and clip the last line instead.
        //
        // Zero for the ordinary run — no box at either edge — in which case
        // this is the `setPadding(0, 0, 0, 0)` the widget already had.
        val edge = RunDecorations.edgePaddingPx(pendingDecorations, pendingText.length)
        textView.setPadding(0, edge.top, 0, edge.bottom)
        textView.text = RunLayoutCache.styledText(
            RunLayoutCache.key(pendingText, pendingAttributes, pendingDecorations, pendingEmbeds)
        )
        // The chrome is positioned off the text layout, so this ViewGroup's
        // own display list is stale the moment the text moves — and a child
        // invalidation alone does not rebuild the parent's.
        invalidate()
        // The swap above dropped whatever was selected, and JS has to be told
        // — a toolbar over a selection that no longer exists is exactly the
        // artifact this event was added to remove. Called rather than left to
        // `onSelectionChanged`, because whether `TextView#setText` re-notifies
        // for the NEW text is a version-dependent detail of the widget; the
        // dedupe makes a duplicate call free.
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
     * The `exclusiveSelection` prop: whether this host takes part in the
     * one-active-selection coordination (`becomeActiveSelectionHost`).
     * Defaults to true, which is what every host did before the prop existed.
     *
     * FALSE OPTS OUT IN BOTH DIRECTIONS. This host neither clears the previous
     * owner nor takes the slot, so it cannot erase another host's selection
     * and — because it is never the recorded owner — no other host can erase
     * its. An opt-out that only stopped the clearing would be useless: the
     * first selection would still die the moment a second one began.
     *
     * WHAT `false` BUYS, AND WHAT IT DOES NOT. It buys several simultaneous
     * `Selection` spans that survive each other, each reported by its own
     * host through `onSelectionChange` — which is what makes "select in A,
     * select in B, merge the two payloads" reachable at all. It does NOT buy
     * several visible highlights, and it buys at most one action mode. A
     * `TextView` draws a selection highlight only while `isFocused() ||
     * isPressed()` (TextView#getUpdatedHighlightPath — the same fact
     * `setSelection` is built around), and only one view has focus, so the
     * earlier selections are live and invisible: the user sees the highlight
     * move to whichever run they touched last. Anything built on this has to
     * give its own feedback for the spans it is accumulating; the platform
     * will not.
     *
     * The baton is handed back here rather than at the next selection change,
     * because a host that opted out while holding it would otherwise be
     * cleared once more by the next selection elsewhere, after it had already
     * stopped participating.
     */
    fun setExclusiveSelection(value: Boolean) {
        if (value == exclusiveSelection) return
        exclusiveSelection = value
        if (!value && activeHost?.get() === this) {
            activeHost = null
        }
    }

    // ---- Commands -----------------------------------------------------------

    /**
     * The `setSelection` command: select `[start, end)` of the current text,
     * UTF-16 offsets, end-exclusive — the same unit and the same clamping
     * discipline as every event this view emits, because JS computed these
     * offsets against text that may have moved on by a frame.
     *
     * FOCUS IS TAKEN, AND IT HAS TO BE. `TextView` draws a selection highlight
     * only while `isFocused() || isPressed()` (TextView#getUpdatedHighlightPath),
     * so setting the `Selection` spans alone would be an invisible selection:
     * present in `selectionStart`/`End`, reported to JS as real, and absent
     * from the screen. The consequence is worth stating rather than hiding —
     * a scrolling ancestor may respond to a focus change by scrolling this run
     * into view. This command does not scroll; the platform's focus handling
     * may.
     *
     * No action mode is started. A programmatic selection shows the range and
     * its handles; the menu belongs to the user's gesture, and iOS behaves the
     * same way.
     *
     * A run that is not selectable takes nothing — the platform's selection UI
     * is off there (the streaming tail under the Android tail policy, or an
     * explicit `selectable={false}`), so a selection would be state nobody can
     * see or dismiss.
     *
     * A RANGE THAT CLAMPS TO EMPTY IS A NO-OP AND LEAVES ANY EXISTING
     * SELECTION ALONE. It used to clear, which made the command destructive
     * in the one case it is least sure of itself: the offsets were computed
     * against text that may have moved on by a frame, so an empty clamp means
     * "I raced a swap", not "the app asked for nothing" — and a user mid-sweep
     * in this run would have lost their selection to a command aimed at text
     * that is no longer here. Clearing is what `clearSelection` is for.
     * Nothing changes, so nothing is emitted: `onSelectionChange` keeps
     * describing the selection this run actually has. iOS follows the same
     * rule, for the same reason (`SelectableRunHostView.setSelection`).
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
    fun setPressables(value: List<Pressable>) {
        if (value == pressables) return
        pressables = value
        // The screen reader's link nodes are these same ranges, so they are
        // rebuilt with them — in `commitProps`, once for the whole batch,
        // like everything else derived from props.
        accessibilityDirty = true
    }

    /**
     * The `selectionActions` prop: one string per menu item, either an
     * action identifier or `identifier + U+001F + title`, in menu order.
     *
     * Resolved to titles HERE rather than in `onPrepareActionMode`, for the
     * same reason `pressables` is parsed on arrival: prepare runs inside a
     * UIKit-equivalent callback that OEM skins invoke repeatedly while a
     * selection is live, and it must not do string work or resource lookups
     * per invocation. The comparison after resolving is also what keeps a
     * prop batch that re-sends an identical list from invalidating an open
     * action mode.
     */
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

    /**
     * One `selectionActions` entry, split the way
     * `src/view/selectionActions.ts` packs it.
     *
     * The split is at the FIRST U+001F and everything after it is the title
     * verbatim, so a title that contains one survives; an identifier could
     * not, which is why the encoder refuses to send one. Returns null — the
     * item is dropped, never added blank — for an empty identifier, and for
     * an identifier that has no title from JS and none of this library's
     * own. That last case is the forward-compatibility rule: a newer JS
     * bundle naming an action this binary predates is ignored.
     */
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

    /**
     * This library's own title for an identifier it implements, or null for
     * one it does not know.
     *
     * A RESOURCE AND NOT A LITERAL, so the two built-in items can be
     * translated and reworded without a fork: a host app declares the same
     * string names in its own `res/values/strings.xml` to override them (an
     * application resource wins over a library's) and adds
     * `res/values-<locale>/` to translate them. It is the Android
     * counterpart of the iOS host's `NSLocalizedString` lookup against
     * `Bundle.main`. Sending a `title` from JS overrides both at once and is
     * the only path that reaches a consumer-defined identifier.
     */
    private fun defaultTitleFor(id: String): String? = when (id) {
        ACTION_COPY_TEXT -> context.getString(R.string.selectable_markdown_copy_text)
        ACTION_COPY_MARKDOWN -> context.getString(R.string.selectable_markdown_copy_markdown)
        else -> null
    }

    /** The menu before any prop arrives, and after a prop reset: literally
     * what the JS default (`DEFAULT_SELECTION_ACTIONS`) encodes to — the two
     * bare identifiers, run through the same parse as any other entry, so
     * there is one place where a built-in item gets its title. */
    private fun defaultSelectionActions(): List<ResolvedAction> = listOfNotNull(
        parseSelectionAction(ACTION_COPY_TEXT),
        parseSelectionAction(ACTION_COPY_MARKDOWN),
    )

    // ---- Selection coordination ---------------------------------------------


    /**
     * One active selection across the document: Android never clears one
     * TextView's selection because another began one, so a transcript of
     * per-run hosts would otherwise keep several live `Selection` spans at
     * once. Not several highlights — a `TextView` draws one only while it is
     * focused or pressed, and only one view has focus — so the older span
     * goes invisible the instant the newer one begins, while remaining a real
     * range its host has already reported to JS. That undrawn, undismissable
     * state is what this removes. Called from
     * `RunTextView.onSelectionChanged` the moment a non-empty selection lands
     * here.
     *
     * THE PREDECESSOR IS THE ONLY HOST THAT CAN BE HOLDING ONE, which is what
     * makes this O(1). The invariant is maintained by this method itself:
     * every non-empty selection passes through here and clears the one before
     * it, so at most one host in the process has a selection, and
     * `activeHost` is it. This used to sweep a weak registry of every live
     * host on every callback — an allocation and a walk over every mounted
     * run, per frame, for the whole of a selection-handle drag.
     *
     * Recursion-safe: clearing the predecessor fires its
     * `onSelectionChanged` with an empty selection, which returns at the
     * guard there. The reference is weak, so an unmounted predecessor is
     * simply gone by the time it would have been cleared, and nothing here
     * keeps a view (or its ReactContext) alive.
     */
    private fun becomeActiveSelectionHost() {
        val previous = activeHost?.get()
        if (previous === this) return
        activeHost = java.lang.ref.WeakReference(this)
        previous?.clearSelection()
    }

    /**
     * Drop this host's selection and close any menu over it. A no-op when
     * nothing is selected.
     *
     * ONE METHOD FOR TWO CALLERS, deliberately: the `clearSelection` command
     * from JS and the coordination clearing the previous selection owner mean
     * exactly the same thing, and two definitions of "this run has no
     * selection" would be two chances to leave an orphaned action mode
     * behind. Order matters the same way it does in `prepareToRecycle`: the
     * selection goes first, because finishing the mode is what the platform
     * does in response.
     *
     * The report is left to the `onSelectionChanged` the removal triggers.
     */
    fun clearSelection() {
        if (textView.selectionEnd <= textView.selectionStart) return
        val spannable = textView.text as? android.text.Spannable ?: return
        android.text.Selection.removeSelection(spannable)
        activeActionMode?.finish()
    }

    // ---- Event emission ----------------------------------------------------

    /**
     * Report where the selection stands, deduped against the last report.
     *
     * The clamp is `emitSelectionAction`'s, minus its "never empty" rule: an
     * empty range is the whole reason this event exists, so it is emitted —
     * once — when it follows a non-empty one. Android spells "nothing
     * selected" two ways, (-1, -1) and a collapsed offset, and both normalise
     * to (0, 0) here so they dedupe against each other rather than
     * alternating.
     *
     * Unlike iOS this needs no forced re-announcement after a text swap: on
     * this platform `setText` DROPS the selection rather than clamping it
     * through, so the swap always produces a genuine range change for the
     * dedupe to notice.
     */
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

        // One dispatch for both architectures, exactly as emitSelectionAction
        // below explains. Recorded above before the dispatcher is resolved, so
        // a report that cannot be delivered (a detached view) does not leave
        // the dedupe claiming the previous range is still current.
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
        if (y < 0f || y > layout.height.toFloat()) return null
        val line = layout.getLineForVertical(y.toInt())
        if (y < layout.getLineTop(line).toFloat() || y >= layout.getLineBottom(line).toFloat()) {
            return null
        }
        if (x < layout.getLineLeft(line) || x > layout.getLineRight(line)) return null
        val offset = layout.getOffsetForHorizontal(line, x)
        // Half-open containment, matching how LinkMovementMethod queries
        // spans at an insertion offset: ranges never overlap — JS's
        // resolveRunPressables drops any range starting inside one it already
        // kept, link marks themselves do nest — so the first hit is the only
        // hit.
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
     * the embed-height `RunLineHeightSpan` that `RunEmbeds.applyLineHeights`
     * sets over the same character, and its surplus branch re-centres the
     * extra room around the baseline — so `getLineBaseline - height` can
     * point above the line's top. The top of the placeholder's line IS the
     * top of the reserved band, whatever the baseline did.
     *
     * REPORTING THE DECLARED SIZE IS ONLY HONEST BECAUSE THE RESERVATION IS
     * IN THE SAME UNIT. The rect below echoes `widthDp`/`heightDp` back
     * unconverted, and the box the span holds open is those same numbers
     * through `toPixelFromDIP` — including the line height, which is why that
     * one is decoded in DIP rather than in the SP every other line height on
     * the wire uses.
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
            // The same guards `RunEmbeds.forEachReserved` applied when the
            // string was built (both halves of the reservation go through it):
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
        // Padding is normally painted into the blank line the projection's
        // '\n\n' block separator leaves around the block, so it costs no
        // height. At the EDGE of a run there is no such line, and the room
        // comes from `RunDecorations.edgePaddingPx` instead: the measure path
        // added it to this host's height and `commitProps` set it as the
        // child TextView's padding, so `textTop` for a box starting at offset
        // 0 is already `paddingTop` or more, and this view's `height` for one
        // ending at the last character is already `paddingBottom` or more
        // past the last line's bottom.
        //
        // THE CLAMPS THEREFORE NO LONGER BITE FOR A WELL-FORMED DECORATION,
        // and they stay because that is not the only kind that can arrive: an
        // entry from a newer JS bundle can name a padding larger than the
        // room JS asked to reserve, and chrome painted over a neighbouring
        // view is worse than chrome drawn a pixel short. They were a bug when
        // they were the ONLY thing between a trailing table and a border on
        // its own last baseline.
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
        // The run-edge room the previous run's box asked for, which is
        // geometry and not a prop: a recycled host that kept it would offset
        // the next run's text by a padding that run never reserved, and the
        // measured height it was framed at would not include. `commitProps`
        // recomputes it from the decorations the next run brings.
        textView.setPadding(0, 0, 0, 0)
        // Embeds and their report ledger go together: a recycled host that
        // kept either could report the PREVIOUS run's rects against the next
        // run's embedIds — the embed cousin of the stale-selection failure
        // this method exists to prevent.
        pendingEmbeds = RunEmbeds.Spec.EMPTY
        lastEmbedRects.clear()
        textDirty = false
        selectionActions = defaultSelectionActions()
        // The menu the finished action mode above was showing is gone, so
        // these only ever describe items that no longer exist. Cleared
        // anyway: a recycled host must not carry a mapping from the previous
        // run's menu ids to the previous run's action identifiers.
        addedMenuItemIds.clear()
        menuItemActions.clear()
        // A fresh host has no tappable ranges; a recycled one keeping the
        // previous run's would turn arbitrary spots of the next run's prose
        // into links — the pressable cousin of the stale-selection failure
        // this method exists to prevent.
        pressables = emptyList()
        // And the screen reader's view of them, for the same reason: a
        // virtual link node left over from the previous run would offer a
        // TalkBack user an activation on text that is gone.
        accessibilityDirty = false
        accessibilityHelper?.setNodes(emptyList())
        // Hand back the one-active-selection baton. The `textView.text = ""`
        // above already dropped this host's selection, so leaving it on
        // record as the document's selection owner would only cost the next
        // selecting host a no-op call — but the invariant is worth keeping
        // true rather than merely harmless.
        if (activeHost?.get() === this) {
            activeHost = null
        }
        // Selection-report history, like `lastEmbedRects` above: it describes
        // the previous run's offsets. A recycled host that kept it could
        // suppress the first real report of the NEXT run's selection as a
        // duplicate — the same stale-state failure class, one channel over.
        lastReportedStart = 0
        lastReportedEnd = 0
        // And the exclusivity policy goes back to the default a freshly
        // constructed host has, for the same reason `selectable` does: it is
        // the safe value (coordinate), and the prop is re-sent by the batch
        // that follows on every run where it matters.
        exclusiveSelection = true
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
        // every item `selectionActions` asked for — "Copy Text" and "Copy
        // Markdown" by default — with no error to notice.
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

    /**
     * One resolved menu item: the identifier reported in
     * `onSelectionAction`, and the string drawn on the item. A data class
     * because `setSelectionActions` compares whole lists by value to decide
     * whether an open action mode has to be invalidated.
     */
    internal data class ResolvedAction(val id: String, val title: String)

    companion object {
        const val ACTION_COPY_TEXT = "copy-text"
        const val ACTION_COPY_MARKDOWN = "copy-markdown"

        /**
         * The one host in the process that currently holds a selection, or
         * null — the whole of the one-active-selection coordination (see
         * `becomeActiveSelectionHost`).
         *
         * Weak, so an unmounted host is collected rather than pinned here
         * with the ReactContext behind it; touched from the main thread only
         * (selection changes and clears are both UI-thread events), so no
         * synchronization is needed. Process-wide, which is the documented
         * behaviour (docs/SELECTION.md, "Selections never span hosts") and
         * also its limitation: two unrelated `<SelectableMarkdown>` trees in
         * a split view clear each other unless one of them sets
         * `exclusiveSelection={false}` (see `setExclusiveSelection`), which
         * is the only opt-out and is per-host, not per-tree.
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

        /**
         * First of the distinctive high item ids ("SM" + index); the nth
         * rendered custom item gets `ITEM_ID_BASE + n`, so the default
         * two-item menu keeps the exact ids it always had.
         *
         * They can never equal the small sequential ids OEM menus and
         * ACTION_PROCESS_TEXT items use, nor any android.R.id constant
         * (those live in 0x0102xxxx) — and a list long enough to walk out of
         * the 0x534Dxx band walks into 0x534Exx, which collides with neither.
         */
        private const val ITEM_ID_BASE = 0x53_4D_01

        /**
         * The character `src/view/selectionActions.ts` packs an item's
         * identifier and title around: U+001F INFORMATION SEPARATOR ONE,
         * chosen because no menu title can legitimately contain it and no
         * identifier in this library uses it. An entry without it is a bare
         * identifier, which is the pre-title wire format unchanged.
         */
        private const val ACTION_TITLE_SEPARATOR = '\u001F'
    }
}
