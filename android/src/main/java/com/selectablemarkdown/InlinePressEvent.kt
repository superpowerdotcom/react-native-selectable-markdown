package com.selectablemarkdown

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

/**
 * `onInlinePress` — fired when a single tap lands inside one of the
 * `pressables` ranges.
 *
 * Everything structural here is inherited from `SelectionActionEvent`'s
 * reasoning, which is the authoritative copy: the `Event`-object dispatch
 * (posted to the dispatcher `UIManagerHelper.getEventDispatcherForReactTag`
 * resolves, so one path serves both architectures), and the `top…` spelling
 * (matched verbatim on paper, left alone by Fabric's `normalizeEventType`,
 * and what the codegen'd view config keys the event under).
 *
 * `canCoalesce` is false here too, and for the equivalent reason: two taps on
 * two different links in the same frame are two distinct user actions, and
 * coalescing would silently drop the first. A double-tap on the *same* link
 * legitimately opens it twice — exactly what the JS fallback's `<Text
 * onPress>` does.
 */
internal class InlinePressEvent(
    surfaceId: Int,
    viewId: Int,
    private val start: Int,
    private val end: Int,
    private val pressableId: Int,
) : Event<InlinePressEvent>(surfaceId, viewId) {

    override fun getEventName(): String = EVENT_NAME

    override fun canCoalesce(): Boolean = false

    /**
     * `start`/`end` are the pressed range, UTF-16 into the *current* `text`,
     * clamped by the emitter in `SelectableRunHostView` — informational, the
     * same way `selectedText` is on the selection event. `pressableId` is
     * JS's identifier for the range, echoed verbatim; it is what JS routes
     * on.
     */
    override fun getEventData(): WritableMap =
        Arguments.createMap().apply {
            putInt("start", start)
            putInt("end", end)
            putInt("pressableId", pressableId)
        }

    companion object {
        const val EVENT_NAME = "topInlinePress"
    }
}
