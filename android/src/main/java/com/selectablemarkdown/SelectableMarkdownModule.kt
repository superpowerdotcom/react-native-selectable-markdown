package com.selectablemarkdown

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

/**
 * Bridge module whose only job is to install the JSI binding: it loads
 * libselectable-markdown.so and hands the JS runtime pointer to the C++
 * installer, which puts the md4c parse function on the global object. No
 * markdown ever travels over the bridge — after `install()` returns true,
 * every parse is a direct JSI call from JS into C++.
 *
 * Why a blocking synchronous method, and not merely for convenience:
 *
 *  - It runs on the JS thread. `jsi::Runtime` has no locking, so touching it
 *    from anywhere else is a data race (invariant 1 in
 *    platform/cpp/SelectableMarkdownJsi.h). A regular async @ReactMethod is
 *    dispatched on the NativeModules thread, which would make this whole
 *    path unsound; a blocking sync method is a direct call from JS and is
 *    therefore already on the thread that owns the runtime.
 *  - It resolves before the first parse. The JS side calls `install()` on
 *    its way into the first parse and reads `global.__selectableMarkdown`
 *    immediately afterwards; an async call would leave a window in which
 *    that read finds nothing and the parse fails on an app whose native
 *    module was, a tick later, perfectly fine.
 *
 * Why it reports an outcome and never throws: this runs on the JS thread
 * during startup, and the causes it can hit (a Gradle/NDK misconfiguration, an
 * ABI the host app filtered out, a JS runtime that is already gone) are things
 * only a rebuild can fix. Throwing here would take the whole app down at
 * launch for a fault no user action can clear, and would report it far from
 * its cause. So the reason goes to logcat for whoever is debugging the build
 * and the outcome comes back as a string. It is not a soft failure: md4c is
 * the only parser this package ships, so a refusal that is never followed by
 * a successful install means every non-empty document throws out of
 * parseDocument — with a message naming the missing native module — instead
 * of rendering. The view layer itself is unaffected, which is why this is
 * reported rather than fatal: the app runs, its markdown does not parse.
 *
 * `installed` is done; `unavailable` (no JSI context or runtime yet) is transient, so ask again;
 * `refused` (library, JNI symbol or C++ installer failed) is permanent for this runtime.
 *
 * The @ReactModule annotation is what the new architecture reads the JS-facing
 * name from. ReactPackageTurboModuleManagerDelegate builds each package's
 * ReactModuleInfo map at startup and prefers `reactModule.name()` over
 * `module.getName()`; without the annotation the two must agree by
 * coincidence, and `NativeModules.SelectableMarkdown` resolving in bridgeless
 * mode would rest on that coincidence.
 */
@ReactModule(name = SelectableMarkdownModule.MODULE_NAME)
class SelectableMarkdownModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = MODULE_NAME

    /** Per module instance, so a reload's fresh runtime is asked afresh; `unavailable` and success stay unmemoized. */
    private var refused = false

    /** The code-block card's Copy button when the app supplies no `onCodeCopy`. */
    @ReactMethod
    fun copyText(text: String) {
        val clipboard =
            reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText("code", text))
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun install(): String {
        if (refused) {
            return OUTCOME_REFUSED
        }

        if (!nativeLibraryLoaded) {
            // The `by lazy` below has already logged, once for the process.
            refused = true
            return OUTCOME_REFUSED
        }

        // The holder is absent before the JS runtime exists (and on a context
        // that has none at all). That is an ordinary lifecycle state rather
        // than a programmer error, so this reads defensively instead of
        // asserting: `!!` here would turn a mid-reload install into a crash.
        val contextHolder = reactApplicationContext.javaScriptContextHolder
        if (contextHolder == null) {
            Log.w(TAG, "install skipped: no JSI context holder (context not ready)")
            return OUTCOME_UNAVAILABLE
        }

        return try {
            // The synchronized() is ReactContext.getJavaScriptContextHolder()'s
            // own documented usage, not decoration. The holder is cleared to 0
            // by whichever thread tears the instance down, and its monitor is
            // the only thing that stops the pointer being invalidated between
            // the read below and the JNI call that dereferences it.
            synchronized(contextHolder) {
                val runtimePointer = contextHolder.get()
                if (runtimePointer == 0L) {
                    // Reset to 0 while the context is being torn down or
                    // reloaded: "not now", not "broken".
                    Log.w(
                        TAG,
                        "install skipped: no JSI runtime pointer " +
                            "(context tearing down, or running without a JSI runtime)",
                    )
                    OUTCOME_UNAVAILABLE
                } else if (nativeInstall(runtimePointer)) {
                    OUTCOME_INSTALLED
                } else {
                    // The C++ installer already logged why (OnLoad.cpp).
                    refused = true
                    OUTCOME_REFUSED
                }
            }
        } catch (error: Throwable) {
            // UnsatisfiedLinkError (Error, not Exception) is the realistic
            // case: the .so loaded but was built from a source tree whose
            // JNI symbol does not match this class. Caught with everything
            // else because no failure mode of an optional fast path is worth
            // taking the app down for.
            Log.w(TAG, "install failed: native install threw", error)
            refused = true
            OUTCOME_REFUSED
        }
    }

    /**
     * Implemented by android/src/main/cpp/OnLoad.cpp, and returns
     * false if the C++ installer refused the runtime.
     *
     * An instance method on purpose: a `@JvmStatic` companion declaration
     * would mangle to a `..._00024Companion_...` symbol and quietly stop
     * matching the C++ side. Renaming or repackaging this class breaks the
     * same link — the failure surfaces as the UnsatisfiedLinkError caught
     * above, not as a build error.
     */
    private external fun nativeInstall(runtimePointer: Long): Boolean

    companion object {
        const val MODULE_NAME = "SelectableMarkdown"

        /** Matched verbatim by src/engine/native/install.ts and returned alike by platform/ios/SelectableMarkdownModule.mm. */
        const val OUTCOME_INSTALLED = "installed"
        const val OUTCOME_UNAVAILABLE = "unavailable"
        const val OUTCOME_REFUSED = "refused"

        private const val TAG = "SelectableMarkdown"
        private const val LIBRARY_NAME = "selectable-markdown"

        /**
         * Loaded once per process, on first `install()`. Lazily rather than
         * in an `init` block so that merely registering the package cannot
         * fail: a host app that builds the Kotlin sources without the NDK
         * build (or filters out this ABI) still gets a working view layer
         * and one line in logcat explaining why nothing parses.
         *
         * System.loadLibrary, not SoLoader.loadLibrary: minSdk here is 24, so
         * the system linker both extracts and resolves DT_NEEDED entries
         * (libjsi.so, libc++_shared.so) without help, and this avoids a
         * compile-time reference to a class that lives outside the React
         * Native artifact this module already depends on.
         */
        private val nativeLibraryLoaded: Boolean by lazy {
            try {
                System.loadLibrary(LIBRARY_NAME)
                true
            } catch (error: Throwable) {
                Log.w(
                    TAG,
                    "lib$LIBRARY_NAME.so failed to load, so markdown cannot be parsed in " +
                        "this build (md4c is the only parser this package ships). Check that " +
                        "the NDK build ran and that this ABI was not filtered out.",
                    error,
                )
                false
            }
        }
    }
}
