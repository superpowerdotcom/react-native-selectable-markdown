/*
 * The iOS implementation of the measurement façade declared in
 * platform/fabric/RNSMRunTextMeasurer.h. Read that header first: it says why
 * this package does not measure through React Native's own TextLayoutManager,
 * and what the interface is shaped around.
 *
 * THE `#ifdef RCT_NEW_ARCH_ENABLED` BELOW IS NOT A GATE, and there is no
 * longer an architecture it could select between. The podspec adds this file
 * unconditionally and calls `install_modules_dependencies` unconditionally,
 * which is what defines the macro — so it is always true for this pod, and
 * SelectableMarkdown.podspec says why at length: from react-native 0.82,
 * which is this package's peer floor, React Native refuses to install the old
 * architecture at all. The guard stays because it costs one line and keeps
 * the file honest about what its includes need (React-Fabric, codegen's
 * Props.h, React-RCTFabric), not because anything reachable turns it off.
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
    Float fontSizeMultiplier) const
{
  /*
   * `fontSizeMultiplier` is applied, which is what makes a native run scale
   * with Dynamic Type the way the `<Text>` blocks around it always have (a
   * document that mixed the two rendered at two type sizes at once). It
   * reaches the string builder, which multiplies every font size and line
   * height by it and nothing else.
   *
   * THE THREE PIECES THAT MAKE THAT SAFE, none of which are ours:
   *
   *   - the value is a layout-context scalar, so it is the same for the
   *     measurement and for the string the mounting layer draws — they are
   *     one object here, so measure/draw agreement is untouched;
   *   - `RCTFabricSurface` refreshes it from `RCTFontSizeMultiplier()` on
   *     `UIContentSizeCategoryDidChangeNotification` and re-constrains the
   *     surface (RCTFabricSurface.mm), so a category change re-lays out the
   *     document rather than leaving it measured at the old size — the
   *     "re-measures on the notification" half docs/FABRIC-PLAN.md §6.2 asks
   *     for is React Native's, already in place;
   *   - RNSMRunHostShadowNode memoises the prepared content keyed on this
   *     exact scalar, so the rebuild happens once per category change and a
   *     streamed commit that changes nothing else still carries the handle
   *     across untouched.
   *
   * What is NOT done here is `adjustsFontForContentSizeCategory` on the host
   * view: it scales at draw time, on the main thread, against a string the
   * shadow node measured unscaled, and it is a no-op for our fonts anyway
   * (they come from `UIFont(name:size:)`, not `UIFontMetrics`). That line was
   * deleted; this is the version that works.
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
                                                    width:layoutConstraints.maximumSize.width
                                         pointScaleFactor:layoutContext.pointScaleFactor];

  /*
   * The room a box at the very EDGE of the run needs, which the text layout
   * above does not ask for and cannot: a table that closes an answer ends at
   * the last character, so its bottom border has nothing under it, and a code
   * block that opens one starts at offset 0, so its top border has nothing
   * above it. Everywhere else the padding is painted into the blank line the
   * '\n\n' block separator leaves and costs no height at all.
   *
   * READ OFF THE STRING THAT WAS JUST MEASURED, not recomputed from `props`.
   * The builder put it there (RNSMAttributedText.mm), and the host view reads
   * it back off the identical object through Fabric State — so the height
   * reported here and the offset the text is drawn at come from one value,
   * computed once. Recomputing it from props on either side would be the
   * measure/draw disagreement docs/FABRIC-PLAN.md §4 exists to make
   * impossible.
   */
  const UIEdgeInsets edgeInsets =
      [RNSMAttributedText runEdgeInsetsOfAttributedString:attributedString];
  size.height += edgeInsets.top + edgeInsets.bottom;

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
