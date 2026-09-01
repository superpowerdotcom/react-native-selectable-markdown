/*
 * The iOS implementation of the measurement façade declared in
 * platform/fabric/RNSMRunTextMeasurer.h. Read that header first: it says why
 * this package does not measure through React Native's own TextLayoutManager,
 * and what the interface is shaped around.
 *
 * The whole file is inside the new-architecture guard, includes and all, so an
 * old-architecture app compiles it to an empty translation unit — no
 * React-Fabric headers, no codegen'd Props.h, nothing from React-RCTFabric.
 * The podspec only adds the Fabric sources when RCT_NEW_ARCH_ENABLED is set,
 * so this guard is belt and braces; it is here anyway because the cost is one
 * line and the failure it prevents — a build error in somebody else's
 * old-architecture app, on a pod they did not ask to be new-architecture — is
 * one this repository has no way to reproduce.
 *
 * WHAT MAKES THIS SHORT. `prepareContent` returns the exact NSAttributedString
 * the component view will draw, and `measure` lays that same object out in a
 * stack from RNSMTextKitStack — the same factory the view constructs its
 * UITextView from. There is no second string builder and no second text-engine
 * configuration to keep in sync, which is why measure/draw agreement is a
 * property of the design here rather than something a test would have to
 * defend (docs/FABRIC-PLAN.md §4.1).
 */

#ifdef RCT_NEW_ARCH_ENABLED

#import <UIKit/UIKit.h>

#import <react/utils/ManagedObjectWrapper.h>

#import "RNSMAttributedText+Props.h"
#import "RNSMRunTextMeasurer.h"
#import "RNSMTextKitStack.h"

namespace facebook::react {

RNSMRunTextMeasurer::RNSMRunTextMeasurer(
    const std::shared_ptr<const ContextContainer> &contextContainer)
    : contextContainer_(contextContainer)
{
  /*
   * The container is stored and not read. Android's implementation of this
   * class pulls the FabricUIManager out of it to make its JNI measurement
   * call; iOS measures in process and needs nothing from it. Taking it in the
   * constructor on both platforms is what keeps the header — and therefore the
   * shadow node and the component descriptor — genuinely cross-platform.
   */
}

std::shared_ptr<void> RNSMRunTextMeasurer::prepareContent(
    const SelectableRunHostProps &props,
    Float /* fontSizeMultiplier */) const
{
  /*
   * `fontSizeMultiplier` is accepted and deliberately not applied. Dynamic
   * Type is cut from this port with its hooks recorded
   * (docs/FABRIC-PLAN.md §6.2): iOS does not scale today — the old
   * `adjustsFontForContentSizeCategory = true` on the host view was a no-op,
   * because it only scales fonts built through UIFontMetrics and none of ours
   * are — and a half-done version is worse than none. Scaling the string here
   * without also re-measuring on UIContentSizeCategoryDidChangeNotification
   * would leave a surface laid out at the size it had when it was mounted and
   * drawn at the size the user has now, which is the measure/draw
   * disagreement this whole file exists to prevent.
   *
   * The parameter stays in the signature rather than being removed because
   * RNSMRunHostShadowNode memoises the prepared content keyed on this exact
   * scalar and rebuilds when it changes. The day the scaling lands, it lands
   * here and the invalidation already works.
   *
   * wrapManagedObject is the ARC-correct bridge to std::shared_ptr<void>
   * (react/utils/ManagedObjectWrapper.h:53-56): it retains once and releases
   * when the last shared_ptr goes, so the string stays alive for exactly as
   * long as the shadow node, the state and the mounting layer need it, across
   * three threads, with no manual retain anywhere.
   */
  return wrapManagedObject([RNSMAttributedText attributedStringWithProps:props]);
}

Size RNSMRunTextMeasurer::measure(
    SurfaceId /* surfaceId */,
    const std::shared_ptr<void> &content,
    const SelectableRunHostProps & /* props */,
    const LayoutConstraints &layoutConstraints,
    const LayoutContext &layoutContext) const
{
  NSAttributedString *attributedString = (NSAttributedString *)unwrapManagedObject(content);

  /*
   * An empty run is answered without touching TextKit at all. This is not
   * only an optimisation: React Native carries the same early return with the
   * comment "measuring an empty string crashes/freezes iOS internal text
   * infrastructure ... this is our last line of defense"
   * (RCTTextLayoutManager.mm:41-46). An empty run is reachable here — a
   * streamed snapshot can produce a run whose text has not arrived yet — so
   * this is a live path, not a theoretical one.
   */
  if (attributedString == nil || attributedString.length == 0) {
    return layoutConstraints.clamp(Size{0, 0});
  }

  CGSize size = [RNSMTextKitStack measureAttributedString:attributedString
                                                    width:layoutConstraints.maximumSize.width
                                         pointScaleFactor:layoutContext.pointScaleFactor];

  /*
   * Clamping is where a measured size becomes a legal one, and it is done here
   * rather than in the shadow node for the same reason React Native does it in
   * `TextLayoutManager::measure` (TextLayoutManager.mm:82) rather than in
   * `ParagraphShadowNode`: Yoga's measure connector applies no constraints of
   * its own to what a measure function returns
   * (YogaLayoutableShadowNode.cpp:841-846), so an unclamped answer is simply
   * used. Under YGMeasureModeExactly the minimum and the maximum are both the
   * assigned width, and clamping is what makes the run report the width of the
   * box it will actually be drawn in rather than the narrower width its last
   * line happens to occupy.
   */
  return layoutConstraints.clamp(Size{static_cast<Float>(size.width), static_cast<Float>(size.height)});
}

} // namespace facebook::react

#endif // RCT_NEW_ARCH_ENABLED
