# CMakeLists.txt — the Fabric seam.
#
# WHAT THIS FILE IS. It is not a build of this library. It is a set of
# additions to a target React Native generates for the *consuming app*:
# react_codegen_SelectableMarkdownSpec, which is compiled into the app's
# libappmodules.so. Nothing here produces an artifact this package ships.
#
# HOW THE APP REACHES IT. react-native.config.js declares
# `android.cmakeListsPath: 'src/main/jni/CMakeLists.txt'`. The CLI joins that
# onto sourceDir (@react-native-community/cli-platform-android,
# config/index.js -> dependencyConfig) and writes it into autolinking.json;
# React Native's Gradle plugin then emits, into the app's build directory,
#
#     add_subdirectory(<pkg>/android/src/main/jni/ SelectableMarkdownSpec_autolinked_build)
#     set(AUTOLINKED_LIBRARIES react_codegen_SelectableMarkdownSpec)
#
# (GenerateAutolinkingNewArchitecturesFileTask.kt, generateCmakeFileContent),
# and ReactNative-application.cmake includes that file and links every name in
# AUTOLINKED_LIBRARIES into libappmodules.so. Without the cmakeListsPath
# override the CLI would default to the *generated* CMakeLists instead, and
# the app would build codegen's non-measurable component and nothing of ours.
#
# WHY WE ADD TO REACT NATIVE'S TARGET INSTEAD OF DECLARING OUR OWN. That
# target's kind (SHARED at 0.75, OBJECT at 0.76+) and its whole link list —
# rrc_view, react_render_core, react_render_componentregistry, react_utils,
# fbjni, folly_runtime, glog, yoga and the rest — are written fresh by codegen
# for the app's React Native version. Inheriting it is what keeps this package
# free of the version ladder that ../../../CMakeLists.txt's "React Native
# linkage" note argues against at length. Declaring our own would mean
# spelling that list out and revising it on every React Native release.
#
# THE SUBSTITUTION, AND WHY IT IS SHAPED THIS WAY. The app's generated
# autolinking.cpp is written by React Native, not by us, and it hardcodes
#
#     #include <react/renderer/components/SelectableMarkdownSpec/ComponentDescriptors.h>
#     providerRegistry->add(concreteComponentDescriptorProvider<SelectableRunHostComponentDescriptor>());
#
# Codegen's version of that name is ConcreteComponentDescriptor over a plain
# ConcreteViewShadowNode: no measure function, so every run in the document
# lays out at zero height (LayoutableShadowNode::measure returns {}). There is
# no registration hook to override on Android, so the only way to make the app
# register the measuring descriptor is to make the include it already writes
# resolve to a header of ours. platform/fabric/android-include/ holds three
# alias headers at exactly the generated paths, and the
# target_include_directories(... BEFORE ...) below is what puts them first.
# Those three headers carry the full argument and the risk; read
# platform/fabric/android-include/.../ShadowNodes.h before touching any of it.
#
# SYSTEM MUST NOT BE ADDED TO THAT target_include_directories CALL. It would
# demote our directory to -isystem, and clang searches every -I path before
# any -isystem path — while codegen's own directory arrives as a plain -I. The
# alias headers would lose silently, the app would register the non-measuring
# descriptor, and the symptom would be a blank document with no build error.

cmake_minimum_required(VERSION 3.13)

# Absolute + normalized, for the same reason ../../../CMakeLists.txt does it:
# a "../../.." smear inside an NDK build log is unreadable, and these two paths
# are the ones most likely to be wrong after a directory move.
get_filename_component(SMD_FABRIC_DIR
  "${CMAKE_CURRENT_SOURCE_DIR}/../../../../platform/fabric" ABSOLUTE)
get_filename_component(SMD_CODEGEN_JNI
  "${CMAKE_CURRENT_SOURCE_DIR}/../../../build/generated/source/codegen/jni" ABSOLUTE)

# The seam asserts its own preconditions, loudly, at configure time.
#
# This is not defensive noise. Everything below depends on React Native's
# codegen having written a specific directory layout and on its generated
# sources using angle-bracket includes — neither of which anyone at Meta
# promised to keep (docs/FABRIC-PLAN.md §9, risk 2). If a future React Native
# moves that output, the alternative to this message is an app whose runs all
# measure zero, reported as "the library renders nothing", with the real cause
# four layers away in someone else's build directory.
#
# Note that this file does not make the *existence* of that directory a new
# requirement: the CLI's default cmakeListsPath is the CMakeLists.txt inside
# it, so an app whose library codegen had not run would already fail on
# add_subdirectory with a far less helpful message. All this adds is the
# explanation.
if(NOT EXISTS "${SMD_CODEGEN_JNI}/react/renderer/components/SelectableMarkdownSpec/ShadowNodes.cpp")
  message(FATAL_ERROR
    "react-native-selectable-markdown: React Native's codegen output is not "
    "where this file expects it (looked for "
    "${SMD_CODEGEN_JNI}/react/renderer/components/SelectableMarkdownSpec/ShadowNodes.cpp). "
    "The Fabric shadow node is wired in by shadowing the generated "
    "ShadowNodes.h / ComponentDescriptors.h / States.h; if React Native "
    "changed that layout, docs/FABRIC-PLAN.md section 2.3 describes the "
    "fallback: declare react_codegen_SelectableMarkdownSpec here, compile only "
    "the generated Props.cpp and EventEmitters.cpp plus our own sources, and "
    "define SelectableRunHostComponentName by hand.")
endif()

# THE OTHER HALF OF THE SAME ASSERTION: the generated sources must still reach
# the three headers we shadow through the exact angle-bracket path.
#
# The `EXISTS` check above covers React Native *restructuring* the output. It
# does not cover React Native changing the *include style*, and that is the
# half with no build error at all. A bare quoted sibling — `#include
# "ShadowNodes.h"` — resolves next to the generated file and finds codegen's
# non-measurable header no matter what `-I` order is set below. A bare angle
# name — `#include <ShadowNodes.h>` — resolves through the generated
# CMakeLists' own `target_include_directories(... PUBLIC . react/renderer/
# components/<lib>)`, with the same result. Neither form is hypothetical:
# codegen already emits the bare-sibling style in this very directory
# (`SelectableMarkdownSpecJSI-generated.cpp` opens with
# `#include "SelectableMarkdownSpecJSI.h"`), it simply has not used it for
# these files yet.
#
# In either case every other assertion in this file stays true, the app builds
# green, and every run in the document lays out at zero height — the exact
# silent failure this seam exists to prevent, reported as "the library renders
# nothing". `npm run check:codegen` asserts the same property, but only against
# the React Native this repository pins; this one runs in the consumer's build,
# against the React Native the consumer actually has, which is the only place
# it can be true or false.
set(SMD_GENERATED_SPEC
  "${SMD_CODEGEN_JNI}/react/renderer/components/SelectableMarkdownSpec")

function(smd_require_angle_include host shadowed)
  file(READ "${SMD_GENERATED_SPEC}/${host}" contents)
  string(FIND "${contents}"
    "#include <react/renderer/components/SelectableMarkdownSpec/${shadowed}>" found)
  if(found EQUAL -1)
    message(FATAL_ERROR
      "react-native-selectable-markdown: React Native's generated ${host} no "
      "longer includes ${shadowed} as "
      "<react/renderer/components/SelectableMarkdownSpec/${shadowed}>. This "
      "package wires its measuring Fabric shadow node in by shadowing that "
      "header on the include path, which only the full angle-bracket form "
      "respects — a quoted sibling include resolves next to the generated file "
      "and a bare angle name resolves through codegen's own component "
      "directory. Either way the app would register codegen's non-measuring "
      "descriptor and every run would lay out at zero height, with no build "
      "error. docs/FABRIC-PLAN.md section 2.3 describes the fallback: declare "
      "react_codegen_SelectableMarkdownSpec here, compile only the generated "
      "Props.cpp and EventEmitters.cpp plus our own sources, and define "
      "SelectableRunHostComponentName by hand.")
  endif()
endfunction()

# The three edges a translation unit walks to reach the descriptor: the
# registration .cpp, the descriptor header it lands in, and the shadow node's
# own state include. ShadowNodes.cpp is deliberately not checked — all it
# contains is the `extern const char SelectableRunHostComponentName[]`
# definition, which is identical in both headers, so its include style cannot
# change which shadow node the app registers.
smd_require_angle_include(ComponentDescriptors.cpp ComponentDescriptors.h)
smd_require_angle_include(ComponentDescriptors.h ShadowNodes.h)
smd_require_angle_include(ShadowNodes.h States.h)

add_subdirectory("${SMD_CODEGEN_JNI}" SelectableMarkdownSpec_codegen_build)

# The target name is written into the app's Android-autolinking.cmake by React
# Native (CODEGEN_LIB_PREFIX + libraryName), so if codegen ever stops creating
# it the app's own link line breaks too — but it breaks with an "unknown
# target" from a generated file, which reads as a React Native bug. Say what it
# actually is while we still have the context to say it.
if(NOT TARGET react_codegen_SelectableMarkdownSpec)
  message(FATAL_ERROR
    "react-native-selectable-markdown: React Native's codegen did not create "
    "the target react_codegen_SelectableMarkdownSpec. Check that this "
    "package's codegenConfig.name is still 'SelectableMarkdownSpec' and that "
    "the Gradle project resolving it is <pkg>/android (see "
    "react-native.config.js for why that directory is load-bearing).")
endif()

# Our C++ is compiled into React Native's target, so it inherits that target's
# includes, its link list and its flags (-std=c++20 -frtti -fexceptions, plus
# the folly flags ReactNative-application.cmake pushes onto every autolinked
# library through the common_flags interface target). RNSMRunHostState.h
# includes <folly/dynamic.h> under ANDROID, so those flags are not optional.
#
# The measurer implementation is per platform by design and only the Android
# one is here; platform/fabric/RNSMRunTextMeasurer.h explains why the façade
# exists and why it is not react::TextLayoutManager.
target_sources(react_codegen_SelectableMarkdownSpec PRIVATE
  "${SMD_FABRIC_DIR}/RNSMRunHostShadowNode.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/RNSMRunTextMeasurer.cpp"
)

# BEFORE, and PUBLIC, and both words are doing work.
#
# BEFORE prepends, so android-include/ wins over the generated headers when
# the generated ComponentDescriptors.cpp, ShadowNodes.cpp and States.cpp are
# compiled — they are still compiled, unchanged, and they are what defines
# SelectableRunHostComponentName and the registration entry point.
#
# PUBLIC because the substitution has to reach the app as well: autolinking.cpp
# is compiled into libappmodules.so, not into this target, and it is the file
# that actually writes the descriptor name. INTERFACE ordering is inherited
# from this property, so the app sees our directory ahead of codegen's for the
# same reason this target does.
#
# One consequence worth knowing before it is discovered: appmodules is compiled
# with -Wall -Werror (ReactNative-application.cmake), so a warning in any
# header reachable from platform/fabric/android-include is a hard failure in a
# consuming app's build, not in ours.
target_include_directories(react_codegen_SelectableMarkdownSpec BEFORE PUBLIC
  "${SMD_FABRIC_DIR}/android-include"
  "${SMD_FABRIC_DIR}"
)

# react/jni/ReadableNativeMap.h — the one header the generated target does not
# already bring in, needed by RNSMRunTextMeasurer.cpp to hand props to
# FabricUIManager.measure as a ReadableMap.
#
# PROBED BY TARGET EXISTENCE, NEVER BY VERSION NUMBER. React Native 0.73-0.75
# published a prefab module per feature (reactnativejni among them); 0.76
# collapsed the lot into a single `reactnative`, and that is the only branch
# reachable inside the peer range package.json declares today (>= 0.82). The
# `reactnativejni` branch is HISTORICAL — it is kept, not because a supported
# consumer can take it, but because it costs one line and is the only thing
# standing between a consumer who overrides the peer range and a page of
# undefined fbjni symbols. Whichever of the two names the app's React Native
# publishes is aliased into the app's CMake scope by
# ReactNative-application.cmake before it includes Android-autolinking.cmake
# (0.75.4 aliases `reactnativejni` there; 0.76+ aliases `reactnative`), so
# exactly one of these branches is live and it is the right one — with no
# version string this file has to keep current. This is the same discipline
# ../../../CMakeLists.txt applies to ReactAndroid::jsi, and the reason that
# file needs no version ladder either.
#
# Failing loudly rather than falling through: if neither target exists, the
# link error would be a page of undefined facebook::jni symbols from a
# translation unit of ours, and nothing in it would name React Native's prefab
# reorganisation as the cause.
if(TARGET reactnativejni)
  target_link_libraries(react_codegen_SelectableMarkdownSpec reactnativejni)
elseif(TARGET reactnative)
  target_link_libraries(react_codegen_SelectableMarkdownSpec reactnative)
else()
  message(FATAL_ERROR
    "react-native-selectable-markdown: neither the `reactnative` prefab target "
    "(React Native 0.76+, which covers the whole supported range) nor the "
    "historical `reactnativejni` (0.73-0.75) is defined in this scope. "
    "RNSMRunTextMeasurer.cpp needs react/jni/ReadableNativeMap.h from one of "
    "them. If React Native renamed the module again, add the new name as "
    "another branch here — the probe is deliberately by target existence so "
    "this stays a one-line change.")
endif()
