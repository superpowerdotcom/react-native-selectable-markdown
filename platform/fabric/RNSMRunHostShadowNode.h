/*
 * RNSMRunHostShadowNode — the measuring Fabric shadow node for
 * <SelectableRunHost>.
 *
 * WHY THE WHOLE PORT EXISTS. A view that measures itself after layout renders
 * at least one frame at the wrong height, continuously while streaming
 * (docs/FABRIC-PLAN.md "Why do this at all").
 * `measureContent` below runs on the layout thread before the frame is
 * committed, so the first frame is the correct frame.
 *
 * WHY IT IS NOT A SUBCLASS OF ParagraphShadowNode. It cannot be —
 * `ParagraphShadowNode` is `final`
 * (react/renderer/components/text/ParagraphShadowNode.h:30-35) — and it
 * should not be, for the reasons in RNSMRunTextMeasurer.h: our content is a
 * sparse, overlapping attribute array over a UTF-16 projected text, not an
 * `AttributedString` of disjoint UTF-8 fragments. What this class does copy
 * from `ParagraphShadowNode` is its *cost* structure, function for function,
 * and each copied piece is commented with the failure it prevents rather
 * than with the fact that Paragraph does it too.
 *
 * WHY THE NAME IS RNSM… AND NOT SelectableRunHostShadowNode. Codegen emits
 * `using SelectableRunHostShadowNode = ConcreteViewShadowNode<…>` — a
 * *non-measurable* alias — and on Android we take that name over by putting
 * platform/fabric/android-include earlier on the include path. Naming our
 * class something codegen never emits means a translation unit that somehow
 * sees both headers gets two distinct types instead of a redefinition error,
 * and it makes the seam exactly one grep wide.
 */

#ifndef SELECTABLE_MARKDOWN_RNSM_RUN_HOST_SHADOW_NODE_H
#define SELECTABLE_MARKDOWN_RNSM_RUN_HOST_SHADOW_NODE_H

#include <memory>
#include <optional>

#include <jsi/jsi.h>
#include <react/renderer/components/SelectableMarkdownSpec/EventEmitters.h>
#include <react/renderer/components/SelectableMarkdownSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/core/LayoutConstraints.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>
#include <react/renderer/core/ShadowNodeFragment.h>
#include <react/renderer/graphics/Float.h>
#include <react/renderer/graphics/Size.h>

#include "RNSMRunHostState.h"
#include "RNSMRunTextMeasurer.h"

namespace facebook::react {

/*
 * Declared here, defined by codegen's generated `ShadowNodes.cpp` as
 * `extern const char SelectableRunHostComponentName[] = "SelectableRunHost";`.
 * We declare it ourselves rather than including codegen's `ShadowNodes.h`
 * because on Android that header is the one this package replaces — including
 * it from here would be a cycle. The spelling is byte-identical to codegen's
 * (GenerateShadowNodeH.js), which is what keeps the two declarations
 * compatible in whichever translation unit ends up seeing both.
 *
 * The string must stay exactly "SelectableRunHost". An `RCT` prefix would be
 * stripped by `componentNameByReactViewName`
 * (react/renderer/componentregistry/componentNameByReactViewName.cpp:13-70),
 * so C++ would look up the bare name while codegen's iOS lookup map stayed
 * keyed on the prefixed one, and the two would never meet.
 */
JSI_EXPORT extern const char SelectableRunHostComponentName[];

class RNSMRunHostShadowNode final : public ConcreteViewShadowNode<
                                        SelectableRunHostComponentName,
                                        SelectableRunHostProps,
                                        SelectableRunHostEventEmitter,
                                        RNSMRunHostState> {
 public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  /*
   * THE CLONE CONSTRUCTOR IS NOT AN OPTIMISATION. Without it,
   * `YogaLayoutableShadowNode`'s clone constructor force-dirties every clone
   * of a `MeasurableYogaNode`
   * (react/renderer/components/view/YogaLayoutableShadowNode.cpp:133-136) —
   * unconditionally, because for a node whose size comes from a measure
   * function Yoga cannot know whether anything changed. So appending one
   * streamed token, which clones the path to the tail run and nothing else,
   * would re-measure *every* run in the document: the same O(n²) shape
   * `StreamSession`'s settled-prefix machinery exists to avoid, reintroduced
   * one layer down where none of that machinery can see it. On a long
   * answer that is a full-document text layout per token.
   *
   * The guard is the one `ParagraphShadowNode` carries for the identical
   * reason: if neither props nor children came in on the fragment and the
   * source was already laid out clean, this clone is the same node and stays
   * clean.
   *
   * HOW THE GUARD IS EXPRESSED DEPENDS ON THE REACT NATIVE, because the peer
   * range spans an API break, and exactly one of two mechanisms compiles to
   * anything on a given header set:
   *
   * - 0.75-era (`npm run check:fabric-cpp` compiles against these): the base
   *   clone constructor force-dirties every `MeasurableYogaNode`, and
   *   `ParagraphShadowNode` undoes it afterwards with `cleanLayout()`
   *   (ParagraphShadowNode.cpp:29-42 at 0.75.4). We do the same through a
   *   detection template (`keepLayoutCleanAcrossClone`, .cpp) rather than a
   *   bare call, because `cleanLayout()` was deleted from
   *   `LayoutableShadowNode` by 0.86 and an inline call is
   *   `use of undeclared identifier` there.
   *
   * - React Native 0.82+: completeClone asks
   *   shouldNewRevisionDirtyMeasurement; like ParagraphShadowNode, we answer
   *   fragment.props != nullptr.
   *
   * It also does something Paragraph cannot. Paragraph's content is built
   * from its *children*, so a clone must rebuild it; ours is a pure function
   * of props, so when the fragment carries no props the prepared content and
   * the last measurement carry across untouched — no string building, no
   * platform round trip, for a clone that changed nothing about this run.
   */
  RNSMRunHostShadowNode(
      const ShadowNode& sourceShadowNode,
      const ShadowNodeFragment& fragment);

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    /*
     * `LeafYogaNode` is a hard prerequisite of `MeasurableYogaNode`, not a
     * pairing convention: `YogaLayoutableShadowNode`'s constructor asserts
     * it before installing the measure function
     * (YogaLayoutableShadowNode.cpp:76-82). It is also true — this host
     * renders text and never lays out React children.
     */
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);

#ifdef ANDROID
    /*
     * Android draws the run into a `TextView`; views cannot be mounted
     * inside one, so this node must not form a stacking context that the
     * mounting layer would then try to fill with child views. Same reason,
     * same `#ifdef`, as `ParagraphShadowNode::BaseTraits`.
     */
    traits.unset(ShadowNodeTraits::Trait::FormsStackingContext);
#endif

    return traits;
  }

  /*
   * Associates the descriptor's single shared measurer with this node. Called
   * from `RNSMRunHostComponentDescriptor::adopt`, i.e. on every created and
   * every cloned node, before anything can measure.
   */
  void setMeasurer(std::shared_ptr<const RNSMRunTextMeasurer> measurer);

#pragma mark - LayoutableShadowNode

  /*
   * Publishes state and DOES NOT MEASURE.
   *
   * `ParagraphShadowNode::layout` re-measures at the final size, but only
   * because it has to position attachments (inline views inside text), and
   * it guards that second measure behind the `preventDoubleTextMeasure`
   * feature flag (ParagraphShadowNode.cpp:183-209). We DO have attachments
   * now — an embed reserves its declared rect at a U+FFFC placeholder
   * (RNSMEmbedAttachment on iOS, a ReplacementSpan on Android) — but nothing
   * about them is positioned HERE: the reservation is part of the measured
   * string itself, and where it landed is reported by the host VIEW after
   * mount through the `onEmbedLayout` event, which is what JS positions the
   * overlay from (docs/SELECTION.md, "Event: onEmbedLayout"). So there is
   * still nothing for layout() to position, the second measure would still
   * be pure cost on every commit, and we still do not acquire a dependency
   * on `react_featureflags` to decide about it.
   */
  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

  /*
   * The prepared platform payload plus the one layout-context scalar it was
   * prepared with. Keeping the multiplier next to the handle is what makes
   * carrying content across a clone safe: a surface whose
   * `fontSizeMultiplier` changed gets a rebuild, everything else gets the
   * pointer.
   */
  class Content final {
   public:
    std::shared_ptr<void> handle;
    Float fontSizeMultiplier{1.0};
  };

 protected:
  bool shouldNewRevisionDirtyMeasurement(
      const ShadowNode& sourceShadowNode,
      const ShadowNodeFragment& fragment) const override;

 private:
  /*
   * True when at least one half of the clone guard is reachable on this
   * header set — see the clone-constructor comment. A member template, and
   * both of those words are load-bearing: the probes must be *dependent*
   * expressions, because in a non-dependent context an ill-formed expression
   * inside `requires` is a hard error rather than `false` (which on 0.75
   * headers is `no member named 'shouldNewRevisionDirtyMeasurement'` — the
   * exact failure mode this probe exists to report politely); and it must be
   * a *member*, because the 0.86 hook is protected, protected access from a
   * non-member context is a substitution failure, and a free probe would
   * therefore answer `false` on exactly the header set where the hook is
   * real. `Node` is always this class and `Base` always
   * `YogaLayoutableShadowNode`; they are parameters only to make the
   * expressions dependent.
   */
  template <typename Node, typename Base>
  static constexpr bool cloneGuardIsLive() {
    constexpr bool baseHasCleanLayout =
        requires(Node& node) { node.cleanLayout(); };
    constexpr bool baseHasDirtyMeasurementHook = requires(
        const Node& node,
        const ShadowNode& sourceNode,
        const ShadowNodeFragment& cloneFragment) {
      node.Base::shouldNewRevisionDirtyMeasurement(sourceNode, cloneFragment);
    };
    return baseHasCleanLayout || baseHasDirtyMeasurementHook;
  }

  /*
   * Builds (if needed) and returns a reference to the `Content`.
   */
  const Content& getContent(const LayoutContext& layoutContext) const;

  /*
   * Publishes `content` as State unless the state already holds it.
   */
  void updateStateIfNeeded(const Content& content);

  /*
   * One measurement, remembered.
   *
   * Yoga calls `measureContent` several times per layout pass with different
   * constraints and modes, and on Android every call is a JNI round trip
   * that ends in a `StaticLayout` build. Keying on the constraints plus
   * `pointScaleFactor` (the other input the platform measurers round
   * against) makes the repeats free. The memo is dropped whenever the
   * content is rebuilt, so it can never answer for a string that no longer
   * exists.
   */
  class Measurement final {
   public:
    LayoutConstraints layoutConstraints;
    Float pointScaleFactor{1.0};
    Size size;
  };

  std::shared_ptr<const RNSMRunTextMeasurer> measurer_;
  mutable std::optional<Content> content_{};
  mutable std::optional<Measurement> lastMeasurement_{};
};

} // namespace facebook::react

#endif // SELECTABLE_MARKDOWN_RNSM_RUN_HOST_SHADOW_NODE_H
