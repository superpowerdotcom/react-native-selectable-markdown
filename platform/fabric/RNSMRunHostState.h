/*
 * RNSMRunHostState — the Fabric State payload for one selection host.
 *
 * WHAT STATE IS FOR HERE. The shadow node measures a run on the layout
 * thread from a styled string it builds itself; the component view then has
 * to draw the *same* string on the main thread. State is how that one object
 * gets from the one thread to the other. The alternative — the view
 * rebuilding the string from `text` + `attributes` — is a second
 * implementation of the same rendering, and the moment the two drift by half
 * a point per line the run clips its own last line. docs/FABRIC-PLAN.md §4
 * is blunt about this being the sharpest edge of the port and about nothing
 * in this repository being able to execute the check, which is exactly why
 * the design removes the opportunity rather than testing for it: there is
 * one string, it is measured and it is drawn.
 *
 * WHY std::shared_ptr<void> AND NOT NSAttributedString *. This header is
 * compiled on both platforms and by the Android NDK, which has never heard
 * of Objective-C. iOS stores `wrapManagedObject(NSAttributedString *)`
 * (react/utils/ManagedObjectWrapper.h:53-56, from React-utils, which
 * `install_modules_dependencies` already provides) — an ARC-correct
 * shared_ptr whose deleter releases the object. Android stores `nullptr`:
 * its measurement and its rendering both happen on the Java side from
 * `props.rawProps`, so there is nothing to carry and no state update is ever
 * published (RNSMRunHostShadowNode::updateStateIfNeeded short-circuits on
 * the unchanged null handle, every commit, forever). That is not a gap — it
 * is the Android half of §3.3: Fabric hands the Java ViewManager the raw
 * props, so the existing sparse `hasKey` reading works untouched and the
 * C++ layer never learns what an attribute is.
 *
 * usesMapBufferForStateData STAYS FALSE (the template argument is on
 * RNSMRunHostShadowNode). MapBuffer serialization exists for state that has
 * to cross into Java; ours never does. With it false, `ConcreteState
 * ::getMapBuffer()` returns `MapBufferBuilder::EMPTY()` without ever calling
 * into this class (react/renderer/core/ConcreteState.h:108-113), so no
 * `getMapBuffer()` is needed here. Turning it on would demand one, and the
 * only thing it could serialize is a null pointer.
 */

#ifndef SELECTABLE_MARKDOWN_RNSM_RUN_HOST_STATE_H
#define SELECTABLE_MARKDOWN_RNSM_RUN_HOST_STATE_H

#include <memory>
#include <utility>

#ifdef ANDROID
#include <folly/dynamic.h>
#endif

namespace facebook::react {

class RNSMRunHostState final {
 public:
  RNSMRunHostState() = default;

  explicit RNSMRunHostState(std::shared_ptr<void> attributedString)
      : attributedString(std::move(attributedString)) {}

  /*
   * The exact object the shadow node measured. Compared by pointer identity
   * in `updateStateIfNeeded`, which is stronger than it looks: the handle is
   * rebuilt only when the props change, and a clean clone carries it
   * forward, so pointer equality *is* "this run's content did not change" —
   * and a streamed snapshot that re-sends identical props therefore
   * publishes no state and remounts nothing.
   */
  std::shared_ptr<void> attributedString{};

#ifdef ANDROID
  /*
   * Required by `ConcreteState::updateState(folly::dynamic&&)`, which the
   * Android state-update path calls unconditionally
   * (react/renderer/core/ConcreteState.h:104-106). Nothing on the Android
   * side ever pushes state back to C++ for this component — the view is
   * measured through `FabricUIManager.measure` and rendered from raw props
   * — so this deliberately ignores `data` and produces a default state
   * rather than pretending to decode a payload nobody sends. Codegen's own
   * `States.h` emits the identical empty pair for the identical reason.
   */
  RNSMRunHostState(
      const RNSMRunHostState& /*previousState*/,
      folly::dynamic /*data*/) {}

  folly::dynamic getDynamic() const {
    return {};
  }
#endif
};

} // namespace facebook::react

#endif // SELECTABLE_MARKDOWN_RNSM_RUN_HOST_STATE_H
