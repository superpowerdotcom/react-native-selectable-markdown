/*
 * addon.cpp — Node-API binding over selectable_markdown::parseToFlatBuffer.
 *
 * WHY THIS EXISTS. The JSI (iOS/Android) bindings can only be exercised
 * inside a running React Native host, which is far too slow a loop for
 * conformance sweeps and for benchmarking. This addon calls the SAME entry
 * point those bindings call (Protocol.h's parseToFlatBuffer) and hands the
 * same bytes to JS, so a regression caught here is a regression on device.
 * It is a test/bench harness only — nothing in the shipped package loads it.
 *
 * CONSTRAINTS this file exists to enforce:
 *
 * 1. No C++ exception may cross the N-API boundary. Node addons are compiled
 *    with exceptions enabled (the C++ standard library needs them), but
 *    unwinding through the C callback frames Node owns is undefined. Every
 *    callback body therefore runs inside a catch-all that converts the
 *    failure into a pending JS exception and returns nullptr.
 *
 * 2. Bad arguments throw a JS TypeError, they never reach the parser. A
 *    harness that segfaults on a typo is a harness nobody trusts; the whole
 *    point is that a fuzzing/bench driver can hand this function garbage and
 *    get a stack trace instead of a core dump.
 *
 * 3. The returned ArrayBuffer OWNS A COPY of the encoded bytes. The obvious
 *    alternative — napi_create_external_arraybuffer over the std::vector's
 *    storage — ties a JS object's lifetime to a C++ allocation and forces a
 *    finalizer that runs on an arbitrary thread at an arbitrary time. The
 *    copy costs one memcpy of a buffer that is already proportional to the
 *    parse we just did, which is noise next to md4c's own work, and it makes
 *    the ownership story trivial: N-API owns it, GC frees it.
 *
 * 4. Offsets are not touched here. Protocol.h's encoder has already applied
 *    the byte->UTF-16 map; this file moves bytes and nothing else. Any
 *    arithmetic on offsets in this file would be a bug (see Protocol.h
 *    invariant 1).
 */

#include <node_api.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <new>
#include <vector>

#include "Protocol.h"

namespace {

/* N-API convention used throughout: a function that returns nullptr has
 * ALREADY left a pending JS exception on `env`. Node re-raises it at the
 * call site, so callers just propagate the nullptr. */

napi_value throwTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

/* Throws `message` unless something is already pending. Used on the failure
 * paths of N-API calls, which may fail either because the engine is
 * unhappy (nothing pending -> we must supply an error) or because JS threw
 * underneath us (pending -> overwriting it would lose the real cause). */
napi_value throwUnlessPending(napi_env env, const char* message) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    return nullptr;
  }
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

/* Reads one argument as a u32. Rejects non-numbers and values outside
 * [0, 2^32) rather than letting JS's silent ToUint32 wrap them: a caller
 * that passes -1 or 2**33 for a bitmask has a bug, and a harness that
 * quietly reinterprets it hides that bug. `ok` is false iff a JS exception
 * has been thrown. */
uint32_t readUint32Arg(napi_env env, napi_value value, const char* name,
                       bool* ok) {
  *ok = false;

  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok) {
    throwUnlessPending(env, "parse(): could not inspect argument type");
    return 0;
  }
  if (type != napi_number) {
    char message[128];
    std::snprintf(message, sizeof(message),
                  "parse(): %s must be a number", name);
    throwTypeError(env, message);
    return 0;
  }

  double raw = 0.0;
  if (napi_get_value_double(env, value, &raw) != napi_ok) {
    throwUnlessPending(env, "parse(): could not read a numeric argument");
    return 0;
  }
  /* The NaN/Infinity cases fall out of the range test: both comparisons are
   * false for NaN, so the `!(a && b)` form below rejects it. */
  if (!(raw >= 0.0 && raw <= 4294967295.0) ||
      raw != static_cast<double>(static_cast<uint32_t>(raw))) {
    char message[160];
    std::snprintf(message, sizeof(message),
                  "parse(): %s must be an integer in [0, 2^32)", name);
    throwTypeError(env, message);
    return 0;
  }

  *ok = true;
  return static_cast<uint32_t>(raw);
}

/* parse(source: string, extensionBits: number, htmlPolicy: number)
 *   -> ArrayBuffer holding one Protocol.h flat buffer.
 *
 * The source string is read as UTF-8 with the standard two-call sizing
 * dance, because that is the only encoding md4c (and therefore
 * OffsetParser) accepts. V8 converts lone surrogates to U+FFFD on the way
 * out, which is exactly what the UTF-16 map in OffsetParser assumes for
 * ill-formed input, so the round trip stays consistent.
 */
napi_value parseImpl(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3] = {nullptr, nullptr, nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) {
    return throwUnlessPending(env, "parse(): could not read arguments");
  }
  if (argc < 3) {
    return throwTypeError(
        env,
        "parse(source, extensionBits, htmlPolicy) requires 3 arguments");
  }

  napi_valuetype sourceType = napi_undefined;
  if (napi_typeof(env, argv[0], &sourceType) != napi_ok) {
    return throwUnlessPending(env, "parse(): could not inspect argument type");
  }
  if (sourceType != napi_string) {
    return throwTypeError(env, "parse(): source must be a string");
  }

  bool ok = false;
  const uint32_t extensionBits =
      readUint32Arg(env, argv[1], "extensionBits", &ok);
  if (!ok) return nullptr;
  const uint32_t htmlPolicy = readUint32Arg(env, argv[2], "htmlPolicy", &ok);
  if (!ok) return nullptr;

  /* Two-call sizing: the first call reports the UTF-8 byte length excluding
   * the NUL terminator, the second fills a buffer of that length + 1. */
  size_t byteLength = 0;
  if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &byteLength) !=
      napi_ok) {
    return throwUnlessPending(
        env, "parse(): could not measure the source string as UTF-8");
  }
  /* parseToFlatBuffer takes a uint32_t length, and the protocol's offsets
   * are u32 with 0xFFFFFFFF reserved as the "no offset" sentinel — so the
   * largest representable source is 2^32-2 bytes. No JS engine will hand us
   * a string that big, but the check is what keeps the truncation from
   * being silent if one ever does. */
  if (byteLength > 0xFFFFFFFEu) {
    napi_throw_range_error(
        env, nullptr,
        "parse(): source is too large; the wire format addresses at most "
        "2^32-2 UTF-8 bytes");
    return nullptr;
  }

  std::vector<char> source(byteLength + 1u, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, argv[0], source.data(), source.size(),
                                 &written) != napi_ok) {
    return throwUnlessPending(
        env, "parse(): could not read the source string as UTF-8");
  }

  const selectable_markdown::ParserConfig config =
      selectable_markdown::configFromBits(extensionBits, htmlPolicy);
  const std::vector<uint8_t> bytes = selectable_markdown::parseToFlatBuffer(
      source.data(), static_cast<uint32_t>(written), config);

  void* destination = nullptr;
  napi_value result = nullptr;
  if (napi_create_arraybuffer(env, bytes.size(), &destination, &result) !=
      napi_ok) {
    return throwUnlessPending(
        env, "parse(): could not allocate the result ArrayBuffer");
  }
  if (!bytes.empty()) {
    std::memcpy(destination, bytes.data(), bytes.size());
  }
  return result;
}

/* Constraint 1's enforcement point: the only C++ frame Node ever calls
 * directly, so the only place a catch-all is needed. */
napi_value parse(napi_env env, napi_callback_info info) {
  try {
    return parseImpl(env, info);
  } catch (const std::bad_alloc&) {
    return throwUnlessPending(env, "parse(): out of memory");
  } catch (const std::exception&) {
    /* what() is not forwarded: it may point at storage the unwind is
     * about to reclaim, and no code path below this file is documented to
     * throw anything with a message worth surfacing. */
    return throwUnlessPending(env, "parse(): native parser threw");
  } catch (...) {
    return throwUnlessPending(env, "parse(): native parser threw (unknown)");
  }
}

}  // namespace

/* Symbol-based registration (napi_register_module_v1), which is what makes
 * this loadable without node-gyp's generated glue. */
NAPI_MODULE_INIT() {
  napi_value protocolVersion = nullptr;
  if (napi_create_uint32(env, selectable_markdown::kProtocolVersion,
                         &protocolVersion) != napi_ok) {
    return throwUnlessPending(
        env, "selectable-markdown: could not create protocolVersion");
  }

  const napi_property_descriptor properties[] = {
      {"parse", nullptr, parse, nullptr, nullptr, nullptr, napi_enumerable,
       nullptr},
      {"protocolVersion", nullptr, nullptr, nullptr, nullptr, protocolVersion,
       napi_enumerable, nullptr},
  };
  if (napi_define_properties(env, exports,
                             sizeof(properties) / sizeof(properties[0]),
                             properties) != napi_ok) {
    return throwUnlessPending(
        env, "selectable-markdown: could not define module exports");
  }
  return exports;
}
