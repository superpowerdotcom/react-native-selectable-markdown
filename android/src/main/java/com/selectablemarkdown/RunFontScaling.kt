package com.selectablemarkdown

import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.uimanager.PixelUtil

/**
 * The `allowFontScaling` / `maxFontSizeMultiplier` props: how every SP value on
 * the wire (font size, line height, letter spacing) becomes pixels.
 *
 * One conversion for the builder and the base paint, and part of
 * `RunLayoutCache.Key`, so the measure path and the drawn TextView cannot scale
 * a run differently. The semantics are React Native's own `<Text>` ones: off
 * means DIP, and a cap below 1 is no cap (`PixelUtil.toPixelFromSP` ignores
 * `maxFontScale < 1`).
 */
internal data class RunFontScaling(
    val allowFontScaling: Boolean,
    val maxFontSizeMultiplier: Float,
) {
    fun toPixel(sp: Float): Float = when {
        !allowFontScaling -> PixelUtil.toPixelFromDIP(sp)
        maxFontSizeMultiplier >= 1f -> PixelUtil.toPixelFromSP(sp, maxFontSizeMultiplier)
        else -> PixelUtil.toPixelFromSP(sp)
    }

    companion object {
        val DEFAULT = RunFontScaling(allowFontScaling = true, maxFontSizeMultiplier = 0f)

        /** From the raw Fabric prop map the measure path receives; absent keys keep the spec defaults. */
        fun fromProps(props: ReadableMap?): RunFontScaling {
            if (props == null) return DEFAULT
            val allow = if (props.hasKey("allowFontScaling") &&
                props.getType("allowFontScaling") == ReadableType.Boolean
            ) {
                props.getBoolean("allowFontScaling")
            } else {
                true
            }
            val max = if (props.hasKey("maxFontSizeMultiplier") &&
                props.getType("maxFontSizeMultiplier") == ReadableType.Number
            ) {
                props.getDouble("maxFontSizeMultiplier").toFloat()
            } else {
                0f
            }
            return of(allow, max)
        }

        fun of(allow: Boolean, max: Float): RunFontScaling {
            // Normalized so equivalent settings share one cache key.
            val cap = if (max.isFinite() && max >= 1f) max else 0f
            return if (allow && cap == 0f) DEFAULT else RunFontScaling(allow, if (allow) cap else 0f)
        }
    }
}
