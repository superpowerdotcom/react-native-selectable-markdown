/**
 * Ask the platform binding to install itself.
 *
 * The native module (platform/ios/SelectableMarkdownModule.mm,
 * android/src/main/java/com/selectablemarkdown/SelectableMarkdownModule.kt)
 * exposes exactly one method, `install()`, and it does one thing: put
 * `__selectableMarkdown` on the JS global. Nothing installs it on its own — a
 * JSI installer that nobody calls is the classic way this pattern silently
 * degrades — so this module is the caller, and an app calls it once during
 * startup:
 *
 *   import { installNativeEngine } from 'react-native-selectable-markdown';
 *   installNativeEngine();
 *
 * WHY IT CANNOT THROW, even though the native engine is now the only parser
 * there is. Not because the failure is harmless — it is not; without a
 * binding, `parseDocument` throws on the first document. It is because of
 * *where* this runs. This is a startup call, usually at module import time,
 * on a path that has nothing to do with rendering markdown: throwing here
 * takes down the whole app, including every screen that never shows a
 * markdown document, and it does so before any error boundary exists to
 * catch it. The failure has to be reported where the parse is attempted,
 * where the caller has a screen to degrade and a boundary to catch it — see
 * `nativeEngine`'s error in ./index, which is the loud half of this pair. So
 * the whole body is inside try/catch and the answer is a boolean the caller
 * is expected to act on.
 *
 * WHY `react-native` IS REQUIRED LAZILY AND NOT IMPORTED. This directory is
 * loaded in plain Node — conformance/run-commonmark.mjs requires
 * dist/engine/native/index.js directly, and the benches do the same — and
 * `require('react-native')` throws there (its entry point reaches for a
 * running host). A top-level `import` would run at module-evaluation time and
 * take the conformance runner down with it; a require inside the function
 * body runs only when someone actually asks to install, which no Node
 * consumer does. Metro still resolves a literal `require('react-native')`
 * statically, so the lazy form costs nothing on device.
 */

import type { NativeHostBinding } from './index';
import { PROTOCOL_VERSION } from './protocol';

/** The one method platform/{ios,android} export. */
interface SelectableMarkdownNativeModule {
  install?: () => boolean;
}

/** Just enough of react-native's shape to read one module off it. */
interface ReactNativeExports {
  NativeModules?: Record<string, SelectableMarkdownNativeModule | undefined>;
}

/**
 * The binding, if one is on the global right now.
 *
 * Deliberately NOT `findHostBinding` from './index': that module re-exports
 * this one, and a cycle between the two would make the package's public
 * surface depend on module evaluation order. The shape check is the same one
 * — a `parse` function is what makes the global usable — and both are pinned
 * by the `NativeHostBinding` type they share.
 */
function hostBinding(): NativeHostBinding | null {
  const host = (globalThis as { __selectableMarkdown?: NativeHostBinding })
    .__selectableMarkdown;
  return host && typeof host.parse === 'function' ? host : null;
}

/**
 * True when `binding` speaks the wire format this bundle decodes.
 *
 * A mismatch means a stale native binary paired with a fresh JS bundle (or the
 * reverse) — the classic "I reloaded JS but did not rebuild the app" state.
 * Catching it here turns it into one warning that names the rebuild; letting
 * it through would instead surface as a NativeProtocolError thrown out of
 * every single parse, since decode.ts checks the same version on the buffer's
 * header word. Both end with markdown not rendering, but only one of them
 * tells the reader why.
 */
function protocolMatches(binding: NativeHostBinding): boolean {
  return binding.protocolVersion === PROTOCOL_VERSION;
}

/* Memoized success only. A `false` is never cached: the reasons for it are
 * mostly transient ("the runtime is being torn down", "the bridge has not
 * finished starting"), and the native side memoizes its own success, so a
 * retry that is going to fail is a cheap synchronous call rather than work.
 * Module state is per-JS-context, which is the right scope: a dev reload
 * re-evaluates this module against the fresh runtime that needs installing
 * again. */
let installed = false;

/* One warning per JS context, not one per call — an app that retries in a
 * render path must not turn a diagnostic into a flood. */
let warnedAboutProtocol = false;

/**
 * Install the md4c-backed engine into this JS context, and report whether it
 * is usable now.
 *
 * Idempotent, safe to call at import time, and never throws (see the file
 * header). `false` means the native module is not reachable from this JS
 * context — Expo Go, web, plain Node without the built addon, or a JS-only
 * reload after adding the package — and since md4c is the only parser this
 * package has, it also means `parseDocument` will throw on the first
 * document. Treat the boolean as a precondition, not a capability hint: an
 * app that gets `false` should surface it or fix the build, because there is
 * no second parser waiting behind it.
 *
 * The native side is what logs *why* it failed — RCTLogWarn on iOS, Log.w on
 * Android — because it is the only side that knows whether the runtime was
 * missing, the engine was JavaScriptCore, or the .so failed to load. This
 * function itself stays quiet: it is called from contexts (the conformance
 * runner, benches, web) where the absence is expected and understood by the
 * caller, and the loud report belongs at the parse, not at startup.
 */
export function installNativeEngine(): boolean {
  if (installed) return true;

  try {
    /* Ask only if we have to. The binding may already be there — a second
     * call in the same context, or a host that installed during startup — and
     * the native round trip is a blocking synchronous call worth skipping. */
    let binding = hostBinding();

    if (binding === null) {
      /* The one require in the package that is not a top-level import — see
       * the file header for why it has to stay inside a function body. */
      const reactNative = require('react-native') as ReactNativeExports;
      /* Every hop is optional on purpose: `NativeModules` is absent outside a
       * React Native host, the module is absent when the package's native
       * code was never linked, and `install` is absent when a JS bundle meets
       * an older native binary. None of those is worth an exception. */
      reactNative?.NativeModules?.SelectableMarkdown?.install?.();
      /* The native return value is ignored in favour of reading the global:
       * that is the thing every caller downstream actually consumes, so it is
       * the only honest answer to "is it installed?". */
      binding = hostBinding();
    }

    if (binding === null) return false;

    if (!protocolMatches(binding)) {
      if (!warnedAboutProtocol) {
        warnedAboutProtocol = true;
        console.warn(
          `react-native-selectable-markdown: the native module speaks wire protocol ` +
            `v${binding.protocolVersion} but this JavaScript bundle decodes v${PROTOCOL_VERSION}. ` +
            `Rebuild the app so the two match; until then the binding is refused and ` +
            `markdown cannot be parsed.`,
        );
      }
      return false;
    }

    installed = true;
    return true;
  } catch {
    /* Reached when `require('react-native')` fails (plain Node), when the
     * blocking synchronous method throws across the bridge, or when a host
     * hands us something that is not shaped like NativeModules. All of them
     * mean the same thing to the caller. */
    return false;
  }
}

/**
 * True when a protocol-compatible native binding was installed into this JS
 * context by a previous `installNativeEngine()` call.
 *
 * A pure read of memoized state: unlike `installNativeEngine`, it never asks
 * the platform for anything, so a `false` from a context that has simply not
 * called `installNativeEngine()` yet says nothing about whether the module is
 * there. That makes it a diagnostic for "did startup do its job?", not a
 * usable test for "can this parse?".
 *
 * Distinct from `isNativeEngineAvailable()` in ./index, which answers the
 * broader "is a parse function reachable" — it installs on demand, and it also
 * counts a parse function linked directly by a test harness through
 * `__linkNativeEngine`, which never goes through the protocol check because
 * there is no binding object to check.
 */
export function isNativeEngineInstalled(): boolean {
  return installed;
}
