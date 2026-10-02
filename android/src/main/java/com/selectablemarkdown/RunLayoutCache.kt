package com.selectablemarkdown

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.graphics.Typeface
import android.text.Spannable
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.yoga.YogaMeasureMode
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A bounded memo in front of the one string builder and the one layout
 * configuration — NOT a second path around them. Every entry in here was
 * produced by `RunAttributedText.build` / `RunTextMeasure.measure`, so a hit
 * returns byte-for-byte what a rebuild would have; the agreement doctrine in
 * `RunTextMeasure` is untouched, this just stops paying for it repeatedly.
 *
 * WHY IT EXISTS. A streamed message recommits its settled runs many times per
 * second unchanged, and both measure and `commitProps` rebuild. React Native's own
 * text stack solves this identically (TextLayoutManager's spannable cache plus
 * a TextMeasureCache keyed on the full layout constraints, capped at 1024).
 *
 * THE KEY CAPTURES EVERYTHING THE BUILD READS, and that list is load-bearing:
 *
 *  - `text` and the three spec lists — the inputs `RunAttributedText.build`
 *    styles. `Attribute`, `Decoration` and `Embed` are data classes, so
 *    `List.equals` is a deep value comparison and no equals/hashCode had to
 *    be added to the `Spec` wrappers (the key holds the lists, not the
 *    wrappers).
 *  - the window display metrics (`density`, `scaledDensity`), because build
 *    bakes them into the spans: every `AbsoluteSizeSpan` and every attribute
 *    `RunLineHeightSpan` goes through `PixelUtil.toPixelFromSP` (reads
 *    `scaledDensity`), and every margin, tab stop and embed size through
 *    `toPixelFromDIP` (reads `density`),
 *    both off `DisplayMetricsHolder.getWindowDisplayMetrics()`.
 *    A FONT-SCALE CHANGE MUST MISS THE CACHE: without the metrics in the key,
 *    every run after an accessibility font-size change would keep rendering
 *    and measuring at the previous scale, silently, until eviction happened
 *    to reach it. Density is in the key for the same reason (fold/unfold,
 *    display switch).
 *
 * INVALIDATION. There is none, deliberately: keys carrying the old metrics
 * simply stop being asked for and age out of the LRU, and a text/attribute
 * change is a different key by construction. Nothing in here can serve a
 * stale entry — it can only waste a slot on one. (`clear`, wired to
 * onTrimMemory, is memory reclamation, not invalidation: every entry is pure
 * derived data, so dropping all of them costs rebuilds and nothing else.)
 *
 * THREADING. `RunTextMeasure.measure` runs on the layout thread, or the UI
 * thread for a synchronous commit; `commitProps` runs on the UI thread.
 * Every map access is synchronized on the map — including gets, because with
 * `accessOrder = true` a get reorders the map. The lock is also what safely
 * publishes a built Spannable across threads; after `build` returns, nothing
 * writes to it (see `styledText` for why the TextView cannot either), so
 * concurrent readers are safe.
 */
internal object RunLayoutCache {

    /**
     * ~128 distinct styled runs is several screens of transcript; a measure
     * entry is a boxed Long, so that map is allowed twice the entries because
     * one run is commonly measured under more than one constraint pair.
     */
    private const val SPANNABLE_ENTRIES = 128
    private const val MEASURE_ENTRIES = 256

    /**
     * THE ENTRY CAPS ALONE ARE NOT A MEMORY BOUND, because an entry's weight
     * is its text and a run's text is a document, not a <Text> fragment (which
     * is what React Native's own 1024-entry caches deal in). Streaming makes
     * almost every insertion a one-shot key: the tail run's `text` grows on
     * every delta commit, and `segmentRuns` merges settled blocks into one run
     * whose text can span the whole settled document — so without a byte
     * budget the maps fill with up to 128/256 HISTORICAL snapshots of
     * document-scale strings (the Spannable holds the full text, and every
     * MeasureKey retains its Key's full text String), tens of MB that nothing
     * releases until 128/256 FUTURE distinct builds age them out.
     *
     * So each map also carries a char budget (UTF-16 units — bytes/2) and
     * evicts eldest-first past it. 1M chars ≈ 2MB of text per map holds a
     * large live working set — the current merged settled run, the current
     * tail, and slack — while the churn of one-shot streaming keys evicts
     * old snapshots instead of accumulating them. The budget, not the entry
     * cap, is the standing bound; it is also what keeps this singleton's
     * retention harmless across ReactInstance teardown (at most the budget
     * survives, and the trim hook below reclaims it under pressure). A text
     * longer than the whole budget could never fit — inserting it would evict
     * everything and then itself — so both maps refuse it outright.
     */
    private const val SPANNABLE_BUDGET_CHARS = 1L shl 20
    private const val MEASURE_BUDGET_CHARS = 1L shl 20

    /** Everything `RunAttributedText.build` and `configurePaint` read.
     * `localeTag` is in the key because the paint's `textLocale` (set in
     * `configurePaint` from `Locale.getDefault()`) moves line-break and
     * metric decisions for CJK scripts: a locale change with an unchanged
     * key would serve a layout measured under the previous locale.
     * `embeds` is in the key because `build` bakes each reservation into a
     * `RunEmbedSpan`: an embed whose declared size changed under unchanged
     * text would otherwise be served the previous size's spannable for as
     * long as the LRU kept it. */
    internal data class Key(
        val text: String,
        val attributes: List<RunAttributedText.Attribute>,
        val decorations: List<RunDecorations.Decoration>,
        val embeds: List<RunEmbeds.Embed>,
        /** Every SP conversion in `build` and `configurePaint` goes through it. */
        val scaling: RunFontScaling,
        val density: Float,
        val scaledDensity: Float,
        val localeTag: String,
        val typefaces: List<Typeface>,
    )

    /**
     * The FULL constraint tuple, not just the wrap width, and that is a
     * correctness point: under EXACTLY the returned layout width is the
     * incoming float, which `wrapWidth = layoutWidth.toInt()` truncates —
     * widths 411.4 and 411.7 share a wrap width but must report themselves
     * back, and the height clamp depends on `height`/`heightMode`. React
     * Native's TextMeasureCache keys on the same four values for the same
     * reason. Yoga passes NaN for UNDEFINED constraints; a data class
     * compares Floats by bits (Float.compare / floatToIntBits), so NaN keys
     * hash and match consistently.
     */
    private data class MeasureKey(
        val key: Key,
        val width: Float,
        val widthMode: YogaMeasureMode,
        val height: Float,
        val heightMode: YogaMeasureMode,
    )

    /** accessOrder LinkedHashMap is the platform's own LRU idiom (LruCache is
     * built on the same mode), but eviction is a loop in `putBudgeted` rather
     * than `removeEldestEntry`, because that hook can shed only one entry per
     * put and the byte budget can demand several (one document-scale insert
     * displaces many small entries). LruCache's sizeOf/trimToSize is the
     * pattern being restated here, with `charsOf(key)` as the weigher —
     * charging the KEY's text is what also bounds the measure map, whose
     * values are boxed Longs but whose MeasureKeys retain full texts. Callers
     * hold the map's monitor around every access, including gets (accessOrder
     * makes a get a reorder) and the accounting field. 16 / 0.75f are
     * LinkedHashMap's own defaults, restated because the three-argument
     * constructor is the only one that takes accessOrder. */
    private class LruMap<K, V>(
        private val maxEntries: Int,
        private val maxChars: Long,
        private val charsOf: (K) -> Int,
    ) : LinkedHashMap<K, V>(16, 0.75f, true) {
        private var chars = 0L

        fun putBudgeted(key: K, value: V) {
            if (put(key, value) == null) {
                // Overwrite of a live key (the two-thread build race) keeps
                // the accounting: equal keys have equal texts by construction.
                chars += charsOf(key)
            }
            // The just-put entry is MRU under accessOrder, so this walks
            // eldest-first and cannot evict it (oversize texts were refused
            // before reaching here).
            val eldest = entries.iterator()
            while (size > maxEntries || chars > maxChars) {
                chars -= charsOf(eldest.next().key)
                eldest.remove()
            }
        }

        override fun clear() {
            super.clear()
            chars = 0L
        }
    }

    private val spannables =
        LruMap<Key, Spannable>(SPANNABLE_ENTRIES, SPANNABLE_BUDGET_CHARS) { it.text.length }
    private val measurements =
        LruMap<MeasureKey, Long>(MEASURE_ENTRIES, MEASURE_BUDGET_CHARS) { it.key.text.length }

    /**
     * Drop every entry, from any thread. Correctness-neutral by the
     * invalidation argument above — everything here is a memo of a pure
     * build — so it is safe to wire to memory pressure, and `installTrimHook`
     * does exactly that.
     */
    internal fun clear() {
        synchronized(spannables) { spannables.clear() }
        synchronized(measurements) { measurements.clear() }
    }

    private val trimHookInstalled = AtomicBoolean(false)

    /**
     * Registers a trim-memory callback that empties both maps, once per
     * process. Called from `SelectableRunHostViewManager.createViewInstance`
     * because that is the earliest point this component holds a Context; the
     * callback registers on the APPLICATION context deliberately, so it —
     * like this singleton — outlives every ReactInstance and keeps reclaiming
     * the (budget-bounded) retention after teardown. RUNNING_MODERATE is the
     * one level not acted on; from RUNNING_LOW up, and on the legacy
     * onLowMemory, a cache whose worst case is "rebuild what is asked for
     * next" has no business holding megabytes.
     */
    internal fun installTrimHook(context: Context) {
        if (!trimHookInstalled.compareAndSet(false, true)) return
        context.applicationContext.registerComponentCallbacks(object : ComponentCallbacks2 {
            override fun onTrimMemory(level: Int) {
                if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) clear()
            }

            override fun onConfigurationChanged(newConfig: Configuration) = Unit

            override fun onLowMemory() = clear()
        })
    }

    /**
     * `scaledDensity` is deprecated on API 34 in favour of non-linear font
     * scaling, but it is still what `PixelUtil.toPixelFromSP` resolves
     * through (`TypedValue.applyDimension(COMPLEX_UNIT_SP, …)`), and on 34+
     * it still moves whenever the font-scale setting moves — the curve
     * changed, not the token — so it remains a valid change detector.
     * `getWindowDisplayMetrics` throws before React Native initializes it,
     * which is the same precondition every `PixelUtil` call in `build`
     * already has; no view or shadow node exists before then.
     */
    @Suppress("DEPRECATION")
    internal fun key(
        text: String,
        attributes: RunAttributedText.Spec,
        decorations: RunDecorations.Spec,
        embeds: RunEmbeds.Spec,
        scaling: RunFontScaling = RunFontScaling.DEFAULT,
    ): Key {
        val metrics = DisplayMetricsHolder.getWindowDisplayMetrics()
        return Key(
            text,
            attributes.layoutAttributes,
            decorations.decorations,
            embeds.embeds,
            scaling,
            metrics.density,
            metrics.scaledDensity,
            Locale.getDefault().toLanguageTag(),
            resolvedTypefaces(attributes.layoutAttributes),
        )
    }

    /**
     * True while the live inputs still match what `key` captured. The window
     * between `key()` and a build/measure is not atomic: a font-scale,
     * density, or locale change inside it would produce content that does
     * not match its key, and caching that entry would serve the wrong
     * content for as long as the LRU keeps it. Callers check this before a
     * put and skip caching on a mismatch — the work is returned uncached,
     * which is the pre-cache behaviour and costs only the one rebuild.
     */
    @Suppress("DEPRECATION") // scaledDensity: same rationale as key() above.
    private fun keyIsCurrent(key: Key): Boolean {
        val metrics = DisplayMetricsHolder.getWindowDisplayMetrics()
        return key.density == metrics.density &&
            key.scaledDensity == metrics.scaledDensity &&
            key.localeTag == Locale.getDefault().toLanguageTag() &&
            key.typefaces == resolvedTypefaces(key.attributes)
    }

    private fun resolvedTypefaces(attributes: List<RunAttributedText.Attribute>): List<Typeface> =
        attributes.mapNotNull { attribute ->
            attribute.fontFamily?.let { RunTypefaces.resolve(it, attribute.fontWeight ?: 400, attribute.italic) }
        }

    /**
     * The styled string for a key: cached, or built by the one builder and
     * cached. Both the measure paths and the view come through here, which is
     * what turns "one builder, called twice" into "one builder, called once
     * per distinct run" — the instance measured on the layout thread is the
     * instance the TextView is handed.
     *
     * SHARING THE INSTANCE IS SAFE BECAUSE NOTHING WRITES TO IT AFTER BUILD.
     * Every span is set inside `RunAttributedText.build`; StaticLayout and
     * `Layout.getDesiredWidth` only read. The one plausible mutator is
     * `TextView.setText`, and it never keeps a Spanned it is given: with the
     * SPANNABLE buffer type (a selectable TextView, this host's default) it
     * copies through `Spannable.Factory.newSpannable` — a fresh
     * SpannableString — and with the NORMAL buffer (the non-selectable
     * streaming tail) `TextUtils.stringOrSpannedString` copies into a
     * SpannedString. Selection spans and the TextView's ChangeWatcher
     * therefore land on the widget's private copy, never on the cached
     * instance the measure threads are concurrently reading. If either half
     * of that ever changes — a custom Spannable.Factory, or a buffer type
     * set on the child — the view path must copy before setText.
     *
     * A build race (two threads missing on the same key) builds twice and
     * keeps the first put, so every consumer converges on one instance.
     */
    internal fun styledText(key: Key): Spannable {
        if (key.text.isEmpty()) {
            // build() has its own empty fast path; caching one trivial entry
            // per metrics token would only spend slots.
            return RunAttributedText.build(key.text, RunAttributedText.Spec.EMPTY)
        }
        if (key.text.length > SPANNABLE_BUDGET_CHARS) {
            // Oversize refusal (see the budget constants): a text that cannot
            // fit is built and handed back uncached, which is the pre-cache
            // behaviour — each consumer builds its own instance — and costs
            // only the duplicate build, never a wrong result.
            return RunAttributedText.build(
                key.text,
                RunAttributedText.Spec(key.attributes),
                RunDecorations.Spec(key.decorations),
                RunEmbeds.Spec(key.embeds),
                key.scaling,
            )
        }
        synchronized(spannables) { spannables[key] }?.let { return it }
        val built = RunAttributedText.build(
            key.text,
            RunAttributedText.Spec(key.attributes),
            RunDecorations.Spec(key.decorations),
            RunEmbeds.Spec(key.embeds),
            key.scaling,
        )
        // Built under inputs that no longer match the key (metrics or locale
        // moved mid-build): hand it back uncached rather than poison the map.
        if (!keyIsCurrent(key)) return built
        synchronized(spannables) {
            spannables[key]?.let { return it }
            spannables.putBudgeted(key, built)
        }
        return built
    }

    /** A previously measured Yoga output (pixels, packed by
     * `YogaMeasureOutput.make`) for these exact constraints, or null. */
    internal fun measurement(
        key: Key,
        width: Float,
        widthMode: YogaMeasureMode,
        height: Float,
        heightMode: YogaMeasureMode,
    ): Long? {
        // Oversize refusal, mirrored on the get: putMeasurement never admits
        // such a key, so the lookup could only miss.
        if (key.text.length > MEASURE_BUDGET_CHARS) return null
        return synchronized(measurements) {
            measurements[MeasureKey(key, width, widthMode, height, heightMode)]
        }
    }

    internal fun putMeasurement(
        key: Key,
        width: Float,
        widthMode: YogaMeasureMode,
        height: Float,
        heightMode: YogaMeasureMode,
        output: Long,
    ) {
        // The value is a packed Long, but the MeasureKey retains the Key and
        // its full text String — the weigher charges exactly that, and an
        // over-budget text is refused here like in styledText.
        if (key.text.length > MEASURE_BUDGET_CHARS) return
        // Same mid-flight-change guard as styledText's put: a measurement
        // taken under inputs the key no longer describes must not be cached.
        if (!keyIsCurrent(key)) return
        synchronized(measurements) {
            measurements.putBudgeted(MeasureKey(key, width, widthMode, height, heightMode), output)
        }
    }
}
