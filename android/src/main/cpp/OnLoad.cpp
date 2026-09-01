/*
 * OnLoad.cpp — the Android half of the JSI install path.
 *
 * The whole binding is one call: Kotlin reads the JSI runtime pointer out of
 * the ReactApplicationContext and passes it down as a jlong; this file turns
 * that jlong back into a jsi::Runtime& and hands it to
 * installSelectableMarkdown. Everything above (what gets installed on the
 * global object, how the flat buffer is produced) lives in
 * platform/cpp/SelectableMarkdownJsi.cpp, shared with iOS.
 *
 * INVARIANTS:
 *
 * 1. No C++ exception ever crosses back into the JVM. An exception escaping
 *    a JNI function is undefined behavior and in practice aborts the
 *    process; jsi::JSError and std::bad_alloc are both reachable from
 *    installSelectableMarkdown, so both catch clauses below are load-bearing
 *    and neither may be removed as "defensive".
 *
 * 2. Failure is reported, not thrown. A failed install does mean the app
 *    cannot parse markdown — md4c is the only parser this package ships —
 *    but this runs at startup, from JNI, before there is a screen to show
 *    anything on, and an abort here would report a missing capability as a
 *    process crash with no attribution. So the return value carries the
 *    outcome and logcat carries the reason; the TypeScript layer raises the
 *    actionable error later, at the first parse, where a caller can catch
 *    it. Logging the reason is load-bearing: without it, "install returned
 *    false" is indistinguishable from a library that was never built.
 *
 * 3. This file owns nothing, and it hops no threads. The runtime pointer is
 *    borrowed for the duration of the call — the JSI runtime is owned by
 *    React Native and is destroyed and recreated on every reload, so nothing
 *    here caches it. Thread affinity is the caller's guarantee:
 *    SelectableMarkdownJsi.h invariant 1 requires the runtime's own thread,
 *    and SelectableMarkdownModule.install() is a blocking synchronous
 *    @ReactMethod, i.e. a direct call from JS. Anything that reaches this
 *    function from another thread is already unsound before it gets here.
 *
 * 4. Re-installing is not an error. installSelectableMarkdown is idempotent
 *    per runtime (its invariant 2), so this stays a plain "call it and
 *    report" with no process-wide "already installed" flag — a dev reload
 *    hands us a fresh runtime that must be installed into again.
 *
 * 5. FABRIC IS NOT REGISTERED HERE, AND THAT IS NOT AN OMISSION. The obvious
 *    place to look for the Fabric component registration is this file, so
 *    say where it actually is. Third-party Fabric C++ never lives in the
 *    library's own .so: the shadow node, its state and its component
 *    descriptor are compiled into the *app's* libappmodules.so through the
 *    target react_codegen_SelectableMarkdownSpec (android/src/main/jni/
 *    CMakeLists.txt is the seam; platform/fabric holds the sources). The
 *    app's own JNI_OnLoad — React Native's template one, at
 *    ReactAndroid/cmake-utils/default-app-setup/OnLoad.cpp — installs
 *    DefaultComponentsRegistry::registerComponentDescriptorsFromEntryPoint,
 *    which sharedProviderRegistry() then calls
 *    (ReactAndroid/src/main/jni/react/newarchdefaults/
 *    DefaultComponentsRegistry.cpp:28-34); that entry point calls the
 *    generated autolinking_registerProviders, which is where our descriptor
 *    is added. Nothing in that chain passes through this file or this .so.
 *
 *    Which is also why this file still must not call
 *    facebook::jni::initialize. libselectable-markdown.so and
 *    libappmodules.so are separate shared objects with separate JNI_OnLoads,
 *    and the fbjni our Fabric code uses is linked into the app's, not into
 *    ours. Initializing fbjni from here would be a second initialization of
 *    a library this .so does not link, for the benefit of code it does not
 *    contain.
 *
 * Plain JNI, not fbjni: there is exactly one native method, it takes a
 * primitive and returns a primitive, and it never touches a Java object.
 * fbjni would buy nothing and would put an extra initialization ordering
 * constraint on JNI_OnLoad.
 */

#include "SelectableMarkdownJsi.h"

#include <android/log.h>
#include <jni.h>
#include <jsi/jsi.h>

#include <exception>

namespace {

constexpr const char* kLogTag = "SelectableMarkdown";

}  // namespace

/* Required so the JVM accepts the library; there is nothing to initialize —
 * no class references to cache (the one native method is bound by name, not
 * by RegisterNatives) and no fbjni bootstrap. Returning the JNI version is
 * the entire contract. */
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*reserved*/) {
  (void)vm;
  return JNI_VERSION_1_6;
}

/* Symbol name is the JNI mangling of
 * com.selectablemarkdown.SelectableMarkdownModule.nativeInstall(long) —
 * renaming or repackaging that Kotlin class silently breaks the binding at
 * runtime (UnsatisfiedLinkError), which the module catches and reports as a
 * failed install. Returns JNI_TRUE only when the JS-side global is in
 * place. */
extern "C" JNIEXPORT jboolean JNICALL
Java_com_selectablemarkdown_SelectableMarkdownModule_nativeInstall(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jlong runtimePointer) {
  /* Checked on the Kotlin side too. Repeated here because this cast is the
   * one place in the library where a bad value becomes a wild pointer
   * dereference, and the two sides can be built from different versions. */
  if (runtimePointer == 0) {
    __android_log_print(ANDROID_LOG_WARN, kLogTag,
                        "install skipped: null JSI runtime pointer");
    return JNI_FALSE;
  }

  auto& runtime =
      *reinterpret_cast<facebook::jsi::Runtime*>(runtimePointer);

  try {
    selectable_markdown::installSelectableMarkdown(runtime);
  } catch (const std::exception& error) {
    /* jsi::JSError and jsi::JSINativeException both derive from
     * std::exception, so this covers a runtime that rejects the install. */
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "install failed: %s",
                        error.what());
    return JNI_FALSE;
  } catch (...) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag,
                        "install failed: unknown exception");
    return JNI_FALSE;
  }

  return JNI_TRUE;
}
