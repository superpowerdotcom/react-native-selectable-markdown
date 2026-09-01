#include "SelectableMarkdownJsi.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "OffsetParser.h"
#include "Protocol.h"

namespace selectable_markdown {

using facebook::jsi::ArrayBuffer;
using facebook::jsi::Function;
using facebook::jsi::JSError;
using facebook::jsi::JSIException;
using facebook::jsi::MutableBuffer;
using facebook::jsi::Object;
using facebook::jsi::PropNameID;
using facebook::jsi::Runtime;
using facebook::jsi::Value;

namespace {

/* The JS-visible names. Kept as constants so the error strings below and the
 * property writes can never disagree about what the binding is called. */
constexpr const char* kGlobalName = "__selectableMarkdown";
constexpr const char* kPropParse = "parse";
constexpr const char* kPropProtocolVersion = "protocolVersion";

/* parse(source, extensionBits, htmlPolicy). Also the `length` reported to
 * JS, which is what makes `parse.length === 3` a usable smoke test. */
constexpr unsigned kParseArity = 3;

/* Largest exactly-representable u32 as a double. JS has no integer type, so
 * every argument arrives as a double and has to be range-checked by hand. */
constexpr double kMaxUint32AsDouble = 4294967295.0;

/*
 * An ArrayBuffer backing store that owns the encoder's output.
 *
 * WHY THIS EXISTS. jsi::ArrayBuffer does not copy: it takes a shared_ptr to
 * a MutableBuffer and keeps it alive for as long as JS holds the buffer. The
 * naive alternatives both break — handing it a pointer into a local vector
 * dangles the moment parse() returns, and copying into a fresh allocation
 * doubles the peak memory of the one crossing Protocol.h went out of its way
 * to make copy-free. Moving the vector in is the only option that is both
 * zero-copy and lifetime-safe.
 *
 * jsi::MutableBuffer requires size() and data() to be stable for the object's
 * whole life, so bytes_ is written exactly once (at construction) and never
 * resized afterwards.
 */
class OwnedByteBuffer final : public MutableBuffer {
 public:
  explicit OwnedByteBuffer(std::vector<uint8_t>&& bytes)
      : bytes_(std::move(bytes)) {
    /* An empty vector may have data() == nullptr, and some runtimes assert
     * on a null backing pointer even for a zero-length buffer. Reserving one
     * byte forces an allocation without changing size(), so the stability
     * contract above still holds. (encodeFlatBuffer always emits at least a
     * header, so this is belt-and-braces.) */
    bytes_.reserve(1);
  }

  size_t size() const override { return bytes_.size(); }
  uint8_t* data() override { return bytes_.data(); }

 private:
  std::vector<uint8_t> bytes_;
};

/* A human-readable JS type name for error messages. jsi has no typeof, and
 * "expected a number, got object" is the difference between a five-second
 * fix and a debugging session. */
const char* typeName(Runtime& runtime, const Value& value) {
  if (value.isUndefined()) return "undefined";
  if (value.isNull()) return "null";
  if (value.isBool()) return "boolean";
  if (value.isNumber()) return "number";
  if (value.isString()) return "string";
  if (value.isSymbol()) return "symbol";
  if (value.isBigInt()) return "bigint";
  if (value.isObject()) {
    return value.getObject(runtime).isFunction(runtime) ? "function" : "object";
  }
  return "value of unknown type";
}

/* Read a u32 bitfield argument.
 *
 * WHY THE STRICTNESS. Both arguments are bitfields, and a plain
 * static_cast<uint32_t> of a double is undefined for NaN/inf and wraps for
 * negatives — so `parse(src, -1, 0)` would silently become "every extension
 * on" instead of an error. Protocol.h's configFromBits deliberately ignores
 * unknown bits (forward compatibility), which means it cannot catch this for
 * us: a garbage value there is indistinguishable from a newer JS layer. The
 * only place a caller bug can still be caught is here. */
uint32_t requireUint32(Runtime& runtime, const Value& value, int position,
                       const char* name) {
  if (!value.isNumber()) {
    throw JSError(runtime, std::string(kGlobalName) + "." + kPropParse +
                               ": argument " + std::to_string(position) +
                               " (" + name + ") must be a number, got " +
                               typeName(runtime, value) + ".");
  }
  const double raw = value.asNumber();
  /* Written as a negated conjunction so NaN (which compares false against
   * everything) lands in the error branch. */
  if (!(raw >= 0.0 && raw <= kMaxUint32AsDouble) || raw != std::floor(raw)) {
    throw JSError(runtime, std::string(kGlobalName) + "." + kPropParse +
                               ": argument " + std::to_string(position) +
                               " (" + name +
                               ") must be an integer in [0, 4294967295], got " +
                               std::to_string(raw) + ".");
  }
  return static_cast<uint32_t>(raw);
}

/* The body of parse(), free to throw jsi::JSError; parseHostFunction below
 * is the wrapper that guarantees nothing else escapes. */
Value parseImpl(Runtime& runtime, const Value* args, size_t count) {
  /* Exact arity, not ">= 3". This function is called by exactly one thing
   * (the decoder in src/engine/native/), never by user code, so an extra
   * argument means the JS side and this binding disagree about the
   * signature — which is precisely the bug worth failing loudly on. */
  if (count != kParseArity) {
    throw JSError(runtime,
                  std::string(kGlobalName) + "." + kPropParse +
                      " expects exactly 3 arguments (source: string, "
                      "extensionBits: number, htmlPolicy: number), got " +
                      std::to_string(count) + ".");
  }

  if (!args[0].isString()) {
    throw JSError(runtime, std::string(kGlobalName) + "." + kPropParse +
                               ": argument 1 (source) must be a string, got " +
                               typeName(runtime, args[0]) + ".");
  }

  /* Read the numbers before the string: they are cheap, and a type error
   * should not be paid for with a full UTF-8 transcode of the document. */
  const uint32_t extensionBits =
      requireUint32(runtime, args[1], 2, "extensionBits");
  const uint32_t htmlPolicy = requireUint32(runtime, args[2], 3, "htmlPolicy");

  /* THE ONE conversion of the source (header invariant 4). utf8() hands back
   * a std::string of UTF-8 octets; that exact buffer is what md4c parses and
   * what buildUtf16OffsetMap indexes, so md4c's byte offsets and the map
   * agree by construction. Nothing may re-encode or normalize it. */
  const std::string source = args[0].getString(runtime).utf8(runtime);

  /* parseToFlatBuffer takes a uint32_t length (Protocol.h / OffsetParser.h),
   * and the wire header stores offsets as u32. A >4GiB markdown string is
   * not a case worth widening the protocol for, but it is a case worth
   * refusing explicitly instead of truncating the length. */
  if (source.size() > static_cast<size_t>(UINT32_MAX)) {
    throw JSError(runtime,
                  std::string(kGlobalName) + "." + kPropParse +
                      ": source is too large for the wire format (" +
                      std::to_string(source.size()) +
                      " UTF-8 bytes; the limit is 4294967295).");
  }

  const ParserConfig config = configFromBits(extensionBits, htmlPolicy);
  std::vector<uint8_t> bytes = parseToFlatBuffer(
      source.data(), static_cast<uint32_t>(source.size()), config);

  /* Move, never copy — see OwnedByteBuffer. */
  return ArrayBuffer(runtime,
                     std::make_shared<OwnedByteBuffer>(std::move(bytes)));
}

/*
 * The host function the runtime actually calls.
 *
 * WHY THE CATCH-ALL. The JSI contract says a host function may throw and the
 * runtime will surface it to JS, but only jsi::JSError has a defined
 * translation; what an engine does with an arbitrary std::exception — let
 * alone a non-std throw — is implementation-defined, and on some it is
 * std::terminate. parseToFlatBuffer can throw std::bad_alloc on a large
 * document, which is a per-document condition the JS layer should see as a
 * catchable Error — one oversized document is not a broken app, and the
 * caller can drop it, truncate it or show a message — not a hard crash. So
 * every escape route is normalized here (header invariant 3).
 */
Value parseHostFunction(Runtime& runtime, const Value& /*thisValue*/,
                        const Value* args, size_t count) {
  try {
    return parseImpl(runtime, args, count);
  } catch (const JSIException&) {
    /* Covers JSError (our argument errors, already carrying a JS value and
     * stack) and JSINativeException (the runtime telling us it is in an
     * unusable state). Both already have a JS-side representation; wrapping
     * them again would only bury the message. */
    throw;
  } catch (const std::exception& error) {
    throw JSError(runtime, std::string(kGlobalName) + "." + kPropParse +
                               " failed in native code: " + error.what());
  } catch (...) {
    throw JSError(runtime, std::string(kGlobalName) + "." + kPropParse +
                               " failed in native code with a non-standard "
                               "exception.");
  }
}

/*
 * Best-effort Object.freeze on the binding.
 *
 * WHY BEST-EFFORT. The binding is a global, so anything in the bundle can
 * reach it; freezing turns a stray `__selectableMarkdown.parse = …` into a
 * no-op (a TypeError under strict mode) rather than a silently swapped
 * parser, and it makes protocolVersion trustworthy as a version gate. But it
 * is a guardrail, not a security boundary — a bundle that has replaced
 * Object.freeze has already won. Losing the guardrail is strictly better
 * than failing the install, which would leave the app with no parser at all
 * (md4c is the only one this package ships), so every failure here is
 * swallowed.
 */
void freezeShallow(Runtime& runtime, const Object& target) {
  try {
    Function freeze = runtime.global()
                          .getPropertyAsObject(runtime, "Object")
                          .getPropertyAsFunction(runtime, "freeze");
    freeze.call(runtime, Value(runtime, target));
  } catch (const JSIException&) {
    /* No Object, no Object.freeze, or it threw. See above. */
  }
}

/*
 * Refuse the install on a runtime that cannot hand out an ArrayBuffer over a
 * MutableBuffer (header invariant 6).
 *
 * WHY A PROBE AND NOT A #ifdef. Which engine a React Native app runs is an
 * app-build decision (`:hermes_enabled`, `hermesEnabled`), not a compile-time
 * fact this translation unit can see — the same .so/.a is linked into Hermes
 * and JSC apps alike. Runtime::createArrayBuffer is a virtual whose JSC
 * implementation is a bare `throw std::logic_error("Not implemented")`, so
 * asking is the only way to find out, and asking is cheap: one throwaway
 * zero-length buffer, once per runtime, on a path that already only runs at
 * startup.
 *
 * WHY IT MUST HAPPEN AT INSTALL AND NOT AT FIRST PARSE. `parse` throwing is
 * indistinguishable, from JS, from a document the parser choked on: the app
 * would look like it had a markdown bug in every document rather than a
 * missing capability. Failing here instead means the global never appears,
 * which is exactly the condition src/engine/native/index.ts detects and
 * reports with a message naming the cause — an engine without Hermes — the
 * first time anything asks it to parse.
 */
void requireArrayBufferSupport(Runtime& runtime) {
  static const char* const kMessage =
      "__selectableMarkdown: this JavaScript engine cannot create an "
      "ArrayBuffer over a jsi::MutableBuffer (JavaScriptCore does not "
      "implement it), so the md4c binding was not installed. Markdown cannot "
      "be parsed in this app: md4c is the only parser this package ships. "
      "Enable Hermes.";
  try {
    /* Empty on purpose: the probe is about whether the runtime accepts the
     * call at all, and OwnedByteBuffer already guarantees a non-null data()
     * for a zero-length vector. */
    ArrayBuffer probe(runtime,
                      std::make_shared<OwnedByteBuffer>(std::vector<uint8_t>()));
    (void)probe;
  } catch (const JSIException&) {
    /* The runtime rejected it in JSI's own vocabulary — say so in ours, so
     * the host's log line names the cause rather than the symptom. */
    throw facebook::jsi::JSINativeException(kMessage);
  } catch (const std::exception&) {
    /* std::logic_error is what RN's JSCRuntime raises. */
    throw facebook::jsi::JSINativeException(kMessage);
  } catch (...) {
    throw facebook::jsi::JSINativeException(kMessage);
  }
}

}  // namespace

void installSelectableMarkdown(Runtime& runtime) {
  Object global = runtime.global();

  /* Idempotence (header invariant 2). Hosts race: a TurboModule may install
   * during module setup while the JS layer also calls install() defensively
   * on first parse. Re-installing would be observable — it would hand out a
   * second host function and replace a frozen object that JS may already
   * hold a reference to — so the second call is a no-op instead. */
  if (global.getProperty(runtime, kGlobalName).isObject()) {
    return;
  }

  /* Before anything is published: prove the runtime can do the one thing the
   * whole design depends on (header invariant 6). Throws if it cannot, and
   * the global stays absent. */
  requireArrayBufferSupport(runtime);

  Object binding(runtime);

  /* kProtocolVersion is a u32; doubles represent it exactly. The JS side
   * compares this against PROTOCOL_VERSION in
   * src/engine/native/protocol.ts before trusting a single header word. */
  binding.setProperty(runtime, kPropProtocolVersion,
                      Value(static_cast<double>(kProtocolVersion)));

  binding.setProperty(
      runtime, kPropParse,
      Function::createFromHostFunction(
          runtime, PropNameID::forAscii(runtime, kPropParse), kParseArity,
          parseHostFunction));

  /* Freeze before publishing, so no one can observe the mutable window. */
  freezeShallow(runtime, binding);

  global.setProperty(runtime, kGlobalName, std::move(binding));
}

}  // namespace selectable_markdown
