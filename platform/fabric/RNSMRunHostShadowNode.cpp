/*
 * RNSMRunHostShadowNode.cpp — see RNSMRunHostShadowNode.h for why each of
 * these functions exists at all. This file is the cost model: what gets
 * rebuilt, what gets remembered, and what is deliberately never done.
 */

#include "RNSMRunHostShadowNode.h"

#include <utility>

#include <react/debug/react_native_assert.h>

namespace facebook::react {

namespace {

/*
 * The 0.75-era half of the clone guard — see the constructor comment in the
 * header for the two-mechanism shape. `cleanLayout()` was deleted from
 * `LayoutableShadowNode` somewhere between 0.75 and 0.86, so the call cannot
 * appear in a plain function body: on newer headers it is exactly the
 * `use of undeclared identifier` this template exists to avoid. Inside a
 * template the requires-expression is dependent, so the branch is discarded
 * (not compiled) where the API no longer exists, and compiled where it does.
 * Both members probed here are public on every header set that has them.
 */
template <typename Node>
void keepLayoutCleanAcrossClone(
    Node& node,
    const Node& source,
    const ShadowNodeFragment& fragment) {
  if constexpr (requires {
                  node.cleanLayout();
                  source.getIsLayoutClean();
                }) {
    if (!fragment.children && !fragment.props && source.getIsLayoutClean()) {
      node.cleanLayout();
    }
  }
}

} // namespace

RNSMRunHostShadowNode::RNSMRunHostShadowNode(
    const ShadowNode& sourceShadowNode,
    const ShadowNodeFragment& fragment)
    : ConcreteViewShadowNode(sourceShadowNode, fragment) {
  const auto& source =
      static_cast<const RNSMRunHostShadowNode&>(sourceShadowNode);

  /*
   * The descriptor's `adopt()` runs immediately after every clone and would
   * set this anyway. Carrying it here as well means the node is never, even
   * momentarily, a measurable node without a measurer — which matters
   * because the failure of that state is a null dereference on the layout
   * thread, not a diagnosable error.
   */
  measurer_ = source.measurer_;

  /*
   * Content is a pure function of props, so a fragment that carries no props
   * cannot have changed it. This is the clone that streaming produces by the
   * hundred: a new snapshot re-renders the tree, every settled run's element
   * is referentially identical (src/view/SelectableMarkdown.tsx memoises per
   * run), and React clones the path to the changed tail without new props for
   * anything above it. Carrying the handle over means those clones do no
   * string building and no platform round trip at all.
   *
   * `lastMeasurement_` rides along for the same reason: it is keyed on the
   * constraints and the pixel scale, both of which survive a clone, and it is
   * only ever valid for the content it was taken from — which is why it is
   * dropped in lockstep with the content in `getContent`.
   */
  if (!fragment.props) {
    content_ = source.content_;
    lastMeasurement_ = source.lastMeasurement_;
  }

  /*
   * And the guard itself — see the header for why removing it costs a
   * full-document re-measure per streamed token, and for why it exists in
   * two shapes. On 0.75-era headers the base clone constructor has already
   * force-dirtied this node and the helper undoes it, condition for
   * condition the same as `ParagraphShadowNode`'s guard there
   * (ParagraphShadowNode.cpp:33-41). On 0.86-era headers the helper compiles
   * to nothing: the cloned yoga node inherits the source's dirty flag, and
   * the decision has moved to `shouldNewRevisionDirtyMeasurement` below,
   * which the base consults from `completeClone` — run by the component
   * descriptor after construction, so virtual dispatch reaches it.
   *
   * `fragment.children` is in the test even though this is a `LeafYogaNode`
   * that never has any. Paragraph tests it for a real reason — its content
   * comes from its children — and matching it exactly is worth more than
   * dropping a term that is always false anyway: the day this node stops
   * being a leaf, the guard is already right.
   */
  keepLayoutCleanAcrossClone(*this, source, fragment);

  /*
   * The tripwire for the day React Native changes shape a second time. If
   * neither mechanism is detectable, every clone of this measurable node is
   * force-dirtied and streaming degrades to a full-document re-measure per
   * token — silently, with no error anywhere, which is why this must be a
   * compile error and not a runtime observation. The probe's own shape is
   * explained where it is declared (the header): the qualified call inside it
   * probes the *base's* declaration, because unqualified lookup would find
   * ours and prove nothing.
   */
  static_assert(
      cloneGuardIsLive<RNSMRunHostShadowNode, YogaLayoutableShadowNode>(),
      "Neither cleanLayout() nor shouldNewRevisionDirtyMeasurement() is "
      "reachable on this React Native, so every clone of this node would "
      "re-measure the whole document per streamed token. Find the current "
      "clean-clone idiom in YogaLayoutableShadowNode and wire it up here.");
}

/*
 * The 0.86-era half of the clone guard. `ParagraphShadowNode` answers the
 * same way (ParagraphShadowNode.cpp:64-68), and for the same reason this
 * node's content carry-over is keyed on props alone: content is a pure
 * function of props, so a revision that brought no props cannot have changed
 * what is measured. New children force a dirty in the base before this hook
 * is even asked (YogaLayoutableShadowNode::completeClone).
 */
bool RNSMRunHostShadowNode::shouldNewRevisionDirtyMeasurement(
    const ShadowNode& /*sourceShadowNode*/,
    const ShadowNodeFragment& fragment) const {
  return fragment.props != nullptr;
}

void RNSMRunHostShadowNode::setMeasurer(
    std::shared_ptr<const RNSMRunTextMeasurer> measurer) {
  ensureUnsealed();
  measurer_ = std::move(measurer);
}

const RNSMRunHostShadowNode::Content& RNSMRunHostShadowNode::getContent(
    const LayoutContext& layoutContext) const {
  /*
   * Exact float equality is the right test here and not a sloppy one: the
   * multiplier is a value copied through the layout context unchanged from
   * `RCTFabricSurface`, so "same value" really is bit-identical, and any
   * difference at all has to rebuild. A tolerance would mean rendering the
   * previous accessibility text size.
   */
  if (content_.has_value() &&
      content_->fontSizeMultiplier == layoutContext.fontSizeMultiplier) {
    return content_.value();
  }

  ensureUnsealed();

  react_native_assert(measurer_);

  content_ = Content{
      measurer_->prepareContent(
          getConcreteProps(), layoutContext.fontSizeMultiplier),
      layoutContext.fontSizeMultiplier};

  // The memo below answers for a specific content handle. Rebuilding the
  // content without dropping it would return the old run's height for the new
  // run's text — a clipped or over-tall run that no error reports.
  lastMeasurement_.reset();

  return content_.value();
}

void RNSMRunHostShadowNode::updateStateIfNeeded(const Content& content) {
  ensureUnsealed();

  /*
   * Pointer identity, because the handle is rebuilt only when props change
   * and is carried verbatim across a clone otherwise. So this is "the content
   * did not change", and skipping the state update means a streamed snapshot
   * that re-sends identical props publishes nothing and remounts nothing.
   * `ParagraphShadowNode::updateStateIfNeeded` (:117-131) short-circuits on
   * the same question, by value, because it has no stable handle to compare.
   *
   * On Android the handle is always `nullptr` (RNSMRunHostState.h explains
   * why), so this returns on every commit and no state is ever published.
   * That is correct, not a missing case: the Android view is rendered from
   * `props.rawProps` on the Java side and has nothing to receive.
   */
  if (getStateData().attributedString == content.handle) {
    return;
  }

  setStateData(RNSMRunHostState{content.handle});
}

#pragma mark - LayoutableShadowNode

Size RNSMRunHostShadowNode::measureContent(
    const LayoutContext& layoutContext,
    const LayoutConstraints& layoutConstraints) const {
  const auto& content = getContent(layoutContext);

  /*
   * Yoga calls this several times in one pass — at least once to find the
   * intrinsic width and once at the resolved width, more when a flex line
   * has to be resolved. On Android each call is a JNI round trip ending in a
   * `StaticLayout`; on iOS it is a full TextKit layout of the run. Answering
   * the repeats from the memo is the difference between measuring a document
   * once per commit and measuring it three or four times.
   */
  if (lastMeasurement_.has_value() &&
      lastMeasurement_->layoutConstraints == layoutConstraints &&
      lastMeasurement_->pointScaleFactor == layoutContext.pointScaleFactor) {
    return lastMeasurement_->size;
  }

  /*
   * A null measurer means this node was created by a descriptor that is not
   * `RNSMRunHostComponentDescriptor` — on Android, that the include-order
   * seam in android/src/main/jni/CMakeLists.txt did not take and codegen's
   * own non-measurable descriptor got registered instead (docs/FABRIC-PLAN.md
   * §2.3, §9 risk 2). Asserting is deliberate: the alternative, returning
   * `{}`, is a document that lays out at zero height with no error anywhere,
   * which is the single hardest failure of this port to diagnose from a bug
   * report. `ParagraphShadowNode` takes the same position.
   */
  react_native_assert(measurer_);

  auto size = measurer_->measure(
      getSurfaceId(),
      content.handle,
      getConcreteProps(),
      layoutConstraints,
      layoutContext);

  /*
   * NO `ensureUnsealed()` HERE, AND THAT IS DELIBERATE — every other mutation
   * in this class has one, so the absence needs a reason on the record before
   * someone "restores" it.
   *
   * `ensureUnsealed()` is `react_native_assert(!getSealed())`: a debug-build
   * abort, nothing in release. Adding it would claim that reaching this line on
   * a sealed node is a bug worth crashing a consumer's debug build over, and
   * that claim cannot be supported. `getContent` above does assert, because it
   * rebuilds the content handle — but only on the miss path, exactly like
   * `ParagraphShadowNode::getContent` (:44-67), so a memo hit followed by this
   * write already reaches here without one.
   *
   * The reason the write is safe is structural rather than asserted. Layout
   * never reaches a sealed node: `YogaLayoutableShadowNode::configureYogaTree`
   * (:475-495) routes every child the parent does not own through
   * `cloneChildInPlace` (:514-531), which replaces it with a fresh unsealed
   * clone before Yoga's measure callback can touch it, and a child the parent
   * *does* own was created in this generation and is unsealed by construction.
   * `ParagraphShadowNode` relies on the same property for its own `mutable`
   * content memo and asserts nothing at this point either.
   *
   * If that ever stops holding, the symptom is a data race on a cache — two
   * threads measuring one shared node — and the fix is not an assert here but
   * `cloneChildInPlace` no longer covering the case, which would break far more
   * than this node.
   */
  lastMeasurement_ =
      Measurement{layoutConstraints, layoutContext.pointScaleFactor, size};

  return size;
}

void RNSMRunHostShadowNode::layout(LayoutContext layoutContext) {
  ensureUnsealed();

  /*
   * No measure, and no call up to `YogaLayoutableShadowNode::layout` either:
   * that walks `yogaLayoutableChildren_` to lay children out, and this node
   * is a `LeafYogaNode` that has none. All that is left to do at layout time
   * is hand the mounting layer the object that was measured.
   */
  updateStateIfNeeded(getContent(layoutContext));
}

} // namespace facebook::react
