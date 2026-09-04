package com.selectablemarkdown

import android.content.Context
import android.content.res.AssetManager
import android.graphics.Typeface
import com.facebook.react.common.assets.ReactFontManager

/**
 * Family name to `Typeface`, through React Native's font machinery instead of
 * Android's system font map.
 *
 * WHY THIS EXISTS AT ALL. `fontFamily` on the wire is a React Native family
 * name — the same string a consumer puts on a `<Text>` — and React Native
 * resolves those through `ReactFontManager`, which looks in
 * `assets/fonts/<family>[_bold|_italic|_bold_italic].ttf|.otf` and in the
 * `res/font` families an app registered with `addCustomFont`, falling back to
 * the system map only when neither has the name. The framework's
 * `TypefaceSpan(String)` resolves through `Typeface.create(name, style)`,
 * which knows the SYSTEM map and nothing else — so a bundled family rendered
 * in the default system face in the native run while the `<Text selectable>`
 * fallback (standalone blocks, code blocks, table cells) rendered it in the
 * real one. That is a visible split inside one message, and because the two
 * faces have different advance widths, a wrapping split too. The default
 * theme hid it: its Android families are 'sans-serif' and 'monospace', both
 * system names that resolve identically either way.
 *
 * THE ASSET MANAGER IS INSTALLED, NOT INJECTED, because the styled string is
 * built by a pure object on the layout thread with no Context in reach
 * (`RunAttributedText.build`). `SelectableRunHostViewManager` arms this from
 * both of the points where this component first holds one — `measure` (the
 * earliest, since Fabric measures before it mounts) and `createViewInstance`
 * — so no measurement can be taken before resolution works. The application
 * context is what is kept: an AssetManager outlives every ReactInstance, and
 * so does this singleton.
 *
 * RESOLUTION IS AT PAINT TIME, NOT BUILD TIME (see `RunTypefaceSpan`): the
 * spannable is cached by `RunLayoutCache`, and a baked `Typeface` would
 * outlive the reason it was chosen, while a family NAME re-resolves.
 *
 * NOTHING IS CACHED HERE, AND THAT IS THE FIX RATHER THAN AN OVERSIGHT.
 * `ReactFontManager` keeps its own cache — a `FontFamily` per family holding
 * one `Typeface` per style — and consults the `res/font` families an app
 * registered with `addCustomFont` BEFORE it looks at assets. A cache of our
 * own in front of it is therefore a second answer that can only ever go
 * stale: an app that registers a family lazily (a downloaded face, a theme
 * chosen after `Application.onCreate`) would have had the pre-registration
 * answer frozen in for the life of the process, and the `<Text selectable>`
 * fallback — which asks React Native every time — would render the same
 * `fontFamily` in a different face. That is exactly the split this file
 * exists to close, reintroduced one layer up.
 *
 * WHAT IT COSTS, stated honestly: a monitor acquisition plus two `HashMap`
 * lookups per call (the custom-font map, then the family cache), where the
 * cache made it a lock-free `ConcurrentHashMap` read with the monitor taken
 * only on a miss. That is a real move onto the hot path — this runs once per
 * face span per line per measure and per draw — and it is the price of the
 * `<Text>` fallback and this path never disagreeing about a lazily
 * registered family. React Native's own text stack calls `getTypeface` this
 * same way on every text update, and the alternative — verifying a cached
 * face against a fresh resolve — is the resolve.
 *
 * THE WEIGHT AND THE STYLE ARE ASKED FOR WITH THE FAMILY, IN ONE CALL, and
 * that is the second half of the same fix. React Native picks the face FILE
 * from the family and the weight together — `getTypeface(family, weight,
 * italic, assets)` builds a `TypefaceStyle`, whose `getNearestStyle()` maps
 * the CSS weight onto the `_bold` / `_italic` / `_bold_italic` file suffix —
 * so a family resolved at the wrong weight loads the wrong file. This object
 * used to be handed the weight the paint happened to carry, which for
 * `{ fontFamily: 'Inter', fontWeight: '700' }` was still 400 when the family
 * was resolved: `assets/fonts/Inter.ttf` came back and the bold was then
 * SYNTHESIZED on top of it, while the `<Text selectable>` fallback loaded
 * `assets/fonts/Inter_bold.ttf`. Different face, different advance widths,
 * different wrapping — the same split one level narrower. `RunTypefaceSpan`
 * now carries the weight and the italic of the range it covers, inheriting
 * whichever of the three the range does not state from the entries that cover
 * it, so both paths ask React Native the identical question.
 *
 * THE NINE-VALUE SCALE SURVIVES ON TOP OF THAT. An asset family only has four
 * files, so React Native answers a weight of 500 with the regular one and
 * stops there; `RunFontWeightSpan` (API 28+) then applies the real weight to
 * whatever face came back, which is a refinement the `<Text>` path does not
 * make for asset families and cannot change which FILE was loaded. The two
 * paths therefore agree about the face and this one is finer about the
 * weight, where before they disagreed about the face itself.
 *
 * THE LOCK IS AROUND REACT NATIVE'S CACHE. `ReactFontManager` keeps plain
 * `HashMap`s and is written for the UI thread; this object's callers are the
 * UI thread AND the layout thread, so its calls are serialized here. That
 * cannot stop React Native's own text stack from calling it concurrently from
 * a third thread — it is a narrowing, not a guarantee. The critical section is
 * two map lookups once a family has been resolved once, which is why holding
 * it on every call rather than only on a miss is affordable; `build` keeps
 * the number of calls down by setting a face span only where family, weight
 * or slant actually CHANGE from the range enclosing them.
 */
internal object RunTypefaces {

    /** CSS weights, in the numeric scale `RunAttributedText.parseFontWeight`
     * normalizes to. `WEIGHT_BOLD` is also the cut React Native's
     * `TypefaceStyle` uses when it picks a face file. */
    const val WEIGHT_NORMAL = 400
    const val WEIGHT_BOLD = 700

    @Volatile
    private var assets: AssetManager? = null

    /**
     * Arm family resolution. Idempotent and cheap enough to call on every
     * measure: after the first call it is one volatile read.
     */
    fun install(context: Context) {
        if (assets != null) return
        assets = context.applicationContext.assets
    }

    /**
     * The face for one family at one weight and slant, asked of React Native
     * every time — see the note above on why nothing is memoized here, and
     * why the three are one question and not two. Falls back to the system map
     * while no Context has reached this process yet. Never null: React
     * Native's resolver itself ends in `Typeface.create(family, style)`, which
     * answers the default face for a name it does not know.
     *
     * The CSS weight goes across whole rather than pre-collapsed: React
     * Native's `TypefaceStyle` needs it that way to tell an asset family
     * (nearest of four files, weight not re-applied) from a `res/font` family
     * registered with `addCustomFont` (one file, weight applied to it) — a
     * distinction a `Typeface` style bit cannot carry.
     */
    fun resolve(family: String, weight: Int, italic: Boolean): Typeface {
        val assetManager = assets ?: return Typeface.create(family, nearestStyle(weight, italic))
        val fromAssets: Typeface? = synchronized(this) {
            ReactFontManager.getInstance().getTypeface(family, weight, italic, assetManager)
        }
        return fromAssets ?: Typeface.create(family, nearestStyle(weight, italic))
    }

    /**
     * The two-value `Typeface` style for a CSS weight — what the system map
     * takes, for the fallbacks above. The cut is `WEIGHT_BOLD`, matching
     * `ReactFontManager.TypefaceStyle.getNearestStyle`, so a fallback and a
     * resolution disagree about the weight by no more than the system map
     * itself does.
     */
    private fun nearestStyle(weight: Int, italic: Boolean): Int {
        val bold = if (weight >= WEIGHT_BOLD) Typeface.BOLD else Typeface.NORMAL
        return if (italic) bold or Typeface.ITALIC else bold
    }
}
