/*
 * RNSMRunHostComponentDescriptor — the descriptor that makes
 * <SelectableRunHost> a *measuring* component.
 *
 * WHY THIS TYPE HAS TO EXIST, GIVEN THAT CODEGEN ALREADY EMITS ONE. Codegen's
 * `ComponentDescriptors.h` is
 * `using SelectableRunHostComponentDescriptor =
 *      ConcreteComponentDescriptor<SelectableRunHostShadowNode>;`
 * over a shadow node that is a plain `ConcreteViewShadowNode` — no
 * `MeasurableYogaNode` trait, no `measureContent`. Registering that one means
 * `LayoutableShadowNode::measure` falls through to its default
 * (react/renderer/core/LayoutableShadowNode.cpp:222-226 returns `{}`) and
 * every run in the document lays out at zero height. There is no smaller
 * version of this port: a Fabric component without a measuring shadow node is
 * a blank screen, not a partial feature.
 *
 * WHAT IT ADDS. Exactly one thing, and the shape is lifted from
 * `ParagraphComponentDescriptor`: build one measurer from the descriptor's
 * `ContextContainer` and hand the same instance to every node in `adopt()`.
 * One per descriptor, not one per node, because on iOS the measurer owns the
 * text-engine configuration that has to agree with the view's, and on Android
 * it holds the `FabricUIManager` global ref — neither is something a node
 * should be constructing for itself, and a per-node copy would be a per-node
 * opportunity to configure it differently.
 *
 * HOW IT GETS REGISTERED, which differs per platform and is the riskiest seam
 * in the port:
 *
 *   iOS      `+componentDescriptorProvider` on
 *            RCTSelectableRunHostComponentView returns
 *            `concreteComponentDescriptorProvider<RNSMRunHostComponentDescriptor>()`.
 *            That method is the sole iOS registration hook
 *            (React/Fabric/Mounting/RCTComponentViewFactory.mm:182-186), so
 *            codegen's descriptor is simply never mentioned.
 *
 *   Android  the app's generated `autolinking.cpp` hardcodes
 *            `#include <react/renderer/components/SelectableMarkdownSpec/ComponentDescriptors.h>`
 *            and `concreteComponentDescriptorProvider<SelectableRunHostComponentDescriptor>()`
 *            (GenerateAutolinkingNewArchitecturesFileTask.kt:96-107, :136-143).
 *            We cannot change what it writes, so we change what that include
 *            resolves to: platform/fabric/android-include/ carries an alias
 *            header of that exact path which binds the codegen name to this
 *            type, and the CMake seam puts it first on the include path.
 */

#ifndef SELECTABLE_MARKDOWN_RNSM_RUN_HOST_COMPONENT_DESCRIPTOR_H
#define SELECTABLE_MARKDOWN_RNSM_RUN_HOST_COMPONENT_DESCRIPTOR_H

#include <memory>

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/core/ShadowNode.h>

#include "RNSMRunHostShadowNode.h"
#include "RNSMRunTextMeasurer.h"

namespace facebook::react {

class RNSMRunHostComponentDescriptor final
    : public ConcreteComponentDescriptor<RNSMRunHostShadowNode> {
 public:
  RNSMRunHostComponentDescriptor(
      const ComponentDescriptorParameters& parameters)
      : ConcreteComponentDescriptor<RNSMRunHostShadowNode>(parameters) {
    /*
     * `contextContainer_` is the descriptor's own
     * (react/renderer/core/ComponentDescriptor.h:135) and outlives every
     * node it creates, which is why the measurer is built here rather than
     * lazily inside a node: a node that had to construct one would need the
     * container, and it has no way to get it.
     */
    measurer_ = std::make_shared<const RNSMRunTextMeasurer>(contextContainer_);
  }

 protected:
  void adopt(ShadowNode& shadowNode) const override {
    ConcreteComponentDescriptor::adopt(shadowNode);

    /*
     * `adopt` runs on `createShadowNode` *and* on `cloneShadowNode`
     * (ConcreteComponentDescriptor.h:66-85), so every node in the tree —
     * including the hundreds of clones a streamed answer produces — has a
     * measurer before Yoga can call its measure function. The clone
     * constructor also copies the measurer across; the two together mean
     * there is no window in which a measurable node has none.
     */
    static_cast<RNSMRunHostShadowNode&>(shadowNode).setMeasurer(measurer_);
  }

 private:
  std::shared_ptr<const RNSMRunTextMeasurer> measurer_;
};

} // namespace facebook::react

#endif // SELECTABLE_MARKDOWN_RNSM_RUN_HOST_COMPONENT_DESCRIPTOR_H
