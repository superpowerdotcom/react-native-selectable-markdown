package com.selectablemarkdown

import android.content.Context
import android.content.res.AssetManager
import android.graphics.Typeface
import com.facebook.react.common.assets.ReactFontManager

/** Resolves through `ReactFontManager`, as `<Text>` does: `TypefaceSpan(String)` knows only the system font map. */
internal object RunTypefaces {

    /** `WEIGHT_BOLD` is also the cut React Native's `TypefaceStyle` uses when it picks a face file. */
    const val WEIGHT_NORMAL = 400
    const val WEIGHT_BOLD = 700

    @Volatile
    private var assets: AssetManager? = null

    fun install(context: Context) {
        if (assets != null) return
        assets = context.applicationContext.assets
    }

    /**
     * Uncached: `ReactFontManager` caches already, and a second cache would freeze a lazily registered family.
     * Weight and slant go with the family because React Native picks the face file from all three.
     * Serialized because `ReactFontManager` uses plain `HashMap`s and this runs on the UI and layout threads.
     */
    fun resolve(family: String, weight: Int, italic: Boolean): Typeface {
        val assetManager = assets ?: return Typeface.create(family, nearestStyle(weight, italic))
        val fromAssets: Typeface? = synchronized(this) {
            ReactFontManager.getInstance().getTypeface(family, weight, italic, assetManager)
        }
        return fromAssets ?: Typeface.create(family, nearestStyle(weight, italic))
    }

    private fun nearestStyle(weight: Int, italic: Boolean): Int {
        val bold = if (weight >= WEIGHT_BOLD) Typeface.BOLD else Typeface.NORMAL
        return if (italic) bold or Typeface.ITALIC else bold
    }
}
