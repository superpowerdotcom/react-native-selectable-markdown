package com.selectablemarkdown

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

/**
 * `onSelectionChange` — fired whenever the run's selection moves, including to
 * nothing.
 *
 * Everything structural here is inherited from `SelectionActionEvent`'s
 * reasoning, which is the authoritative copy: the `Event`-object dispatch
 * (posted to the dispatcher `UIManagerHelper.getEventDispatcherForReactTag`
 * resolves, so one path serves both architectures), and the `top…` spelling
 * (matched verbatim on paper, left alone by Fabric's `normalizeEventType`, and
 * what the codegen'd view config keys the event under).
 *
 * WHAT IS DIFFERENT FROM THE OTHER TWO EVENTS, and it is the whole reason this
 * one exists: an EMPTY range is a legal payload. `SelectionActionEvent` never
 * emits one — a menu item fired against no selection would be nonsense — but
 * "the selection went away" is exactly what a consumer's own floating toolbar
 * has to hear in order to dismiss itself, and nothing else reports it.
 *
 * `canCoalesce` is FALSE here too, and the reasoning is worth stating because
 * this is the one event where coalescing looks defensible: it fires
 * repeatedly while a selection handle is dragged, and keeping only the newest
 * of two in a frame would be harmless for a drag. It is not harmless for the
 * pair that matters — a hand-off emits "run B holds [4,9)" and then "run A
 * holds nothing", two events from two different views. `Event` coalesces by
 * name, view AND coalescing key (Event.java:100-112), so two views never
 * collide and the pair would survive; what would not survive is a clear and a
 * re-selection inside one view in a single frame, which is exactly the
 * sequence a programmatic `setSelection` produces. The host's own dedupe is
 * what keeps the volume down, and it drops only genuinely identical ranges.
 *
 * There is no `selectedText` field, unlike `SelectionActionEvent`. Building
 * one would mean a substring per frame of a drag, transcoded across the
 * bridge, for a string JS can already slice out of the text it sent.
 */
internal class SelectionChangeEvent(
    surfaceId: Int,
    viewId: Int,
    private val start: Int,
    private val end: Int,
) : Event<SelectionChangeEvent>(surfaceId, viewId) {

    override fun getEventName(): String = EVENT_NAME

    override fun canCoalesce(): Boolean = false

    /**
     * `start`/`end` are UTF-16 offsets into the *current* `text`,
     * end-exclusive, clamped and ordered by the emitter in
     * `SelectableRunHostView` — the same contract as every other offset this
     * component reports, except that `start == end` is meaningful here and
     * means "nothing is selected".
     */
    override fun getEventData(): WritableMap =
        Arguments.createMap().apply {
            putInt("start", start)
            putInt("end", end)
        }

    companion object {
        const val EVENT_NAME = "topSelectionChange"
    }
}
