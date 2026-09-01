/*
 * States.h — ANDROID ONLY. Shadows codegen's generated header at this path;
 * the mechanism, the reason and the risk are all written out at length in the
 * sibling ShadowNodes.h and are not repeated here.
 *
 * This one exists purely so the substitution is *consistent*. Our shadow node
 * is `ConcreteViewShadowNode<…, RNSMRunHostState>`, so if the generated
 * `ShadowNodes.h` were replaced but this were not, `SelectableRunHostState`
 * would still name codegen's empty class — and the two would silently be
 * different types in the same build: a `ConcreteState<SelectableRunHostState>`
 * on one side of a translation unit boundary and a
 * `ConcreteState<RNSMRunHostState>` on the other. That is an ODR violation
 * whose symptom is a wrong `vtable`, not a compile error.
 *
 * Codegen's generated `States.cpp` includes this file and defines nothing
 * (the class is header-only on both sides), so nothing else has to change.
 */

#ifndef SELECTABLE_MARKDOWN_ANDROID_ALIAS_STATES_H
#define SELECTABLE_MARKDOWN_ANDROID_ALIAS_STATES_H

#include <RNSMRunHostState.h>

namespace facebook::react {

using SelectableRunHostState = RNSMRunHostState;

} // namespace facebook::react

#endif // SELECTABLE_MARKDOWN_ANDROID_ALIAS_STATES_H
