package com.selectablemarkdown

import android.graphics.Paint
import android.text.Layout
import android.text.Spannable
import android.text.TextPaint
import android.text.style.LeadingMarginSpan
import android.text.style.LineHeightSpan
import android.text.style.TabStopSpan
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.uimanager.PixelUtil
import kotlin.math.ceil

/**
 * The `decorations` prop: block chrome for one run — the code block's box,
 * the table's border, row rules and aligned columns, the thematic break's
 * rule. See src/view/runDecorations.ts for where the entries come from and
 * docs/SELECTION.md for the wire contract.
 *
 * One prop, two consumers, split by what each part of a decoration is:
 *
 *  - the LAYOUT-AFFECTING parts — a box's `textInset`, the whole 'columns'
 *    kind, and the whole 'indent' kind (list indentation) — are applied to
 *    the spannable here, from `RunAttributedText.build`, as real spans
 *    (LeadingMarginSpan, TabStopSpan). They move where glyphs sit, so they
 *    must exist in the string both the TextView draws and the measure path
 *    lays out — the same one-builder discipline that file documents.
 *  - the DRAWN parts — boxes and rules — never touch the string at all.
 *    `SelectableRunHostView` keeps the parsed list and paints them in its
 *    own onDraw, behind the child TextView.
 *
 * Parsing follows `RunAttributedText.parse` exactly: total (malformed
 * entries and kinds this binary does not know are skipped, never thrown), on
 * arrival (a ReadableArray is bridge-owned memory), into plain values.
 * Dimensions stay in dp until the point of use, like every other prop.
 */
object RunDecorations {

    internal data class Decoration(
        val start: Int,
        val end: Int,
        val kind: String,
        /** Box fill / rule colour, packed 0xAARRGGBB from JS's processColor. */
        val color: Int?,
        val borderColor: Int?,
        val borderWidth: Float,
        val borderRadius: Float,
        val topCornersOnly: Boolean,
        /** Blockquote bar: a stripe at the box's leading edge, painted in its
         * own sweep above every fill and independent of the box's own (a
         * bar-only quote has no fill). Draw-only — the quote body's inset
         * arrives in separate 'indent' entries, not through this or the
         * quote box's `textInset`. */
        val barColor: Int?,
        val barWidth: Float,
        val paddingTop: Float,
        val paddingBottom: Float,
        val textInset: Float,
        val hang: Float,
        val thickness: Float,
        val alignTop: Boolean,
        val inset: Float,
        val gap: Float,
        /** 'columns' only: interior row-boundary padding, in dp — see
         * `RunDecoration.rowPaddingV` (runDecorations.ts). */
        val rowPaddingV: Float,
    )

    class Spec internal constructor(internal val decorations: List<Decoration>) {
        companion object {
            val EMPTY = Spec(emptyList())
        }
    }

    fun parse(source: ReadableArray?): Spec {
        if (source == null || source.size() == 0) return Spec.EMPTY
        val parsed = ArrayList<Decoration>(source.size())
        for (index in 0 until source.size()) {
            if (source.getType(index) != ReadableType.Map) continue
            val entry = source.getMap(index) ?: continue
            val decoration = parseEntry(entry) ?: continue
            parsed.add(decoration)
        }
        return Spec(parsed)
    }

    private fun parseEntry(entry: ReadableMap): Decoration? {
        val start = optInt(entry, "start") ?: return null
        val end = optInt(entry, "end") ?: return null
        val kind = optString(entry, "kind") ?: return null
        if (start < 0 || end < start) return null
        return Decoration(
            start = start,
            end = end,
            kind = kind,
            color = optInt(entry, "color"),
            borderColor = optInt(entry, "borderColor"),
            borderWidth = optFloat(entry, "borderWidth"),
            borderRadius = optFloat(entry, "borderRadius"),
            topCornersOnly = optString(entry, "corners") == "top",
            barColor = optInt(entry, "barColor"),
            barWidth = optFloat(entry, "barWidth"),
            paddingTop = optFloat(entry, "paddingTop"),
            paddingBottom = optFloat(entry, "paddingBottom"),
            textInset = optFloat(entry, "textInset"),
            hang = optFloat(entry, "hang"),
            thickness = optFloat(entry, "thickness"),
            alignTop = optString(entry, "align") == "top",
            inset = optFloat(entry, "inset"),
            gap = optFloat(entry, "gap"),
            rowPaddingV = optFloat(entry, "rowPaddingV"),
        )
    }

    /**
     * The vertical room a run needs BEYOND its own text, in **dp**: `top`
     * above its first line, `bottom` below its last.
     *
     * WHY A RUN-EDGE BOX IS DIFFERENT FROM EVERY OTHER BOX. A box's
     * `paddingTop`/`paddingBottom` normally costs no height at all, because
     * the projection separates blocks with '\n\n' (docs/SELECTION.md) and the
     * padding is painted into the blank line that leaves. A box at the EDGE
     * of a run has no such line to borrow: a table that closes an answer ends
     * at the run's last character, so its bottom border would land on the
     * baseline of its last row, and a code block that opens one starts at
     * offset 0, so its top border would be drawn through its first line.
     * Neither is a corner case — "here is a table" as the closing block of a
     * model's answer is the ordinary shape.
     *
     * ONE FUNCTION, TWO CALLERS, WHICH IS THE POINT. `RunTextMeasure.measure`
     * adds `top + bottom` to the height it reports, so the view Fabric frames
     * is that much taller; `SelectableRunHostView` sets the same two values
     * as the child TextView's vertical padding, so the text is drawn inside
     * the room that was measured for it and every `totalPaddingTop` in that
     * file follows it. Deriving them twice would be the measure/draw
     * disagreement `RunTextMeasure`'s header exists to prevent.
     *
     * LARGEST WINS, NOT THE SUM: boxes that share an edge (an island inside a
     * blockquote, both starting at offset 0) are drawn from that same edge,
     * so the room the deepest padding needs is the room they all need.
     *
     * Offsets are clamped against `textLength` exactly as `applyLayoutSpans`
     * and the draw path clamp them, so a stale offset from a newer JS bundle
     * asks for room at an edge it actually reaches. Returns 0/0 for the
     * ordinary run, in which case the view is exactly as tall as its text.
     */
    internal fun edgePaddingDp(spec: Spec, textLength: Int): EdgePadding {
        if (spec.decorations.isEmpty() || textLength <= 0) return EdgePadding.NONE
        var top = 0f
        var bottom = 0f
        for (decoration in spec.decorations) {
            if (decoration.kind != "box") continue
            val start = decoration.start.coerceIn(0, textLength)
            val end = decoration.end.coerceIn(start, textLength)
            if (end <= start) continue
            if (start == 0) top = maxOf(top, decoration.paddingTop)
            if (end == textLength) bottom = maxOf(bottom, decoration.paddingBottom)
        }
        if (top <= 0f && bottom <= 0f) return EdgePadding.NONE
        return EdgePadding(top, bottom)
    }

    /** The result of `edgePaddingDp`, in dp. */
    internal data class EdgePadding(val top: Float, val bottom: Float) {
        companion object {
            val NONE = EdgePadding(0f, 0f)
        }
    }

    /**
     * `edgePaddingDp` in WHOLE PIXELS, which is the form both of its consumers
     * have to use.
     *
     * WHY THE ROUNDING LIVES HERE AND NOT AT EACH CALL SITE. The two sides of
     * this contract are `RunTextMeasure.measure`, which adds the room to the
     * height Fabric frames the host with, and `SelectableRunHostView
     * .commitProps`, which sets the same room as the child TextView's
     * padding — and `View.setPadding` takes an Int. The measure side used to
     * add the un-truncated float while the view truncated it, so the drawn
     * band could sit up to a pixel short of the room reserved for it: two
     * derivations of one number that the comments on both sides claimed were
     * one. Converting once, here, is what makes that claim true.
     *
     * ROUNDED UP, not truncated: the padding is the room a border needs to
     * clear the text, and a fraction of a pixel short is a border drawn on the
     * glyphs. A whole pixel of slack at the bottom of a run is invisible.
     */
    internal fun edgePaddingPx(spec: Spec, textLength: Int): EdgePaddingPx {
        val dp = edgePaddingDp(spec, textLength)
        if (dp.top <= 0f && dp.bottom <= 0f) return EdgePaddingPx.NONE
        return EdgePaddingPx(
            ceil(PixelUtil.toPixelFromDIP(dp.top)).toInt(),
            ceil(PixelUtil.toPixelFromDIP(dp.bottom)).toInt(),
        )
    }

    /** The result of `edgePaddingPx`, in whole pixels. */
    internal data class EdgePaddingPx(val top: Int, val bottom: Int) {
        companion object {
            val NONE = EdgePaddingPx(0, 0)
        }
    }

    /**
     * The layout-affecting half, applied to the spannable the one builder
     * produced — after the attribute spans, deliberately: tab-stop columns
     * are computed by measuring cell substrings, and a cell must be measured
     * in the font its spans gave it (a bold header cell is wider than its
     * body-weight text, and the column has to fit it).
     */
    internal fun applyLayoutSpans(out: Spannable, spec: Spec, paint: TextPaint) {
        if (spec.decorations.isEmpty()) return
        val length = out.length
        val flags = Spannable.SPAN_EXCLUSIVE_EXCLUSIVE
        for (decoration in spec.decorations) {
            val start = decoration.start.coerceIn(0, length)
            val end = decoration.end.coerceIn(start, length)
            if (end <= start) continue
            when (decoration.kind) {
                "box" -> {
                    if (decoration.textInset > 0f) {
                        // Leading margin only: Android has no trailing-margin
                        // span, so a box's right padding exists only where the
                        // text happens not to reach — a wrapped code line can
                        // touch the box's right edge. The documented, accepted
                        // asymmetry with iOS (which insets both sides).
                        val margin = PixelUtil.toPixelFromDIP(decoration.textInset).toInt()
                        out.setSpan(LeadingMarginSpan.Standard(margin), start, end, flags)
                    }
                }
                "columns" -> {
                    applyTabColumns(out, start, end, decoration, paint)
                    // Independent of the tab stops (which bail for a
                    // one-column table): a single-column table still pads
                    // its rows.
                    if (decoration.rowPaddingV > 0f) {
                        applyRowPadding(out, start, end, decoration.rowPaddingV)
                    }
                }
                "indent" -> {
                    // List indentation: first lines at `textInset` (the
                    // marker column), wrapped lines `hang` deeper so they
                    // hang under the item's text rather than its bullet.
                    // LeadingMarginSpans covering one paragraph are ADDITIVE
                    // on this platform, which is exactly why JS guarantees
                    // these ranges are disjoint from each other and from
                    // every box's `textInset` range (runDecorations.ts,
                    // `listIndentSegments`) — one span per paragraph, so the
                    // sum IS the value, and Android agrees with iOS's
                    // assign-once paragraph styles.
                    val first = PixelUtil.toPixelFromDIP(decoration.textInset).toInt()
                    val rest = first + PixelUtil.toPixelFromDIP(decoration.hang).toInt()
                    if (first > 0 || rest > 0) {
                        out.setSpan(LeadingMarginSpan.Standard(first, rest), start, end, flags)
                    }
                }
                // 'rule' and unknown (newer-JS) kinds have no layout half.
            }
        }
    }

    /**
     * Tab stops for one 'columns' range: the widest cell of each
     * tab-separated column plus the entry's gap, accumulated. Stops are
     * relative to the start of the line's text — after any leading margin —
     * which is why, unlike iOS (where NSTextTab measures from the container
     * edge), the entry's `textInset` is NOT added here.
     */
    private fun applyTabColumns(
        out: Spannable,
        start: Int,
        end: Int,
        decoration: Decoration,
        paint: TextPaint,
    ) {
        val columnWidths = ArrayList<Float>()
        var rowStart = start
        while (rowStart <= end) {
            var rowEnd = rowStart
            while (rowEnd < end && out[rowEnd] != '\n') rowEnd += 1

            var cellStart = rowStart
            var column = 0
            while (cellStart <= rowEnd) {
                var cellEnd = cellStart
                while (cellEnd < rowEnd && out[cellEnd] != '\t') cellEnd += 1
                val width = if (cellEnd > cellStart) {
                    ceil(Layout.getDesiredWidth(out, cellStart, cellEnd, paint).toDouble()).toFloat()
                } else {
                    0f
                }
                if (column < columnWidths.size) {
                    if (width > columnWidths[column]) columnWidths[column] = width
                } else {
                    columnWidths.add(width)
                }
                if (cellEnd >= rowEnd) break
                cellStart = cellEnd + 1
                column += 1
            }

            if (rowEnd >= end) break
            rowStart = rowEnd + 1
        }

        if (columnWidths.size < 2) return

        val gap = PixelUtil.toPixelFromDIP(decoration.gap)
        val flags = Spannable.SPAN_EXCLUSIVE_EXCLUSIVE
        var location = 0f
        for (width in columnWidths) {
            location += width + gap
            out.setSpan(TabStopSpan.Standard(location.toInt()), start, end, flags)
        }
    }

    /**
     * Interior row padding for one 'columns' range: extra line height at the
     * row boundaries INSIDE the range — below every row but the last, above
     * every row but the first — so each boundary opens by twice the padding
     * and the row rule (drawn at the following row's `getLineTop`, which the
     * padded ascent moves up to the boundary's midpoint) sits centred in the
     * gap. Interior-only, mirroring iOS's paragraph-spacing application in
     * RNSMAttributedText.mm: the table's OUTER padding stays on the box
     * decoration's paddingTop/paddingBottom, painted into the
     * block-separator slack.
     *
     * One span per row, with the row's bounds baked in, because
     * `LineHeightSpan.chooseHeight` runs per line and only the line's own
     * offsets identify it: a wrapped row pads its first and last lines only,
     * so a long cell's continuation lines keep the base leading — the same
     * property iOS gets from paragraph spacing for free.
     */
    private fun applyRowPadding(out: Spannable, start: Int, end: Int, paddingDp: Float) {
        val padding = PixelUtil.toPixelFromDIP(paddingDp).toInt()
        if (padding <= 0) return
        val flags = Spannable.SPAN_EXCLUSIVE_EXCLUSIVE
        var rowStart = start
        while (rowStart <= end) {
            var rowEnd = rowStart
            while (rowEnd < end && out[rowEnd] != '\n') rowEnd += 1
            val isFirstRow = rowStart == start
            val isLastRow = rowEnd >= end
            if (rowEnd > rowStart && (!isFirstRow || !isLastRow)) {
                out.setSpan(
                    RunRowPaddingSpan(
                        paddingPx = padding,
                        rowStart = rowStart,
                        rowEnd = rowEnd,
                        padTop = !isFirstRow,
                        padBottom = !isLastRow,
                    ),
                    rowStart,
                    rowEnd,
                    flags,
                )
            }
            if (rowEnd >= end) break
            rowStart = rowEnd + 1
        }
    }

    private fun optString(entry: ReadableMap, key: String): String? =
        if (entry.hasKey(key) && entry.getType(key) == ReadableType.String) {
            entry.getString(key)
        } else {
            null
        }

    private fun optFloat(entry: ReadableMap, key: String): Float =
        if (entry.hasKey(key) && entry.getType(key) == ReadableType.Number) {
            entry.getDouble(key).toFloat()
        } else {
            0f
        }

    /** Through Long, like RunAttributedText.optInt: packed colours arrive as
     * the signed 32-bit pattern and a Double->Int would saturate. */
    private fun optInt(entry: ReadableMap, key: String): Int? =
        if (entry.hasKey(key) && entry.getType(key) == ReadableType.Number) {
            entry.getDouble(key).toLong().toInt()
        } else {
            null
        }
}

/**
 * Pads one table row's first and/or last line — see
 * `RunDecorations.applyRowPadding` for the geometry and why it is
 * interior-only.
 *
 * Runs AFTER `RunLineHeightSpan` by insertion order (attribute spans are set
 * before decoration spans in `RunAttributedText.build`, and `getSpans`
 * returns equal-priority spans in insertion order), which is load-bearing:
 * that span ASSIGNS the line's metrics wholesale, so a padding adjustment
 * applied before it would be silently erased. Adjusting `top`/`ascent` and
 * `bottom`/`descent` in pairs keeps the padded region inside the line the
 * way `RunLineHeightSpan`'s own surplus split does, so `getLineTop` of the
 * padded line moves by exactly the padding — which is what centres the row
 * rule drawn at that boundary.
 */
internal class RunRowPaddingSpan(
    private val paddingPx: Int,
    private val rowStart: Int,
    private val rowEnd: Int,
    private val padTop: Boolean,
    private val padBottom: Boolean,
) : LineHeightSpan {

    override fun chooseHeight(
        text: CharSequence?,
        start: Int,
        end: Int,
        spanstartv: Int,
        v: Int,
        fm: Paint.FontMetricsInt
    ) {
        // The row's first line is the one containing `rowStart`; its last is
        // the one whose end passes `rowEnd` (the line includes the row's
        // terminating '\n', so a wrapped row's interior lines end at or
        // before `rowEnd` and stay untouched).
        if (padTop && start <= rowStart) {
            fm.top -= paddingPx
            fm.ascent -= paddingPx
        }
        if (padBottom && end > rowEnd) {
            fm.bottom += paddingPx
            fm.descent += paddingPx
        }
    }
}
