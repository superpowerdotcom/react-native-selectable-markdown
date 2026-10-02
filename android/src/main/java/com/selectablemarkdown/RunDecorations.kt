package com.selectablemarkdown

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.text.Layout
import android.text.Spannable
import android.text.Spanned
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.LeadingMarginSpan
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan
import android.text.style.ReplacementSpan
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
        /** 'chip' only: horizontal room on each side, in dp. */
        val paddingH: Float,
        /** 'chip' and 'marker': least advance, in dp. */
        val minWidth: Float,
        /** 'marker' only: dot diameter, in dp. */
        val dotSize: Float,
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
            paddingH = optFloat(entry, "paddingH"),
            minWidth = optFloat(entry, "minWidth"),
            dotSize = optFloat(entry, "dotSize"),
        )
    }

    /**
     * Room in dp for a box at a run's edge, which has no '\n\n' blank line to paint its padding into.
     * Largest wins, not the sum: boxes sharing an edge are drawn from it.
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

    internal data class EdgePadding(val top: Float, val bottom: Float) {
        companion object {
            val NONE = EdgePadding(0f, 0f)
        }
    }

    /** Rounded up once here so the measured height and the view's Int padding agree; short by a fraction, a border lands on the glyphs. */
    internal fun edgePaddingPx(spec: Spec, textLength: Int): EdgePaddingPx {
        val dp = edgePaddingDp(spec, textLength)
        if (dp.top <= 0f && dp.bottom <= 0f) return EdgePaddingPx.NONE
        return EdgePaddingPx(
            ceil(PixelUtil.toPixelFromDIP(dp.top)).toInt(),
            ceil(PixelUtil.toPixelFromDIP(dp.bottom)).toInt(),
        )
    }

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
                "chip" -> out.setSpan(
                    RunChipSpan(
                        PixelUtil.toPixelFromDIP(decoration.paddingH),
                        PixelUtil.toPixelFromDIP(decoration.minWidth),
                        paint,
                    ),
                    start,
                    end,
                    flags,
                )
                "marker" -> {
                    val paragraphStart = lastNewlineBefore(out, start) + 1
                    val paragraphEnd = nextNewlineFrom(out, start)
                    val rtl = TextDirectionHeuristics.FIRSTSTRONG_LTR
                        .isRtl(out, paragraphStart, paragraphEnd - paragraphStart)
                    out.setSpan(
                        RunMarkerSpan(
                            PixelUtil.toPixelFromDIP(decoration.minWidth),
                            PixelUtil.toPixelFromDIP(decoration.dotSize),
                            decoration.color,
                            rtl,
                        ),
                        start,
                        end,
                        flags,
                    )
                }
                "spacing" -> if (decoration.paddingBottom > 0f) {
                    applyParagraphSpacing(out, end, decoration.paddingBottom)
                }
                // 'rule' and unknown (newer-JS) kinds have no layout half.
            }
        }
    }

    private fun lastNewlineBefore(text: CharSequence, offset: Int): Int {
        var index = offset - 1
        while (index >= 0 && text[index] != '\n') index -= 1
        return index
    }

    private fun nextNewlineFrom(text: CharSequence, offset: Int): Int {
        var index = offset
        while (index < text.length && text[index] != '\n') index += 1
        return index
    }

    /**
     * 'spacing': the bottom half of the row-padding mechanism on the paragraph
     * holding the range's last character, so it composes with line heights
     * exactly as `rowPaddingV` does (after `RunLineHeightSpan` by insertion order).
     */
    private fun applyParagraphSpacing(out: Spannable, end: Int, paddingDp: Float) {
        val padding = PixelUtil.toPixelFromDIP(paddingDp).toInt()
        if (padding <= 0 || end <= 0) return
        val last = end - 1
        // A '\n' at `last` terminates the paragraph it belongs to.
        val paragraphEnd = if (out[last] == '\n') last else nextNewlineFrom(out, last)
        val paragraphStart = lastNewlineBefore(out, paragraphEnd) + 1
        // The last paragraph of the text has no line past `paragraphEnd` to pad; JS never sends it.
        if (paragraphEnd >= out.length) return
        out.setSpan(
            RunRowPaddingSpan(
                paddingPx = padding,
                rowStart = paragraphStart,
                rowEnd = paragraphEnd,
                padTop = false,
                padBottom = true,
            ),
            paragraphStart,
            paragraphEnd + 1,
            Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
    }

    /**
     * A chip's painted rect in layout coordinates, or false when the range
     * carries no `RunChipSpan` (prop skew) or has not laid out. `scratch` is
     * overwritten: it is re-styled with the range's metric spans, the same
     * ones the span's own `getSize` was measured under.
     */
    internal fun chipRect(
        layout: Layout,
        text: Spanned,
        decoration: Decoration,
        basePaint: TextPaint,
        scratch: TextPaint,
        out: RectF,
    ): Boolean {
        val length = text.length
        val start = decoration.start.coerceIn(0, length)
        val end = decoration.end.coerceIn(start, length)
        if (end <= start) return false
        val chip = text.getSpans(start, end, RunChipSpan::class.java).firstOrNull {
            text.getSpanStart(it) == start && text.getSpanEnd(it) == end
        } ?: return false
        styleLike(text, start, end, basePaint, scratch)
        val width = chip.getSize(scratch, text, start, end, null).toFloat()
        val line = layout.getLineForOffset(start)
        val x = layout.getPrimaryHorizontal(start)
        val left = if (layout.isRtlCharAt(start)) x - width else x
        val baseline = layout.getLineBaseline(line).toFloat()
        val metrics = scratch.fontMetrics
        out.set(
            left,
            baseline + metrics.ascent - PixelUtil.toPixelFromDIP(decoration.paddingTop),
            left + width,
            baseline + metrics.descent + PixelUtil.toPixelFromDIP(decoration.paddingBottom),
        )
        return true
    }

    /** `paint` as the text stack would style `[start, end)` for measuring: metric spans in insertion order. */
    internal fun styleLike(text: Spanned, start: Int, end: Int, base: TextPaint, paint: TextPaint) {
        paint.set(base)
        for (span in text.getSpans(start, end, MetricAffectingSpan::class.java)) {
            if (span is ReplacementSpan) continue
            if (text.getSpanStart(span) > start || text.getSpanEnd(span) <= start) continue
            span.updateMeasureState(paint)
        }
    }

    /**
     * Layout and TextLine split a `ReplacementSpan` at every metric-span
     * boundary inside it and ask each piece separately. Only the piece at the
     * span's own start answers, for the whole range: its end is returned, and
     * -1 for a continuation piece (zero width, draws nothing).
     */
    internal fun replacementEnd(span: Any, text: CharSequence?, start: Int, end: Int): Int {
        if (text !is Spanned) return end
        val spanStart = text.getSpanStart(span)
        if (spanStart < 0) return end
        if (start > spanStart) return -1
        return maxOf(end, text.getSpanEnd(span))
    }

    /** ReplacementSpan bypasses character styles, including backgrounds and ordinary decoration lines. */
    internal fun drawReplacementText(
        canvas: Canvas, text: CharSequence, start: Int, end: Int,
        x: Float, top: Int, baseline: Int, bottom: Int, base: Paint, paint: TextPaint,
    ) {
        val spanned = text as? Spanned
        val rtl = TextDirectionHeuristics.FIRSTSTRONG_LTR.isRtl(text, start, end - start)
        val width = base.getRunAdvance(text, start, end, start, end, rtl, end)
        var from = start
        while (from < end) {
            val to = spanned?.nextSpanTransition(from, end, CharacterStyle::class.java) ?: end
            paint.set(base)
            paint.bgColor = 0
            if (spanned != null) {
                for (span in spanned.getSpans(from, to, CharacterStyle::class.java)) {
                    if (span !is MetricAffectingSpan) span.updateDrawState(paint)
                }
            }
            val lead = base.getRunAdvance(text, start, end, start, end, rtl, from)
            val trail = base.getRunAdvance(text, start, end, start, end, rtl, to)
            val left = x + if (rtl) width - trail else lead
            val right = x + if (rtl) width - lead else trail
            if (paint.bgColor != 0) {
                val foreground = paint.color
                paint.color = paint.bgColor
                canvas.drawRect(left, top.toFloat(), right, bottom.toFloat(), paint)
                paint.color = foreground
            }
            canvas.drawTextRun(text, from, to, start, end, left, baseline.toFloat(), rtl, paint)
            from = to
        }
    }

    /**
     * `out` styled as the text stack styles one span run `[from, to)` of a
     * replacement range: `base` (the paint the span was handed, which already
     * carries the metric spans at the range's start) with its metric state
     * reset to `unstyled`, then every span covering the run applied, except
     * replacement spans. `draw` picks draw state (colours, backgrounds) over
     * measure state; metric spans update both identically here.
     */
    internal fun styleRun(
        text: Spanned?, from: Int, to: Int, base: Paint, unstyled: TextPaint, out: TextPaint, draw: Boolean,
    ) {
        if (base is TextPaint) out.set(base) else out.set(base)
        out.textSize = unstyled.textSize
        out.typeface = unstyled.typeface
        out.letterSpacing = unstyled.letterSpacing
        out.textSkewX = unstyled.textSkewX
        out.textScaleX = unstyled.textScaleX
        out.isFakeBoldText = unstyled.isFakeBoldText
        out.baselineShift = unstyled.baselineShift
        out.bgColor = 0
        if (text == null) return
        for (span in text.getSpans(from, to, CharacterStyle::class.java)) {
            if (span is ReplacementSpan) continue
            if (text.getSpanStart(span) > from || text.getSpanEnd(span) < to) continue
            if (span is MetricAffectingSpan) {
                if (draw) span.updateDrawState(out) else span.updateMeasureState(out)
            } else if (draw) {
                span.updateDrawState(out)
            }
        }
    }

    /** The innermost foreground colour over `start`, which a `ReplacementSpan`'s paint never receives. */
    internal fun foregroundAt(text: CharSequence?, start: Int, end: Int, fallback: Int): Int {
        if (text !is Spanned) return fallback
        var color = fallback
        for (span in text.getSpans(start, end, ForegroundColorSpan::class.java)) {
            if (text.getSpanStart(span) <= start && text.getSpanEnd(span) > start) {
                color = span.foregroundColor
            }
        }
        return color
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

/**
 * A 'chip': reserves `paddingH` on each side (and `minWidth`'s shortfall,
 * split evenly) so the chip never overlaps its neighbours, and draws the text
 * centred. The fill and border are painted by the host behind the text
 * (`SelectableRunHostView`), where its pressed state can paint over the fill.
 * Atomic, so a chip never breaks across lines.
 */
internal class RunChipSpan(
    private val paddingHPx: Float,
    private val minWidthPx: Float,
    unstyled: TextPaint,
) : ReplacementSpan() {

    /** The run's base paint before any span: per-run styling starts from its metric state. Read-only. */
    private val unstyled = TextPaint(unstyled)

    /** UI-thread only: `draw` never runs on the measure path. */
    private val drawPaint = TextPaint(TextPaint.ANTI_ALIAS_FLAG)

    override fun getSize(
        paint: Paint,
        text: CharSequence?,
        start: Int,
        end: Int,
        fm: Paint.FontMetricsInt?,
    ): Int {
        if (fm != null) paint.getFontMetricsInt(fm)
        val full = RunDecorations.replacementEnd(this, text, start, end)
        if (full < 0) return 0
        val textWidth = if (text == null) 0f else textWidth(paint, text, start, full, measurePaint.get()!!)
        return ceil(maxOf(minWidthPx, textWidth + 2f * paddingHPx).toDouble()).toInt()
    }

    /** The chip's text measured run by run, so nested marks (a bold word, a size) keep their widths. */
    private fun textWidth(base: Paint, text: CharSequence, start: Int, end: Int, scratch: TextPaint): Float {
        val spanned = text as? Spanned
        var width = 0f
        var from = start
        while (from < end) {
            val to = spanned?.nextSpanTransition(from, end, CharacterStyle::class.java) ?: end
            RunDecorations.styleRun(spanned, from, to, base, unstyled, scratch, draw = false)
            width += scratch.measureText(text, from, to)
            from = to
        }
        return width
    }

    override fun draw(
        canvas: Canvas,
        text: CharSequence?,
        start: Int,
        end: Int,
        x: Float,
        top: Int,
        y: Int,
        bottom: Int,
        paint: Paint,
    ) {
        if (text == null) return
        val full = RunDecorations.replacementEnd(this, text, start, end)
        if (full < 0) return
        val size = getSize(paint, text, start, end, null)
        val textWidth = textWidth(paint, text, start, full, drawPaint)
        val spanned = text as? Spanned
        val rtl = TextDirectionHeuristics.FIRSTSTRONG_LTR.isRtl(text, start, full - start)
        val left = x + (size - textWidth) / 2f
        var edge = if (rtl) left + textWidth else left
        var from = start
        while (from < full) {
            val to = spanned?.nextSpanTransition(from, full, CharacterStyle::class.java) ?: full
            RunDecorations.styleRun(spanned, from, to, paint, unstyled, drawPaint, draw = true)
            val width = drawPaint.measureText(text, from, to)
            val runLeft = if (rtl) edge - width else edge
            if (drawPaint.bgColor != 0) {
                val foreground = drawPaint.color
                drawPaint.color = drawPaint.bgColor
                canvas.drawRect(runLeft, top.toFloat(), runLeft + width, bottom.toFloat(), drawPaint)
                drawPaint.color = foreground
            }
            canvas.drawTextRun(text, from, to, from, to, runLeft, y.toFloat(), rtl, drawPaint)
            edge = if (rtl) edge - width else edge + width
            from = to
        }
    }

    private companion object {
        /** `getSize` runs on the measure thread(s) and the UI thread over the same cached span. */
        val measurePaint = object : ThreadLocal<TextPaint>() {
            override fun initialValue(): TextPaint = TextPaint(TextPaint.ANTI_ALIAS_FLAG)
        }
    }
}

/**
 * A list marker column: the marker glyphs take at least `minWidth`, drawn at
 * the leading edge, so an item's first-line text starts where its wrapped
 * lines hang. With a dot, the dot is drawn there too; JS hides the glyphs by
 * colour, so they still select and copy.
 */
internal class RunMarkerSpan(
    private val minWidthPx: Float,
    private val dotSizePx: Float,
    private val dotColor: Int?,
    private val rtl: Boolean,
) : ReplacementSpan() {

    private val drawPaint = TextPaint(TextPaint.ANTI_ALIAS_FLAG)
    private val xBounds = Rect()

    override fun getSize(
        paint: Paint,
        text: CharSequence?,
        start: Int,
        end: Int,
        fm: Paint.FontMetricsInt?,
    ): Int {
        if (fm != null) paint.getFontMetricsInt(fm)
        val full = RunDecorations.replacementEnd(this, text, start, end)
        if (full < 0) return 0
        val textWidth = if (text == null) 0f else paint.measureText(text, start, full)
        return ceil(maxOf(minWidthPx, textWidth).toDouble()).toInt()
    }

    override fun draw(
        canvas: Canvas,
        text: CharSequence?,
        start: Int,
        end: Int,
        x: Float,
        top: Int,
        y: Int,
        bottom: Int,
        paint: Paint,
    ) {
        if (text == null) return
        val full = RunDecorations.replacementEnd(this, text, start, end)
        if (full < 0) return
        val size = getSize(paint, text, start, end, null).toFloat()
        val textWidth = paint.measureText(text, start, full)
        val foreground = RunDecorations.foregroundAt(text, start, full, paint.color)
        RunDecorations.drawReplacementText(
            canvas, text, start, full, if (rtl) x + size - textWidth else x, top, y, bottom, paint, drawPaint,
        )
        if (dotSizePx <= 0f) return
        paint.getTextBounds("x", 0, 1, xBounds)
        val radius = dotSizePx / 2f
        drawPaint.color = dotColor ?: foreground
        drawPaint.style = Paint.Style.FILL
        canvas.drawCircle(
            if (rtl) x + size - radius else x + radius,
            y + xBounds.top / 2f,
            radius,
            drawPaint,
        )
    }
}
