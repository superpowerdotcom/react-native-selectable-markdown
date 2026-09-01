package com.selectablemarkdown

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Spannable
import android.text.style.ReplacementSpan
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.uimanager.PixelUtil

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
        // One placeholder character, a non-negative id, and a positive size:
        // anything else — including the 0.0 unset sentinel the codegen
        // struct documents — reserves nothing.
        if (start < 0 || end != start + 1 || embedId < 0) return null
        if (width <= 0f || height <= 0f) return null
        return Embed(start, end, embedId, width, height)
    }

    /**
     * The layout-affecting half, applied to the spannable the one builder
     * produced. Each valid entry replaces its placeholder's glyph with a
     * fixed `width` × `height` box that draws nothing — the overlay paints.
     *
     * THE CHARACTER GUARD IS THE SKEW GUARD: a span is only set where the
     * text really carries U+FFFC. Offsets were computed against the text JS
     * sent, and under prop skew — or a malformed entry from a newer JS —
     * they can point at prose; replacing a real character with an invisible
     * box would corrupt what the reader sees, where skipping the entry only
     * costs the reservation.
     */
    internal fun applySpans(out: Spannable, spec: Spec) {
        if (spec.embeds.isEmpty()) return
        val length = out.length
        for (embed in spec.embeds) {
            if (embed.start >= length || embed.end > length) continue
            if (out[embed.start] != PLACEHOLDER) continue
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
 * line extents belong to the `LineHeightSpan`s: JS sends a `lineHeight`
 * attribute equal to the embed height over this same character, emitted
 * AFTER the base attribute, and `RunAttributedText.build`'s insertion-order
 * rule makes that `RunLineHeightSpan` the last word on the placeholder's
 * line. Its surplus branch redistributes extra room evenly above and below
 * the baseline, so the baseline may sit mid-line — which is why
 * `reportEmbedRects` anchors the reported rect on `getLineTop`, never on
 * baseline arithmetic against this span's ascent.
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
