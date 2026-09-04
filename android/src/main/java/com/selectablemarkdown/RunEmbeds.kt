package com.selectablemarkdown

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Spannable
import android.text.style.ReplacementSpan
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.uimanager.PixelUtil
import kotlin.math.max

/**
 * The `embeds` prop: reserved rectangles for one run — each a
 * `width` × `height` hole in the text layout at a U+FFFC placeholder
 * character JS projected there, over which the JS side absolutely positions
 * a consumer's React view. See src/view/runEmbeds.ts for where the entries
 * come from and docs/SELECTION.md for the wire contract.
 *
 * The host never learns what an embed IS. It reserves the space (the
 * layout-affecting half, applied to the spannable here as a
 * `RunEmbedSpan`), reports where the space landed (`onEmbedLayout`, from
 * `SelectableRunHostView.reportEmbedRects`), and echoes `embedId` back —
 * the same division of knowledge `pressables` uses for hrefs.
 *
 * Parsing follows `RunAttributedText.parse` exactly: total (malformed
 * entries are skipped, never thrown), on arrival (a ReadableArray is
 * bridge-owned memory), into plain values. Dimensions stay in dp until the
 * point of use, like every other prop.
 */
object RunEmbeds {

    internal data class Embed(
        /** UTF-16 offsets into the run text, end-exclusive; the wire
         * contract is `end == start + 1` (one U+FFFC), enforced in `parse`. */
        val start: Int,
        val end: Int,
        /** JS's identifier for the embed, echoed verbatim in the event. */
        val embedId: Int,
        val widthDp: Float,
        val heightDp: Float,
    )

    class Spec internal constructor(internal val embeds: List<Embed>) {
        companion object {
            val EMPTY = Spec(emptyList())
        }
    }

    fun parse(source: ReadableArray?): Spec {
        if (source == null || source.size() == 0) return Spec.EMPTY
        val parsed = ArrayList<Embed>(source.size())
        for (index in 0 until source.size()) {
            if (source.getType(index) != ReadableType.Map) continue
            val entry = source.getMap(index) ?: continue
            val embed = parseEntry(entry) ?: continue
            parsed.add(embed)
        }
        return if (parsed.isEmpty()) Spec.EMPTY else Spec(parsed)
    }

    private fun parseEntry(entry: ReadableMap): Embed? {
        val start = optInt(entry, "start") ?: return null
        val end = optInt(entry, "end") ?: return null
        val embedId = optInt(entry, "embedId") ?: return null
        val width = optFloat(entry, "width")
        val height = optFloat(entry, "height")
        // One placeholder character, a non-negative id, and a size that is
        // positive AND FINITE: anything else — including the 0.0 unset
        // sentinel the codegen struct documents — reserves nothing.
        //
        // Finiteness is tested outright rather than left to `<= 0f`, which is
        // false for both NaN and Infinity. NaN is JS's answer for a size
        // computed from a missing measurement and Infinity is its answer for
        // one divided by zero, and an infinite dp size does not degrade
        // gracefully downstream: `PixelUtil.toPixelFromDIP` keeps it infinite
        // and `toInt` saturates it to Int.MAX_VALUE, which would then be the
        // width of a ReplacementSpan inside a measure pass. The rule this
        // channel promises is that a bad entry reserves nothing.
        if (start < 0 || end != start + 1 || embedId < 0) return null
        if (!width.isFinite() || !height.isFinite()) return null
        if (width <= 0f || height <= 0f) return null
        return Embed(start, end, embedId, width, height)
    }

    /**
     * The line-height half of every reservation, set where the attribute it
     * stands in for was set — after the attribute spans, before the
     * decorations, whose row padding ADJUSTS whatever the line heights
     * assigned and would be erased by a line height set after it.
     *
     * BOTH HALVES OF ONE RESERVATION ARE DECODED IN ONE UNIT, which is the
     * whole reason this exists. A reservation is a width × height box in DIP,
     * but its height also rides `attributes` as a `lineHeight` over the same
     * placeholder (src/view/runAttributes.ts) — where `RunAttributedText.build`
     * decodes it as SP, because SP is the right unit for every OTHER line
     * height on the wire. Under a system font scale other than 1.0 the two
     * halves of one number then disagreed: at scale 0.85 the line band came
     * out 15% shorter than the box the overlay was told to draw, so the embed
     * hung over the line below it; at 1.3 the band was 30% taller than the
     * card, leaving a gap under it. A box is a box — it does not grow with the
     * reader's text-size setting, and neither does the space held open for it
     * — so the reservation's line height is re-decoded here through the same
     * `toPixelFromDIP` the box goes through, and JS's SP-decoded twin is
     * dropped.
     *
     * THE FLOOR IS WHY THE TWIN IS READ BEFORE IT IS DROPPED. A reservation
     * may raise a line to fit but must never shrink one — an inline chip
     * shorter than the prose around it would squash that prose — so what is
     * set here is the taller of the box and every line height already covering
     * the placeholder. That is the rule JS applies in points
     * (`Math.max(embed.content.height, floor)`), restated in pixels because
     * that is the only unit in which the two are comparable once the font
     * scale is in play. The twin is identified by RANGE, not identity: it is
     * the LAST line height covering exactly this one character, which is what
     * JS emits for it (attributes first, embeds appended last). Anything
     * wider — and any earlier exact-range entry, which is what a heading whose
     * entire text is this one embed produces — is prose leading, and counts
     * toward the floor instead.
     */
    internal fun applyLineHeights(out: Spannable, spec: Spec) {
        forEachReserved(out, spec) { embed ->
            var twin: RunLineHeightSpan? = null
            var floorPx = 0f
            for (span in out.getSpans(embed.start, embed.end, RunLineHeightSpan::class.java)) {
                if (out.getSpanStart(span) == embed.start && out.getSpanEnd(span) == embed.end) {
                    twin?.let { floorPx = max(floorPx, it.lineHeightPx.toFloat()) }
                    twin = span
                } else {
                    floorPx = max(floorPx, span.lineHeightPx.toFloat())
                }
            }
            twin?.let { out.removeSpan(it) }
            val heightPx = PixelUtil.toPixelFromDIP(embed.heightDp)
            out.setSpan(
                RunLineHeightSpan(max(heightPx, floorPx)),
                embed.start,
                embed.end,
                Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }
    }

    /**
     * The box half, applied to the spannable the one builder produced. Each
     * valid entry replaces its placeholder's glyph with a fixed
     * `width` × `height` box that draws nothing — the overlay paints.
     */
    internal fun applySpans(out: Spannable, spec: Spec) {
        forEachReserved(out, spec) { embed ->
            out.setSpan(
                RunEmbedSpan(
                    PixelUtil.toPixelFromDIP(embed.widthDp).toInt().coerceAtLeast(1),
                    PixelUtil.toPixelFromDIP(embed.heightDp).toInt().coerceAtLeast(1),
                ),
                embed.start,
                embed.end,
                Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }
    }

    /**
     * The entries that really reserve something, which is what both halves
     * above walk and what `SelectableRunHostView.reportEmbedRects` re-walks
     * before it reports a rect: an entry that reserved nothing must report
     * nothing.
     *
     * THE CHARACTER GUARD IS THE SKEW GUARD: a span is only set where the
     * text really carries U+FFFC. Offsets were computed against the text JS
     * sent, and under prop skew — or a malformed entry from a newer JS —
     * they can point at prose; replacing a real character with an invisible
     * box would corrupt what the reader sees, where skipping the entry only
     * costs the reservation.
     */
    private inline fun forEachReserved(out: Spannable, spec: Spec, body: (Embed) -> Unit) {
        if (spec.embeds.isEmpty()) return
        val length = out.length
        for (embed in spec.embeds) {
            if (embed.start >= length || embed.end > length) continue
            if (out[embed.start] != PLACEHOLDER) continue
            body(embed)
        }
    }

    /** U+FFFC OBJECT REPLACEMENT CHARACTER — `EMBED_PLACEHOLDER` in
     * src/selection/mapSelection.ts; the two must agree or every entry
     * fails the character guard above. */
    internal const val PLACEHOLDER = '￼'

    private fun optFloat(entry: ReadableMap, key: String): Float =
        if (entry.hasKey(key) && entry.getType(key) == ReadableType.Number) {
            entry.getDouble(key).toFloat()
        } else {
            0f
        }

    private fun optInt(entry: ReadableMap, key: String): Int? =
        if (entry.hasKey(key) && entry.getType(key) == ReadableType.Number) {
            entry.getDouble(key).toInt()
        } else {
            null
        }
}

/**
 * The reservation itself: a fixed-size, draw-nothing box in place of the
 * placeholder glyph.
 *
 * A `ReplacementSpan` is a `MetricAffectingSpan`, so `Layout.getDesiredWidth`
 * and `StaticLayout` both account for it — the measure paths and the
 * `TextView` read the one cached spannable this span was set on, which is
 * what keeps the measured hole and the drawn hole the same hole with no new
 * agreement machinery.
 *
 * HOW THE HEIGHT ACTUALLY LANDS. `getSize` asks for the height as ascent
 * (the box sits on the baseline, rising `heightPx` above it), but the final
 * line extents belong to the `LineHeightSpan`s: `RunEmbeds.applyLineHeights`
 * sets a `RunLineHeightSpan` of the same DIP-decoded height over this same
 * character, after every attribute line height, and insertion order is what
 * lets it raise the placeholder's line to fit the box (that function says why
 * the reservation decodes its own height rather than taking JS's SP-decoded
 * one, and what stops it shrinking a line). Where the line ends up taller
 * still — an inline chip inside taller prose leading — the surplus branch
 * redistributes the extra room evenly above and below the baseline, so the
 * baseline may sit mid-line, which is why `reportEmbedRects` anchors the
 * reported rect on `getLineTop` and never on baseline arithmetic against this
 * span's ascent.
 *
 * IMMUTABLE, AND THAT IS LOAD-BEARING: the spannable carrying this span is
 * shared across the measure thread and the widget (`RunLayoutCache.styledText`
 * documents the boundary), so a span that cached a measured rect in a field
 * would be a data race. Geometry is computed from the `Layout` at report
 * time instead. A data class, so the cache key's spannable inputs stay
 * value-comparable.
 */
internal data class RunEmbedSpan(
    private val widthPx: Int,
    private val heightPx: Int,
) : ReplacementSpan() {

    override fun getSize(
        paint: Paint,
        text: CharSequence?,
        start: Int,
        end: Int,
        fm: Paint.FontMetricsInt?,
    ): Int {
        if (fm != null) {
            fm.ascent = -heightPx
            fm.top = fm.ascent
            fm.descent = 0
            fm.bottom = 0
        }
        return widthPx
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
        // Nothing. The consumer's React view is overlaid on the reported
        // rect; this span only holds the space open.
    }
}
