package com.selectablemarkdown

import android.graphics.Rect
import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.view.accessibility.AccessibilityNodeProviderCompat
import androidx.customview.widget.ExploreByTouchHelper
import kotlin.math.ceil
import kotlin.math.floor

/**
 * One range of a run a screen reader has to be able to reach on its own.
 *
 * `pressable` non-null is the LINK case, and it carries the identifier the
 * activation echoes back — so a TalkBack activation and a finger tap emit the
 * same `onInlinePress` payload through the same emitter, and JS cannot tell
 * which one fired. `pressable` null is a BLOCK ROLE, named by `role`:
 * announced as a heading, or given a position inside its list or table, and
 * never clickable.
 *
 * The coordinates are ONE-BASED, exactly as they cross the wire (0 is the
 * absent sentinel there), and become zero-based only where
 * `CollectionItemInfoCompat` is built.
 */
internal data class RunAccessibilityNode(
    val start: Int,
    val end: Int,
    val pressable: SelectableRunHostView.Pressable?,
    val role: String? = null,
    val row: Int? = null,
    val rowCount: Int? = null,
    val column: Int? = null,
    val columnCount: Int? = null,
)

/**
 * The screen-reader ranges of a run, read off the props it already has.
 *
 * WHY A RUN NEEDS THIS AT ALL. A run is one platform text view holding what
 * the document had as several blocks, so the block-level semantics the JS
 * renderer tree sets (`accessibilityRole="header"` on a heading,
 * `accessibilityRole="link"` on a link — src/view/renderers.tsx) never run
 * for a block that flows: TalkBack reached a heading inside a run as prose in
 * a larger font, unreachable by heading-by-heading navigation, and a link as
 * text that could not be activated. Both are recovered here, and both from
 * fields that are genuinely on the wire.
 *
 * ONE NODE PER CONSTRUCT, OVER ITS OWN TEXT. A `listItem` entry stops where
 * the sublist or table inside it begins, because JS narrows it there
 * (`resolveRunSemantics` in src/view/runAttributes.ts). Without that this
 * helper vended the parent AND its children over overlapping ranges, so
 * TalkBack read a sublist twice — once inside the parent's node and again as
 * its own — while iOS, which reads its ranges back off attribute runs, lost
 * the children's focus stops entirely to the parent's value. The narrowing is
 * what makes the two hosts announce the same thing.
 *
 * LIST AND TABLE STRUCTURE COMES BACK THE SAME WAY, through
 * `CollectionItemInfoCompat` on the item's node and `CollectionInfoCompat` on
 * the host's. That pair is what makes TalkBack say "item 2 of 5" or "row 2,
 * column 3" — in the reader's own language, from numbers alone, so this
 * library ships no announcement strings of its own. It is the same reason
 * only three roles exist: a code block and a blockquote have no such
 * primitive, so announcing them would mean shipping the English word for
 * them. They stay flat, docs/SELECTION.md says so, and `RunSemanticRole` in
 * src/view/runAttributes.ts is where the next role would be added.
 *
 * THE COST IS THAT A LIST IS READ TWICE: the TextView announces the whole
 * run and then each item announces itself. That is the shape React Native's
 * own `ReactAccessibilityDelegate` ships for the links inside a `<Text>`, and
 * the alternative — rewriting what the TextView announces — would take the
 * text-granularity navigation and selection that live on its real text with
 * it. iOS, where the elements are separate objects from the text view, elides
 * the covered ranges instead (`SelectableRunHostView.accessibilityElements`).
 */
internal object RunAccessibility {

    /** The `role` values this binary understands — see `RunSemanticRole` in
     * src/view/runAttributes.ts. Anything else is ignored, which leaves the
     * range announced as the prose it already was. Not private: the helper
     * below reads them back off a resolved node. */
    const val ROLE_HEADING = "heading"
    const val ROLE_LIST_ITEM = "listItem"
    const val ROLE_TABLE_CELL = "tableCell"

    /**
     * Link ranges come from `pressables` exactly — they are already the
     * 'link' and 'blockedLink' marks, non-overlapping and sorted
     * (src/view/runPressables.ts), which is the same list the tap hit-test
     * uses.
     *
     * HEADING RANGES COME FROM THE `role` FIELD ON THE ATTRIBUTE ENTRIES,
     * and that field is the whole point. They used to be INFERRED from the
     * shape of the styling — size + lineHeight + weight, no family, no
     * background, and not the first full-cover sized entry — because nothing
     * on the wire said "heading". The inference was correct for the theme
     * path and wrong in both directions for anyone using `attributeForMark`:
     * a consumer whose override gave some other range that same three-field
     * shape got it announced as a heading, and one that restyled headings
     * without a `lineHeight` lost the announcement entirely. Neither failure
     * was visible to any test in this repository. `resolveRunAttributes` now
     * states the role outright, outside the overridable styling path, so a
     * heading a consumer restyled is still a heading here.
     *
     * `roleLevel` IS PARSED AND DROPPED BECAUSE NO PLATFORM PRIMITIVE CARRIES
     * A RANK. `AccessibilityNodeInfo.setHeading(true)` is a single boolean;
     * there is no public API on it — and none on `CollectionItemInfo`, which
     * is where a list item's depth would have to go — that holds a heading
     * level or a nesting depth. The only vehicle left is the content
     * description, and putting "heading level 2" there means shipping an
     * English string this library cannot translate, which is worse than the
     * reader's own localised "heading". iOS drops it for the same reason:
     * `UIAccessibilityTraits.header` is a bit and not a rank
     * (`SelectableRunHostView.accessibilityElements` says so on that side).
     * It stays on the wire so that the day a primitive exists, consuming it
     * is a change here and not a second wire change.
     */
    fun resolve(
        text: String,
        attributes: RunAttributedText.Spec,
        pressables: List<SelectableRunHostView.Pressable>,
    ): List<RunAccessibilityNode> {
        val length = text.length
        if (length == 0) return emptyList()

        val nodes = ArrayList<RunAccessibilityNode>(pressables.size + 1)
        for (pressable in pressables) {
            val start = pressable.start.coerceIn(0, length)
            val end = pressable.end.coerceIn(start, length)
            if (end <= start) continue
            nodes.add(RunAccessibilityNode(start, end, pressable))
        }

        for (attribute in attributes.attributes) {
            val role = attribute.role
            if (role != ROLE_HEADING && role != ROLE_LIST_ITEM && role != ROLE_TABLE_CELL) {
                continue
            }
            // Clamped like every other reader of these offsets: they were
            // computed against the text JS sent, which under prop skew can be
            // a different length from the text in hand.
            val start = attribute.start.coerceIn(0, length)
            val end = attribute.end.coerceIn(start, length)
            if (end <= start) continue
            nodes.add(
                RunAccessibilityNode(
                    start = start,
                    end = end,
                    pressable = null,
                    role = role,
                    row = attribute.roleRow,
                    rowCount = attribute.roleRowCount,
                    // A list is a ONE-COLUMN collection, which is how both the
                    // wire and TalkBack read it: the item's position is its
                    // row, and the column it omits is column 1 of 1.
                    column = if (role == ROLE_TABLE_CELL) attribute.roleColumn else 1,
                    columnCount =
                        if (role == ROLE_TABLE_CELL) attribute.roleColumnCount else 1,
                )
            )
        }

        if (nodes.size > 1) {
            // Reading order, with the block role ahead of a link that starts
            // at the same offset: "Heading, Introduction" then "Introduction,
            // button" reads the way the document does.
            nodes.sortWith(
                compareBy<RunAccessibilityNode> { it.start }
                    .thenBy { if (it.pressable == null) 0 else 1 }
            )
        }
        return nodes
    }

    /**
     * The grid to declare on the host, or null when no collection in `nodes`
     * can be described.
     *
     * WHY ONLY ONE GRID CAN BE DECLARED. `CollectionItemInfo` is half of what
     * TalkBack needs; the other half is a `CollectionInfo` on an ANCESTOR,
     * and the only ancestor these virtual views have is the host TextView
     * itself (`ExploreByTouchHelper` builds a flat tree by design). One node
     * cannot describe two different grids.
     *
     * IT USED TO GIVE UP THE MOMENT THERE WERE TWO, and that lost the common
     * case rather than an exotic one: a merged run is exactly where a list
     * with a sublist, or a list beside a table, ends up, and a single sublist
     * of a different length was enough to leave the whole run with no
     * `CollectionInfo` — so the "item 2 of 5" this channel exists for was
     * never phrased for the documents that need it most. It now picks the
     * grid with the MOST cells (first-seen wins a tie) and the helper gives
     * `CollectionItemInfo` only to the nodes of THAT grid
     * (`RunAccessibilityHelper.onPopulateNodeForVirtualView`), so the biggest
     * collection in the run is announced properly and nothing is ever phrased
     * against a total that is not its own. The nodes left out keep their
     * label and their focus stop; they lose only a position TalkBack had no
     * way to say.
     *
     * A CANDIDATE MUST REALLY BE ONE GRID: every cell distinct and inside the
     * declared bounds. Two three-item lists in one run claim the same three
     * cells, so that shape is rejected and the next-largest is tried — one
     * list of three announced twice would be worse than no total at all.
     */
    fun collectionOf(nodes: List<RunAccessibilityNode>): Pair<Int, Int>? {
        // Insertion-ordered so a tie on size is broken by document order, and
        // `sortedByDescending` is stable, so that order survives the sort.
        val sizes = LinkedHashMap<Pair<Int, Int>, Int>()
        for (node in nodes) {
            val shape = shapeOf(node) ?: continue
            sizes[shape] = (sizes[shape] ?: 0) + 1
        }
        if (sizes.isEmpty()) return null
        for (candidate in sizes.entries.sortedByDescending { it.value }) {
            if (describesOneGrid(nodes, candidate.key)) return candidate.key
        }
        return null
    }

    /**
     * The (rows, columns) grid a node claims to sit in, or null when it
     * claims none — a heading, a link, or an item whose wire entry carried no
     * position.
     *
     * The shape is the node's whole collection identity here: nothing on the
     * wire names the list an item belongs to, so two collections with
     * different totals are told apart by their totals and two with the SAME
     * totals are told apart only by the duplicate-cell test below.
     */
    private fun shapeOf(node: RunAccessibilityNode): Pair<Int, Int>? {
        if (node.row == null) return null
        val rows = node.rowCount ?: return null
        return Pair(rows, node.columnCount ?: 1)
    }

    /** Whether the nodes of `shape` really are ONE grid of that shape: every
     * cell inside the declared bounds, and no cell claimed twice. */
    private fun describesOneGrid(
        nodes: List<RunAccessibilityNode>,
        shape: Pair<Int, Int>,
    ): Boolean {
        val seen = HashSet<Pair<Int, Int>>()
        for (node in nodes) {
            if (shapeOf(node) != shape) continue
            val row = node.row ?: continue
            val column = node.column ?: 1
            if (row > shape.first || column > shape.second) return false
            if (!seen.add(Pair(row, column))) return false
        }
        return seen.isNotEmpty()
    }

    /**
     * Whether `node` may carry a `CollectionItemInfo` given the grid the host
     * declares.
     *
     * A node of a DIFFERENT grid must not: its "3" would be phrased against
     * the declared collection's total and TalkBack would say "item 3 of 6"
     * about an item that is third of two. With no grid declared at all
     * nothing can be mis-phrased, so the info travels as it always did — it
     * is inert without a collection on an ancestor, and it is what a future
     * TalkBack reading item info on its own would want.
     */
    fun carriesItemInfo(node: RunAccessibilityNode, collection: Pair<Int, Int>?): Boolean {
        if (collection == null) return true
        return shapeOf(node) == collection
    }
}

/**
 * The accessibility half of the inline-press channel: a virtual view per link
 * and per block role — heading, list item, table cell — inside one run's
 * TextView.
 *
 * WHY IT EXISTS AT ALL. The host detects link taps by observing raw
 * MotionEvents (`SelectableRunHostView.dispatchTouchEvent`), deliberately, so
 * that no movement method is installed on a widget whose selection behaviour
 * has to stay stock. TalkBack does not inject touches: it activates a focused
 * node with ACTION_CLICK through the accessibility API, so with only the
 * gesture path a link inside a native run could not be activated at all — and
 * nothing announced that it was there. This provides the missing channel
 * WITHOUT touching the gesture path: no ClickableSpan, no
 * LinkMovementMethod, and both routes end in the same `emitInlinePress`.
 *
 * ANDROIDX, NOT A NEW ARCHITECTURE. `ExploreByTouchHelper` lives in
 * androidx.customview, which arrives with React Native's own Android artifact
 * (react-android -> appcompat -> drawerlayout -> customview) and is what
 * React Native's `ReactAccessibilityDelegate` extends to expose the links in
 * a `<Text>` the very same way. android/build.gradle names it explicitly all
 * the same, because this file imports it directly.
 *
 * IT IS ATTACHED TO THE CHILD TEXTVIEW, not to the host FrameLayout: the
 * TextView is the node a screen reader focuses and the Layout the bounds are
 * read from, so virtual-view coordinates and text coordinates are the same
 * space, and the host stays a plain decorator.
 */
internal class RunAccessibilityHelper(
    private val textView: TextView,
    private val onLinkActivated: (SelectableRunHostView.Pressable) -> Unit,
) : ExploreByTouchHelper(textView) {

    /** Current ranges, indexed by virtual view id. */
    private var nodes: List<RunAccessibilityNode> = emptyList()

    /**
     * The grid declared on the host node, derived once per `setNodes` rather
     * than per node: `collectionOf` walks every node, and the per-virtual-view
     * populate hook needs the same answer to decide whether that node's
     * position can be phrased at all.
     */
    private var collection: Pair<Int, Int>? = null

    /**
     * Replaces the exposed ranges. Called once per prop batch from
     * `commitProps`, and with an empty list from `prepareToRecycle` — a
     * recycled host that kept the previous run's link ranges would offer a
     * screen reader taps on text that is no longer there, the accessibility
     * cousin of the stale-selection failure that method exists to prevent.
     *
     * Value-compared like the prop setters on the host: Fabric re-delivers
     * the whole prop map on every commit, and `invalidateRoot` on every one
     * of them would be a stream of subtree-changed events at streaming rate.
     */
    fun setNodes(value: List<RunAccessibilityNode>) {
        if (value == nodes) return
        nodes = value
        collection = RunAccessibility.collectionOf(value)
        // Bounds are read live in onPopulateNodeForVirtualView, but the SET of
        // children is cached by the framework until it is invalidated. Costs
        // nothing when no accessibility service is running — the send is
        // gated on AccessibilityManager.isEnabled inside the helper.
        invalidateRoot()
    }

    /**
     * A run with no links and no block roles must look EXACTLY like the stock
     * TextView it is, so no provider is offered at all in that case — the
     * same choice React Native's ReactAccessibilityDelegate makes
     * (ReactAccessibilityDelegate.java:940-953), and the reason this delegate
     * can be installed unconditionally in the host's constructor instead of
     * being attached and detached as props change.
     */
    override fun getAccessibilityNodeProvider(host: View): AccessibilityNodeProviderCompat? {
        if (nodes.isEmpty()) return null
        return super.getAccessibilityNodeProvider(host)
    }

    /**
     * The host TextView's own node, which is where a `CollectionInfo` has to
     * go: `CollectionItemInfo` on an item means nothing to TalkBack without a
     * collection on an ancestor, and `ExploreByTouchHelper`'s virtual views
     * have exactly one — this view.
     *
     * ONE grid, the largest in the run (see `RunAccessibility.collectionOf`),
     * because one node cannot describe two. A run that is a single list or a
     * single table — the shape a flowed answer usually has — gets "item 2 of
     * 5" and "row 2, column 3" out of it, phrased by TalkBack in the reader's
     * own language; a run holding a list and a table announces the larger of
     * the two, and the other one's items keep their label and their focus
     * stop without a position.
     */
    @Suppress("DEPRECATION")
    override fun onPopulateNodeForHost(node: AccessibilityNodeInfoCompat) {
        super.onPopulateNodeForHost(node)
        val declared = collection ?: return
        node.setCollectionInfo(
            AccessibilityNodeInfoCompat.CollectionInfoCompat.obtain(
                declared.first,
                declared.second,
                // Not hierarchical: a nested list is a collection of its own
                // here and only one grid is ever declared, so this node never
                // stands for a tree.
                false,
            )
        )
    }

    /**
     * Explore-by-touch: which range is under the finger. Same offset lookup
     * and same guards as the host's `pressableAt` — a point past the end of a
     * short line must not "hit" the nearest character — with two extra rules:
     * a link inside a block role wins, because the link is the node that can
     * be activated and the role is only an announcement; and among block
     * roles the SHORTEST wins. Block roles do not overlap as JS sends them
     * today — an item's range stops where the construct inside it begins —
     * so that second rule is a guard rather than a working tiebreak, and the
     * answer it gives for an overlap is the more specific thing under the
     * finger.
     */
    override fun getVirtualViewAt(x: Float, y: Float): Int {
        if (nodes.isEmpty()) return ExploreByTouchHelper.INVALID_ID
        val offset = offsetAt(x, y) ?: return ExploreByTouchHelper.INVALID_ID
        var block = ExploreByTouchHelper.INVALID_ID
        var blockLength = Int.MAX_VALUE
        for (index in nodes.indices) {
            val node = nodes[index]
            if (offset < node.start || offset >= node.end) continue
            if (node.pressable != null) return index
            val length = node.end - node.start
            if (length < blockLength) {
                block = index
                blockLength = length
            }
        }
        return block
    }

    override fun getVisibleVirtualViews(virtualViewIds: MutableList<Int>) {
        for (index in nodes.indices) {
            virtualViewIds.add(index)
        }
    }

    /**
     * `setBoundsInParent` is deprecated on AccessibilityNodeInfoCompat and is
     * still the only bounds ExploreByTouchHelper reads: it throws if a child
     * node leaves them unset, and derives the screen bounds from them itself.
     */
    @Suppress("DEPRECATION")
    override fun onPopulateNodeForVirtualView(
        virtualViewId: Int,
        node: AccessibilityNodeInfoCompat,
    ) {
        val range = nodes.getOrNull(virtualViewId)
        val bounds = if (range == null) null else boundsFor(range)
        if (range == null || bounds == null) {
            // A range with no geometry — ellipsized away, or queried before
            // the first layout. It still needs a node with non-empty bounds
            // (the throw above), so it gets one with nothing to announce,
            // which is what makes a screen reader skip it.
            node.contentDescription = ""
            node.setBoundsInParent(Rect(0, 0, 1, 1))
            return
        }
        node.contentDescription = textOf(range)
        node.setBoundsInParent(bounds)
        if (range.pressable != null) {
            // No role description string: an untranslated one shipped by a
            // library is worse than the platform's own word for a button,
            // which every screen reader already says in the user's language.
            node.className = "android.widget.Button"
            node.isClickable = true
            node.addAction(AccessibilityNodeInfoCompat.ACTION_CLICK)
            return
        }
        if (range.role == RunAccessibility.ROLE_HEADING) {
            // Localised by the reader itself, and what TalkBack's
            // heading-by-heading navigation looks for.
            node.isHeading = true
            return
        }
        val row = range.row ?: return
        // Only for the grid the host declares: a position phrased against
        // another collection's total is a wrong announcement, where no
        // position at all is merely a missing one (`carriesItemInfo`).
        if (!RunAccessibility.carriesItemInfo(range, collection)) return
        // Zero-based here and ONE-based everywhere else: the wire uses 0 as
        // its absent sentinel, so the conversion has to happen somewhere and
        // this is the only place that wants a zero-based index.
        node.setCollectionItemInfo(
            AccessibilityNodeInfoCompat.CollectionItemInfoCompat.obtain(
                row - 1,
                1,
                (range.column ?: 1) - 1,
                1,
                // A GFM table's row 1 is its header row, always — that is a
                // property of the wire (see `roleRow` in
                // src/view/SelectableRunHostNativeComponent.ts), not a guess
                // about the styling. Flagging it is what lets TalkBack name
                // the column a cell is in, again in its own words.
                range.role == RunAccessibility.ROLE_TABLE_CELL && row == 1,
            )
        )
    }

    override fun onPerformActionForVirtualView(
        virtualViewId: Int,
        action: Int,
        arguments: Bundle?,
    ): Boolean {
        if (action != AccessibilityNodeInfoCompat.ACTION_CLICK) return false
        val pressable = nodes.getOrNull(virtualViewId)?.pressable ?: return false
        // The same emitter the gesture path calls: one clamp, one event, one
        // payload shape.
        onLinkActivated(pressable)
        return true
    }

    private fun textOf(range: RunAccessibilityNode): CharSequence {
        val text = textView.text ?: return ""
        val start = range.start.coerceIn(0, text.length)
        val end = range.end.coerceIn(start, text.length)
        if (end <= start) return ""
        return text.subSequence(start, end).toString()
    }

    /**
     * The range's focus rectangle in the TextView's own coordinates, or null
     * when the layout cannot place it.
     *
     * A RANGE THAT WRAPS GETS ITS FIRST LINE, whole. Two reasons, both
     * borrowed from React Native's version of this method: a screen reader
     * activates a node at the centre of its bounds, and the centre of a box
     * spanning two lines can sit outside the range entirely; and the
     * announcement is the content description, not the box, so a generous
     * first-line rectangle costs nothing. Taking the whole line rather than a
     * half-open piece of it is also what keeps this direction-agnostic — in
     * an RTL paragraph the range's leading edge is its right edge.
     */
    private fun boundsFor(range: RunAccessibilityNode): Rect? {
        val layout = textView.layout ?: return null
        val text = textView.text ?: return null
        val length = text.length
        val start = range.start.coerceIn(0, length)
        val end = range.end.coerceIn(start, length)
        if (end <= start) return null

        val firstLine = layout.getLineForOffset(start)
        val lastLine = layout.getLineForOffset(end - 1)
        val left: Float
        val right: Float
        if (firstLine == lastLine) {
            // An offset sitting exactly on a line break resolves to the NEXT
            // line's leading edge, which would give the range a box the width
            // of the paragraph; the line's visible end is the last offset
            // still on it.
            val endOnLine = minOf(end, layout.getLineVisibleEnd(firstLine))
            val startX = layout.getPrimaryHorizontal(start)
            val endX =
                if (endOnLine > start) layout.getPrimaryHorizontal(endOnLine) else startX
            left = minOf(startX, endX)
            right = maxOf(startX, endX)
        } else {
            left = layout.getLineLeft(firstLine)
            right = layout.getLineRight(firstLine)
        }

        val dx = textView.totalPaddingLeft - textView.scrollX
        val dy = textView.totalPaddingTop - textView.scrollY
        val top = layout.getLineTop(firstLine) + dy
        val bottom = layout.getLineBottom(firstLine) + dy
        if (bottom <= top) return null
        val boxLeft = floor(left).toInt() + dx
        val boxRight = ceil(right).toInt() + dx
        // Never empty: ExploreByTouchHelper treats unset/empty parent bounds
        // as a programming error.
        return Rect(boxLeft, top, maxOf(boxRight, boxLeft + 1), bottom)
    }

    /**
     * The text offset under a point in the TextView's coordinates, with the
     * guards `getLineForVertical` + `getOffsetForHorizontal` famously lack:
     * the point must lie inside the line's vertical band and its horizontal
     * extent, or a hover in the margin past a short line would "hit" the
     * nearest character. The host's `pressableAt` applies the identical rule
     * in its own coordinate space.
     */
    private fun offsetAt(x: Float, y: Float): Int? {
        val layout = textView.layout ?: return null
        val localX = x - textView.totalPaddingLeft + textView.scrollX
        val localY = y - textView.totalPaddingTop + textView.scrollY
        if (localY < 0f || localY > layout.height.toFloat()) return null
        val line = layout.getLineForVertical(localY.toInt())
        if (localY < layout.getLineTop(line).toFloat() ||
            localY >= layout.getLineBottom(line).toFloat()
        ) {
            return null
        }
        if (localX < layout.getLineLeft(line) || localX > layout.getLineRight(line)) return null
        return layout.getOffsetForHorizontal(line, localX)
    }
}
