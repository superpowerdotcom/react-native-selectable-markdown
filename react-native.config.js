/**
 * Autolinking descriptor.
 *
 * `sourceDir` MUST be relative to this package's root. The CLI resolves it as
 * `path.join(root, sourceDir)` (@react-native-community/cli-platform-android,
 * config/index.js -> dependencyConfig), and path.join does not treat an
 * absolute second argument as a reset — it concatenates. An absolute path here
 * therefore produces `<pkg>/<pkg>/android`, which does not exist, so
 * findManifest and findBuildGradle both come back empty, dependencyConfig
 * returns null, and the CLI concludes this package has no Android side at all:
 * no entry in settings.gradle, no NDK build, no PackageList line, and
 * `NativeModules.SelectableMarkdown` undefined at runtime. The build stays
 * green and says nothing, and then every parse throws at runtime: md4c is the
 * only parser this package has, so with the native module missing there is
 * nothing to render markdown with — the app ships, launches, and fails on the
 * first document it is asked to display.
 *
 * `sourceDir` IS `android`, NOT `platform/android`, AND THAT IS NOT COSMETIC.
 * React Native's Gradle plugin finds the package.json whose `codegenConfig` it
 * obeys with `project.file("../package.json")` and one fallback
 * (@react-native/gradle-plugin .../utils/PathUtils.kt, findPackageJsonFile) —
 * exactly one directory up from the Gradle project, and nothing more. From
 * `platform/android/` that first probe is `platform/package.json`, which does
 * not exist, so the plugin falls back to the *consuming app's* package.json,
 * and `GenerateCodegenArtifactsTask.resolveTaskParameters()` then prefers that
 * file's `codegenConfig.name` and `android.javaPackageName` over the values in
 * this package's `android/build.gradle` `react { }` block. In an app that has
 * its own `codegenConfig` — any app with its own native components — our
 * library name and jsSrcsDir are silently replaced by the app's, so the
 * generated `react_codegen_SelectableMarkdownSpec` target and the
 * `SelectableRunHostManagerInterface` this package's ViewManager implements
 * are simply never produced. That surfaces either as a CMake configure failure
 * naming a target nobody defined, or — worse — as a build that succeeds with
 * no Fabric component, in which case every run lays out at zero height. The
 * failure is consumer-dependent and invisible in this repository's CI, which
 * is why the directory sits at the package root like every other React Native
 * library's.
 *
 * `cmakeListsPath` is what installs the Fabric seam. Without it the CLI
 * defaults to `<sourceDir>/build/generated/source/codegen/jni/CMakeLists.txt`
 * (config/index.js, dependencyConfig) — React Native's own generated target,
 * which builds codegen's *non-measurable* ConcreteViewShadowNode and nothing
 * of ours. Pointing it at our file makes the app's generated
 * `Android-autolinking.cmake` `add_subdirectory` that instead; it then adds
 * the codegen directory itself, compiles our shadow node into the same target
 * and shadows three generated headers so the descriptor the app registers is
 * the measuring one. The path is joined onto `sourceDir`, not onto the package
 * root. `android/src/main/jni/CMakeLists.txt` documents the seam and asserts
 * its own preconditions at configure time; docs/FABRIC-PLAN.md §2.3 is the
 * long form.
 *
 * iOS needs no entry: cli-platform-apple's getDependencyConfig ignores any
 * `podspecPath` it is given and locates the podspec by searching the package
 * root, which is where SelectableMarkdown.podspec lives. The block below is
 * kept only to state that intent in one place.
 */
module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: 'SelectableMarkdown.podspec',
      },
      android: {
        sourceDir: 'android',
        cmakeListsPath: 'src/main/jni/CMakeLists.txt',
      },
    },
  },
};
