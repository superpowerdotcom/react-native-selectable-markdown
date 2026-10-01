# CMakeLists.txt — Android/NDK build of the selectable-markdown native core.
#
# WHAT THIS BUILDS. One shared library, libselectable-markdown.so, holding
# the whole native stack: vendored md4c (C99), the OffsetParser adapter, the
# flat-buffer encoder from Protocol.h, the JSI binding, and the JNI shim in
# src/main/cpp/OnLoad.cpp that hands the runtime pointer to that binding.
# Nothing else in the app needs to link it — Kotlin loads it by name.
#
# WHY THE SOURCES LIVE OUTSIDE THIS DIRECTORY. platform/cpp is shared with
# iOS (the podspec compiles the exact same files) and with the Node test
# addon. Android must not get its own copy or its own fork of the parser:
# the wire format in Protocol.h is only a contract if every host encodes it
# with the same code.
#
# WHAT THIS FILE IS NOT. It is not the Fabric build. The measuring shadow
# node, its descriptor and the JNI measurer are compiled into the *app's*
# libappmodules.so, through src/main/jni/CMakeLists.txt — see the "React
# Native linkage" note at the bottom of this file for why they cannot live
# here.

cmake_minimum_required(VERSION 3.13)

project(selectable-markdown LANGUAGES C CXX)

# Absolute + normalized so a broken checkout fails with a readable path
# instead of a "../../.." relative smear inside an NDK build log. The ".."
# reaches the package root: this Gradle project sits at <pkg>/android, not
# under platform/, because React Native's Gradle plugin resolves the
# package.json whose codegenConfig it obeys as project.file("../package.json")
# and nothing else (PathUtils.kt, findPackageJsonFile). react-native.config.js
# carries the full argument.
get_filename_component(SMD_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../platform/cpp" ABSOLUTE)
set(SMD_MD4C_DIR "${SMD_CPP_DIR}/vendor/md4c")

# Vendored, patch-file discipline (see vendor/md4c/UPSTREAM.md): these two
# translation units are byte-identical to upstream and are never edited here,
# which is also why they are kept in their own list — see the warning flags
# below.
set(SMD_VENDOR_SOURCES
  "${SMD_MD4C_DIR}/md4c.c"
  "${SMD_MD4C_DIR}/entity.c"
)

set(SMD_SOURCES
  "${SMD_CPP_DIR}/OffsetParser.cpp"
  "${SMD_CPP_DIR}/FlatBuffer.cpp"
  "${SMD_CPP_DIR}/SelectableMarkdownJsi.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/main/cpp/OnLoad.cpp"
)

add_library(selectable-markdown SHARED ${SMD_VENDOR_SOURCES} ${SMD_SOURCES})

# md4c is ISO C99 (what upstream's own build uses) and the rest of the tree
# is C++17 (Protocol.h uses inline constexpr variables). Per-language
# properties keep the C sources from being dragged into the C++ standard and
# vice versa. Known benign noise: clang reports one typedef redefinition in
# md4c.c under C99 — it is upstream's, it is not ours to fix in place, and it
# is not a reason to bump this to C11.
set_target_properties(selectable-markdown PROPERTIES
  C_STANDARD 99
  C_STANDARD_REQUIRED ON
  C_EXTENSIONS OFF
  CXX_STANDARD 17
  CXX_STANDARD_REQUIRED ON
  CXX_EXTENSIONS OFF
)

# OffsetParser.cpp includes <md4c.h>; OnLoad.cpp includes
# "SelectableMarkdownJsi.h". Both directories are PRIVATE — no consumer of
# this .so ever compiles against these headers, they call in through JSI.
target_include_directories(selectable-markdown PRIVATE
  "${SMD_CPP_DIR}"
  "${SMD_MD4C_DIR}"
)

# -O2 unconditionally, including debug builds. WHY: md4c is the only parser
# this package has, so every document in a debug build goes through this .so
# too — there is no slower-but-present JS path a debug build could be
# compared against or fall back to. An -O0 md4c is several times slower than
# an -O2 one, which would make ordinary debug-build sluggishness look like a
# parser problem and would mislead every on-device profile taken before a
# release build exists.
target_compile_options(selectable-markdown PRIVATE -O2)

# RTTI and exceptions, stated here and not only in build.gradle's cppFlags.
# jsi.h throws (jsi::JSError, jsi::JSINativeException) and the binding catches
# by type, and OnLoad.cpp's catch clauses are the JNI boundary's only defence
# against an exception escaping into the JVM. Both are on by default in the
# NDK, but a host app that overrides cppFlags would otherwise silently turn
# them off and the failure would surface as an abort deep inside libjsi rather
# than as an error pointing here. CXX only: the vendored md4c is C.
target_compile_options(selectable-markdown
  PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:-frtti;-fexceptions>")

# Warnings on first-party sources only, and never fatal. Turning -Wall on the
# vendored md4c sources would report defects we are not allowed to fix in
# place (patches/ discipline), so the signal would be permanent noise.
set_source_files_properties(${SMD_SOURCES} PROPERTIES COMPILE_OPTIONS "-Wall")

# --- React Native linkage ---------------------------------------------------
#
# RN >= 0.71 publishes its native libraries as a prefab inside the
# com.facebook.react:react-android AAR, which Gradle exposes to CMake as a
# config package. Requires buildFeatures.prefab = true in build.gradle; if
# that is off (or the host app predates prefab) the find_package below is
# the failure point, so say what to do about it.
find_package(ReactAndroid CONFIG QUIET)
if(NOT ReactAndroid_FOUND)
  message(FATAL_ERROR
    "react-native-selectable-markdown: the ReactAndroid prefab was not found. "
    "This library needs React Native >= 0.82 with android.buildFeatures.prefab "
    "enabled in the consuming module.")
endif()

# ReactAndroid::jsi is the ONLY React target this library links, and that is a
# deliberate constraint rather than a starting point: OnLoad.cpp is plain JNI
# (see its header comment) and the binding touches jsi::Runtime and nothing
# else, so libjsi.so satisfies every undefined symbol we produce.
#
# The reason this matters is version reach. `jsi` is the one prefab module
# React Native has published under an unchanged name since 0.73; every other
# target was renamed in 0.76, so linking only jsi needs no version ladder.
#
# FABRIC DOES NOT CHANGE THAT, AND THIS IS THE PART PEOPLE EXPECT TO BREAK.
# The Fabric shadow node, its component descriptor and the JNI measurer are
# not compiled into libselectable-markdown.so at all. Third-party Fabric C++
# goes into the *app's* libappmodules.so, through a target called
# react_codegen_SelectableMarkdownSpec whose CMakeLists React Native's codegen
# writes fresh for the app, per React Native version
# (@react-native/codegen .../generators/modules/GenerateModuleJniH.js). Its
# link list — rrc_view, react_render_core, react_render_componentregistry,
# fbjni, folly_runtime and the rest — is therefore version-correct by
# construction and is never spelled out by us; src/main/jni/CMakeLists.txt
# adds our sources to that target rather than declaring a target of its own,
# precisely so this file never has to name a prefab module React Native might
# rename. The one module that target does not already link is the JNI bridge
# header (react/jni/ReadableNativeMap.h), and the seam asks for it by target
# existence — `if(TARGET reactnativejni) … elseif(TARGET reactnative)` — not
# by version number, which is the same discipline as the paragraph above.
#
# So ReactAndroid::jsi remains the only React target this .so needs, on both
# architectures, at every version in the supported range.
if(NOT TARGET ReactAndroid::jsi)
  message(FATAL_ERROR
    "react-native-selectable-markdown: ReactAndroid::jsi is missing from the "
    "React Native prefab. Expected React Native >= 0.82.")
endif()
target_link_libraries(selectable-markdown PRIVATE ReactAndroid::jsi)

# A failed install does not crash the app — it is reported as `false` and the
# JS layer raises an actionable error at the first parse — which makes logcat
# the only place the *reason* ever appears. Since md4c is the only parser this
# package ships, "why did this build stop parsing markdown" is a question
# someone will ask, so the log library is linked rather than the failure being
# swallowed silently.
# find_library, not a bare "log", so this file still configures on a host
# toolchain when someone parses or lints it outside the NDK.
find_library(SMD_ANDROID_LOG_LIB log)
if(SMD_ANDROID_LOG_LIB)
  target_link_libraries(selectable-markdown PRIVATE "${SMD_ANDROID_LOG_LIB}")
endif()
