/*
 * SelectableMarkdownJsi — the one place the C++ core is exposed to JS.
 *
 * Installs a single global, `__selectableMarkdown`, with exactly two
 * members:
 *
 *   protocolVersion : number
 *       Protocol.h's kProtocolVersion. The JS decoder compares it against
 *       src/engine/native/protocol.ts's PROTOCOL_VERSION *before* reading a
 *       buffer, so a stale native binary paired with a fresh JS bundle is a
 *       clean "version mismatch, refuse the binding and say so" rather than
 *       a misread header. Refusing means parsing stops until the app is
 *       rebuilt — there is no second parser to fall back to — which is still
 *       the right trade against decoding a v2 buffer with a v1 reader and
 *       handing selection a document full of plausible, wrong spans.
 *
 *   parse(source: string, extensionBits: number, htmlPolicy: number)
 *       : ArrayBuffer
 *       The flat wire buffer described in Protocol.h. Mirrors the
 *       `ParseToBuffer` type in src/engine/native/protocol.ts — that type is
 *       the contract, this is its device implementation (the Node test addon
 *       is the other).
 *
 * WHY A GLOBAL AND NOT A TURBOMODULE METHOD. The codegen'd TurboModule
 * bridging path would convert the result through a `jsi::Value` shaped by
 * the codegen's type system; there is no ArrayBuffer return type in the
 * codegen surface, so the buffer would have to be re-encoded (base64, or an
 * array of numbers) and re-decoded per parse. That defeats Protocol.h's
 * entire reason for existing — one crossing, zero copies above the encoder.
 * A plain host function returning a jsi::ArrayBuffer crosses once. The host
 * module (platform/ios/SelectableMarkdownModule.mm on iOS) exists only to
 * find a runtime and call installSelectableMarkdown on it.
 *
 * INVARIANTS this header exists to enforce:
 *
 * 1. JS THREAD ONLY. jsi::Runtime is not thread-safe and has no internal
 *    locking. installSelectableMarkdown must be called on the thread that
 *    owns `runtime` (the JS thread), and the installed `parse` is only ever
 *    invoked by the runtime itself, i.e. on that same thread. A host that
 *    reaches a runtime pointer from the main queue must hop first — see the
 *    RuntimeExecutor path in SelectableMarkdownModule.mm.
 *
 * 2. IDEMPOTENT, AND PER-RUNTIME. Calling installSelectableMarkdown more
 *    than once on the same runtime is a no-op after the first: it returns
 *    early when `__selectableMarkdown` is already an object. That matters
 *    because hosts race — a TurboModule may install during setup and the JS
 *    layer may call install() again defensively. Conversely, "already
 *    installed" is a property of the *runtime*, not of the process: a dev
 *    reload builds a fresh runtime with a fresh (empty) global object, and
 *    that runtime must be installed into again.
 *
 * 3. NO C++ EXCEPTION REACHES JS UNWRAPPED. Everything thrown inside the
 *    host function is converted to a jsi::JSError carrying an actionable
 *    message. Argument mistakes name the argument, its expected type and
 *    what was actually passed, because the only consumer that will ever hit
 *    them is a binding author debugging at 2am.
 *
 * 4. THE UTF-8 BYTES JS HANDS US ARE THE BYTES md4c PARSES. `parse` reads
 *    the source exactly once, via jsi::String::utf8, and passes that
 *    std::string straight to parseToFlatBuffer. Every byte offset md4c
 *    reports therefore indexes that buffer, and the byte->UTF-16 map built
 *    from the same buffer converts them to the offsets the JS decoder needs
 *    (Protocol.h invariant 1). Re-encoding the source anywhere in between
 *    would silently desynchronize the map.
 *
 * 5. THE RETURNED ArrayBuffer OWNS ITS BYTES. It is backed by a
 *    jsi::MutableBuffer that holds the encoder's std::vector by value, moved
 *    in. No copy of the payload is made and no pointer into C++ storage
 *    outlives the JS object: the vector dies with the last reference to the
 *    buffer, which the runtime holds.
 *
 * 6. A RUNTIME THAT CANNOT BACK AN ArrayBuffer BY A MutableBuffer IS NEVER
 *    INSTALLED INTO. Invariant 5 rests on jsi::Runtime::createArrayBuffer,
 *    which is *not* universally implemented: React Native's JSCRuntime
 *    implements it as `throw std::logic_error("Not implemented")` on every
 *    version this package supports (ReactCommon/jsc/JSCRuntime.cpp, checked
 *    on 0.73 through 0.81). Publishing the binding on such a runtime would
 *    advertise a parser that throws on every call, and it would throw from
 *    inside `parse` — indistinguishable, from JS, from a document md4c
 *    choked on. So installSelectableMarkdown probes the capability once and
 *    refuses the install when it is missing, which turns a per-document
 *    mystery into one startup warning naming Hermes. Hermes, the default on
 *    every supported version, passes the probe.
 */

#ifndef SELECTABLE_MARKDOWN_JSI_H
#define SELECTABLE_MARKDOWN_JSI_H

#include <jsi/jsi.h>

namespace selectable_markdown {

/* Install (or re-confirm) `__selectableMarkdown` on `runtime`'s global
 * object. Safe to call repeatedly; see invariant 2.
 *
 * Must run on the runtime's own thread (invariant 1).
 *
 * May throw jsi::JSIException — jsi::JSINativeException if the runtime
 * cannot back an ArrayBuffer with a MutableBuffer (invariant 6), or whatever
 * the runtime raises if it rejects the property writes. A host with nothing
 * sensible to do about that should catch and log rather than propagate: this
 * runs at startup, and the JS layer already reports the absent global as an
 * actionable error at the first parse, where a caller can catch it. Both
 * hosts in this repo do exactly that; a throw here is therefore a "markdown
 * will not parse until this app is rebuilt" signal, never a crash. */
void installSelectableMarkdown(facebook::jsi::Runtime& runtime);

}  // namespace selectable_markdown

#endif  // SELECTABLE_MARKDOWN_JSI_H
