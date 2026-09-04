require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# THERE IS NO ARCHITECTURE GATE IN THIS FILE ANY MORE, AND THAT IS THE POINT.
#
# The package's peer range starts at react-native 0.82, and from 0.82 React
# Native refuses to install the old architecture at all
# (scripts/react_native_pods.rb: "Calling pod install with
# RCT_NEW_ARCH_ENABLED=0 is not supported anymore since React Native 0.82").
# So `RCT_NEW_ARCH_ENABLED` has exactly one reachable value here, every
# consumer gets the Fabric sources, and the old-architecture view manager and
# shadow node are gone from the package entirely.

Pod::Spec.new do |s|
  s.name         = "SelectableMarkdown"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.description  = package["description"]
  s.homepage     = package["repository"]["url"].sub(/\.git\z/, "")
  s.license      = package["license"]
  s.authors      = { "Superpower" => "https://superpower.com" }
  s.platforms    = { :ios => "13.4" }
  s.source       = { :git => package["repository"]["url"], :tag => "v#{s.version}" }

  # platform/cpp/*.cpp is the parser core plus the JSI binding; the vendored
  # md4c .c files compile as C alongside it (CLANG_CXX_LANGUAGE_STANDARD does
  # not apply to them, and they need no C++ flags).
  #
  # THE FIRST GLOB IS `platform/ios/*` AND NOT `platform/ios/**/*`, WHICH IS
  # THE POINT — for header hygiene, not for architecture. There is no
  # architecture to select any more (see the top of this file):
  # platform/ios/fabric/ is added below unconditionally, in its own entry, and
  # every directory named there is named again in `private_header_files`. That
  # pairing is what keeps the public Objective-C surface separate from the
  # headers that must never reach the umbrella header, and it is spelled one
  # directory at a time. A recursive glob would sweep any subdirectory added
  # later into the public set by default, and a C++ or React-RCTFabric header
  # landing there is the hard build failure the next comment describes.
  #
  # The Fabric sources are still individually wrapped in
  # `#ifdef RCT_NEW_ARCH_ENABLED`. That guard is always true for this pod —
  # install_modules_dependencies below defines the macro — so it is belt and
  # braces, not a gate.
  source_files = [
    "platform/ios/*.{swift,h,m,mm}",
    "platform/cpp/*.{h,cpp}",
    "platform/cpp/vendor/md4c/*.{h,c}",
  ]

  # C++ HEADERS MUST NOT REACH THE UMBRELLA HEADER. This pod sets
  # DEFINES_MODULE = YES and contains Swift, so CocoaPods compiles every
  # *public* header as Objective-C to build the module map. A header that
  # declares a C++ type, or that imports one of React-RCTFabric's, is a hard
  # build failure there — and it takes `import SelectableMarkdown` with it, in
  # every app, not just the ones on the new architecture.
  #
  # What stays public is the pure-Objective-C surface the Swift host view calls
  # into: RNSMAttributedText.h, RNSMTextKitStack.h, SelectableMarkdownModule.h.
  # Everything else is private, including RNSMAttributedText+Props.h, whose
  # whole purpose is to be the C++ half of a class whose other half is public.
  private_header_files = [
    "platform/cpp/**/*.h",
    "platform/ios/RNSMAttributedText+Props.h",
  ]

  # platform/fabric/*.{h,cpp} — the cross-platform shadow node, state and
  # component descriptor, shared verbatim with the Android build (which
  # compiles them through android/src/main/jni/CMakeLists.txt, not through
  # this file).
  #
  # THE SINGLE STAR IS LOAD-BEARING: platform/fabric/android-include/ holds
  # three alias headers sitting at codegen's own generated paths
  # (react/renderer/components/SelectableMarkdownSpec/{ShadowNodes,
  # ComponentDescriptors,States}.h). On Android they shadow the generated
  # headers on purpose. On iOS they must never be seen at all — they would
  # shadow the real generated headers this pod compiles against, and the
  # first symptom would be a redefinition or a circular include somewhere in
  # ReactCodegen's output.
  source_files += [
    "platform/fabric/*.{h,cpp}",
    "platform/ios/fabric/*.{h,mm}",
  ]
  private_header_files += [
    "platform/fabric/*.h",
    "platform/ios/fabric/*.h",
  ]

  s.source_files = source_files
  s.private_header_files = private_header_files

  s.swift_version = "5.0"

  # ASSIGNED BEFORE `install_modules_dependencies` RUNS, AND THAT ORDER IS NOT
  # STYLISTIC. That helper reads the current hash, appends its own
  # HEADER_SEARCH_PATHS, overwrites CLANG_CXX_LANGUAGE_STANDARD, and finishes
  # with `spec.pod_target_xcconfig = current_config`
  # (scripts/cocoapods/new_architecture.rb:96,127). Anything assigned to
  # `pod_target_xcconfig` after that call is discarded in silence — the pod
  # builds, with the boost and Yoga header paths it needs and without ours.
  s.pod_target_xcconfig = {
    # c++20. `install_modules_dependencies` would overwrite the pin to c++20
    # anyway (new_architecture.rb:96 takes it from
    # Helpers::Constants.cxx_language_standard), and React Native's own headers
    # require it — react/utils/hash_combine.h:16 declares a `concept`. Naming
    # it here keeps the standard explicit for the check that proves the
    # markdown engine still compiles clean at it:
    #
    #     npm run check:fabric-cpp -- --syntax-only platform/cpp/*.cpp
    #
    # The bare `--` is load-bearing. npm forwards only what follows it, so a
    # `--syntax-only` written before it is swallowed as an npm config option
    # (npm 11 warns about it and carries on) and the script runs its default
    # full compile instead.
    #
    # That command is a CI gate, not only a local one: the fabric-cpp job in
    # .github/workflows/ci.yml runs it on both runners (adding
    # `--platform ios` on macOS, `--platform android` on ubuntu, because an
    # explicit file list narrows the script to a single pass) and
    # .github/workflows/release.yml runs it on both legs of the release. The
    # default `npm run check:fabric-cpp` skips platform/cpp on purpose — it
    # reaches no react/renderer header — so before that step existed, the
    # engine and its JSI installer compiled in no automated job at all.
    #
    # Both workflows build that file list with `find`, not with the glob
    # written above: `platform/cpp/*.cpp` is expanded by the shell and does not
    # descend, so a source added in a subdirectory of platform/cpp would fall
    # outside the gate with nothing going red. The glob is fine for a local
    # run, where the sources are in front of you; it is not what a gate should
    # rest on.
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    "DEFINES_MODULE" => "YES",
    # Every entry is a bare-name include somewhere in the tree, so it has to
    # be an explicit search path rather than a guess about how CocoaPods
    # flattens public headers in a given release. $(inherited) first so the
    # paths CocoaPods derives from s.dependency are kept.
    #
    #   platform/cpp                -> "SelectableMarkdownJsi.h" from the
    #                                  Objective-C++ host in platform/ios
    #   platform/cpp/vendor/md4c    -> <md4c.h> from OffsetParser.cpp
    #   platform/ios               -> "RNSMAttributedText+Props.h" and
    #                                  "RNSMTextKitStack.h" from the Fabric
    #                                  measurer and mounting view one
    #                                  directory down
    #   platform/fabric            -> "RNSMRunTextMeasurer.h",
    #                                  "RNSMRunHostShadowNode.h" and
    #                                  "RNSMRunHostComponentDescriptor.h" from
    #                                  platform/ios/fabric
    #   React-jsi                   -> <jsi/jsi.h>, the JSI binding's whole
    #                                  API surface
    #
    # platform/fabric/android-include IS DELIBERATELY ABSENT and must stay
    # absent — see the note on the source glob above.
    #
    # There is deliberately nothing here for the new architecture's own
    # headers. React-Fabric, React-RCTFabric and ReactCodegen arrive as pod
    # dependencies through install_modules_dependencies below, and CocoaPods
    # derives their public header paths itself; naming them here would be a
    # second, staler copy of that list.
    #
    # SelectableMarkdownModule.mm reaches the runtime through selectors that
    # both RCTCxxBridge and the bridgeless RCTBridgeProxy implement, so it
    # needs no header out of React-NativeModulesApple or React-runtimeexecutor
    # — which is why it compiles the same way whether the host app runs with a
    # bridge or bridgeless, and why neither pod has to be named here.
    "HEADER_SEARCH_PATHS" => [
      "$(inherited)",
      '"$(PODS_TARGET_SRCROOT)/platform/cpp"',
      '"$(PODS_TARGET_SRCROOT)/platform/cpp/vendor/md4c"',
      '"$(PODS_TARGET_SRCROOT)/platform/ios"',
      '"$(PODS_TARGET_SRCROOT)/platform/fabric"',
      '"$(PODS_ROOT)/Headers/Public/React-jsi"'
    ].join(" ")
  }

  # React-Core carries RCTBridge.h, RCTBridgeModule.h and RCTLog.h, which
  # SelectableMarkdownModule.mm and the Swift host still import.
  s.dependency "React-Core"
  # jsi::Runtime, jsi::MutableBuffer, jsi::ArrayBuffer — see
  # platform/cpp/SelectableMarkdownJsi.h.
  s.dependency "React-jsi"

  # Brings in React-RCTFabric (RCTViewComponentView), React-Fabric (the
  # renderer core the shadow node subclasses), React-utils
  # (ManagedObjectWrapper, which carries the measured NSAttributedString
  # through Fabric State), ReactCodegen (the generated Props.h /
  # EventEmitters.h this package compiles against) and the folly flags all of
  # those headers need — plus -DRCT_NEW_ARCH_ENABLED=1, which is what turns
  # every guarded file above into real code.
  #
  # No `respond_to?` guard and no architecture condition: every version in the
  # peer range (>= 0.82) defines this helper and installs the new architecture.
  #
  # NOT ADDED: React-FabricComponents. It exists to reach RCTAttributedTextUtils
  # and RCTTextLayoutManager, and platform/fabric/RNSMRunTextMeasurer.h explains
  # at length why this package measures its own text instead — the short version
  # is that adopting AttributedString would put a second UTF-8/UTF-16 conversion
  # on the selection path.
  install_modules_dependencies(s)
end
