/*
 * The iOS implementation of the measurement façade declared in
 * platform/fabric/RNSMRunTextMeasurer.h. Read that header first: it says why
 * this package does not measure through React Native's own TextLayoutManager,
 * and what the interface is shaped around.
 *
 * The `#ifdef RCT_NEW_ARCH_ENABLED` below is always true at the react-native
 * >= 0.82 floor; it only states what the includes need.
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
#include <cmath>

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
    Float fontSizeMultiplier) const
{
  /*
   * RCTFabricSurface re-lays out the surface on a content size category change,
   * and RNSMRunHostShadowNode memoises this content on the multiplier. Do not
   * add `adjustsFontForContentSizeCategory` to the host view: it rescales at
   * draw time against the string measured here.
   *
   * wrapManagedObject is the ARC-correct bridge to std::shared_ptr<void>
   * (react/utils/ManagedObjectWrapper.h:53-56): it retains once and releases
   * when the last shared_ptr goes, so the string stays alive for exactly as
   * long as the shadow node, the state and the mounting layer need it, across
   * three threads, with no manual retain anywhere.
   */
  return wrapManagedObject([RNSMAttributedText attributedStringWithProps:props
                                                      fontSizeMultiplier:fontSizeMultiplier]);
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
                                                    width:layoutConstraints.maximumSize.width];

  // Read off the measured string, never recomputed from props, so the host's
  // text offset matches the height reported here.
  const UIEdgeInsets edgeInsets =
      [RNSMAttributedText runEdgeInsetsOfAttributedString:attributedString];
  const Float scale = layoutContext.pointScaleFactor > 0 ? layoutContext.pointScaleFactor : 1;
  size.width = std::ceil(size.width * scale) / scale;
  size.height = std::ceil((size.height + edgeInsets.top + edgeInsets.bottom) * scale) / scale;

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
