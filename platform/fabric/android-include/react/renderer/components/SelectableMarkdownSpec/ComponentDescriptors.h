/*
 * ComponentDescriptors.h — ANDROID ONLY. Shadows codegen's generated header
 * at this path; the mechanism, the reason and the risk are written out at
 * length in the sibling ShadowNodes.h.
 *
 * This is the one that actually changes what the app does. The generated
 * `autolinking.cpp` includes exactly this path and then writes
 * `providerRegistry->add(concreteComponentDescriptorProvider<SelectableRunHostComponentDescriptor>())`,
 * so the type this header binds that name to is the descriptor the app
 * registers — codegen's non-measurable one if this file is not on the include
 * path first, ours if it is. The difference between the two is a document
 * that renders and a document laid out at zero height.
 */

#ifndef SELECTABLE_MARKDOWN_ANDROID_ALIAS_COMPONENT_DESCRIPTORS_H
#define SELECTABLE_MARKDOWN_ANDROID_ALIAS_COMPONENT_DESCRIPTORS_H

#include <memory>

#include <RNSMRunHostComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/components/SelectableMarkdownSpec/ShadowNodes.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {

using SelectableRunHostComponentDescriptor = RNSMRunHostComponentDescriptor;

/*
 * Declared, not defined: codegen's generated `ComponentDescriptors.cpp` is
 * still compiled into `react_codegen_SelectableMarkdownSpec` and still
 * provides the body. Its body is `registry->add(
 * concreteComponentDescriptorProvider<SelectableRunHostComponentDescriptor>())`,
 * which — because that file includes this header — now registers ours.
 *
 * Dropping this declaration would not be a compile error in *our* code; it
 * would be an undefined symbol in whatever calls the registration entry
 * point, discovered at link time in a consuming app. It stays for that
 * reason alone.
 */
void SelectableMarkdownSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);

} // namespace facebook::react

#endif // SELECTABLE_MARKDOWN_ANDROID_ALIAS_COMPONENT_DESCRIPTORS_H
