package com.selectablemarkdown

import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.text.Spannable
import android.text.SpannableString
import android.text.TextPaint
import android.text.style.AbsoluteSizeSpan
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.uimanager.PixelUtil
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.min

/**
 * Turns the projected run text plus JS's styled ranges into a Spannable.
 *
 * WHY IT IS A SHARED OBJECT AND NOT A METHOD ON THE VIEW. Two things have to
 * agree about this string: the TextView that draws it, and the shadow node
 * that measures it for Yoga on the shadow thread. They run on different
 * threads and are constructed independently, so if each built its own styled
 * text they would drift — and the visible symptom of drift is the worst kind,
 * a run laid out at the wrong height with no error anywhere. One builder,
 * called twice, cannot disagree with itself.
 *
 * The parse is total: an entry that is malformed, out of range, or carries a
 * key this binary does not know is skipped, never thrown. A newer JS bundle
 * against an older native binary must degrade to less styling, never to a
 * crash inside a measure or draw pass.
 */
object RunAttributedText {

    /** Parsed form of one JS attribute entry; see src/view/runAttributes.ts.
     * `internal` rather than `private` because `Spec` carries a list of them
     * across the object boundary to the view and the shadow node. */
    internal data class Attribute(
        val start: Int,
        val end: Int,
        val fontFamily: String?,
        val fontSizeSp: Float?,
        val lineHeightSp: Float?,
        /** Numeric CSS weight (100..900; keywords normalized), null = the
         * range says nothing about weight. */
        val fontWeight: Int?,
        val italic: Boolean,
        val underline: Boolean,
        val strikethrough: Boolean,
        val color: Int?,
        val backgroundColor: Int?,
    )

    /**
     * A snapshot of the attribute list, decoupled from the `ReadableArray`
     * that carried it.
     *
     * A ReadableArray is a handle onto memory the bridge owns and may recycle
     * once the prop batch is done, so holding one across the shadow-thread
     * measure that happens later is a use-after-free waiting to happen. The
     * props are parsed once, on arrival, into this.
     */
    class Spec internal constructor(internal val attributes: List<Attribute>) {
        companion object {
            val EMPTY = Spec(emptyList())
        }
    }

    fun parse(source: ReadableArray?): Spec {
        if (source == null || source.size() == 0) return Spec.EMPTY
        val parsed = ArrayList<Attribute>(source.size())
        for (index in 0 until source.size()) {
            if (source.getType(index) != ReadableType.Map) continue
            val entry = source.getMap(index) ?: continue
            val attribute = parseEntry(entry) ?: continue
            parsed.add(attribute)
        }
        return Spec(parsed)
    }

    private fun parseEntry(entry: ReadableMap): Attribute? {
        // Read through getDouble even for the integer offsets: a JS number
        // crosses the bridge as a double, and getInt throws rather than
        // rounding when it finds one.
        val start = optInt(entry, "start") ?: return null
        val end = optInt(entry, "end") ?: return null
        val decoration = optString(entry, "textDecorationLine")
        return Attribute(
            start = start,
            end = end,
            fontFamily = optString(entry, "fontFamily"),
            fontSizeSp = if (entry.hasKey("fontSize") && entry.getType("fontSize") == ReadableType.Number) {
                entry.getDouble("fontSize").toFloat()
            } else {
                null
            },
            // SP, like fontSize, and for the same reason: JS sends an absolute
            // line height derived from the same base size, so the two have to
            // scale together under the system font scale or a run's leading
            // stops tracking its own type. React Native reads its own
            // TextStyle.lineHeight exactly this way when allowFontScaling is
            // on, which is the default (TextAttributeProps.setLineHeight).
            lineHeightSp = if (entry.hasKey("lineHeight") && entry.getType("lineHeight") == ReadableType.Number) {
                entry.getDouble("lineHeight").toFloat()
            } else {
                null
            },
            fontWeight = parseFontWeight(optString(entry, "fontWeight")),
            italic = optString(entry, "fontStyle") == "italic",
            underline = decoration == "underline",
            strikethrough = decoration == "line-through",
            // JS ran these through processColor, so they arrive as packed
            // 0xAARRGGBB integers — which is what lets a consumer theme use
            // any colour format React Native accepts.
            color = optInt(entry, "color"),
            backgroundColor = optInt(entry, "backgroundColor"),
        )
    }

    /**
     * The nine-value `fontWeight` scale, normalized to its numeric form.
     * From API 28 the real weight reaches the paint (`RunFontWeightSpan`,
     * matching the granular faces RN's own TextStyle resolves on the
     * fallback path); before that the span layer is trait-based
     * (StyleSpan BOLD) and the scale collapses to the CSS fallback rule —
     * 600 and up take the bold face, everything below stays regular.
     */
    private fun parseFontWeight(weight: String?): Int? = when (weight) {
        null -> null
        "bold" -> 700
        "normal" -> 400
        else -> weight.toIntOrNull()?.takeIf { it in 1..1000 }
    }

    private fun optString(entry: ReadableMap, key: String): String? =
        if (entry.hasKey(key) && entry.getType(key) == ReadableType.String) {
            entry.getString(key)
        } else {
            null
        }

    /**
     * `toLong().toInt()` rather than `toInt()`: a packed colour is a 32-bit
     * pattern, and React Native hands Android the signed form while iOS gets
     * the unsigned one. Going through Long truncates to the low 32 bits
     * either way, where a direct Double->Int would saturate an unsigned value
     * to Int.MAX_VALUE and paint the wrong colour.
     */
    private fun optInt(entry: ReadableMap, key: String): Int? =
        if (entry.hasKey(key) && entry.getType(key) == ReadableType.Number) {
            entry.getDouble(key).toLong().toInt()
        } else {
            null
        }

    /**
     * Build the styled text.
     *
     * Spans are added in list order and Android composes them the way the
     * contract needs: `StyleSpan` ORs its style into whatever the paint
     * already has, so bold inside an italic range renders bold-italic, while
     * colour and size spans simply let the later (inner) one win.
     *
     * Line height composes the same way for a subtler reason. StaticLayout
     * collects every `LineHeightSpan` covering a paragraph and calls
     * `chooseHeight` on each in turn, in the order `getSpans` returns them —
     * insertion order, since none of these spans carries a priority. JS emits
     * the base attribute first and marks after it, so a heading's line height
     * is applied last and wins over the body's for the heading's own lines,
     * which is exactly the "innermost construct wins" rule the rest of this
     * function follows. Block separation is what keeps that from leaking:
     * `mapSelection` joins blocks with '\n\n', so a heading is its own
     * paragraph and its span is not even offered to the paragraph below it.
     */
    fun build(
        text: String,
        spec: Spec,
        decorations: RunDecorations.Spec = RunDecorations.Spec.EMPTY,
    ): Spannable {
        val out = SpannableString(text)
        if (text.isEmpty()) return out
        for (attribute in spec.attributes) {
            // Clamp: offsets were computed against the text JS sent, which
            // under prop skew can differ in length from the text in hand.
            val start = attribute.start.coerceIn(0, text.length)
            val end = attribute.end.coerceIn(start, text.length)
            if (end <= start) continue
            val flags = Spannable.SPAN_EXCLUSIVE_EXCLUSIVE

            attribute.fontFamily?.let { out.setSpan(TypefaceSpan(it), start, end, flags) }
            attribute.fontSizeSp?.let {
                out.setSpan(
                    AbsoluteSizeSpan(PixelUtil.toPixelFromSP(it).toInt()),
                    start,
                    end,
                    flags,
                )
            }
            attribute.lineHeightSp?.let {
                out.setSpan(
                    RunLineHeightSpan(PixelUtil.toPixelFromSP(it)),
                    start,
                    end,
                    flags,
                )
            }
            attribute.fontWeight?.let { weight ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    out.setSpan(RunFontWeightSpan(weight), start, end, flags)
                } else if (weight >= 600) {
                    out.setSpan(StyleSpan(Typeface.BOLD), start, end, flags)
                }
            }
            if (attribute.italic) out.setSpan(StyleSpan(Typeface.ITALIC), start, end, flags)
            if (attribute.underline) out.setSpan(UnderlineSpan(), start, end, flags)
            if (attribute.strikethrough) out.setSpan(StrikethroughSpan(), start, end, flags)
            attribute.color?.let { out.setSpan(ForegroundColorSpan(it), start, end, flags) }
            attribute.backgroundColor?.let {
                out.setSpan(BackgroundColorSpan(it), start, end, flags)
            }
        }

        // The layout-affecting half of the decoration channel (leading
        // margins, tab-stop columns), after the attribute spans on purpose:
        // column widths are measured off `out`, so a cell must already carry
        // the font its spans give it. The paint is configured by the same
        // call both measure paths use, which is what keeps a cell measured
        // here the width it lays out at there.
        if (decorations.decorations.isNotEmpty()) {
            val paint = TextPaint(TextPaint.ANTI_ALIAS_FLAG)
            RunTextMeasure.configurePaint(paint, RunTextMeasure.baseTextSizeSp(text, spec))
            RunDecorations.applyLayoutSpans(out, decorations, paint)
        }
        return out
    }
}

/**
 * A real font weight on the paint's current typeface (API 28+; callers gate).
 *
 * WHY NOT StyleSpan(BOLD). The style layer is a two-value trait, so under it
 * the nine-weight `fontWeight` scale collapsed at the 600 cut: '500' rendered
 * indistinguishable from body text and '900' capped at plain bold, while the
 * `<Text>` fallback resolved the real intermediate faces through RN's own
 * TextStyle — the two render paths visibly disagreeing about the same theme
 * token. `Typeface.create(base, weight, italic)` picks the closest face the
 * family carries (synthesizing bold where none exists, as StyleSpan did).
 *
 * WHY IT READS THE PAINT rather than owning a family: spans compose in
 * insertion order and JS emits marks outermost-first, so by the time this
 * runs the paint already carries the family an enclosing mark set (a strong
 * span inside a code span must weight the MONO face). A TypefaceSpan built
 * around a fixed typeface would reset that family; mutating the paint's
 * current one composes, exactly the property StyleSpan's OR-ing had. Italic
 * is carried from the current face; a fake italic (skew) lives on the paint,
 * not the typeface, and is untouched.
 *
 * MetricAffectingSpan, because weight changes advance widths: both the
 * measure path and the draw path run it, which is what keeps the shadow
 * node's measurement and the TextView's drawing agreeing — the same
 * one-builder discipline as everything else in this file.
 */
internal class RunFontWeightSpan(private val weight: Int) : MetricAffectingSpan() {

    override fun updateMeasureState(paint: TextPaint) = update(paint)

    override fun updateDrawState(paint: TextPaint) = update(paint)

    private fun update(paint: TextPaint) {
        val base = paint.typeface ?: Typeface.DEFAULT
        paint.typeface = Typeface.create(base, weight, base.isItalic)
    }
}

/**
 * Absolute line height for the lines a range covers.
 *
 * WHY THIS IS WRITTEN HERE RATHER THAN IMPORTED. React Native ships exactly
 * this class — `CustomLineHeightSpan` — but it lives in
 * `com.facebook.react.views.text.internal.span`, a package whose name says
 * what it is. Depending on a symbol React Native has declared internal means a
 * minor upgrade can delete it, and the failure would be a
 * NoClassDefFoundError inside a measure pass on a device, in an app we do not
 * build. Twenty lines of our own cost less than that.
 *
 * WHY NOT `TextView.setLineSpacing`. Because it is the wrong shape twice over:
 * it is a view-wide setting, so it could not give a heading a different
 * leading from the paragraph beside it in the same run, and `lineSpacingExtra`
 * adds to the font's natural leading rather than setting an absolute height —
 * the long-standing bug React Native's own comment on `CustomLineHeightSpan`
 * points at (facebook/react-native#7546). `lineHeight` on the wire is
 * absolute, in the same unit as React Native's `TextStyle.lineHeight`, because
 * that is what the JS fallback puts on its `<Text>` and the two must not
 * disagree.
 *
 * THE ALGORITHM IS A PRIORITY ORDER, NOT A DISTRIBUTION. When the requested
 * height is smaller than the glyphs need, something has to be given up, and
 * dropping the wrong part is what produces clipped descenders — the ends of
 * 'g', 'y' and 'p' sliced off, which reads as a font bug. So the order is
 * descent first, then ascent, then bottom, then top: keep what sits below the
 * baseline, then what sits above it, then the extra leading the font asks for.
 * Only when the height is larger than the glyphs need is the surplus split,
 * and it is split evenly above and below so a line of text stays optically
 * centred in its own leading. This is the same prioritisation React Native
 * settled on, and matching it is the point: the native host and the
 * `<Text selectable>` fallback have to measure and draw the same height for
 * the same `lineHeight`.
 */
internal class RunLineHeightSpan(heightPx: Float) : LineHeightSpan {

    // Rounded up, once, at construction. StaticLayout works in whole pixels,
    // and rounding per line would let a run's height drift from the sum of its
    // line heights.
    private val lineHeight: Int = ceil(heightPx.toDouble()).toInt()

    override fun chooseHeight(
        text: CharSequence?,
        start: Int,
        end: Int,
        spanstartv: Int,
        v: Int,
        fm: Paint.FontMetricsInt
    ) {
        if (fm.descent > lineHeight) {
            // Not even the descent fits. Keep as much of it as there is room
            // for and give up everything above the baseline.
            fm.descent = min(lineHeight.toDouble(), fm.descent.toDouble()).toInt()
            fm.bottom = fm.descent
            fm.ascent = 0
            fm.top = fm.ascent
        } else if (-fm.ascent + fm.descent > lineHeight) {
            // The descent fits; keep all of it and as much ascent as is left.
            fm.bottom = fm.descent
            fm.ascent = -lineHeight + fm.descent
            fm.top = fm.ascent
        } else if (-fm.ascent + fm.bottom > lineHeight) {
            // Glyphs fit; the font's extra bottom leading does not, so trim it.
            fm.top = fm.ascent
            fm.bottom = fm.ascent + lineHeight
        } else if (-fm.top + fm.bottom > lineHeight) {
            // Only the font's extra top leading is left to trim.
            fm.top = fm.bottom - lineHeight
        } else {
            // There is room to spare: split it evenly above and below. Rounding
            // up on the negative side and down on the positive one makes
            // bottom - top come out to exactly the requested height even when
            // the surplus is odd, which is what keeps a run's measured height
            // equal to lineCount * lineHeight.
            val additional = lineHeight - (-fm.top + fm.bottom)
            val top = (fm.top - ceil(additional / 2.0f)).toInt()
            val bottom = (fm.bottom + floor(additional / 2.0f)).toInt()
            fm.top = top
            fm.ascent = top
            fm.descent = bottom
            fm.bottom = bottom
        }
    }
}
