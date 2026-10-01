#import "SelectableMarkdownModule.h"

#import <React/RCTBridge.h>
#import <React/RCTLog.h>

#import <objc/runtime.h>

#import <exception>

#import <jsi/jsi.h>

#import "SelectableMarkdownJsi.h"

/*
 * HOW THIS FILE REACHES A jsi::Runtime, AND WHY IT IS THE ONLY ROUTE.
 *
 * -install is a blocking synchronous method, so React Native runs it on the
 * JS thread with the JS thread parked inside the call — on the bridge
 * (RCTNativeModule::callSerializableNativeHook -> invokeInner, inline) and on
 * TurboModules alike (ObjCTurboModule::performMethodInvocation ->
 * ModuleNativeMethodCallInvoker::invokeSync, which is a bare `work()`). That
 * is the one context in which borrowing the raw runtime pointer is legal
 * (SelectableMarkdownJsi.h invariant 1), and it is why this module has no
 * asynchronous install path at all.
 *
 * Both objects React Native hands a NativeModule as its `bridge` expose that
 * pointer under the same selector, `-runtime`, returning `void *`:
 *
 *   - RCTCxxBridge, on the new architecture with a bridge, and on the old one
 *     before it was removed (React/Base/RCTBridge+Private.h).
 *   - RCTBridgeProxy, in bridgeless mode, which RCTTurboModuleManager sets as
 *     the `bridge` of every legacy module and which RCTInstance constructs
 *     with `runtime:_reactInstance->getJavaScriptContext()` — the real
 *     pointer, not a stub.
 *
 * Those headers were read on 0.73 through 0.81 only; the class-level probes
 * below are what keep a newer React Native safe.
 *
 * WHAT WAS REJECTED, AND WHY, SO NOBODY RE-ADDS IT:
 *
 *   RCTRuntimeExecutorModule. It appeared after 0.73 and was deleted again
 *   after 0.78 (React/Base/RCTRuntimeExecutorModule.h is absent in both), so
 *   it covered a four-version window that ended below this package's peer
 *   floor. Worse, in bridgeless the executor it
 *   hands out routes through the JS message queue (ReactInstance.cpp ->
 *   RCTMessageThread::runOnQueue), so -execute: called *from* the JS thread
 *   defers rather than running inline: the install would land a tick later
 *   and this method would have to answer NO to a question it could have
 *   answered YES to.
 *
 *   RCTCallInvokerModule (0.76+). invokeSync funnels into
 *   RuntimeScheduler::executeNowOnTheSameThread, which blocks on the
 *   RuntimeExecutor above; calling it from the JS thread is the documented
 *   deadlock (executeSynchronouslyOnSameThread_CAN_DEADLOCK). Not usable
 *   here, and its async sibling has the same one-tick lag as the executor.
 */

/*
 * The two React Native selectors this file duck-types against.
 *
 * Declared locally rather than imported from <React/RCTBridge+Private.h> for
 * one reason: every call below is guarded by a class-level lookup, so a React
 * Native that no longer has these is a clean "no runtime reachable, answer NO
 * and warn" instead of a header that fails to resolve at build time.
 * The signatures are copied exactly from RCTBridge+Private.h — a mismatch
 * here would be a miscompiled message send, not a warning.
 */
@protocol SelectableMarkdownRuntimeOwner <NSObject>
/* RCTCxxBridge and RCTBridgeProxy. NULL while JS is loading, after a reload
 * has torn the runtime down, and whenever the bridge is invalid. */
- (void *)runtime;
@end

@interface RCTBridge (SelectableMarkdownInternals)
/* RCTBridge hands out the RCTCxxBridge that actually owns the runtime.
 * RCTBridgeProxy answers this with itself. */
- (RCTBridge *)batchedBridge;
/* Set by both architectures: RCTCxxBridge on setup, and RCTInstance on the
 * bridgeless path (`[RCTBridge setCurrentBridge:(RCTBridge *)bridgeProxy]`).
 * Only ever a fallback for a module that was never given a `bridge`. */
+ (instancetype)currentBridge;
@end

namespace {

/*
 * "Does this object implement `sel`?" — asked of the CLASS, never of the
 * object.
 *
 * THIS IS NOT PARANOIA, IT IS THE BRIDGELESS PATH. RCTBridgeProxy is an
 * NSProxy, and NSProxy does not implement -respondsToSelector:; it forwards
 * it like any other message, and RCTBridgeProxy's -forwardInvocation: neither
 * dispatches nor writes a return value, so the answer comes back NO for
 * selectors the proxy demonstrably implements. (Verified against Foundation:
 * an NSProxy subclass that defines -runtime answers NO to
 * -respondsToSelector:@selector(runtime) while [proxy runtime] returns the
 * real value.) object_getClass + class_respondsToSelector never send a
 * message, so they answer truthfully for a real class and for a proxy alike.
 */
BOOL SelectableMarkdownClassImplements(id object, SEL selector)
{
  return object != nil && class_respondsToSelector(object_getClass(object), selector);
}

/*
 * The one place C++ exceptions are allowed to stop.
 *
 * installSelectableMarkdown throws jsi::JSINativeException on a runtime that
 * cannot back an ArrayBuffer with a MutableBuffer (JavaScriptCore — see
 * SelectableMarkdownJsi.h invariant 6) and may throw whatever the runtime
 * raises if it rejects the property writes. Letting that unwind into
 * Objective-C++ would end the process, and crashing is the wrong answer even
 * though the consequence is severe — an app with no binding cannot parse
 * markdown at all, because md4c is the only parser this package has. But this
 * runs during startup, on the JS thread, usually before any screen exists: a
 * crash here would report the fault as an unattributed launch failure and
 * take the rest of the app down with it. So it is logged and reported as a
 * plain NO, and the JS side raises the same fault at the first parse, where
 * the message can name the rebuild and a caller can catch it.
 */
BOOL SelectableMarkdownInstallInto(facebook::jsi::Runtime &runtime)
{
  try {
    selectable_markdown::installSelectableMarkdown(runtime);
    return YES;
  } catch (const std::exception &error) {
    RCTLogWarn(
        @"SelectableMarkdown: could not install the JSI binding (%s). Markdown "
        @"cannot be parsed in this app until it is rebuilt with the native "
        @"module linked — this package parses with md4c and ships no "
        @"JavaScript parser to fall back to.",
        error.what());
  } catch (...) {
    RCTLogWarn(
        @"SelectableMarkdown: could not install the JSI binding (non-standard "
        @"exception). Markdown cannot be parsed in this app until it is "
        @"rebuilt with the native module linked — this package parses with "
        @"md4c and ships no JavaScript parser to fall back to.");
  }
  return NO;
}

/* 'unavailable' is transient (no runtime yet, or mid-reload); 'refused' is
 * permanent for this runtime. */
static NSString *const kSelectableMarkdownInstalled = @"installed";
static NSString *const kSelectableMarkdownUnavailable = @"unavailable";
static NSString *const kSelectableMarkdownRefused = @"refused";

}  // namespace

@implementation SelectableMarkdownModule {
  /* Module-level memo of "we already installed into the current runtime".
   * The C++ side is idempotent on its own (SelectableMarkdownJsi.h invariant
   * 2); this only avoids re-walking the bridge on every call. It is
   * deliberately NOT reset anywhere: a new JS runtime comes with a new bridge
   * (or a new RCTInstance) and therefore a new module instance. */
  BOOL _installed;

  /* Per module instance like _installed, so a reload's new runtime is asked
   * afresh. The transient case is deliberately not memoized. */
  BOOL _refused;
  BOOL _warnedUnavailable;
}

RCT_EXPORT_MODULE(SelectableMarkdown)

/* Set by RN through KVC — RCTModuleData on the bridge, RCTTurboModuleManager
 * (`[(id)module setValue:_bridgeProxy forKey:@"bridge"]`) in bridgeless.
 * Both write straight to this ivar because RCTBridgeModule declares `bridge`
 * readonly, so the @synthesize is what makes the injection work at all. */
@synthesize bridge = _bridge;

/*
 * NO, and the "it does nothing on the main queue" reading of that is the
 * least interesting half.
 *
 * A module that answers YES is constructed inside RCTUnsafeExecuteOnMainQueueSync
 * (RCTTurboModuleManager -_createAndSetUpObjCModule:, RCTModuleData -instance).
 * This module is created lazily, on the first `NativeModules.SelectableMarkdown`
 * access — which is a JS-thread event — so answering YES would make that
 * access a JS-thread-blocks-on-main-queue hop, and deadlock outright whenever
 * the main thread is itself waiting on JS. There is no UIKit state here to
 * justify paying that.
 */
+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

/* RCTJSThread, not a private serial queue and not the main queue.
 *
 * The module's only method is blocking-synchronous, and React Native runs
 * those on the JS thread whatever this returns — but the value is not inert:
 * it is what RN would otherwise dispatch any *future* method on, and a main
 * queue here would be a standing invitation to add one that touches the
 * runtime from the wrong thread. Declaring RCTJSThread states the module's
 * actual affinity and costs RN nothing (it explicitly skips creating a
 * shared queue for it). */
- (dispatch_queue_t)methodQueue
{
  return RCTJSThread;
}

/*
 * Install the binding and report whether it is usable right now, and if not,
 * whether retrying can help.
 *
 * The answer is "the global exists by the time this returns", not
 * "installation was requested" — the caller's next statement reads that
 * global. This package ships no JavaScript parser, so parseDocument throws
 * until a call answers `installed`.
 */
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(install)
{
  return [self installOutcome];
}

- (NSString *)installOutcome
{
  if (_installed) {
    return kSelectableMarkdownInstalled;
  }

  if (_refused) {
    return kSelectableMarkdownRefused;
  }

  void *runtime = [self jsRuntimePointer];
  if (runtime == nullptr) {
    if (!_warnedUnavailable) {
      _warnedUnavailable = YES;
      RCTLogWarn(
        @"SelectableMarkdown: no JS runtime was reachable, so the parser is "
        @"not installed and markdown cannot be parsed yet. This is usually "
        @"transient (JS still loading, or a reload in progress) — call "
        @"install() again once the bridge is up.");
    }
    return kSelectableMarkdownUnavailable;
  }

  if (!SelectableMarkdownInstallInto(*static_cast<facebook::jsi::Runtime *>(runtime))) {
    /* Already logged; memoized so a polling caller sees one warning, not one per frame. */
    _refused = YES;
    return kSelectableMarkdownRefused;
  }

  _installed = YES;
  return kSelectableMarkdownInstalled;
}

/* NULL means "not right now", never "broken": before the bridge has started,
 * during a reload, and in a host that exposes neither object. */
- (void *)jsRuntimePointer
{
  id bridge = _bridge;
  if (bridge == nil && SelectableMarkdownClassImplements([RCTBridge class], @selector(currentBridge))) {
    /* +currentBridge is a process-global "most recently created bridge" and
     * picks the wrong one in a multi-bridge host, which is exactly why it is
     * consulted only when RN never gave this module a bridge of its own. */
    bridge = [RCTBridge currentBridge];
  }
  if (bridge == nil) {
    return nullptr;
  }

  /* RCTBridgeProxy owns the pointer directly; a real RCTBridge delegates to
   * the RCTCxxBridge underneath it. Asking the object we have first is what
   * keeps the proxy off the -batchedBridge path, which it answers with a
   * deprecation log rather than a different object. */
  id owner = bridge;
  if (!SelectableMarkdownClassImplements(owner, @selector(runtime)) &&
      SelectableMarkdownClassImplements(owner, @selector(batchedBridge))) {
    id batched = [(RCTBridge *)owner batchedBridge];
    if (batched != nil) {
      owner = batched;
    }
  }

  if (!SelectableMarkdownClassImplements(owner, @selector(runtime))) {
    return nullptr;
  }
  return [(id<SelectableMarkdownRuntimeOwner>)owner runtime];
}

@end
