package com.selectablemarkdown

import android.graphics.Rect
import android.os.Bundle
import android.view.View
import android.view.KeyEvent
import android.widget.TextView
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.view.accessibility.AccessibilityNodeProviderCompat
import androidx.customview.widget.ExploreByTouchHelper
import kotlin.math.ceil
import kotlin.math.floor

/** A link when `pressable` is set, else a block role; row and column are one-based as on the wire. */
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
 * Only roles with a platform primitive exist, so the library ships no announcement strings.
 * A covered range is read twice, as in React Native's `<Text>` links: rewriting the TextView's
 * own announcement would cost its text navigation.
 */
internal object RunAccessibility {

    /** Mirrors `RunSemanticRole` in src/view/runAttributes.ts. */
    const val ROLE_HEADING = "heading"
    const val ROLE_LIST_ITEM = "listItem"
    const val ROLE_TABLE_CELL = "tableCell"

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
            // Under prop skew these offsets can run past the text in hand.
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
                    column = if (role == ROLE_TABLE_CELL) attribute.roleColumn else 1,
                    columnCount =
                        if (role == ROLE_TABLE_CELL) attribute.roleColumnCount else 1,
                )
            )
        }

        if (nodes.size > 1) {
            // A block role reads before a link starting at the same offset, as the document does.
            nodes.sortWith(
                compareBy<RunAccessibilityNode> { it.start }
                    .thenBy { if (it.pressable == null) 0 else 1 }
            )
        }
        return nodes
    }

    /** The largest real grid in `nodes`: the host TextView is the virtual views' only ancestor, so it can declare just one. */
    fun collectionOf(nodes: List<RunAccessibilityNode>): Pair<Int, Int>? {
        // Insertion order plus a stable sort breaks size ties by document order.
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

    /** The shape is a node's whole collection identity: nothing on the wire names the list an item belongs to. */
    private fun shapeOf(node: RunAccessibilityNode): Pair<Int, Int>? {
        if (node.row == null) return null
        val rows = node.rowCount ?: return null
        return Pair(rows, node.columnCount ?: 1)
    }

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

    /** A node of another grid would be phrased against the declared grid's total. */
    fun carriesItemInfo(node: RunAccessibilityNode, collection: Pair<Int, Int>?): Boolean {
        if (collection == null) return true
        return shapeOf(node) == collection
    }
}

/** TalkBack activates links with ACTION_CLICK, never the touches the host observes, so links need virtual views. */
internal class RunAccessibilityHelper(
    private val textView: TextView,
    private val onLinkActivated: (SelectableRunHostView.Pressable) -> Unit,
) : ExploreByTouchHelper(textView) {

    private var nodes: List<RunAccessibilityNode> = emptyList()

    private var collection: Pair<Int, Int>? = null

    fun setNodes(value: List<RunAccessibilityNode>) {
        // Fabric re-delivers every prop per commit; invalidating on each would flood events at streaming rate.
        if (value == nodes) return
        nodes = value
        collection = RunAccessibility.collectionOf(value)
        invalidateRoot()
    }

    /** No provider for a run without nodes, so it stays exactly a stock TextView. */
    override fun getAccessibilityNodeProvider(host: View): AccessibilityNodeProviderCompat? {
        if (nodes.isEmpty()) return null
        return super.getAccessibilityNodeProvider(host)
    }

    @Suppress("DEPRECATION")
    override fun onPopulateNodeForHost(node: AccessibilityNodeInfoCompat) {
        super.onPopulateNodeForHost(node)
        val declared = collection ?: return
        node.setCollectionInfo(
            AccessibilityNodeInfoCompat.CollectionInfoCompat.obtain(
                declared.first,
                declared.second,
                // Not hierarchical: only one flat grid is ever declared.
                false,
            )
        )
    }

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

    private var keyboardNavigation = false

    private inline fun <T> linksOnly(action: () -> T): T {
        keyboardNavigation = true
        return try { action() } finally { keyboardNavigation = false }
    }

    fun dispatchLinkKeyEvent(event: KeyEvent): Boolean = linksOnly { dispatchKeyEvent(event) }

    fun onHostFocusChanged(focused: Boolean, direction: Int, previous: Rect?) {
        linksOnly { onFocusChanged(focused, direction, previous) }
    }

    override fun getVisibleVirtualViews(virtualViewIds: MutableList<Int>) {
        for (index in nodes.indices) {
            if (keyboardNavigation && nodes[index].pressable == null) continue
            virtualViewIds.add(index)
        }
    }

    /** ExploreByTouchHelper reads only the deprecated `setBoundsInParent`, and throws when a child leaves it unset. */
    @Suppress("DEPRECATION")
    override fun onPopulateNodeForVirtualView(
        virtualViewId: Int,
        node: AccessibilityNodeInfoCompat,
    ) {
        val range = nodes.getOrNull(virtualViewId)
        val bounds = if (range == null) null else boundsFor(range)
        if (range == null || bounds == null) {
            // Ellipsized or not laid out yet: an empty description makes the reader skip it.
            node.contentDescription = ""
            node.setBoundsInParent(Rect(0, 0, 1, 1))
            return
        }
        node.contentDescription = textOf(range)
        bounds.offset(textView.scrollX, textView.scrollY)
        node.setBoundsInParent(bounds)
        if (range.pressable != null) {
            node.className = "android.widget.TextView"
            node.roleDescription = textView.context.getString(com.facebook.react.R.string.link_description)
            node.isClickable = true
            node.addAction(AccessibilityNodeInfoCompat.ACTION_CLICK)
            return
        }
        if (range.role == RunAccessibility.ROLE_HEADING) {
            node.isHeading = true
            return
        }
        val row = range.row ?: return
        if (!RunAccessibility.carriesItemInfo(range, collection)) return
        // CollectionItemInfo is zero-based; the wire is one-based because 0 is its absent sentinel.
        node.setCollectionItemInfo(
            AccessibilityNodeInfoCompat.CollectionItemInfoCompat.obtain(
                row - 1,
                1,
                (range.column ?: 1) - 1,
                1,
                // A GFM table's row 1 is always its header row.
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

    /** A wrapping range gets its whole first line: a reader activates at the centre, which a two-line box can miss. */
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
            // An offset on a line break resolves to the next line's leading edge.
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
        // ExploreByTouchHelper rejects empty bounds.
        return Rect(boxLeft, top, maxOf(boxRight, boxLeft + 1), bottom)
    }

    /** Bounded to the line's band and extent: `getOffsetForHorizontal` alone snaps a margin hover to the nearest character. */
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
