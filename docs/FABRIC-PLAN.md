# Fabric: the new-architecture port

A design retrospective, not a live plan. It records how the Fabric
(new-architecture) port was built and why, written against react-native
0.75.4. The port shipped in full, including the goals §9 proposed deferring.

One thing it treats as live was removed in 0.10.0, when the peer range moved
to `react-native >= 0.82`: the old-architecture (Paper) path. Read any "both
architectures" discussion as history. The embed subsystem was removed in the
same release and restored, Fabric-only, in 0.11.0, so its `embeds`
discussion is current again.

The `file.ext:NN-MM` citations are stale. Source comments cite this document
by section number, which is why it stays and why the numbering never changes.
`docs/SELECTION.md` is the current JS-to-native contract; this explains how it
got that shape.

Related: [SELECTION.md](SELECTION.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[NATIVE.md](NATIVE.md) (the md4c binding, untouched by this port).

---

## Why do this at all

Old-architecture leaf views get no measure function, so the iOS host measured
itself in `layoutSubviews` and reported back through
`RCTUIManager.setIntrinsicContentSize(_:forView:)`, after the frame was laid
out at the wrong height. Every run rendered at least one wrong-sized frame, and
during streaming, where the tail run changes on every snapshot, it did so
continuously: prose that jumps as it arrives.

Fabric fixes this by construction. `measureContent` runs on the layout thread
before commit, so the first frame is the correct frame. Everything else here
(codegen, descriptors, recycling) is the price of that.

---

## 0. Verification status of this plan

Claims that would be expensive to get wrong were re-checked against
`node_modules/react-native` (0.75.4) before being built on:

| Claim | Evidence |
| --- | --- |
| `ParagraphShadowNode` is `final`; cannot be subclassed | `ReactCommon/react/renderer/components/text/ParagraphShadowNode.h:30-35` |
| `ConcreteViewShadowNode` is templated on the component-name symbol | `ReactCommon/react/renderer/components/view/ConcreteViewShadowNode.h:22-38` |
| `MeasurableYogaNode` requires `LeafYogaNode` | `ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:76-82` |
| Every clone of a measurable node is force-dirtied unless the clone ctor calls `cleanLayout()` | `YogaLayoutableShadowNode.cpp:134-137`; `ParagraphShadowNode.cpp:29-42` |
| `AttributedString::Fragment::string` is `std::string` (UTF-8), fragments are a flat non-overlapping list | `ReactCommon/react/renderer/attributedstring/AttributedString.h:33-56` |
| `TextAttributes` has `apply()` and sparse `std::optional` fields | `ReactCommon/react/renderer/attributedstring/TextAttributes.h:41-91` |
| RN measures iOS text with `usesFontLeading = NO`, `lineFragmentPadding = 0` | `ReactCommon/react/renderer/textlayoutmanager/platform/ios/react/renderer/textlayoutmanager/RCTTextLayoutManager.mm:176,183,287-289` |
| iOS Fabric component discovery is by the string passed to `codegenNativeComponent`, resolved to a `<Name>Cls()` C symbol | `React/Fabric/Mounting/RCTComponentViewFactory.mm:119`; `.../ComponentViews/RCTFabricComponentsPlugins.mm:41` |
| `+componentDescriptorProvider` on the view class is the sole iOS registration hook | `RCTComponentViewFactory.mm:182-186` |
| `RCTViewComponentView.prepareForRecycle` resets `_eventEmitter` | `React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm:452-470` |
| `setup_fabric!` is called unconditionally at 0.75 | `scripts/react_native_pods.rb:177-180`; `scripts/cocoapods/fabric.rb:10-18` |
| `install_modules_dependencies` overwrites `CLANG_CXX_LANGUAGE_STANDARD` to `c++20` and replaces `pod_target_xcconfig` at the end | `scripts/cocoapods/new_architecture.rb:96,127` |
| `RCT_NEW_ARCH_ENABLED` is never a Swift compilation condition | only `SWIFT_ACTIVE_COMPILATION_CONDITIONS` write in the tree is `react_native_pods.rb:308` (`DEBUG`, Debug config only) |
| `findPackageJsonFile` looks exactly one directory up | `@react-native/gradle-plugin/.../utils/PathUtils.kt:200-212` |
| The Gradle codegen task prefers the *found* package.json's `codegenConfig.name` over `react { libraryName }` | `.../tasks/GenerateCodegenArtifactsTask.kt:56-64` |
| RN's generated `react_codegen_<lib>` CMake target links neither `rrc_text` nor `react_render_textlayoutmanager` nor `reactnativejni` | `@react-native/codegen/lib/generators/modules/GenerateModuleJniH.js:54-105` |
| `ReactNative-application.cmake` aliases every prefab to a bare name inside the app's CMake scope | `ReactAndroid/cmake-utils/ReactNative-application.cmake:64-100` |
| `Props::rawProps` (`folly::dynamic`) is populated on Android and is what Fabric hands the Java ViewManager | `ReactCommon/react/renderer/core/Props.cpp:29-31`; `ReactAndroid/src/main/jni/react/fabric/FabricMountingManager.cpp:222-226` |
| `ViewManager.measure(Context, ReadableMap, ReadableMap, ReadableMap, …)` is routed by component name | `ReactAndroid/.../uimanager/ViewManager.java:402-414`; `.../fabric/mounting/MountingManager.java:361-385`; `.../fabric/FabricUIManager.java:549-585` |
| `ViewManager.updateProperties` falls back to `@ReactProp` reflection when `getDelegate()` is null | `ReactAndroid/.../uimanager/ViewManager.java:82-89` |
| `UIManager.hasViewManagerConfig` exists on both UIManager implementations | `Libraries/ReactNative/PaperUIManager.js:105-107`; `Libraries/ReactNative/BridgelessUIManager.js:292-294` |

Codegen behaviour was verified by running codegen; the output is quoted in §3.

Two corrections to earlier investigation:

1. **A tsc-transpiled spec file degrades silently.** The babel preset enables
   the codegen plugin only when the source text matches
   `/\bcodegenNativeComponent</`. `tsc` strips the type argument, so no
   `__INTERNAL_VIEW_CONFIG` is emitted and the default export falls back to
   `requireNativeComponent`, dead under bridgeless. `scripts/verify-pack.mjs`
   therefore asserts the untranspiled spec ships (§7, G1).
2. **`unstable_hasComponent` throws a bare string, not an `Error`**, when its
   global is absent. `RunHost`'s probe stays inside a bare `catch`.

The C++ compile harness (`scripts/check-fabric-cpp.mjs`) passed from a cold
cache, but proved less than claimed because it skipped a file it was assumed
to cover. §0.1 has that and every other gap between claim and verification.

### 0.1 What the plan got wrong, recorded after the fact

What an adversarial review of the finished work found. Every item was
reproduced before it was fixed.

| What the plan or the implementation claimed | What was true | Where it is fixed |
| --- | --- | --- |
| §8: the C++ harness "logs each file it skipped so a green run never overstates its coverage" | It did not. `android/src/main/jni/RNSMRunTextMeasurer.cpp`, the only C++ here that binds an fbjni method id by hand, was compiled and reported by nothing, because both walkers started at `platform/`. `platform/ios/RNSMTextKitStack.mm` and `SelectableMarkdownModule.mm` were invisible to the skip list for a different reason (a text match on `react/renderer/`). The report read "18 TUs across 2 platforms" over a set that excluded them. | `scripts/check-fabric-cpp.mjs`: one `classifyNativeSources()` derives both lists from one traversal of `platform/` and `android/`, and the run dies if either Fabric directory contributes nothing. The Android JNI measurer compiles on the android pass (`ReactAndroid/src/main/jni` added to include roots). Verified by mutation: `yogaMeassureToSize` → a nonexistent name ⇒ `FAIL android/src/main/jni/RNSMRunTextMeasurer.cpp`. |
| §2.1 + G1.9/G1.10: excluding the spec from `dist/` is safe because `RunHost` reaches it through a `require` | `dist/view/RunHost.js` shipped a static `require('./SelectableRunHostNativeComponent')` of a module absent from `dist/`. Metro resolves `react-native` → `src/` and is fine, but webpack, Rollup, Vite, Parcel and Next resolve the CJS graph ahead of time and stop with `Module not found` in the consumer's build; react-native-web is that case. The `try/catch` is irrelevant, because resolution precedes execution. | `scripts/emit-dist-spec-shim.mjs`, run by `npm run build`, writes a `module.exports = {}` shim at the path tsc would have used, so `spec.default` stays undefined and tier 2 is reached as documented. `verify-pack.mjs` gained a CJS graph walk from `main` that fails on any unresolvable relative require, and its transpiled-copy assertion moved from filename to content (a leak calls `codegenNativeComponent`; the shim never does). |
| The Swift was "reviewed, not verified" | It did not compile. Four errors in the Swift-imports-Objective-C class no reading catches: `didSetProps` needs `override` (RN declares it as a category on `UIView`); `+makeTextContainerWithSize:` imports as `makeTextContainer(with:)`; `-setIntrinsicContentSize:forView:` imports as `setIntrinsicContentSize(_:for:)`; `NSArray` does not convert to `[Any]`. A fifth surfaced after (`.greatestFiniteMagnitude` ambiguous against a bare `0`). The file is architecture-neutral and unconditionally in `source_files`, so this broke both architectures on the first `pod install && xcodebuild`, for every consumer. | `scripts/check-swift.mjs` (`npm run check:swift`) reproduces React-Core's Clang module from RN's real headers and type-checks `platform/ios/*.swift` against the iOS SDK at the podspec's deployment target and Swift version. `--selftest` reverts all four defects and asserts each is rejected. |
| §8: `npm run conformance` proves "the streaming prefix oracle still holds after the softBreak change" | The prefix oracle compares ASTs, and the softBreak change touches no AST. It would have passed with `softBreak` emitting `'\n\n'` or nothing. Nothing in the repository called `projectRun` or `mapSelectionToSource` over a real corpus. | `conformance/selection/projection-oracle.test.ts`: the CommonMark 0.31.2 suite plus every fixture, under `presets.llmChat` and `presets.everything`: piece tiling, in-bounds ordered mapped spans, `markdown === source.slice(span)`, and a per-`softBreak` assertion that the projected character is a space. Reverting the emit to `'\n'` fails two assertions and passes the other six, confirming the change was offset-neutral. |
| §2.3, and the alias header: a quoted-include regression "fires at configure time in the consuming app" | Only the restructuring half fired. None of the seam's three configure-time assertions looked at include style; a bare quoted sibling include leaves all three true while resolving to codegen's non-measuring header, so the app builds green and every run lays out at zero height. Codegen already emits that style in the same directory (`SelectableMarkdownSpecJSI-generated.cpp:10`). `check:codegen` had the matching hole: it failed on the quoted *full path*, the harmless form. | `smd_require_angle_include` in `android/src/main/jni/CMakeLists.txt` asserts the exact angle spelling on the three edges that reach the descriptor, at configure time in the consumer's build. `check-codegen.mjs` requires `#include <react/renderer/components/<spec>/X.h>` character for character for all three shadowed headers. |
| §5: "Tail policy is unchanged", resting on "the JS layer guarantees that a selectable run's text never changes" | True of settled *blocks*, false of settled *runs*. `segmentRuns` merges every adjacent settled flowing block into one run keyed `run:${span.start}`, so a newly settled block lands in the same run: same key, same mounted view, still `selectable`, longer text. Measured over the eight fixtures at 5-character chunks under `presets.llmChat`: 27 text changes on Android-selectable runs, about four per message, each a `TextView#setText` that drops the selection and action mode. Pre-existing. | Not fixed; both candidate fixes are larger than this diff. `docs/SELECTION.md` records it as a known gap, and `SelectableRunHostView.kt` carries the measurement and the two options. |
| Fabric delivers only changed props, like paper | It delivers the whole map: `FabricMountingManager::getProps` returns `rawProps` entire and `ViewManager.updateProperties` pushes every key through the delegate. `setAttributes` had no equality guard, so any prop change (a theme switch, a new `onSelectionCopy` identity) re-`setText` an identical string and killed a live selection. Harmless on paper. | An equality guard on `setAttributes` matching the one `setText` already had (`SelectableRunHostView.kt`). |
| G4.11 specified `getExportedCustomDirectEventTypeConstants` without saying to merge `super` | The implementation returned a fresh map, dropping `BaseViewManager`'s `topAccessibilityAction → onAccessibilityAction`. `accessibilityActions` is a live `@ReactProp`, so a consumer setting it never received the callback on the old architecture. Pre-existing, but the method was rewritten here without restoring the merge. | Merges `super` (copied, not mutated). |
| §4.4's clone constructor | A later edit replaced it with `shouldNewRevisionDirtyMeasurement`, which does not exist at 0.75.4. Declared `override` it does not compile; without `override` it compiles, overrides nothing, is never called, and leaves every clone force-dirtied with no error: the exact O(n²) §4.4 exists to prevent. | The `cleanLayout()` guard is restored, with the trap named in the header. `npm run check:fabric-cpp` rejects the `override` form. |
| §8: "released behind an explicitly experimental flag in the README" | The README still described a pre-Fabric library in three places, never mentioned the new architecture, and never stated the 0.75 Fabric floor. | README states the floor, marks the Fabric path experimental, splits the status table by architecture, and records the `use_frameworks! :linkage => :dynamic` limitation (codegen wraps third-party registration in `#ifndef RCT_DYNAMIC_FRAMEWORKS`). |
| CI ran the gates | `check:fabric-cpp` and its self-test ran nowhere automated; the port's C++ was compiled by one person on one Mac. `release.yml` ran fewer checks than `ci.yml` while being the last step before `npm publish`. | `ci.yml` gains a `fabric-cpp` job (ubuntu + `libboost-dev`) and a `swift` job (macos, `RNSM_REQUIRE_SWIFT=1` so a skip is a failure). `release.yml` runs typecheck, check:codegen and both C++ gates before packing. |

One stale path also shipped: `src/engine/native/install.ts` still named
`platform/android/.../SelectableMarkdownModule.kt`, a directory §2.3 moved.

---

## 1. The decision that shapes everything: we do not adopt React Native's text stack

The obvious design is `ParagraphShadowNode`'s: build a
`facebook::react::AttributedString`, hand it to `TextLayoutManager`, publish
`ParagraphState`. We do not, and every other decision follows. Reasons, worst
first:

1. **It puts a UTF-8/UTF-16 conversion in the selection contract.**
   `AttributedString::Fragment::string` is UTF-8. Every offset in this library
   is UTF-16, and the single conversion point is `platform/cpp/FlatBuffer.cpp`.
   A second conversion where selection offsets are computed risks silently
   copying the wrong markdown.
2. **It forces a flattening step.** `AttributedString` is a flat, disjoint
   fragment list. Our attributes are sparse and overlapping, because both
   platforms' text stores apply overlapping ranges natively
   (`src/view/runAttributes.ts`). Flattening re-derives "which marks cover
   this character" at every boundary, in C++. §3 covers this.
3. **On Android it would not measure our view.** `TextLayoutManager`'s
   Android measure path is a JNI round trip hardcoded to `"RCTText"`, landing
   in `ReactTextViewManager.measure`. It would measure RN's `<Text>`
   semantics, not our `TextView` configuration.
4. **It links prefab modules the paper path avoids.** `rrc_text` and
   `react_render_textlayoutmanager` exist at 0.75 but not at 0.73, and not
   under those names at 0.76+. `jsi` is the only prefab stable across the
   supported range.

**Instead**, the existing sparse-attribute builders,
`SelectableRunHostView.buildAttributedString` (Swift) and
`RunAttributedText.build` (Kotlin), become the single source of truth per
platform, called from both the paper path and the Fabric shadow node.
Measurement goes through our own façade, shaped like `TextLayoutManager`:

```
platform/fabric/RNSMRunTextMeasurer.h        // façade + Content handle
platform/ios/fabric/RNSMRunTextMeasurer.mm   // TextKit 1, in-process
android/src/main/jni/RNSMRunTextMeasurer.cpp // JNI -> our own ViewManager.measure
```

**Cost.** We do not inherit RN's font resolution (`RCTFont`,
`ReactFontManager`) or `includeFontPadding` semantics. That divergence predates
this port (§6, item 13) and gets its own diff.

---

## 2. Dual-architecture strategy

### 2.1 JS: one spec file, one resolution order

One `codegenNativeComponent` declaration serves both architectures at 0.75:
the babel plugin rewrites the default export to
`NativeComponentRegistry.get(name, () => __INTERNAL_VIEW_CONFIG)`, and the
registry prefers `getNativeComponentAttributes(name)` on paper and the static
config under bridgeless. So `src/view/SelectableRunHostNativeComponent.ts`
replaces `requireNativeComponent('SelectableRunHost')` on both paths.

`RunHost.loadNativeHost()` resolves once per JS runtime:

```
1. UIManager.hasViewManagerConfig('SelectableRunHost') is true
     -> the codegen'd component (paper view manager or Fabric component view)
2. anything throws, or the probe is false
     -> null -> <Text selectable> fallback  (Expo Go, web, jest, unlinked)
```

(Tier 2 was later removed, and md4c became the only parser, so in Expo Go, on
the web, or in an unrebuilt app `parseDocument` now throws before there is
anything to render. The module installs the parser binding without a view, so
a build with the module linked but the component missing still parses.)

Three details, each a silent failure otherwise:

- **`hasViewManagerConfig`, not `getViewManagerConfig`.** The latter
  soft-errors to `null` under bridgeless, so a correctly linked Fabric
  component would be reported missing and every run would lose
  `onSelectionAction` and both custom menu items. `hasViewManagerConfig`
  exists on both implementations and maps to `unstable_hasComponent`.
- **The probe stays inside a bare `catch`** (§0).
- **The spec must reach Metro untranspiled.** `dist/` is tsc output with the
  type arguments stripped, which disables the codegen plugin. So
  `package.json` gets `"react-native": "src/index.ts"` (Metro's
  `resolverMainFields` is `['react-native','browser','main']`), the spec is
  excluded from `tsconfig.build.json`'s emit, and `scripts/verify-pack.mjs`
  asserts the packed tarball.

The name stays `SelectableRunHost`, not `RCTSelectableRunHost`:
`componentNameByReactViewName` strips a leading `RCT`, so C++ would look up
`SelectableRunHost` while codegen's iOS map would be keyed
`RCTSelectableRunHost`.

### 2.2 iOS: the podspec, and what an old-arch app compiles

`install_modules_dependencies(s)` is gated on the environment:

```ruby
if ENV['RCT_NEW_ARCH_ENABLED'] == '1' && respond_to?(:install_modules_dependencies, true)
  install_modules_dependencies(s)
end
```

At 0.75 `setup_fabric!` runs unconditionally, so the guard is not strictly
needed there, but the peer range started at 0.73 and could not be verified.
The guard is safe across the range.

Everything under `platform/ios/fabric/` is wrapped, includes and all, in
`#ifdef RCT_NEW_ARCH_ENABLED`, so an old-architecture app compiles those files
to empty translation units. The generated
`RCTThirdPartyFabricComponentsProvider.mm` entry referencing
`SelectableRunHostCls` is itself inside `#if RCT_NEW_ARCH_ENABLED`.

Three podspec changes:

1. **`CLANG_CXX_LANGUAGE_STANDARD` becomes `c++20` unconditionally.**
   `install_modules_dependencies` sets it anyway under new arch; one
   configuration to verify. `platform/cpp/*.cpp` must compile at C++20
   (`scripts/check-fabric-cpp.mjs --syntax-only`, §8).
2. **`pod_target_xcconfig` is assigned before `install_modules_dependencies`.**
   The helper reads the hash, appends to `HEADER_SEARCH_PATHS`, then
   reassigns it; anything set afterwards is discarded.
3. **C++ headers must not reach the umbrella header.** The pod sets
   `DEFINES_MODULE = YES` and contains Swift, so CocoaPods compiles every
   public header as Objective-C. `s.private_header_files` covers
   `platform/cpp/**/*.h`, `platform/fabric/**/*.h` and the ObjC++-only headers
   under `platform/ios/`. The pod had never been `pod install`ed, so this
   surfaces on the first install.

No `React-FabricComponents`: it exists to reach `RCTAttributedTextUtils` and
`RCTTextLayoutManager`, both rejected in §1.

### 2.3 Android: the Gradle project has to move

The library's own `libselectable-markdown.so` is unchanged, linking only
`ReactAndroid::jsi`. Third-party Fabric C++ is compiled into the app's
`libappmodules.so` through a target named `react_codegen_<libraryName>` whose
CMakeLists React Native generates per version.

That requires the RN Gradle plugin to run codegen for this library, which does
not work from `platform/android/`. `findPackageJsonFile` checks exactly
`project.file("../package.json")`, then falls back to the consuming app's
root, and `GenerateCodegenArtifactsTask` prefers that file's
`codegenConfig.name` over our `react { libraryName }`. In an app with its own
`codegenConfig`, our library name and `jsRootDir` are silently replaced: a
CMake configure failure naming an undefined target or, worse, a green build
where our component was never generated and every run lays out at zero height.

**So `platform/android/` moves to `android/`**, which is why every RN library
uses `<pkg>/android`. A second `platform/package.json` would still not fix
`findLibraryName`, which the CLI reads from the package root.

`android/build.gradle` gains:

```groovy
apply plugin: 'com.facebook.react'   // on the root buildscript classpath in every RN app
react {
    libraryName = 'SelectableMarkdownSpec'
    jsRootDir = file('../src')
    codegenJavaPackageName = 'com.selectablemarkdown'
}
```

The plugin runs codegen for every `com.android.library` that applies it,
regardless of architecture, so the generated Java delegate is always on the
classpath and the Kotlin ViewManager implements
`SelectableRunHostManagerInterface` unconditionally: the only compile-time
link between the TypeScript spec and the Kotlin setters. `codegenConfig.type`
is iOS-only; Android always generates `all`, which makes
`#include <SelectableMarkdownSpec.h>` in the generated `autolinking.cpp`
resolve with zero TurboModules.

**The seam.** The app's `autolinking.cpp` hardcodes

```cpp
#include <react/renderer/components/SelectableMarkdownSpec/ComponentDescriptors.h>
providerRegistry->add(concreteComponentDescriptorProvider<SelectableRunHostComponentDescriptor>());
```

and codegen's `ComponentDescriptors.h` aliases that name to the non-measurable
`ConcreteViewShadowNode`. We take the name over by putting our own header
earlier on the include path. Every generated `.cpp` uses angle-bracket
includes (`ShadowNodes.cpp` line 11), so `-I` order decides.

`react-native.config.js` points `android.cmakeListsPath` at
`src/main/jni/CMakeLists.txt`:

```cmake
# Inherit RN's own generated target: its kind (SHARED at 0.75, OBJECT at 0.76+)
# and its link list are version-correct by construction.
set(SMD_CODEGEN_JNI "${CMAKE_CURRENT_SOURCE_DIR}/../../../build/generated/source/codegen/jni")
if(NOT EXISTS "${SMD_CODEGEN_JNI}/react/renderer/components/SelectableMarkdownSpec/ShadowNodes.cpp")
  message(FATAL_ERROR
    "react-native-selectable-markdown: React Native's codegen output is not where "
    "this file expects it. The Fabric shadow node is wired in by shadowing the "
    "generated ShadowNodes.h/ComponentDescriptors.h/States.h; if RN changed that "
    "layout, docs/FABRIC-PLAN.md section 2.3 describes the fallback.")
endif()

add_subdirectory("${SMD_CODEGEN_JNI}" SelectableMarkdownSpec_codegen_build)

target_sources(react_codegen_SelectableMarkdownSpec PRIVATE ${SMD_FABRIC_SOURCES})
target_include_directories(react_codegen_SelectableMarkdownSpec BEFORE PUBLIC
  "${SMD_FABRIC_DIR}/android-include"   # our ShadowNodes.h / ComponentDescriptors.h / States.h
  "${SMD_FABRIC_DIR}")

# react/jni/ReadableNativeMap.h. Target existence, never a version number:
# 0.73-0.75 publish per-feature prefabs, 0.76+ collapse them into `reactnative`.
if(TARGET reactnativejni)
  target_link_libraries(react_codegen_SelectableMarkdownSpec reactnativejni)
elseif(TARGET reactnative)
  target_link_libraries(react_codegen_SelectableMarkdownSpec reactnative)
endif()
```

The bare target names work inside the app's CMake scope because
`ReactNative-application.cmake` aliases every prefab.

**Fallback if RN changes the generated layout** (where the `FATAL_ERROR`
points): declare `react_codegen_SelectableMarkdownSpec` ourselves, compiling
the generated `Props.cpp` and `EventEmitters.cpp` plus our sources, with
`extern const char SelectableRunHostComponentName[] = "SelectableRunHost";`
replacing `ShadowNodes.cpp`. No include-order dependency, at the cost of a
two-branch link list.

**An old-arch Android app compiles none of this.** `Android-autolinking.cmake`
is only generated for new-arch apps, so `src/main/jni/CMakeLists.txt` is never
reached. Library codegen still emits a Java delegate nobody instantiates.
`@ReactProp` methods stay on the ViewManager for paper's reflection-built view
config.

`android/src/main/cpp/OnLoad.cpp` keeps its plain-JNI `JNI_OnLoad` and does
not call `facebook::jni::initialize`: our `.so` and the app's
`libappmodules.so` are separate shared objects, and the fbjni our Fabric code
uses is linked into the app's. Fabric registration happens in RN's
`DefaultComponentsRegistry.cpp`.

### 2.4 Native source layout

`platform/cpp/` is the markdown engine and must not acquire view-layer code.
Fabric C++ gets its own tree:

```
platform/fabric/                               shared, compiles on both platforms
  RNSMRunHostShadowNode.h/.cpp                 traits, clean-clone ctor, measureContent, layout
  RNSMRunHostState.h                           iOS: wrapped NSAttributedString; Android: empty
  RNSMRunHostComponentDescriptor.h             adopt() -> setMeasurer()
  RNSMRunTextMeasurer.h                        the platform façade (see §1)
  android-include/react/renderer/components/SelectableMarkdownSpec/
    ShadowNodes.h  ComponentDescriptors.h  States.h    aliases; Android-only (see §2.3)

platform/ios/fabric/
  RNSMRunTextMeasurer.mm                       TextKit 1 measurement
  RCTSelectableRunHostComponentView.h/.mm      the mounting-layer view

android/src/main/jni/
  CMakeLists.txt                               the seam
  RNSMRunTextMeasurer.cpp                      JNI round trip to our ViewManager
```

Our classes are `RNSMRunHost*`, not `SelectableRunHost*`, so they cannot
collide with codegen's aliases. The Android-only alias headers are the only
place codegen's names bind to our types.

### 2.5 The supported RN range

| | Paper path | Fabric path |
| --- | --- | --- |
| Supported | `>= 0.73`, unchanged | `>= 0.75` |
| Verified against | 0.75.4 sources only (as today) | 0.75.4 sources + a real codegen run + a real C++ compile |
| Untested | 0.73, 0.74, 0.76+ | 0.73, 0.74, 0.76+ |

`peerDependencies` stayed `>=0.73` (the paper path worked there); the Fabric
floor was documented as 0.75:

- **The 0.76 prefab reorganisation is a non-issue.** No file shipped to the
  NDK names a prefab except `ReactAndroid::jsi` and the target-existence probe
  above; the rest of the link list is inherited from RN's generated target.
- **0.73 and 0.74 are unverified.** `react_render_textlayoutmanager` did not
  exist at 0.73, `ReactCodegen` was `React-Codegen` before 0.75, and nothing
  here can build against those versions.
- **Only a CI matrix build (0.73, 0.74, 0.76, 0.81) moves the floor**, and it
  needs an example app first (§8).

---

## 3. The sparse-attribute problem, and why flattening never happens

### 3.1 What codegen does with a sparse array-of-object prop

The highest-risk unknown, settled by running codegen. Given

```ts
type NativeRunTextAttribute = Readonly<{
  start: Int32; end: Int32;
  fontFamily?: string; fontSize?: Float; lineHeight?: Float;
  fontWeight?: string; fontStyle?: string; textDecorationLine?: string;
  color?: ProcessedColorValue; backgroundColor?: ProcessedColorValue;
}>;
```

`generate-specs-cli.js` emits (verbatim):

```cpp
struct SelectableRunHostAttributesStruct {
  int start{0};
  int end{0};
  std::string fontFamily{};
  Float fontSize{0.0};
  Float lineHeight{0.0};
  std::string fontWeight{};
  std::string fontStyle{};
  std::string textDecorationLine{};
  SharedColor color{};
  SharedColor backgroundColor{};
};

static inline void fromRawValue(const PropsParserContext& context, const RawValue &value, SelectableRunHostAttributesStruct &result) {
  auto map = (std::unordered_map<std::string, RawValue>)value;

  auto tmp_fontFamily = map.find("fontFamily");
  if (tmp_fontFamily != map.end()) {
    fromRawValue(context, tmp_fontFamily->second, result.fontFamily);
  }
  /* ... one such block per field ... */
}
```

**Sparseness survives.** No `std::optional` (codegen never reads
`prop.optional`), but `fromRawValue` only assigns present keys, so an absent
key keeps the brace-initialised default. "Absent" is a per-type sentinel:

| field | absent reads as | safe? |
| --- | --- | --- |
| `std::string` | `""` | yes. No attribute means an empty family/weight/decoration |
| `Float` | `0.0` | yes. A 0pt font size and a 0pt line height are both meaningless |
| `SharedColor` | `HostPlatformColor::UndefinedColor` | yes, and best: `SharedColor::operator bool()` *is* the is-set test (`ReactCommon/react/renderer/graphics/Color.h:48-50`) |
| `bool` | `false` | no. `false` is a legal value, so it cannot double as "unset" |

Two shapes are banned from the struct, both confirmed by probe:

- **No optional booleans.** No sentinel exists.
- **No string enums nested in an array element.** `generateEnumString` only
  recurses into top-level object props, so
  `fontWeight?: WithDefault<'400'|'700','400'>` emits
  `ProbeWeight weight{ProbeWeight::400};`, an undeclared type with an invalid
  initialiser. So `fontWeight`, `fontStyle` and `textDecorationLine` are plain
  `string`, with permitted values enforced by the TypeScript type on
  `RunTextAttribute`.

Also by probe: `ReadonlyArray<'copy-text'|'copy-markdown'>` compiles to a
`uint32_t` bitmask, which loses order, and `selectionActions` is an ordered
menu. It stays `ReadonlyArray<string>` → `std::vector<std::string>`.

### 3.2 Colours stay processed in JS

`ColorValue` and `ProcessedColorValue` both become `SharedColor`, but the
generated view config only attaches `{process: processColor}` to top-level
colour props. Verified by running babel over a probe spec:

```js
validAttributes: {
  tintColor: {process: require('react-native/Libraries/StyleSheet/processColor').default},
  attributes: true,     // <- nothing nested is processed
  actions: true
}
```

`GenerateViewConfigJs.js` returns `j.literal(true)` for object and array
element types, and `fromRawValueShared.h` falls through to
`parsePlatformColor`, where a raw `"#ff0000"` is undefined.

So `toNativeAttribute` in `src/view/RunHost.tsx` stays, including the
`color: null` handling: an explicit `null` survives jsi→dynamic conversion
(only `undefined` is dropped) and would read natively as "clear the colour"
rather than "no opinion". The spec types the fields as `ProcessedColorValue`;
the generated C++ is identical either way.

### 3.3 Where flattening happens: nowhere

Because §1 rejects `AttributedString`, no disjoint-fragment representation
exists. The sparse, overlapping array crosses intact and is applied in order by
each platform's text store, as both hosts already did:

- iOS: `NSMutableAttributedString.addAttribute(_:value:range:)` over
  overlapping ranges, with `enumerateAttribute(.font, in:)` for the one
  attribute that composes (a font carries family, size and traits, so a code
  span inside a bold heading merges rather than replaces).
- Android: `SpannableString.setSpan` in `RunAttributedText.build`.

The Fabric shadow node reads `SelectableRunHostProps.attributes` (iOS) or
forwards `props->rawProps` (Android) into those builders. No flattening, no
parallel arrays, no bitmask, no second wire format.

On Android, Fabric hands the Java ViewManager the raw props
(`Props::initialize` stores `(folly::dynamic)rawProps` under `#ifdef ANDROID`;
`FabricMountingManager::getProps` wraps it as a `ReadableNativeMap`), so
`RunAttributedText.parse`'s `hasKey`-based "absent means inherit" reading and
its "skip an unknown key" degradation work unchanged. The codegen struct exists
on Android only for prop diffing.

Residual risk: the sentinel encoding is a convention, not a type. An optional
boolean added later reads as `false` wherever omitted, an iOS-only styling bug
no test here can see. The spec file says so, and `scripts/check-codegen.mjs`
fails on an optional boolean in that struct by name.

---

## 4. Measurement agreement

The shadow node measures on the layout thread; the view draws on the main
thread. If they use different text engines they disagree, and the symptom is
text clipped at the bottom of a run, worse with line count.

The mechanism on both platforms: one place builds the styled string, one place
configures the layout engine, and both sides call both. One function, not "the
same three properties set in two files".

### 4.1 iOS

RN's own text measurement diverges from a stock `UITextView` on four axes:

| | RN's `RCTTextLayoutManager` | stock `UITextView` |
| --- | --- | --- |
| `NSLayoutManager.usesFontLeading` | `NO` (`RCTTextLayoutManager.mm:183`) | `YES` (UIKit default) |
| `textContainer.lineFragmentPadding` | `0` (`:176`) | `5.0` |
| `textContainerInset` | n/a | `{8,0,8,0}` |
| TextKit generation | TextKit 1 | TextKit 2 on iOS 16+ |

`usesFontLeading` alone changes line height for any face with non-zero
leading. The paper view got away with measuring via `textView.sizeThatFits`,
the object it drew with; under Fabric that escape does not exist. So: one
TextKit-1 factory, used by both sides.

```objc
// platform/ios/RNSMTextKitStack.h  (public, pure ObjC)
@interface RNSMTextKitStack : NSObject
+ (NSLayoutManager *)makeLayoutManager;                       // usesFontLeading = NO
+ (NSTextContainer *)makeTextContainerWithSize:(CGSize)size;  // lineFragmentPadding = 0
+ (CGSize)measureAttributedString:(NSAttributedString *)string
                            width:(CGFloat)width
                 pointScaleFactor:(CGFloat)pointScaleFactor;
@end
```

> **Correction: the sketch is not what shipped, on two counts.**
> `+makeLayoutManager` was never exported; it is the file-local
> `RNSMMakeLayoutManager()`, since a second caller building its own layout
> manager is the failure the factory prevents. And
> `+makeTextContainerWithSize:` became `+makeTextStackWithSize:`, returning
> the `NSTextStorage`, plus `+textContainerOfStack:`. TextKit 1 ownership runs
> storage → layout manager → container with `assign` back-pointers, so
> returning the container returned the one object the graph did not retain:
> ARC released the storage, every caller got a container whose `layoutManager`
> dangled, measurement returned `{0, 0}`, Yoga laid every run out at zero
> height, and nothing was logged. Because the pointer dangled rather than
> being nil, `-[UITextView initWithFrame:textContainer:]` sometimes used freed
> memory instead of raising, so it looked like a rendering bug, not a crash.
> `RNSMTextKitStack.h` carries the full note.

- `RNSMRunTextMeasurer.mm` builds the stack with `{maxWidth, CGFLOAT_MAX}`,
  calls `ensureLayoutForTextContainer:` then `usedRectForTextContainer:`, and
  rounds with `layoutContext.pointScaleFactor` (not `RCTScreenScale()`, which
  is main-thread-affine).
- The view constructs its `UITextView` with
  `-[UITextView initWithFrame:textContainer:]` over a container from the same
  factory: a stronger TextKit-1 opt-in than
  `UITextView(usingTextLayoutManager: false)`, because it also owns
  `usesFontLeading`.

One string builder, `RNSMAttributedText`, replaces
`SelectableRunHostView.buildAttributedString`:

```objc
// RNSMAttributedText.h: public, pure ObjC. The Swift paper view calls this
+ (NSAttributedString *)attributedStringWithText:(NSString *)text
                                      attributes:(NSArray<NSDictionary *> *)attributes;

// RNSMAttributedText+Props.h: private, C++. The shadow node calls this
+ (NSAttributedString *)attributedStringWithProps:(const facebook::react::SelectableRunHostProps &)props;
```

Both funnel into one private implementation; the C++ overload only turns
sentinels back into present/absent.

The measured string travels to the view through Fabric State, so it is built
once per commit and the view draws the object that was measured:

```cpp
class RNSMRunHostState final {
 public:
  std::shared_ptr<void> attributedString;   // wrapManagedObject(NSAttributedString *)
#ifdef ANDROID
  RNSMRunHostState(const RNSMRunHostState&, const folly::dynamic&) {}
  folly::dynamic getDynamic() const { return {}; }
#endif
};
```

`wrapManagedObject` / `unwrapManagedObject` come from `React-utils`, which
`install_modules_dependencies` provides. `getDynamic()` and `getMapBuffer()`
are pure-virtual on `State` only under `#ifdef ANDROID`.

Deleted while here: `textView.adjustsFontForContentSizeCategory = true`. It
only scales `UIFontMetrics` fonts, which ours are not, so it was a no-op, and
a working version would scale at draw time against an unscaled measurement.
Dynamic Type is cut (§6) with the hooks recorded.

### 4.2 Android

No second measurement implementation is needed. `FabricUIManager.measure(surfaceId, componentName, localData, props, state, …)`
routes by component name through `MountingManager.measure` to
`ViewManager.measure(Context, ReadableMap, ReadableMap, ReadableMap, …)`, the
mechanism `AndroidSwitchMeasurementsManager.cpp` uses.

So `RNSMRunTextMeasurer.cpp` on Android is about forty lines: take
`getConcreteProps().rawProps` (a `folly::dynamic` of the exact JS props,
§3.3), wrap it with `ReadableNativeMap::newObjectCxxArgs`, and call `measure`
with `getSurfaceId()` and the component name. It does not know what an
attribute is.

On the Java side, `SelectableRunHostViewManager.measure(...)` and the paper
`SelectableRunHostShadowNode.measure(...)` both delegate to one object:

```kotlin
internal object RunTextMeasure {
    fun configurePaint(paint: TextPaint)                     // the single paint configuration
    fun measure(context: Context, text: String, spec: RunAttributedText.Spec,
                width: Float, widthMode: YogaMeasureMode,
                height: Float, heightMode: YogaMeasureMode): Long
}
```

`SelectableRunHostView` configures its `TextView` through the same
`configurePaint`, and both paths build through `RunAttributedText.build`.
Agreement is structural, and paper and Fabric measure identically.

Yoga can call `measureContent` several times per pass, each a JNI round trip.
The node memoises the last `(LayoutConstraints -> Size)` pair and, more
importantly, implements the clean-clone constructor (§4.4).

### 4.3 The tests that would catch a violation

| | Test | Where it can run |
| --- | --- | --- |
| iOS | XCTest: for a matrix of (font family × size × weight × width × string: ASCII, CJK, emoji/ZWJ, mixed), assert `[RNSMTextKitStack measureAttributedString:width:pointScaleFactor:]` equals `[UITextView sizeThatFits:]` on a view built from the same factory, within half a point. | needs a simulator, not available here |
| Android | Robolectric/instrumented: assert `RunTextMeasure.measure(...)` height equals the `TextView`'s `measuredHeight` after `measure()` for the same `(text, spec, width)`. | needs the Android SDK, not available here |
| Both | Snapshot the styled-string builders: assert `RNSMAttributedText` and `RunAttributedText.build` produce identical attribute runs for the same `(text, attributes)` input, so paper and Fabric cannot drift. | needs a device toolchain, not available here |

The sharpest edge of the plan (§8): the mechanism makes disagreement
structurally impossible, but nothing in this repository can execute the check.
These tests land with the example app.

### 4.4 The one line that makes streaming viable

```cpp
RNSMRunHostShadowNode::RNSMRunHostShadowNode(
    const ShadowNode& sourceShadowNode, const ShadowNodeFragment& fragment)
    : ConcreteViewShadowNode(sourceShadowNode, fragment) {
  const auto& source = static_cast<const RNSMRunHostShadowNode&>(sourceShadowNode);
  if (!fragment.children && !fragment.props && source.getIsLayoutClean()) {
    cleanLayout();
  }
}
```

Without it, `YogaLayoutableShadowNode` force-dirties every clone of a
`MeasurableYogaNode`, so appending one token would re-measure every run in the
document: the O(n²) `StreamSession`'s settled-prefix machinery exists to
avoid, one layer down. `ParagraphShadowNode` has the identical constructor for
the identical reason. It pairs with the per-run memoisation in
`src/view/SelectableMarkdown.tsx`.

Because our content derives purely from props (Paragraph's comes from
children), the same guard lets the prepared `Content` handle carry forward
across a clone.

Two more behaviours copied from Paragraph:

- `updateStateIfNeeded` short-circuits when content is unchanged, so a
  snapshot that re-sends identical props does not publish state or remount.
- `layout()` does not measure. Paragraph re-measures only to position
  attachments; our node never needs attachment positions (embed rects, while
  embeds existed, were reported by the mounted view after layout), so
  `layout()` prepares content at the final size, calls `updateStateIfNeeded`,
  and returns. That halves the measure count and avoids `react_featureflags`.

---

## 5. Selection must not regress

Every guarantee in `docs/SELECTION.md` survives the move:

**The UITextView is not rewritten.** `platform/ios/SelectableRunHostView.swift`
keeps the TextKit-1 opt-in, save→swap→restore-clamped selection preservation
with Select-All tracking, the `editMenuForTextIn` hook with stable `UIAction`
identifiers, and clamped, never-empty event emission. It loses only string
building (moved to `RNSMAttributedText`) and becomes architecture-neutral. The
Fabric component view adds it as `contentView`, which `RCTViewComponentView`
keeps framed with no `layoutSubviews` override. Fabric's touch layer
cooperates: `RCTSurfaceTouchHandler` sets `cancelsTouchesInView = NO` and
refuses to be prevented by recognizers inside the surface.
`RCTTextInputComponentView` is the precedent.

**`RCT_NEW_ARCH_ENABLED` gating must not touch the Swift file.** The define
reaches `spec.compiler_flags` and `OTHER_CPLUSPLUSFLAGS` only; the sole
`SWIFT_ACTIVE_COMPILATION_CONDITIONS` write in RN's scripts is `DEBUG`. So the
Swift view exposes an architecture-neutral
`var onSelectionAction: ((Int, Int, NSString, NSString) -> Void)?` and each
wrapper adapts it. An `#ifdef` in Swift would silently compile the old-arch
branch in a new-arch app.

**Offsets stay UTF-16 into the current `text`.** Nothing converts them. The
Fabric adaptation is one call:

```objc
static_cast<const SelectableRunHostEventEmitter &>(*_eventEmitter)
    .onSelectionAction({.start = start, .end = end,
                        .action = RCTStringFromNSString(action),
                        .selectedText = RCTStringFromNSString(text)});
```

The emitter dispatches `"selectionAction"`, mapped to `onSelectionAction`
through `directEventTypes: {topSelectionAction: ...}`, identical on both
architectures.

**Android moves off `RCTEventEmitter`.**
`getJSModule(RCTEventEmitter::class.java).receiveEvent(...)` is the paper
module and silently drops on Fabric ("custom copy items do nothing"). It
becomes:

```kotlin
val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id)
dispatcher?.dispatchEvent(SelectionActionEvent(UIManagerHelper.getSurfaceId(this), id, start, end, action, selectedText))
```

with `class SelectionActionEvent : Event<SelectionActionEvent>` overriding
`getEventName() = "topSelectionAction"`.
`UIManagerHelper.getEventDispatcherForReactTag` resolves to
`ReactEventEmitter` on paper and `FabricEventEmitter` on Fabric.

**`prepareForRecycle` is a correctness requirement.** A pooled component view
is reused for a different run. If it kept its selection and edit menu, "Copy
Markdown" on stale handles would map offsets through the new run's piece table
and silently produce a valid-looking payload for text the user never selected.

```objc
- (void)prepareForRecycle {
  [super prepareForRecycle];   // resets _eventEmitter (RCTViewComponentView.mm:466)
  _state.reset();
  [_textView reset];           // attributedText = nil; selectedRange = {0,0};
                               // resignFirstResponder; dismiss any live edit menu
}
```

We never cache the emitter, so an event after recycle has nowhere to go.
Android's `ViewManager.prepareToRecycleView` gets the same treatment, on top
of the existing detach-time discipline (finish the live `ActionMode`,
uninstall the callback).

**Tail policy is unchanged.** iOS preserves selection across text swaps, so
the tail run stays selectable; Android does not, so its tail run is
`selectable={false}` until settled. `RunHost.tsx` decides; Fabric does not
touch it, and makes the iOS case better, since the swap follows a measure that
already knew the new text. (§0.1 records the caveat: settled *runs* do still
change text on Android.)

---

## 6. Residual styling work: what we fix now, and what we cut

Independent measurement diffed the native host against the JS `<Text>`
fallback across the CommonMark spec plus all eight fixtures. Eight of eleven
representative prose runs rendered different characters. Nineteen items in
all; here is what this port does about them.

### 6.1 Fixed now

**(a) `softBreak` projects `' '`, not `'\n'`.** `mapSelection.ts` emitted
`'\n'` for both break kinds while the fallback rendered `softBreak: () => ' '`,
so hard-wrapped LLM prose rendered as forced line breaks natively. `' '` is
CommonMark-correct and offset-neutral (one code unit either way, against the
same `realSpan(node)`). It changes projected text, so tests and
`docs/SELECTION.md` change with it.

**(b) `lineHeight` becomes a `RunTextAttribute` field.** The fallback set
`lineHeight = baseSize × 1.4` on body text and `headingSize × 1.4` on
headings; the native host set none, so linking the module visibly compressed
the document. It lands here because line height is a measurement input.

- Contract: `lineHeight?: number` on `RunTextAttribute`, set on
  `baseAttribute` and the `heading` case. Spec field `lineHeight?: Float`
  (sentinel `0.0` = unset).
- iOS: `NSMutableParagraphStyle` with `minimumLineHeight` and
  `maximumLineHeight` over the range. TextKit applies paragraph attributes to
  the whole paragraph, and blocks are separated by `'\n\n'`, so a heading is
  its own paragraph. Mirrors `RCTTextAttributes.mm`.
- Android: a ~20-line `LineHeightSpan` in `RunAttributedText.build` (RN's
  `CustomLineHeightSpan` is `internal`). Shared by the view, the paper shadow
  node and the Fabric measure override.

**(c) Prose renderers become selectable.** Any block containing a code block,
table, thematic break or image was standalone and rendered through
`renderBlocks`, where `paragraph`, `heading`, `blockquote`, `list` and
`htmlBlock` never set `selectable`. A paragraph with an image was not
selectable at all. Five props.

**(d) `spoiler` joins `VIEW_KINDS`.** A spoiler needs a tap target to reveal,
and the native host can only paint the mask. `docs/SELECTION.md` already
says a block that owns a tap target should not also be a selection host. One
line; (c) makes the resulting standalone block selectable. Spoilers are off in
every preset but `everything`.

**(e) Small, exact corrections**, one line each:
- The fallback's blockquote and list-item child separator becomes `'\n\n'` to
  match `BLOCK_SEPARATOR` (fallback-only, zero offset impact).
- An `incomplete` link stops being painted `theme.colors.link`, which flashed
  streamed text blue then black.
- `RunHostProps.style` narrows from `StyleProp<TextStyle>` to
  `StyleProp<ViewStyle>`; the host always ignored text properties there, and
  on Fabric `style` goes through `ViewProps`.
- `src/index.ts` exports `./view/runAttributes`, so
  `RunHostProps.attributes`'s element type is nameable from the package entry.
- `processColor` is memoised per colour string in a module-level `Map` in
  `RunHost.tsx`. `.map(toNativeAttribute)` measured at 3.5× the cost of
  `resolveRunAttributes`, re-normalising the same theme strings every
  snapshot. Eight lines.

### 6.2 Cut, with reasons

| Divergence | Why it is cut |
| --- | --- |
| Blockquote bar (`'▎ '` glyph, fallback only) and list indentation (`'   '.repeat(depth)`, fallback only) | Both need paragraph-level attributes (`NSParagraphStyle.headIndent`/`firstLineHeadIndent`, `LeadingMarginSpan.Standard`, `QuoteSpan`) that do not fit `RunTextAttribute`'s character-range shape; list indentation also needs a `listItem` mark kind with a level. A second attribute channel, a projection change and two span implementations, unaffected by Fabric. It also unblocks `spacing.listIndent` and `spacing.quoteIndent`. Its own diff. |
| Tappable links and spoiler reveal on the native host | Needs a new prop (`pressRanges`) and event (`onRangePress`). Adding a second event while porting the first is how you break the first. (d) covers spoilers; blocked and incomplete links already degrade correctly. |
| Nested lists gaining a blank line (`listItem` children joined with `'\n\n'` where the next sibling is a list) | Changes offsets, so it needs its own `mapSelection` test pass and prefix-oracle run. Bundling an offset change into a native port loses the ability to bisect. |
| Custom-font resolution (`UIFont(name:)` vs RN's family lookup; raw `TypefaceSpan` vs `ReactFontManager`) | Real, but pre-existing on both architectures, and fixing it changes paper rendering. Own diff, targeting `ReactFontManager.getInstance().getTypeface(...)` and `RCTFont`'s family lookup. |
| Dynamic Type | iOS does not scale (`adjustsFontForContentSizeCategory` is a no-op for non-`UIFontMetrics` fonts); Android does (SP units). A proper fix threads `RCTFontSizeMultiplier()` and `layoutContext.fontSizeMultiplier` into the builders and re-measures on `UIContentSizeCategoryDidChangeNotification`. A half-done version breaks measure/draw agreement. The no-op line is deleted; the hooks are recorded here. |
| Blank-line height between blocks; heading accessibility; unreachable mark kinds (`underline`, `codeBlock`, `tableHeader`, `math`, `html` are never produced by default); duplicate `underline` marks over one range | Cosmetic or projection artefacts. The duplicate underline is not a parser bug: md4c reads `MD_FLAG_UNDERLINE` as "`_` means underline", so `__x__` is two nested `underline` nodes (pinned in `src/engine/native/__tests__/underline.test.ts`) and `mapSelection` emits one mark per node. Both say `textDecorationLine: 'underline'` over the same range, so nothing renders differently, and only under `presets.everything`. |

### 6.3 The flat-buffer verdict: do not pack the attribute array

Should `attributes` move off the prop channel into a packed binary format like
the engine's? No, and Fabric strengthens the answer.

Replaying the real transcript fixture (131 appends, 1162 chars) through
`resolveRunAttributes` → `toNativeAttribute` → `processColor`, with
`SelectableMarkdown`'s memoisation emulated exactly:

```
ATTRIBUTES per snapshot:   p50 1    p90 3    p99 5    max 7
attribute JSON bytes:      p50 145  p90 297  max 666      (22.0 kB per whole stream)
project+resolve+colour:    p50 5.4 us   p90 16.4 us   (2.9 ms for the entire stream)
```

Packing would save roughly 100 bytes per snapshot and 17 kB per streamed
message, for a protocol version bump, a C++ encoder, two native decoders, a JS
packer, and the loss of the "skip an unknown key" degradation
`RunAttributedText.parse` is built around. Three further reasons:

1. **It does not fix the broken case.** A block that cannot settle (a
   300-item list, one enormous paragraph) makes the tail run's attribute array
   grow linearly and be re-sent whole on every token. Measured: 113 MB of JSON
   for a 19 kB document, p50 456 attributes per snapshot. Packed, still 35 MB
   and still O(n²). The real fix is bounding the tail (per-item runs, or an
   `attributesFrom` index), orthogonal to the wire format.
2. **There is no format to pack into.** The flat buffer is the engine channel
   (one JSI call, one `ArrayBuffer`, per parse). Attributes cross the view
   channel as props, and codegen has no `ArrayBuffer` prop type: a base64
   string undoes the saving, a host object loses prop diffing.
3. **On Android it would destroy what makes Fabric cheap for us.** §3.3: raw
   props reach the ViewManager, so the `hasKey`-based sparse reading works
   unchanged.

What we did instead: the memoised `processColor` in §6.1(e), the one
disproportionate measured cost.

---

## 7. File-by-file work plan

Four disjoint ownership groups. G1 item 1 is the only cross-group blocker: the
spec file must land before G2/G3/G4 can compile against the generated
`Props.h`. Legend: `+` create, `~` modify, `→` move.

### G1: JS/TS

| | File | Contents | Depends on |
| --- | --- | --- | --- |
| 1 | `+ src/view/SelectableRunHostNativeComponent.ts` | `codegenNativeComponent<NativeProps>('SelectableRunHost')`. Props per §3.1: `text`, `attributes?` (sparse struct incl. `lineHeight`), `selectable?: WithDefault<boolean,true>`, `selectionActions?: ReadonlyArray<string>`, `onSelectionAction?: DirectEventHandler<…>`. Carries the comment on the sentinel encoding and the two banned shapes. | none (blocks G2/G3/G4) |
| 2 | `~ package.json` | `codegenConfig: {name: "SelectableMarkdownSpec", type: "components", jsSrcsDir: "src/view", android: {javaPackageName: "com.selectablemarkdown"}}`; `"react-native": "src/index.ts"`; `files` gains `android`, drops `platform/android`. | 1 |
| 3 | `~ src/view/RunHost.tsx` | Resolution via `hasViewManagerConfig` in a bare `catch` (§2.1); memoised `processColor`; `style` narrows to `ViewStyle`. `toNativeAttribute` unchanged. | 1 |
| 4 | `~ src/view/runAttributes.ts` `~ …/runAttributes.test.ts` | `lineHeight?: number` on `RunTextAttribute`; set on `baseAttribute` and `heading`. | none |
| 5 | `~ src/selection/mapSelection.ts` + `__tests__/` | `softBreak` emits `' '`; `hardBreak` keeps `'\n'`. | none |
| 6 | `~ src/view/renderers.tsx` | `selectable` on the five prose renderers; `'\n\n'` separators; incomplete-link colour. | none |
| 7 | `~ src/selection/runs.ts` + tests | `'spoiler'` → `VIEW_KINDS`. | none |
| 8 | `~ src/index.ts` | `export * from './view/runAttributes';` | 4 |
| 9 | `~ tsconfig.build.json` | Exclude `src/view/SelectableRunHostNativeComponent.ts` from emit. | 1 |
| 10 | `~ scripts/verify-pack.mjs` | Assert the packed tarball contains the spec with `codegenNativeComponent<` intact (§0). | 1, 9 |
| 11 | `~ docs/SELECTION.md` | Break-kind row; Fabric status; the `lineHeight` prop; the recycling guarantee. | 4, 5 |
| 12 | `~ docs/ARCHITECTURE.md` | Module map: `platform/fabric/`, `android/`. | none |

### G2: shared C++

| | File | Contents | Depends on |
| --- | --- | --- | --- |
| 1 | `+ platform/fabric/RNSMRunTextMeasurer.h` | The façade: ctor from `ContextContainer::Shared`; `prepareContent(props, fontSizeMultiplier) -> std::shared_ptr<void>`; `measure(content, props, constraints, TextLayoutContext) -> Size`. | G1.1 |
| 2 | `+ platform/fabric/RNSMRunHostState.h` | `std::shared_ptr<void> attributedString` (iOS payload) + the `#ifdef ANDROID` ctor/`getDynamic()` stubs. `usesMapBufferForStateData` stays `false`. | none |
| 3 | `+ platform/fabric/RNSMRunHostShadowNode.h/.cpp` | `ConcreteViewShadowNode<SelectableRunHostComponentName, SelectableRunHostProps, SelectableRunHostEventEmitter, RNSMRunHostState>`; `BaseTraits()` sets `LeafYogaNode | MeasurableYogaNode` and unsets `FormsStackingContext` under ANDROID; the clean-clone ctor (§4.4); cached content + `ensureUnsealed()`; `measureContent`; `layout()` that publishes state and does not measure; `setMeasurer`. | 1, 2 |
| 4 | `+ platform/fabric/RNSMRunHostComponentDescriptor.h` | `ConcreteComponentDescriptor<RNSMRunHostShadowNode>` constructing one `RNSMRunTextMeasurer` from `contextContainer_` and handing it to every node in `adopt()`. | 3 |
| 5 | `+ platform/fabric/android-include/react/renderer/components/SelectableMarkdownSpec/{ShadowNodes,ComponentDescriptors,States}.h` | Three ~10-line alias headers binding codegen's names to ours (§2.3). Android-only; never on the iOS include path. | 3, 4 |
| 6 | `~ scripts/check-fabric-cpp.mjs` | Run codegen into a temp dir and add it to the include path, so `platform/fabric/*.cpp` is compilable by the harness. Add `--platform android` coverage of the shared node. | G1.1 |

### G3: iOS

| | File | Contents | Depends on |
| --- | --- | --- | --- |
| 1 | `+ platform/ios/RNSMTextKitStack.h/.mm` | The single TextKit-1 factory + off-main measurement (§4.1). Public header, pure ObjC. | none |
| 2 | `+ platform/ios/RNSMAttributedText.h/.mm` `+ platform/ios/RNSMAttributedText+Props.h` | The single string builder. Logic moves verbatim from `SelectableRunHostView.buildAttributedString`/`applyFont`/`color`, plus the `lineHeight` paragraph style. Public header pure ObjC; the C++ props overload in the private header. | G1.4 |
| 3 | `~ platform/ios/SelectableRunHostView.swift` | Delegates string building to (2); constructs its `UITextView` from (1); deletes `adjustsFontForContentSizeCategory`; `onSelectionAction` becomes a plain Swift closure. Selection preservation, edit menu and event clamping untouched. | 1, 2 |
| 4 | `~ platform/ios/SelectableRunHostViewManager.swift/.m` | Adapt the new closure to `RCTDirectEventBlock`. Otherwise unchanged (the paper path). | 3 |
| 5 | `+ platform/ios/fabric/RNSMRunTextMeasurer.mm` | iOS implementation of G2.1: `prepareContent` → `RNSMAttributedText` wrapped with `wrapManagedObject`; `measure` → `RNSMTextKitStack`. Inside `#ifdef RCT_NEW_ARCH_ENABLED`. | G2.1, 1, 2 |
| 6 | `+ platform/ios/fabric/RCTSelectableRunHostComponentView.h/.mm` | `RCTViewComponentView` subclass. `_props = RNSMRunHostShadowNode::defaultSharedProps()` in `initWithFrame:`; the Swift text view as `contentView`; `+componentDescriptorProvider`; `updateProps:` for `selectable`/`selectionActions`; `updateState:` → unwrap and apply; the event bridge; `prepareForRecycle` per §5. Ends with `Class<RCTComponentViewProtocol> SelectableRunHostCls(void)`. `#ifdef RCT_NEW_ARCH_ENABLED`. | G2.4, 3, 5 |
| 7 | `~ SelectableMarkdown.podspec` | `c++20`; `pod_target_xcconfig` before the guarded `install_modules_dependencies(s)`; `s.private_header_files`; `platform/fabric` and `platform/ios/fabric` in `source_files` and on the header search path. No `React-FabricComponents`. | 6 |

### G4: Android

| | File | Contents | Depends on |
| --- | --- | --- | --- |
| 1 | `→ platform/android/` ⇒ `android/` | Required by `PathUtils.kt` (§2.3). Also: `react-native.config.js` `sourceDir: 'android'` + `cmakeListsPath`; `CMakeLists.txt`'s `../cpp` becomes `../platform/cpp`; `.gitignore`. | none (do first) |
| 2 | `~ android/build.gradle` | `apply plugin: 'com.facebook.react'` + the `react { }` block (§2.3). Existing `packagingOptions` excludes and prefab stay. | 1 |
| 3 | `~ android/CMakeLists.txt` | No target changes. Amend the "React Native linkage" comment: Fabric linkage lives in `react_codegen_SelectableMarkdownSpec`, built by the app; `ReactAndroid::jsi` remains the only React target this `.so` needs. | 1 |
| 4 | `+ android/src/main/jni/CMakeLists.txt` | The seam of §2.3, with the `FATAL_ERROR` assertion and the `reactnativejni`/`reactnative` target probe. | 1, G2.5 |
| 5 | `+ android/src/main/jni/RNSMRunTextMeasurer.cpp` | Android implementation of G2.1: `rawProps` → `ReadableNativeMap::newObjectCxxArgs` → `FabricUIManager.measure(surfaceId, "SelectableRunHost", …)`. `prepareContent` returns `nullptr`. | G2.1 |
| 6 | `+ android/…/RunTextMeasure.kt` | The single paint configuration + `StaticLayout` measurement, extracted from `SelectableRunHostShadowNode.kt` (§4.2). | G1.4 |
| 7 | `~ android/…/RunAttributedText.kt` | `lineHeight` span; the new `LineHeightSpan`. Sparse `hasKey` reading unchanged. | G1.4 |
| 8 | `~ android/…/SelectableRunHostShadowNode.kt` | Delegates to (6). KDoc states it is paper-only; on Fabric the shadow node is C++. | 6 |
| 9 | `~ android/…/SelectableRunHostView.kt` | `UIManagerHelper` event dispatch; configures its `TextView` through (6); recycle reset. | 6, 10 |
| 10 | `+ android/…/SelectionActionEvent.kt` | `Event<SelectionActionEvent>` with `getEventName() = "topSelectionAction"`. | 1 |
| 11 | `~ android/…/SelectableRunHostViewManager.kt` | `implements SelectableRunHostManagerInterface<SelectableRunHostView>` + `getDelegate()`; the `measure(Context, ReadableMap, …)` override delegating to (6); `prepareToRecycleView`; `topSelectionAction` constant. Keeps every `@ReactProp` and `getShadowNodeClass()` for paper's reflection-built view config. | 2, 6, 10 |
| 12 | `~ android/src/main/cpp/OnLoad.cpp` | Comment only: where Fabric registration happens, and why this `.so` does not call `facebook::jni::initialize`. | 1 |

Untouched: `platform/cpp/**`, `src/engine/**`, `src/stream/**`,
`src/document/**`, `native/node/**`, `SelectableMarkdownModule.{kt,mm}`,
`SelectableMarkdownPackage.kt`.

---

## 8. Verification, as run

This section was a plan and is now a record: every command below was run on
the finished port, and "Proves" says what the run established. Where a check
did not prove what was claimed, §0.1 names the replacement.

### What is proven on this machine

| Check | Command | Proves |
| --- | --- | --- |
| Codegen produces the expected C++ | `npm run check:codegen` | The spec compiles to the `Props.h` in §3.1 (sparse `fromRawValue`, `SharedColor` sentinels, `std::vector<std::string>` for `selectionActions`, no undeclared enum), and the babel preset turns the spec into a static view config while a tsc-transpiled copy silently does not (a negative control run every invocation). Also asserts every generated reference to the three shadowed headers is the exact `#include <react/renderer/components/<spec>/X.h>` form (§0.1). A regression gate, because codegen output changes across RN versions. |
| Fabric C++ compiles | `npm run check:fabric-cpp` | Real `-c` compiles against the genuine RN 0.75.4 headers plus upstream folly/glog/fmt/double-conversion, on both platform header sets. Templates are instantiated, so `ConcreteComponentDescriptor<RNSMRunHostShadowNode>` is proven constructible. Covers `platform/fabric/*.cpp`, `android/src/main/jni/*.cpp`, codegen's five generated sources, and on the android pass the include-order substitution the CMake seam depends on. Every native source it does not compile is named, with its reason. |
| The checker can still fail | `npm run check:fabric-cpp:selftest` | Five deliberately broken translation units are each rejected, for the stated reason. |
| Swift compiles | `npm run check:swift` | `platform/ios/*.swift` type-checks against RN's real `UIView (React)` category, `RCTViewManager`, `RCTUIManager` and the iOS SDK, at the podspec's deployment target and Swift version, through a bridging header derived from the podspec's header split. This gate did not exist while the port was written; the Swift shipped with five compile errors (§0.1). |
| That checker can fail too | `npm run check:swift:selftest` | All four historical defects, reverted one at a time, are each rejected with the expected diagnostic. |
| The engine survives C++20 | `npm run check:fabric-cpp -- --syntax-only platform/cpp/*.cpp` | The `c++17` → `c++20` change (§2.2) does not break `OffsetParser.cpp`, `FlatBuffer.cpp`, `SelectableMarkdownJsi.cpp`. |
| JS behaviour | `npm test`, 792 tests in 31 suites | The projection change (§6.1a), `lineHeight`, `VIEW_KINDS`, run segmentation, every selection/copy round-trip. The count dropped when the JavaScript parser was deleted, and again in 0.10.0 with the embed suites. Suites that parse markdown need the Node addon (`node scripts/build-node-addon.mjs`); without it they report as skipped, visibly. CI and release build it as a hard gate. |
| The projection and selection contract, over a real corpus | `npm test` → `conformance/selection/projection-oracle.test.ts` | The full CommonMark 0.31.2 suite plus every fixture, under `presets.llmChat` and `presets.everything`: pieces tile the projected text, every mapped selection is an in-bounds ordered span, `buildCopyPayload().markdown` is exactly the source slice, every `softBreak` projects a space. The check §8 used to attribute to `npm run conformance` (§0.1). |
| Types | `npm run typecheck` | Including the spec file, which `tsc` sees though it is excluded from emit. |
| The published tarball | `npm run verify:pack` | The spec ships untranspiled with `codegenNativeComponent<` intact (§0); every native directory a consumer compiles is present and non-empty; every path the podspec and `react-native.config.js` name resolves; every relative `require` reachable from `main` resolves (§0.1). |
| Conformance | `npm run conformance` | 651/652 (99.85%), 0 examples threw, every section clean except HTML blocks at 43/44 (spec example 174, an unclosed HTML block inside a blockquote). Report at `conformance/report-native.json`. A score, not a gate: the runner exits 0 regardless. Says nothing about projection or selection. `--engine` is refused. |

### What is still not proven here, and what that means

This shipped native code that was not executed on this machine: no simulator,
no Android SDK, no example app, no `Pods/`. Reviewed, not verified:

- **Every line of Objective-C++ in the mounting layer.**
  `RCTSelectableRunHostComponentView.mm`, `RNSMAttributedText.mm`,
  `RNSMTextKitStack.mm`, `RNSMRunTextMeasurer.mm` and
  `SelectableMarkdownModule.mm`; `check:fabric-cpp` names each on every run.
  `RNSMTextKitStack.mm` holds the single function iOS measure/draw agreement
  rests on.
- **All Kotlin.** Two of §0.1's defects were Kotlin, found by reading.
- **The measure/draw agreement tests of §4.3.** The single most important
  behavioural property, unexecuted.
- **The clean-clone guard's effect.** It compiles; nothing here proves it
  prevents the O(n²) re-measure. Removing `cleanLayout()` compiles perfectly,
  which is how §0.1's regression got in.
- **`pod install`.** Never run. The umbrella-header hazard of §2.2 surfaces
  there.
- **The Android CMake seam.** Its four configure-time assertions fire in an
  app, the earliest any of it is exercised.
- **Recycling.** Only reachable in a running app with enough content to
  scroll.
- **RN 0.73, 0.74, 0.76+.** Source-verified at the endpoints; built against
  none. Open: whether 0.73's codegen emits `SelectableRunHostManagerInterface`
  with the same setter signatures, and whether `platform/ios/*.mm` compiles
  React-Core's headers at `c++20` on 0.73.
- **The Android selection gap of §0.1.** Reproducible in Node; what a dropped
  `ActionMode` looks like to a user needs a device.

**The gating prerequisite is an example app**: a minimal RN 0.75 app with
`newArchEnabled` toggleable, plus `xcodebuild` and `./gradlew assembleDebug`
smoke targets in CI. Until then the Fabric path is reviewed, not exercised.

Everything that can run automatically does. `ci.yml` runs the JS gates, the
codegen gate, the Fabric C++ gate and self-test on ubuntu, and the Swift gate
and self-test on macOS; `release.yml` runs the same gates before it packs.

---

## 9. Risks and the cut line

### What could make this not worth doing

**1. The measurement-agreement tests can't run, so the highest-severity bug
class ships unobserved.** A half-point disagreement per line becomes visible
clipping in a long run, reported as "the library clips text on iPhone", with
no way to reproduce it here. Mitigation is structural (§4) plus the example
app; the residual risk is the main argument for shipping behind a flag.

**2. The Android CMake seam is unofficial.** Shadowing codegen's
`ComponentDescriptors.h` by include order relies on angle-bracket includes,
which nobody at Meta promised to keep. Mitigated by a configure-time assertion
and a documented fallback (§2.3), but a future RN could break every consuming
app's build, in their build log.

**3. It puts a second implementation of the same rendering in the tree.**
`RunHost` documents why two renderings of a run is not a fork: they share
inputs. Fabric adds a third consumer per platform. The mitigation is §1's
discipline: the third consumer calls the same builder as the first.

**4. It is a lot of surface for one property.** Codegen config, a podspec
rewrite, a directory move, a CMake seam, three C++ classes, an ObjC++ view and
a Kotlin measure path, to remove one frame of wrong-height layout. Worth it
only because the wrong frame recurs on every streamed snapshot.

### The cut line

The smallest version that delivers synchronous correct-first-frame layout on
iOS: **ship G1 + G2 + G3, defer G4.**

- the spec file, `RunHost` resolution, and the two contract changes
  measurement needs (`lineHeight`, `softBreak`);
- the shared C++ shadow node, state and descriptor;
- the iOS measurer, TextKit stack, string builder, component view and podspec.

That gives iOS new-architecture apps a first frame measured from the exact
`NSAttributedString` the view draws. Streaming stops jumping; selection,
recycling and the edit menu are handled. On iOS paper nothing changes except
the moved string builder.

Deferred: Android Fabric apps keep the paper ViewManager through the interop
layer, or the fallback. A documented degradation, not a regression. Android's
risk is concentrated in the CMake seam, which can break other people's builds;
iOS's is in measurement agreement, which breaks only our own rendering. Ship
the lower-blast-radius half first.

**Below the cut line there is nothing.** A Fabric component without a
measuring shadow node lays every run out at zero height
(`LayoutableShadowNode::measureContent` returns `{}`), and codegen's
`States.h` cannot push a measured height back. Half a port is a blank screen.

In the end the whole thing shipped, G4 included; see the preface.
