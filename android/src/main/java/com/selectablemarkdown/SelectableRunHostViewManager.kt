package com.selectablemarkdown

import android.content.Context
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.BaseViewManager
import com.facebook.react.uimanager.LayoutShadowNode
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.SelectableRunHostManagerDelegate
import com.facebook.react.viewmanagers.SelectableRunHostManagerInterface
import com.facebook.yoga.YogaMeasureMode
import com.facebook.yoga.YogaMeasureOutput

/**
 * The name must match the string in `codegenNativeComponent('SelectableRunHost')`
 * (src/view/SelectableRunHostNativeComponent.ts): it is what
 * `FabricUIManager.measure` and the mounting layer route on, and what the C++
 * component name resolves to.
 *
 * FABRIC ONLY: the peer range starts at react-native 0.82, so there is no
 * Kotlin measuring shadow node. The shadow node for
 * `SelectableRunHost` is C++ — `RNSMRunHostShadowNode` in platform/fabric,
 * registered through the component descriptor the app's generated
 * autolinking.cpp instantiates. Measurement arrives through `measure` below,
 * called from android/src/main/jni/RNSMRunTextMeasurer.cpp; props are applied
 * through the codegen'd delegate; recycling calls prepareToRecycleView.
 *
 * `LayoutShadowNode` as the second type parameter is the base React Native
 * requires a ViewManager to name, not a measuring node — nothing constructs
 * it, and `createShadowNodeInstance` exists only because `ViewManager`
 * declares it abstract.
 *
 * IMPLEMENTING THE GENERATED INTERFACE IS THE POINT OF THE CODEGEN SETUP.
 * `SelectableRunHostManagerInterface` is generated from the TypeScript spec by
 * React Native's Gradle plugin, for every library that applies it
 * (ReactPlugin.kt:91-93 with an onlyIf that passes for every
 * com.android.library). It is the only compile-time link between the spec and
 * these setters: rename a prop in TypeScript and this file stops compiling,
 * instead of shipping a prop that silently never arrives.
 */
class SelectableRunHostViewManager :
    BaseViewManager<SelectableRunHostView, LayoutShadowNode>(),
    SelectableRunHostManagerInterface<SelectableRunHostView> {

    /**
     * Built once and reused: `updateProperties` asks for it on every prop
     * batch, and the delegate is stateless apart from the back-reference to
     * this manager.
     *
     * With a delegate present, `ViewManager.updateProperties` routes each prop
     * through `delegate.setProperty` instead of reflecting over @ReactProp
     * (ViewManager.java:82-89), which reaches the same props reflection would.
     */
    private val delegate: ViewManagerDelegate<SelectableRunHostView> =
        SelectableRunHostManagerDelegate<SelectableRunHostView, SelectableRunHostViewManager>(this)

    public override fun getDelegate(): ViewManagerDelegate<SelectableRunHostView> = delegate

    override fun getName(): String = COMPONENT_NAME

    override fun createViewInstance(reactContext: ThemedReactContext): SelectableRunHostView {
        // Idempotent, and kept on the application context so both outlive ReactInstance teardown.
        RunLayoutCache.installTrimHook(reactContext)
        RunTypefaces.install(reactContext)
        return SelectableRunHostView(reactContext as ReactContext)
    }

    // NEVER CALLED, AND REQUIRED ANYWAY. `ViewManager` declares both abstract,
    // so they must exist; under Fabric the shadow node is the C++
    // `RNSMRunHostShadowNode` and nothing asks this class for one. A plain
    // `LayoutShadowNode` is the correct answer precisely because it measures
    // nothing — if either of these ever started being called, a run laying out
    // at zero height is a far louder failure than a Kotlin node quietly
    // measuring differently from the C++ one.
    override fun createShadowNodeInstance(): LayoutShadowNode {
        return LayoutShadowNode()
    }

    override fun getShadowNodeClass(): Class<LayoutShadowNode> {
        return LayoutShadowNode::class.java
    }

    // All layout data flows through props + `measure`; the UIManager never
    // sends extra data for this component.
    override fun updateExtraData(root: SelectableRunHostView, extraData: Any?) = Unit

    @ReactProp(name = "text")
    override fun setText(view: SelectableRunHostView, text: String?) {
        view.setText(text ?: "")
    }

    @ReactProp(name = "attributes")
    override fun setAttributes(view: SelectableRunHostView, attributes: ReadableArray?) {
        // Parsed on arrival, on the UI thread, while the caller still owns
        // valid memory for this array — never held and read later.
        view.setAttributes(RunAttributedText.parse(attributes))
    }

    @ReactProp(name = "decorations")
    override fun setDecorations(view: SelectableRunHostView, decorations: ReadableArray?) {
        // Same on-arrival discipline as `attributes`, and folded into the
        // same one styled string in onAfterUpdateTransaction — the
        // layout-affecting half of a decoration lives in the spannable.
        view.setDecorations(RunDecorations.parse(decorations))
    }

    /**
     * React Native calls this once the whole prop batch has been applied,
     * which is where `text` and `attributes` are folded into one styled
     * string. Doing it per prop instead would rebuild twice per update and,
     * worse, briefly draw new text under the old batch's styling.
     */
    override fun onAfterUpdateTransaction(view: SelectableRunHostView) {
        super.onAfterUpdateTransaction(view)
        view.commitProps()
    }

    @ReactProp(name = "selectable", defaultBoolean = true)
    override fun setSelectable(view: SelectableRunHostView, selectable: Boolean) {
        view.setSelectable(selectable)
    }

    /** `defaultBoolean` must match the spec's `WithDefault<boolean, true>` and the view's own field. */
    @ReactProp(name = "exclusiveSelection", defaultBoolean = true)
    override fun setExclusiveSelection(view: SelectableRunHostView, exclusive: Boolean) {
        view.setExclusiveSelection(exclusive)
    }

    @ReactProp(name = "allowFontScaling", defaultBoolean = true)
    override fun setAllowFontScaling(view: SelectableRunHostView, value: Boolean) {
        view.setAllowFontScaling(value)
    }

    @ReactProp(name = "maxFontSizeMultiplier", defaultFloat = 0f)
    override fun setMaxFontSizeMultiplier(view: SelectableRunHostView, value: Float) {
        view.setMaxFontSizeMultiplier(value)
    }

    /** No `receiveCommand` override: `ViewManager` already forwards commands to the codegen delegate. */
    override fun clearSelection(view: SelectableRunHostView) {
        view.clearSelection()
    }

    override fun setSelection(view: SelectableRunHostView, start: Int, end: Int) {
        // Clamped in the view, the only place that knows the current text.
        view.setSelection(start, end)
    }

    @ReactProp(name = "pressables")
    override fun setPressables(view: SelectableRunHostView, pressables: ReadableArray?) {
        // Parsed on arrival, like `attributes`: the ReadableArray is bridge
        // memory that must not be held past the prop batch. A null prop
        // (reset) parses to the empty list, which is also the "nothing
        // listens" value, so the two mean the same thing: intercept no taps.
        view.setPressables(SelectableRunHostView.parsePressables(pressables))
    }

    @ReactProp(name = "embeds")
    override fun setEmbeds(view: SelectableRunHostView, embeds: ReadableArray?) {
        // Same on-arrival discipline as `decorations`, and folded into the
        // same one styled string in onAfterUpdateTransaction — a reservation
        // is a ReplacementSpan in the spannable. A null prop (reset) parses
        // to the empty spec: reserve nothing, report nothing.
        view.setEmbeds(RunEmbeds.parse(embeds))
    }

    /** Copied unexamined: the view unpacks `identifier + U+001F + title` (src/view/selectionActions.ts). */
    @ReactProp(name = "selectionActions")
    override fun setSelectionActions(view: SelectableRunHostView, actions: ReadableArray?) {
        if (actions == null) {
            // Prop reset: fall back to the default menu (both actions).
            view.setSelectionActions(
                listOf(
                    SelectableRunHostView.ACTION_COPY_TEXT,
                    SelectableRunHostView.ACTION_COPY_MARKDOWN,
                )
            )
            return
        }
        val resolved = ArrayList<String>(actions.size())
        for (index in 0 until actions.size()) {
            val value = actions.getString(index)
            if (value != null) {
                resolved.add(value)
            }
        }
        view.setSelectionActions(resolved)
    }

    /**
     * Fabric measurement. Called from the layout thread, through JNI, by
     * android/src/main/jni/RNSMRunTextMeasurer.cpp: `FabricUIManager.measure`
     * routes by component name to `MountingManager.measure` and then here
     * (ViewManager.java:402-414). This is a supported route, not a private
     * hook — AndroidSwitch and AndroidProgressBar reach their own measurement
     * the same way.
     *
     * `props` IS THE RAW JS PROP MAP, not a codegen struct, and that is what
     * makes Fabric cheap for this component. Fabric stores the props as a
     * folly::dynamic under `#ifdef ANDROID` and hands the Java side a
     * ReadableNativeMap over it, so the sparse `hasKey` reading in
     * `RunAttributedText.parse` — including its forward-compatible "skip a key
     * this binary does not know" degradation — works unchanged, and the string
     * measured here is built by the same call the view draws with. Nothing on
     * this platform ever reads the generated `SelectableRunHostProps` struct or
     * its sentinel encoding of absent fields.
     *
     * The reads are defensive because a throw here is a crash on the layout
     * thread: `ReadableNativeMap.getString` raises NoSuchKeyException for a
     * missing key rather than returning null, and the contract this class must
     * keep is that a newer JS bundle against an older binary degrades to less
     * styling, never to a crash inside a measure pass.
     *
     * UNITS. `width` and `height` arrive in **pixels** — `FabricUIManager`
     * converts the constraints on the way in with
     * `LayoutMetricsConversions.getYogaSize`, which is
     * `PixelUtil.toPixelFromDIP` — and the Yoga tree on the other side of the
     * JNI call is in points, so the result has to be converted back. React
     * Native's own text measurement ends with the same
     * `PixelUtil.toDIPFromPixel` pair (TextLayoutManager.java:692-711).
     * Skipping it would report every run three times too tall on a 3x device.
     */
    override fun measure(
        context: Context,
        localData: ReadableMap?,
        props: ReadableMap?,
        state: ReadableMap?,
        width: Float,
        widthMode: YogaMeasureMode,
        height: Float,
        heightMode: YogaMeasureMode,
        attachmentsPositions: FloatArray?
    ): Long {
        // Fabric measures before mounting, so without this a bundled `fontFamily` measures in the system face.
        RunTypefaces.install(context)
        val text = if (props != null && props.hasKey("text")) props.getString("text") ?: "" else ""
        val attributes = if (props != null && props.hasKey("attributes")) {
            RunAttributedText.parse(props.getArray("attributes"))
        } else {
            RunAttributedText.Spec.EMPTY
        }
        val decorations = if (props != null && props.hasKey("decorations")) {
            RunDecorations.parse(props.getArray("decorations"))
        } else {
            RunDecorations.Spec.EMPTY
        }
        val embeds = if (props != null && props.hasKey("embeds")) {
            RunEmbeds.parse(props.getArray("embeds"))
        } else {
            RunEmbeds.Spec.EMPTY
        }
        val measured =
            RunTextMeasure.measure(
                text,
                attributes,
                decorations,
                embeds,
                width,
                widthMode,
                height,
                heightMode,
                RunFontScaling.fromProps(props),
            )
        return YogaMeasureOutput.make(
            PixelUtil.toDIPFromPixel(YogaMeasureOutput.getWidth(measured)),
            PixelUtil.toDIPFromPixel(YogaMeasureOutput.getHeight(measured)),
        )
    }

    /**
     * Fabric pools component views and hands a used one to a different run, so
     * stripping the previous run's selection is a correctness requirement —
     * `SelectableRunHostView.prepareToRecycle` states the failure it prevents,
     * which is the worst one this library has.
     *
     * The super call is not optional: BaseViewManager resets the transform,
     * the accessibility tags and a dozen other base-prop side effects here
     * (BaseViewManager.java:70+), and a view that skipped it would come back
     * rotated or labelled as the run before it.
     */
    override fun prepareToRecycleView(
        reactContext: ThemedReactContext,
        view: SelectableRunHostView
    ): SelectableRunHostView {
        super.prepareToRecycleView(reactContext, view)
        view.prepareToRecycle()
        return view
    }

    /**
     * The event-name mapping. The key is the name the native side dispatches
     * and it is compared verbatim, so it has to be `topSelectionAction` —
     * which is what the codegen'd Fabric view config uses and what
     * `EventEmitter::normalizeEventType` leaves alone. `SelectionActionEvent`
     * owns that string; it is not repeated here.
     *
     * IT MERGES `super` RATHER THAN REPLACING IT, and the difference is a
     * silently missing callback. `BaseViewManager` registers
     * `topAccessibilityAction -> onAccessibilityAction` from this same method
     * (BaseViewManager.java:711-724), and `accessibilityActions` stays a live
     * `@ReactProp` on every view manager that extends it. Returning a fresh map
     * here drops that registration, so an app that sets `accessibilityActions`
     * on a `<RunHost>` would never receive `onAccessibilityAction` — no error,
     * just a callback that never fires.
     *
     * `toMutableMap()` copies rather than mutating what `super` handed back.
     * BaseViewManager builds a fresh HashMap on every call today, so mutating
     * it in place would work, but that is an implementation detail of a class
     * we do not own and the copy costs one small map per component
     * registration, once per app launch.
     */
    override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
        val constants: MutableMap<String, Any> =
            super.getExportedCustomDirectEventTypeConstants()?.toMutableMap() ?: mutableMapOf()
        constants[SelectionActionEvent.EVENT_NAME] =
            mapOf("registrationName" to "onSelectionAction")
        constants[InlinePressEvent.EVENT_NAME] =
            mapOf("registrationName" to "onInlinePress")
        constants[EmbedLayoutEvent.EVENT_NAME] =
            mapOf("registrationName" to "onEmbedLayout")
        constants[SelectionChangeEvent.EVENT_NAME] =
            mapOf("registrationName" to "onSelectionChange")
        return constants
    }

    companion object {
        const val COMPONENT_NAME = "SelectableRunHost"
    }
}
