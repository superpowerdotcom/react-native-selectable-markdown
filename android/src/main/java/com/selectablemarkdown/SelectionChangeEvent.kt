package com.selectablemarkdown

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

internal class SelectionChangeEvent(
    surfaceId: Int,
    viewId: Int,
    private val start: Int,
    private val end: Int,
) : Event<SelectionChangeEvent>(surfaceId, viewId) {

    override fun getEventName(): String = EVENT_NAME

    // Coalescing would drop a clear followed by a re-selection in one view within one frame.
    override fun canCoalesce(): Boolean = false

    /** UTF-16 offsets, end-exclusive; `start == end` means nothing is selected. */
    override fun getEventData(): WritableMap =
        Arguments.createMap().apply {
            putInt("start", start)
            putInt("end", end)
        }

    companion object {
        const val EVENT_NAME = "topSelectionChange"
    }
}
