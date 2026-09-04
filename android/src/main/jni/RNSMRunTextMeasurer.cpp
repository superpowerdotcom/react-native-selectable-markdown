/*
 * RNSMRunTextMeasurer.cpp — the Android implementation of the measurement
 * façade declared in platform/fabric/RNSMRunTextMeasurer.h.
 *
 * WHY THIS FILE IS FORTY LINES AND NOT FOUR HUNDRED. Android does not need a
 * second text-measurement implementation, because it already has ours: the
 * `SelectableRunHostViewManager.measure` override builds the styled string
 * with `RunAttributedText.build` and lays it out with `RunTextMeasure`, which
 * is the same object that configures the `TextView`'s paint. React Native
 * exposes a supported route to that method from C++ —
 * `FabricUIManager.measure(surfaceId, componentName, …)` routes by component
 * name through `MountingManager.measure` to
 * `ViewManager.measure(Context, ReadableMap, …)` — so all this file does is
 * make the call. `AndroidProgressBarMeasurementsManager.cpp` and
 * `AndroidSwitchMeasurementsManager.cpp` are the same shape, line for line;
 * this is not a private hook.
 *
 * The consequence is the property docs/FABRIC-PLAN.md §4 cares most about:
 * measure/draw agreement on Android is not maintained by keeping two engines
 * configured identically, it is structural, because there is only one engine
 * and both sides call it — the shadow node through this file, and the mounted
 * `SelectableRunHostView` directly.
 *
 * THIS FILE ENCODES NOTHING AND KNOWS NOTHING ABOUT ATTRIBUTES. It forwards
 * `props.rawProps` — the exact `folly::dynamic` of the JS props, populated by
 * `Props::initialize` under `#ifdef ANDROID`
 * (react/renderer/core/Props.cpp:30-32) — wrapped as a `ReadableNativeMap`,
 * which is byte-for-byte what `FabricMountingManager::getProps` hands the Java
 * ViewManager when it mounts the same component
 * (ReactAndroid/src/main/jni/react/fabric/FabricMountingManager.cpp:225). So
 * `RunAttributedText.parse`'s `hasKey`-based "absent means inherit" reading,
 * and its forward-compatible "skip a key this binary does not know"
 * degradation, work unchanged under Fabric and are the *same code path* the
 * mounted view uses. Nothing is serialized twice, no MapBuffer is built, and
 * the codegen'd `SelectableRunHostProps` struct — with its sentinel encoding
 * of absence — is never read on this platform at all. That is what makes
 * Fabric cheap for us, and it is why docs/FABRIC-PLAN.md §6.3 rejects packing
 * the attribute array into a binary format: packing would replace this
 * zero-cost path with a hand-rolled one.
 */

#include <RNSMRunTextMeasurer.h>

#include <fbjni/fbjni.h>
#include <react/jni/ReadableNativeMap.h>
#include <react/renderer/core/conversions.h>

#include <RNSMRunHostShadowNode.h>

using namespace facebook::jni;

namespace facebook::react {

RNSMRunTextMeasurer::RNSMRunTextMeasurer(
    const std::shared_ptr<const ContextContainer>& contextContainer)
    : contextContainer_(contextContainer) {}

std::shared_ptr<void> RNSMRunTextMeasurer::prepareContent(
    const SelectableRunHostProps& /*props*/,
    Float /*fontSizeMultiplier*/) const {
  /*
   * Nothing to prepare, and returning `nullptr` is the contract rather than a
   * gap. On iOS this returns the exact `NSAttributedString` the view will
   * draw, carried to the mounting layer through Fabric State so that the
   * measured object and the drawn object are one object. On Android the
   * styled string is built on the Java side, twice-over from the same
   * `RunAttributedText.build` call — once by the measure override, once by the
   * view — and neither is reachable from here without a JNI round trip whose
   * only product would be a handle nobody could use. So the state payload
   * stays empty: `RNSMRunHostShadowNode::updateStateIfNeeded` compares the
   * handle by pointer, sees the unchanged null on every commit, and never
   * publishes state. RNSMRunHostState.h says the same thing from the other
   * side.
   */
  return nullptr;
}

Size RNSMRunTextMeasurer::measure(
    SurfaceId surfaceId,
    const std::shared_ptr<void>& /*content*/,
    const SelectableRunHostProps& props,
    const LayoutConstraints& layoutConstraints,
    const LayoutContext& /*layoutContext*/) const {
  /*
   * The UI manager arrives through the `ContextContainer` under this exact
   * key; it is a global ref installed when the surface starts, which is why
   * the descriptor holds the container and a shadow node does not.
   */
  const jni::global_ref<jobject>& fabricUIManager =
      contextContainer_->at<jni::global_ref<jobject>>("FabricUIManager");

  /*
   * The nine-argument overload (FabricUIManager.java:508-529), which forwards
   * to the ten-argument one with a null `attachmentsPositions`. That array is
   * RN's protocol for its OWN AttributedString attachments, positioned by the
   * measurer so the shadow tree can lay child views into text. Runs DO carry
   * view-shaped content now — the `embeds` prop reserves space for overlaid
   * consumer views — but their rects deliberately do not travel this channel:
   * embed geometry is reported by the mounted view after layout
   * (`SelectableRunHostView.reportEmbedRects` -> `onEmbedLayout`), because
   * the overlay is a JS-positioned sibling, not a shadow-tree child, so the
   * measurer has nobody to hand positions to. The reservations themselves
   * still measure correctly through this call: `embeds` rides the raw props
   * forwarded below, and the Kotlin side folds it into the measured
   * spannable as ReplacementSpans. `measure` is private on the Java side —
   * JNI does not care, and every in-tree measurements manager binds it the
   * same way.
   *
   * `static` so the method id is resolved once per process rather than once
   * per measure. Yoga calls this several times per layout pass.
   */
  static auto measure =
      facebook::jni::findClassStatic("com/facebook/react/fabric/FabricUIManager")
          ->getMethod<jlong(
              jint,
              jstring,
              ReadableMap::javaobject,
              ReadableMap::javaobject,
              ReadableMap::javaobject,
              jfloat,
              jfloat,
              jfloat,
              jfloat)>("measure");

  /*
   * The routing key. Using the symbol codegen defines rather than a literal
   * means the name C++ measures under and the name the Java ViewManager
   * registers under cannot drift: `SelectableRunHostComponentName` is defined
   * once, by the generated ShadowNodes.cpp, as "SelectableRunHost", and
   * `MountingManager.measure` looks the ViewManager up by exactly this string.
   * A mismatch is not a crash — `ViewManagerRegistry.get` throws, which
   * surfaces as a measure failure on the layout thread — and a typo in a
   * string literal is precisely the kind of thing a compiler cannot see.
   */
  local_ref<JString> componentName =
      make_jstring(SelectableRunHostComponentName);

  /*
   * `rawProps` is the props as JS sent them. `ReadableNativeMap` is a hybrid
   * whose Java peer implements `ReadableMap`, but fbjni models the two as
   * unrelated `JavaClass`es, so the cast is how every caller of this method
   * bridges them — `AndroidProgressBarMeasurementsManager.cpp:50-55` included.
   * It is a JNI reference retype, not a conversion: the underlying object
   * already is a `ReadableMap` to the JVM.
   */
  local_ref<ReadableNativeMap::javaobject> propsMap =
      ReadableNativeMap::newObjectCxxArgs(props.rawProps);
  local_ref<ReadableMap::javaobject> propsReadableMap =
      make_local(reinterpret_cast<ReadableMap::javaobject>(propsMap.get()));

  /*
   * No memoisation here, deliberately, and it is not an omission.
   * `AndroidSwitch` and `AndroidProgressBar` cache one measurement forever
   * because their size does not depend on their props; ours depends on the
   * text, the attributes and the width, so a cache in this object would have
   * to be keyed on all three and would duplicate the one
   * `RNSMRunHostShadowNode` already keeps — which is keyed on the layout
   * constraints, dropped whenever the content is rebuilt, and carried across a
   * clean clone. One memo, in the object that knows when it goes stale.
   *
   * `localData` and `state` are null for the same reason `prepareContent`
   * returns null: this component publishes neither.
   */
  const auto minimumSize = layoutConstraints.minimumSize;
  const auto maximumSize = layoutConstraints.maximumSize;

  return yogaMeassureToSize(measure(
      fabricUIManager,
      surfaceId,
      componentName.get(),
      nullptr,
      propsReadableMap.get(),
      nullptr,
      minimumSize.width,
      maximumSize.width,
      minimumSize.height,
      maximumSize.height));
}

} // namespace facebook::react
