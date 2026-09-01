package com.selectablemarkdown

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

/**
 * `onSelectionAction` — the selection-menu event this component emits
 * (`InlinePressEvent` is the other event, and inherits every structural
 * decision made here).
 *
 * WHY IT IS AN `Event` OBJECT RATHER THAN A DIRECT `receiveEvent` CALL. The
 * host used to dispatch through `getJSModule(RCTEventEmitter::class.java)`,
 * which is the *paper* JS module. Under Fabric that module is not what
 * delivers events, and the call does not fail — it is simply dropped. The
 * symptom would be "Copy Text and Copy Markdown do nothing", i.e. this
 * library's headline feature missing on the new architecture, with nothing in
 * logcat and no exception anywhere. Routing through an `Event` posted to the
 * dispatcher that `UIManagerHelper.getEventDispatcherForReactTag` returns
 * fixes that at the only call site: that helper resolves to `ReactEventEmitter`
 * on paper and `FabricEventEmitter` on Fabric, so one dispatch serves both
 * architectures and neither has a path of its own to get wrong.
 *
 * THE NAME IS `topSelectionAction`, AND BOTH SIDES OF THE MAPPING MUST SAY SO.
 * On paper the string here is matched verbatim against the keys of
 * `getExportedCustomDirectEventTypeConstants` — nothing normalizes it
 * (`getNativeComponentAttributes.js` copies `directEventTypes` through
 * untouched) — so a mismatch there means the event arrives and is discarded
 * with no listener found. On Fabric the C++ emitter runs every name through
 * `normalizeEventType` (react/renderer/core/EventEmitter.cpp:29-39), which
 * leaves a `top`-prefixed name alone and rewrites an `on`-prefixed one, and the
 * codegen'd view config keys the same event `topSelectionAction`
 * (GenerateViewConfigJs.js:146-148). `top…` is therefore the one spelling that
 * is correct on both; `onSelectionAction` only happens to work on paper.
 *
 * `canCoalesce` is false, and that is a correctness requirement rather than a
 * tuning choice. `Event` coalesces by default, keeping only the most recent of
 * two events with the same name, view and coalescing key
 * (Event.java:100-112) — so a user who selects one range, taps Copy Markdown,
 * then selects another and taps it again inside the same frame would have the
 * first copy silently dropped. Every event this component emits is a distinct
 * user action against a distinct selection.
 */
internal class SelectionActionEvent(
    surfaceId: Int,
    viewId: Int,
    private val start: Int,
    private val end: Int,
    private val action: String,
    private val selectedText: String,
) : Event<SelectionActionEvent>(surfaceId, viewId) {

    override fun getEventName(): String = EVENT_NAME

    override fun canCoalesce(): Boolean = false

    /**
     * The payload contract is docs/SELECTION.md's, and the offsets are the
     * whole of it: UTF-16 code units into the *current* `text`, end-exclusive,
     * clamped and ordered. They are computed and validated by the emitter in
     * `SelectableRunHostView`; nothing is recomputed here, because a second
     * place that could clamp is a second place that could clamp differently.
     */
    override fun getEventData(): WritableMap =
        Arguments.createMap().apply {
            putInt("start", start)
            putInt("end", end)
            putString("action", action)
            putString("selectedText", selectedText)
        }

    companion object {
        const val EVENT_NAME = "topSelectionAction"
    }
}
