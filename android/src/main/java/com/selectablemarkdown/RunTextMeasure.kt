package com.selectablemarkdown

import android.os.Build
import android.text.Layout
import android.text.Spannable
import android.text.StaticLayout
import android.text.TextPaint
import android.widget.TextView
import com.facebook.react.uimanager.PixelUtil
import com.facebook.yoga.YogaMeasureMode
import com.facebook.yoga.YogaMeasureOutput
import java.util.Locale
import kotlin.math.ceil

/**
 * The one place a run's text layout is configured, and the one place it is
 * measured.
 *
 * WHY THIS OBJECT EXISTS. Three separate things have to agree about how a run
 * lays out: the `TextView` that draws it, the paper shadow node that measures
 * it for Yoga on the shadow thread, and — under Fabric —
 * `SelectableRunHostViewManager.measure`, which the C++ shadow node calls
 * across JNI from the layout thread. If they disagree the symptom is not a
 * build error, it is text clipped at the bottom of a run: it looks like a
 * rendering bug, it gets worse with every extra line, and no test in this
 * repository can see it (docs/FABRIC-PLAN.md §4.3 specifies the instrumented
 * test that could, and says plainly that it cannot run here). So agreement is
 * not maintained by keeping three call sites in sync — there is one paint
 * configuration and one `StaticLayout` construction, and all three sides go
 * through this file. `RunAttributedText.build` is the matching guarantee for
 * the styled string itself. `RunLayoutCache` memoizes both and does not bend
 * any of this: it sits in FRONT of the one builder and this one measure,
 * never beside them, so a cache hit returns what the miss path would have
 * built from the same inputs.
 *
 * A FREE CONSEQUENCE WORTH STATING: because the paper shadow node and the
 * Fabric measure override call the same function with the same inputs, a run
 * does not change height when an app flips `newArchEnabled`. Whatever the two
 * architectures disagree about, it is not this.
 *
 * UNITS. Everything here is in **pixels**, on both architectures, and the two
 * architectures differ in what they want back — which is why converting is the
 * caller's job and not this object's:
 *
 *  - Paper's Yoga tree is itself in pixels (`LayoutShadowNode` pushes
 *    `PixelUtil.toPixelFromDIP` values into Yoga, and React Native's own
 *    `ReactTextShadowNode.measure` hands `StaticLayout` the incoming width
 *    unconverted and returns raw layout pixels). So the paper shadow node
 *    returns what `measure` returns, untouched.
 *  - Fabric's Yoga tree is in points. `FabricUIManager.measure` converts the
 *    constraints to pixels on the way in — `getYogaSize` is
 *    `PixelUtil.toPixelFromDIP(maxSize)`
 *    (fabric/mounting/LayoutMetricsConversions.kt) — and expects points back,
 *    which is why `TextLayoutManager.measureText` ends with
 *    `PixelUtil.toDIPFromPixel`. `SelectableRunHostViewManager.measure`
 *    therefore converts the result and says so.
 *
 * Getting that asymmetry wrong is not subtle in effect: on a 3x device every
 * run would report a height three times too large.
 */
internal object RunTextMeasure {

    /**
     * The fallback base text size, in SP — what a host mounted without
     * `attributes` at all renders at.
     *
     * In practice every run carries an `AbsoluteSizeSpan` covering its whole
     * length, because `resolveRunAttributes` always emits a base attribute
     * with `fontSize` (src/view/runAttributes.ts), and `baseTextSizeSp` below
     * reads that attribute back so the paint underneath the spans agrees
     * with them. This constant is the final fallback, not an assumption that
     * the theme's base size is 16.
     */
    const val TEXT_SIZE_SP = 16f

    /**
     * The base text size for one run, in SP: the base attribute's `fontSize`
     * when the run carries one, `TEXT_SIZE_SP` otherwise.
     *
     * The base attribute is the entry covering the run's whole text, and JS
     * emits it FIRST, before any mark (RunAttributedText.build relies on the
     * same ordering for line height) — so the first full-cover entry with a
     * `fontSize` is it, and a heading that happens to span the entire run
     * cannot win: its size belongs to its span, not to the paint beneath.
     * The paint's own size only shows where spans cannot reach — the phantom
     * last line after a trailing newline is the visible case — but a themed
     * base size must cover those too, or a run measures at one base and a
     * `fonts.baseSize` override at another.
     *
     * A pure function of (text, attributes), which are both already in
     * `RunLayoutCache.Key` — so deriving the size adds nothing to the key and
     * every cached entry was built under the size this returns for it.
     */
    fun baseTextSizeSp(text: String, spec: RunAttributedText.Spec): Float {
        for (attribute in spec.attributes) {
            val size = attribute.fontSizeSp ?: continue
            if (size > 0f && attribute.start <= 0 && attribute.end >= text.length) {
                return size
            }
        }
        return TEXT_SIZE_SP
    }

    /**
     * Line breaking, set explicitly on both sides because their defaults
     * differ and the difference is invisible until it isn't.
     * `StaticLayout.Builder` defaults to `BREAK_STRATEGY_SIMPLE`, while a
     * non-editable `TextView` defaults to `BREAK_STRATEGY_HIGH_QUALITY`; the
     * two put line breaks in different places for the same string and width,
     * so the measured line count and the drawn line count can differ by one.
     * React Native has the identical problem and solves it the identical way —
     * it sets both on `ReactTextView` and passes the same pair into the
     * `StaticLayout.Builder` (TextLayoutManager.java:373-376).
     *
     * The values are React Native's own defaults for `<Text>`
     * (TextAttributeProps.java:78-79), so the native host and the
     * `<Text selectable>` fallback in `renderers.tsx` break lines in the same
     * places. A run that reflows when the native module is linked is the
     * failure `runAttributes.ts` opens by describing.
     */
    private const val BREAK_STRATEGY = Layout.BREAK_STRATEGY_HIGH_QUALITY
    private const val HYPHENATION_FREQUENCY = Layout.HYPHENATION_FREQUENCY_NONE

    /**
     * Scratch paint for the measure path, one per thread rather than one per
     * call. Per thread because `measure` runs concurrently on paper's shadow
     * thread and Fabric's layout thread and TextPaint is not thread-safe;
     * never handed across threads or out of this function. `configurePaint`
     * re-runs on every measure because textSize derives from the window
     * metrics, which move under a font-scale or density change; nothing else
     * on the paint is ever written — span measurement inside StaticLayout and
     * `getDesiredWidth` applies spans to its own working copy, not to the
     * paint it was passed. React Native's TextLayoutManager keeps the same
     * thread-local scratch for the same reason. (`withInitial` needs API 26;
     * minSdk here is 23, hence the subclass.)
     */
    private val scratchPaint = object : ThreadLocal<TextPaint>() {
        override fun initialValue(): TextPaint = TextPaint(TextPaint.ANTI_ALIAS_FLAG)
    }

    /**
     * The single paint configuration.
     *
     * Sizing goes through `PixelUtil`, NOT through
     * `TextView.setTextSize(COMPLEX_UNIT_SP, …)`, and that is deliberate.
     * `PixelUtil.toPixelFromSP` reads `DisplayMetricsHolder`'s window metrics
     * (PixelUtil.kt), while `TextView.setTextSize` reads the metrics of its own
     * `Context`'s resources. The two are usually equal and are not required to
     * be — split-screen and a font-scale change are the ordinary ways they
     * diverge. `RunAttributedText.build` already sizes every `AbsoluteSizeSpan`
     * through `PixelUtil`, so routing the base paint through anything else
     * would mean a run with no `fontSize` attribute and a run with an explicit
     * 16sp one rendering at different sizes on the same screen.
     *
     * `baseSizeSp` is the run's derived base size (`baseTextSizeSp`); only a
     * caller with no run in hand — a freshly constructed view — takes the
     * fallback default.
     */
    fun configurePaint(paint: TextPaint, baseSizeSp: Float = TEXT_SIZE_SP) {
        paint.textSize = PixelUtil.toPixelFromSP(baseSizeSp)
        // Set explicitly on every configuration, measure side and view side
        // alike, for two reasons at once: the measure side's scratch paint is
        // thread-local and would otherwise freeze the locale it was created
        // under, and the view side would otherwise read its own Context's
        // configuration — a third source the measure side cannot see. CJK
        // line breaking follows textLocale, so the two sides disagreeing is
        // the clipped-text failure this object exists to prevent.
        // RunLayoutCache keys on the same Locale.getDefault(), so a locale
        // change misses the cache instead of serving the old layout.
        paint.textLocale = Locale.getDefault()
    }

    /**
     * The view side of the same configuration.
     *
     * `view.paint` is the live `TextPaint` the widget draws with, so this is
     * the same object `configurePaint` would be handed on the measure side
     * rather than a copy of its settings. It is called before any text is set,
     * where `TextView` has no internal `Layout` to invalidate — which is why
     * writing the paint directly is equivalent to `setTextSize` here and not a
     * shortcut around it.
     *
     * The three knobs below are the ones `measure` also sets on its
     * `StaticLayout`; they are set here and nowhere else so that "what the
     * view is configured with" and "what was measured" cannot drift apart in
     * a diff. `includeFontPadding` is `TextView`'s default and is stated
     * anyway, because the measure side has to name it explicitly and a default
     * that is only true on one side is not agreement.
     *
     * The line-spacing pair is set to the identity for a second reason beyond
     * agreement: leading is owned entirely by `RunLineHeightSpan`, driven by
     * the `lineHeight` attribute on the wire, and a non-zero `lineSpacingExtra`
     * here would add to it invisibly on the drawn side only.
     */
    fun configureTextView(view: TextView) {
        configurePaint(view.paint)
        view.includeFontPadding = true
        view.setLineSpacing(0f, 1f)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // Pre-M Android has one line-breaking algorithm and no way to
            // select another, so there is nothing to synchronise there and the
            // measure side leaves it alone for the same reason.
            view.breakStrategy = BREAK_STRATEGY
            view.hyphenationFrequency = HYPHENATION_FREQUENCY
        }
    }

    /**
     * The per-run half of the view-side configuration: re-derives the base
     * size from the props about to be committed, so the drawn side and the
     * measure side (which derives it from the same two values in `measure`)
     * cannot disagree. Written through the live paint like
     * `configureTextView`, and safe past the no-text window that function
     * relies on for a different reason: the base size can only change when
     * `text` or `attributes` changed by value, and `commitProps` follows
     * every such change with a `setText` that rebuilds the widget's layout
     * from the paint as written here.
     */
    fun updateTextViewBaseSize(view: TextView, text: String, spec: RunAttributedText.Spec) {
        configurePaint(view.paint, baseTextSizeSp(text, spec))
    }

    /**
     * Measure one run.
     *
     * `text` and `spec` are the same two values the view draws from, and they
     * are turned into the styled string by `RunAttributedText.build` — the
     * same call, not an equivalent one. `attributes` is not a rendering detail
     * that could be skipped for measurement: a heading is 1.6x the body size,
     * a code span uses a different family, and `lineHeight` sets the leading
     * of every line, so measuring the bare string would lay every styled run
     * out at the wrong height.
     *
     * Returns a Yoga measure output packed with `YogaMeasureOutput.make`, in
     * pixels — see the unit note on this object.
     */
    fun measure(
        text: String,
        spec: RunAttributedText.Spec,
        decorations: RunDecorations.Spec,
        width: Float,
        widthMode: YogaMeasureMode,
        height: Float,
        heightMode: YogaMeasureMode
    ): Long {
        if (text.isEmpty()) {
            return YogaMeasureOutput.make(0f, 0f)
        }

        // The cache consult. The key captures every input the styled string
        // and the paint read — text, both specs, and the window display
        // metrics — so a hit is exactly what the code below would have
        // produced; RunLayoutCache's header carries the argument, including
        // why the metrics must be in the key. Streaming recommits — Fabric
        // re-measures every run on every commit, paper's shadow node dirties
        // on every prop batch — arrive here with identical inputs and
        // identical constraints, and the second lookup turns that whole case
        // into a map get.
        val key = RunLayoutCache.key(text, spec, decorations)
        RunLayoutCache.measurement(key, width, widthMode, height, heightMode)?.let { return it }

        val paint = checkNotNull(scratchPaint.get())
        configurePaint(paint, baseTextSizeSp(text, spec))

        // The same styled string the view will draw — under RunLayoutCache,
        // now the same INSTANCE, not merely the same builder call. Its spans
        // are what make getDesiredWidth and StaticLayout account for heading
        // sizes, monospace runs and line height. `decorations` matters here
        // for the same reason `spec` does: leading margins and tab stops move
        // where lines wrap, so measuring without them would lay a table or a
        // code box out at the wrong height.
        val styled: Spannable = RunLayoutCache.styledText(key)

        val desired = ceil(Layout.getDesiredWidth(styled, paint).toDouble()).toFloat()
        val layoutWidth = when (widthMode) {
            YogaMeasureMode.EXACTLY -> width
            YogaMeasureMode.AT_MOST -> minOf(desired, width)
            else -> desired
        }
        val wrapWidth = layoutWidth.toInt().coerceAtLeast(1)

        val layout = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            StaticLayout.Builder
                .obtain(styled, 0, styled.length, paint, wrapWidth)
                .setAlignment(Layout.Alignment.ALIGN_NORMAL)
                .setLineSpacing(0f, 1f)
                .setIncludePad(true)
                .setBreakStrategy(BREAK_STRATEGY)
                .setHyphenationFrequency(HYPHENATION_FREQUENCY)
                .build()
        } else {
            // Pre-M: no builder and no break strategy to choose, on either
            // side. The remaining parameters are positional — width, alignment,
            // spacing multiplier, spacing add, includePad — and match the
            // builder call above knob for knob.
            @Suppress("DEPRECATION")
            StaticLayout(styled, paint, wrapWidth, Layout.Alignment.ALIGN_NORMAL, 1f, 0f, true)
        }

        val measuredHeight = when (heightMode) {
            YogaMeasureMode.EXACTLY -> height
            YogaMeasureMode.AT_MOST -> minOf(layout.height.toFloat(), height)
            else -> layout.height.toFloat()
        }
        val output = YogaMeasureOutput.make(layoutWidth, measuredHeight)
        RunLayoutCache.putMeasurement(key, width, widthMode, height, heightMode, output)
        return output
    }
}
