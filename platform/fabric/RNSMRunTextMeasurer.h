/*
 * RNSMRunTextMeasurer — the platform text-measurement façade the Fabric
 * shadow node measures through.
 *
 * WHY THIS EXISTS INSTEAD OF react::TextLayoutManager. React Native already
 * ships a cross-platform measurement façade with exactly this shape, and we
 * deliberately do not use it. Adopting it means adopting `AttributedString`,
 * whose `Fragment::string` is a `std::string`
 * (react/renderer/attributedstring/AttributedString.h:39) — UTF-8. Every
 * offset in this library is UTF-16 (docs/SELECTION.md, "Offsets end to end"),
 * and docs/ARCHITECTURE.md states as a pillar that the single UTF-8↔UTF-16
 * conversion point in the codebase is platform/cpp/FlatBuffer.cpp. A second
 * conversion, on the hot path, at the exact boundary where selection offsets
 * are computed, does not fail as a rendering glitch: it fails as the library
 * silently copying the wrong markdown, which is the one thing this project
 * exists to prevent. `AttributedString` would also force our deliberately
 * sparse, overlapping attribute ranges (src/view/runAttributes.ts:126-133)
 * into a flat disjoint fragment list, and on Android it would not even
 * measure our view: that measure path is a JNI round trip hardcoded to the
 * component name "RCTText"
 * (react/renderer/textlayoutmanager/platform/android/.../TextLayoutManager.cpp:218).
 * docs/FABRIC-PLAN.md §1 is the long form of this argument.
 *
 * What we keep from TextLayoutManager is its *shape*: one header, two
 * platform implementations, constructed once per component descriptor from
 * the `ContextContainer` and shared by every node of the component. So the
 * shadow node in this directory is genuinely cross-platform — it never sees
 * an NSAttributedString, a Spannable, or a JNI call.
 *
 * The two implementations, neither of which is in this directory:
 *
 *   platform/ios/fabric/RNSMRunTextMeasurer.mm      TextKit 1, in process.
 *   android/src/main/jni/RNSMRunTextMeasurer.cpp    JNI to FabricUIManager
 *                                                   .measure(), which routes
 *                                                   by component name to our
 *                                                   own Kotlin ViewManager.
 *
 * MEASURE/DRAW AGREEMENT IS THE PROPERTY THIS INTERFACE IS SHAPED AROUND.
 * The shadow node measures on the layout thread; the view draws on the main
 * thread. If the two use different text engines they disagree, and the
 * symptom is text clipped at the bottom of a run — a rendering bug, not a
 * build error, that gets worse with line count and cannot be reproduced by
 * anything in this repository (docs/FABRIC-PLAN.md §4.3 specifies the two
 * device tests that would catch it). The mechanism that makes disagreement
 * structurally impossible is that `prepareContent` returns the *object the
 * view will draw*, not a description of it: on iOS that is the exact
 * NSAttributedString, carried to the mounting layer through Fabric State
 * (RNSMRunHostState) rather than rebuilt there from the same inputs.
 */

#ifndef SELECTABLE_MARKDOWN_RNSM_RUN_TEXT_MEASURER_H
#define SELECTABLE_MARKDOWN_RNSM_RUN_TEXT_MEASURER_H

#include <memory>

#include <react/renderer/components/SelectableMarkdownSpec/Props.h>
#include <react/renderer/core/LayoutConstraints.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ReactPrimitives.h>
#include <react/renderer/graphics/Float.h>
#include <react/renderer/graphics/Size.h>
#include <react/utils/ContextContainer.h>

namespace facebook::react {

class RNSMRunTextMeasurer {
 public:
  RNSMRunTextMeasurer(
      const std::shared_ptr<const ContextContainer>& contextContainer);

  /*
   * Not copyable and not movable, for the same reason `TextLayoutManager`
   * is neither: exactly one instance exists per component descriptor and
   * every shadow node holds a `shared_ptr` to it. A copy would silently
   * give some subtree of the document a second measurer, and on iOS a
   * second measurer means a second text-engine configuration — the
   * measure/draw disagreement above, reintroduced by an accidental copy.
   */
  RNSMRunTextMeasurer(const RNSMRunTextMeasurer&) = delete;
  RNSMRunTextMeasurer& operator=(const RNSMRunTextMeasurer&) = delete;
  RNSMRunTextMeasurer(RNSMRunTextMeasurer&&) = delete;
  RNSMRunTextMeasurer& operator=(RNSMRunTextMeasurer&&) = delete;

  /*
   * Builds the platform payload for one run and returns it as an opaque
   * handle. iOS returns `wrapManagedObject(NSAttributedString *)`; Android
   * returns `nullptr`, because its measurement takes the props across JNI
   * as a `ReadableNativeMap` and the string is built on the Java side by
   * the same `RunAttributedText.build` the view draws with.
   *
   * `std::shared_ptr<void>` rather than a platform type is what keeps this
   * header, the shadow node and the state object compiling identically on
   * both platforms — the same trick `TextLayoutManager::self_` uses. The
   * handle is opaque *here*; the mounting layer that unwraps it is the same
   * code that wrapped it, so nothing ever guesses at what is inside.
   *
   * `fontSizeMultiplier` comes from `LayoutContext::fontSizeMultiplier`
   * (react/renderer/core/LayoutContext.h:55) and is taken separately rather
   * than read off the context inside, because it is the *only* part of the
   * layout context the content depends on — which is precisely what lets
   * RNSMRunHostShadowNode memoise the prepared content on that one scalar
   * and carry it across a clone.
   *
   * It is the Dynamic Type scale, and the two implementations apply it in
   * the two places their platforms put it: iOS multiplies every font size
   * and line height by it while building the string, and Android ignores the
   * parameter because its builder sizes in SP (`PixelUtil.toPixelFromSP`,
   * RunAttributedText.kt), which the platform scales by the same system font
   * scale. Both therefore render a run at the user's text size, which is
   * what the `<Text>` blocks around a run have always done.
   */
  std::shared_ptr<void> prepareContent(
      const SelectableRunHostProps& props,
      Float fontSizeMultiplier) const;

  /*
   * Measures a prepared content handle against `layoutConstraints`.
   *
   * THE ANSWER IS THE RUN'S HEIGHT, NOT ITS TEXT'S. Both implementations add
   * the vertical room a box decoration at the very EDGE of the run needs — a
   * table that closes an answer has nothing under its bottom border, a code
   * block that opens one has nothing above its top border, and everywhere
   * else a box's padding is painted into the blank line the projection's
   * '\n\n' block separator leaves and costs no height at all. The two hosts
   * offset their text by the same amount so it lands inside that room
   * (`RNSMAttributedText.runEdgeInsets(of:)` on iOS,
   * `RunDecorations.edgePaddingDp` on Android), and each platform derives it
   * ONCE, from the artefact its measure and draw paths already share: the
   * prepared string on iOS, the one decorations parser on Android.
   *
   * `surfaceId` is not decoration. Android's implementation is a call to
   * `FabricUIManager.measure(surfaceId, componentName, …)`
   * (ReactAndroid/.../fabric/FabricUIManager.java:549-585), which needs the
   * surface to find the themed `Context` the measurement must use, and a
   * surface id is a property of the shadow node's family — it is reachable
   * from neither `props` nor `content`. `AndroidSwitchMeasurementsManager
   * ::measure(SurfaceId, LayoutConstraints)` takes it for the same reason.
   * docs/FABRIC-PLAN.md §7 G2.1 omits it, and the signature it specifies
   * cannot implement the Android measurer §4.2 specifies; this parameter is
   * the correction.
   *
   * `props` is here for Android, which forwards `props.rawProps` — the
   * exact folly::dynamic of the JS props, populated by `Props::initialize`
   * under `#ifdef ANDROID` (react/renderer/core/Props.cpp:30-32) — straight
   * across JNI, so its `hasKey`-based sparse reading and its
   * forward-compatible "skip a key this binary does not know" degradation
   * keep working unchanged on Fabric. iOS ignores it: everything it needs
   * is already baked into `content`.
   *
   * `layoutContext` is React Native's `LayoutContext`, NOT its
   * `TextLayoutContext`. That is a deliberate substitution and it is the
   * one place this file departs from docs/FABRIC-PLAN.md §7 G2.1.
   * `react/renderer/textlayoutmanager/TextLayoutContext.h` ships only in
   * the `React-FabricComponents` pod (ReactCommon/React-FabricComponents
   * .podspec:178-187) — the pod §2.2 refuses to depend on — and on Android
   * it lives in `react_render_textlayoutmanager`, which RN's generated
   * `react_codegen_<lib>` target does not link. Including it would be a
   * header-not-found on both platforms in a real app while compiling fine
   * against a full node_modules checkout. `LayoutContext` is in
   * `react/renderer/core/`, is already the object `measureContent`
   * receives, and carries both scalars measurement depends on
   * (`pointScaleFactor`, `fontSizeMultiplier`), so nothing is lost.
   */
  Size measure(
      SurfaceId surfaceId,
      const std::shared_ptr<void>& content,
      const SelectableRunHostProps& props,
      const LayoutConstraints& layoutConstraints,
      const LayoutContext& layoutContext) const;

 private:
  /*
   * Android reads `"FabricUIManager"` out of this to get the global ref it
   * calls `measure` on; iOS never touches it. Stored rather than passed per
   * call because the descriptor owns the container's lifetime and a shadow
   * node does not have one to hand.
   */
  std::shared_ptr<const ContextContainer> contextContainer_;
};

} // namespace facebook::react

#endif // SELECTABLE_MARKDOWN_RNSM_RUN_TEXT_MEASURER_H
