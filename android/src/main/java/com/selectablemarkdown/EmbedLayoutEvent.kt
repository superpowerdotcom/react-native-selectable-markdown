package com.selectablemarkdown

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

/**
 * `onEmbedLayout` — fired per embed, after layout, with the rect the host
 * reserved for it (host coordinates, dp).
 *
 * Everything structural here is inherited from `SelectionActionEvent`'s
 * reasoning, which is the authoritative copy: the `Event`-object dispatch
 * (posted to the dispatcher `UIManagerHelper.getEventDispatcherForReactTag`
 * resolves, so one path serves both architectures), and the `top…` spelling
 * (matched verbatim on paper, left alone by Fabric's `normalizeEventType`,
 * and what the codegen'd view config keys the event under).
 *
 * `canCoalesce` is false here for a DIFFERENT reason than the other two
 * events. A layout report is latest-wins, so coalescing would be
 * semantically fine — but the framework coalesces by `(eventName, viewTag,
 * coalescingKey)`, the key is a Short, and reports for DIFFERENT embeds of
 * one host must never merge, so correctness would hang on an id-to-Short
 * mapping. The host dedupes at the source instead (`reportEmbedRects` emits
 * only rects that moved), which bounds the event volume better than
 * coalescing could and keeps this class as boring as its siblings.
 */
internal class EmbedLayoutEvent(
    surfaceId: Int,
    viewId: Int,
    private val embedId: Int,
    private val x: Float,
    private val y: Float,
    private val width: Float,
    private val height: Float,
) : Event<EmbedLayoutEvent>(surfaceId, viewId) {

    override fun getEventName(): String = EVENT_NAME

    override fun canCoalesce(): Boolean = false

    /**
     * `embedId` is JS's identifier for the embed (its index into the
     * `embeds` prop as sent), echoed verbatim — it is what JS routes on,
     * bounds-checked there like `pressableId`. The rect is in the host
     * view's coordinate space, dp, matching how JS positions the overlay.
     */
    override fun getEventData(): WritableMap =
        Arguments.createMap().apply {
            putInt("embedId", embedId)
            putDouble("x", x.toDouble())
            putDouble("y", y.toDouble())
            putDouble("width", width.toDouble())
            putDouble("height", height.toDouble())
        }

    companion object {
        const val EVENT_NAME = "topEmbedLayout"
    }
}
