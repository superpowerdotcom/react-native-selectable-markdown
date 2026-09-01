/*
 * ShadowNodes.h — ANDROID ONLY. This header deliberately shadows the one
 * React Native's codegen generates at the same path.
 *
 * READ THIS BEFORE PUTTING platform/fabric/android-include ON ANY INCLUDE
 * PATH. It must never appear on the iOS one. On iOS the codegen'd
 * `ShadowNodes.h` is compiled by the `ReactCodegen` pod and is genuinely
 * used; there is nothing to shadow, because iOS registers our descriptor
 * directly through `+componentDescriptorProvider` and never names the
 * generated alias. Adding this directory there would only create a second
 * definition of `SelectableRunHostShadowNode` for no gain.
 *
 * WHY SHADOWING IS THE MECHANISM. On Android the app's generated
 * `autolinking.cpp` is written by React Native, not by us, and it hardcodes
 * `#include <react/renderer/components/SelectableMarkdownSpec/ComponentDescriptors.h>`
 * plus a `concreteComponentDescriptorProvider<SelectableRunHostComponentDescriptor>()`
 * call (GenerateAutolinkingNewArchitecturesFileTask.kt:96-107, :136-143).
 * Codegen's version of that name is
 * `ConcreteComponentDescriptor<ConcreteViewShadowNode<…>>` — a node with no
 * measure function, which lays every run out at zero height. There is no
 * hook to override it, so the only way to make the app register the
 * measuring descriptor is to make the name it already writes mean ours.
 *
 * WHY IT WORKS. Every file React Native's codegen generates reaches its own
 * headers through *angle-bracket* includes — the generated `ShadowNodes.cpp`
 * opens with `#include <react/renderer/components/SelectableMarkdownSpec/ShadowNodes.h>`,
 * not a quoted include — so `-I` order alone decides which file wins, and
 * `android/src/main/jni/CMakeLists.txt` puts this directory first with
 * `target_include_directories(... BEFORE ...)`. `npm run check:fabric-cpp`
 * compiles React Native's own generated `.cpp` files against this directory
 * to prove the substitution is complete, and `npm run check:codegen` asserts
 * the generated sources still use angle brackets.
 *
 * WHY IT IS A RISK WORTH NAMING. Nobody at Meta promised that generated
 * include style, and nothing prevents a future React Native from emitting a
 * quoted include or restructuring the output directory.
 *
 * Both halves of that now fire at configure time in the *consuming app*, and
 * they are two separate `FATAL_ERROR`s in android/src/main/jni/CMakeLists.txt
 * because they fail differently. Restructuring is caught by the `EXISTS`
 * check on the generated tree. A changed include style is caught by
 * `smd_require_angle_include`, which reads the generated sources and asserts
 * the exact angle-bracket spelling — and it has to, because a quoted sibling
 * include leaves every other assertion in that file true while quietly
 * resolving to codegen's non-measuring header. For a while the comment here
 * claimed the guard covered both and only the first was implemented; the
 * uncovered half was the silent one.
 *
 * docs/FABRIC-PLAN.md §2.3 records the fallback: declare
 * `react_codegen_SelectableMarkdownSpec` ourselves, compile only the
 * generated `Props.cpp`/`EventEmitters.cpp`, and supply the component-name
 * definition by hand. This is §9 risk 2, and it is the one piece of this port
 * that can break other people's builds.
 *
 * The alias below is the entire substitution. Everything codegen's version
 * declares is still declared, at the same names, with the same includes, so a
 * translation unit that included the generated header cannot tell the
 * difference — except that its shadow node now measures.
 */

#ifndef SELECTABLE_MARKDOWN_ANDROID_ALIAS_SHADOW_NODES_H
#define SELECTABLE_MARKDOWN_ANDROID_ALIAS_SHADOW_NODES_H

#include <RNSMRunHostShadowNode.h>
#include <react/renderer/components/SelectableMarkdownSpec/EventEmitters.h>
#include <react/renderer/components/SelectableMarkdownSpec/Props.h>
#include <react/renderer/components/SelectableMarkdownSpec/States.h>

namespace facebook::react {

/*
 * `SelectableRunHostComponentName` itself is NOT redeclared here — it is
 * declared by RNSMRunHostShadowNode.h above, in exactly the spelling codegen
 * uses, and still *defined* by codegen's own `ShadowNodes.cpp`, which is
 * compiled into `react_codegen_SelectableMarkdownSpec` unchanged. That file
 * includes this one, so this alias is what it compiles against.
 */
using SelectableRunHostShadowNode = RNSMRunHostShadowNode;

} // namespace facebook::react

#endif // SELECTABLE_MARKDOWN_ANDROID_ALIAS_SHADOW_NODES_H
