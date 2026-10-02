package com.selectablemarkdown

import java.util.TreeMap

/** Disjoint decoration ranges, updated in wire order so inner styles replace inherited lines. */
internal class RunLineStyles(private val length: Int) {
    private data class Style(val line: String? = null, val style: String? = null, val color: Int? = null)
    internal data class Range(val start: Int, val end: Int, val line: String, val style: String?, val color: Int?)

    private val boundaries = TreeMap<Int, Style>().apply { put(0, Style()) }

    fun apply(start: Int, end: Int, line: String?, style: String?, color: Int?) {
        if (end <= start || (line == null && style == null && color == null)) return
        val after = boundaries.floorEntry(end).value
        val before = boundaries.floorEntry(start).value
        boundaries[start] = before
        boundaries[end] = after
        for (entry in boundaries.subMap(start, true, end, false).entries) {
            val inherited = entry.value
            val nextLine = line ?: inherited.line
            entry.setValue(Style(
                line = nextLine,
                style = if (line != null) style else if (nextLine != null) style ?: inherited.style else null,
                color = color ?: inherited.color,
            ))
        }
    }

    fun ranges(): List<Range> {
        val out = ArrayList<Range>()
        for ((start, value) in boundaries) {
            val end = boundaries.higherKey(start) ?: length
            val line = value.line
            if (end <= start || line == null || line == "none") continue
            val previous = out.lastOrNull()
            if (previous != null && previous.end == start && previous.line == line &&
                previous.style == value.style && previous.color == value.color) {
                out[out.lastIndex] = previous.copy(end = end)
            } else {
                out.add(Range(start, end, line, value.style, value.color))
            }
        }
        return out
    }
}
