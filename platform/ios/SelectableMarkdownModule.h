/*
 * SelectableMarkdownModule — the iOS host for the JSI binding.
 *
 * This module does exactly one thing: find the JS runtime and call
 * selectable_markdown::installSelectableMarkdown on it (see
 * platform/cpp/SelectableMarkdownJsi.h for what gets installed and why it is
 * a global rather than a TurboModule method). It exports no parsing API of
 * its own — everything the JS layer needs arrives through
 * `global.__selectableMarkdown`.
 *
 * JS usage:
 *
 *   import { NativeModules } from 'react-native';
 *   NativeModules.SelectableMarkdown?.install();
 *   // -> 'installed' | 'unavailable' | 'refused'
 *
 * The return value is "the binding is installed and usable *now*", not
 * "installation was requested". Anything but 'installed' (or a missing
 * module, or a missing global afterwards) means this app cannot parse
 * markdown at all: md4c is the only parser the package has, and there is no
 * JavaScript one behind it, so the first non-empty parseDocument call will
 * throw. Every failure path here still logs a warning rather than raising, and
 * that is deliberate — install() is called at startup, before there is any UI
 * to show an error in, and the only fix is a rebuild, which no exception
 * thrown here could hurry along. The warning names the missing build step; the
 * exception that stops the app from rendering wrong text arrives later, at the
 * parse site, where a caller can actually catch it.
 *
 * WHY THREE STRINGS AND NOT A BOOLEAN. It used to return a boolean, and
 * a bare NO conflated "not yet" with "not ever" — so a JS caller that polled
 * retried the permanent failures forever, crossing the bridge and printing a
 * fresh warning each time. 'unavailable' is transient and worth retrying;
 * 'refused' is permanent for this binary, is memoized here so the warning
 * prints once, and is memoized again in src/engine/native/install.ts so the
 * next call does not even cross. A JS bundle older than this binary ignores
 * the return value and reads the global instead, so the change is invisible
 * to it.
 *
 * install() is idempotent and cheap to call again — which matters, because
 * "installed" is a property of the JS runtime, and a dev reload creates a new
 * one. Call it once at startup and again from any code path that finds the
 * global missing. src/engine/native/install.ts is that caller.
 *
 * It must be called FROM JS. It is a blocking synchronous method, which is
 * what puts it on the JS thread — the only thread from which a jsi::Runtime
 * may be touched (SelectableMarkdownJsi.h invariant 1). There is deliberately
 * no Objective-C entry point that installs from elsewhere.
 *
 * Two failures are permanent rather than "not yet" — the module reports them
 * as 'refused' — and both are intentional non-errors:
 *   - the app runs JavaScriptCore, whose jsi::Runtime cannot back an
 *     ArrayBuffer with a MutableBuffer (SelectableMarkdownJsi.h invariant 6);
 *   - the package's native code was never linked into the binary.
 * Neither is recoverable at runtime and neither has a fallback: an app in
 * either state renders every document as a thrown error until it is rebuilt —
 * with Hermes, for the first, and with this package's native code linked, for
 * the second.
 */

#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

@interface SelectableMarkdownModule : NSObject <RCTBridgeModule>

@end

NS_ASSUME_NONNULL_END
