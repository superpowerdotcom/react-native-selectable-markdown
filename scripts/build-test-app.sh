#!/usr/bin/env bash
# Builds a fresh React Native app with this package installed from its packed
# tarball, then compiles it: Gradle on Android, CocoaPods + xcodebuild on iOS.
#
# Why this exists
# ---------------
# check:fabric-cpp and check:swift compile slices of the package against React
# Native's headers. Neither runs the Kotlin compiler, the app's CMake build,
# the library's NDK build, or `pod install`, and 0.13.1 shipped a Kotlin error
# (an undefined `pressed` in SelectableRunHostView.kt) that failed every
# Android build. This is the consumer's path end to end: npm pack, npm
# install, autolinking, codegen, compile.
#
# The tarball rather than a `file:` link, because package.json `files` decides
# what a consumer actually gets — a source directory missing from it should
# fail here, not in someone's app.
#
# Usage
#   scripts/build-test-app.sh android   # assembleDebug (one ABI) + the library's JVM unit tests
#   scripts/build-test-app.sh ios       # pod install + a simulator build
#
# RNSM_APP_DIR sets the scratch directory and keeps it, so DerivedData survives
# between runs; the app itself is recreated every time. Without it the build
# goes to a temp dir that is removed on success and kept on failure.

set -euo pipefail

platform=${1:-}
case "$platform" in
  android | ios) ;;
  *)
    echo "usage: $0 android|ios" >&2
    exit 2
    ;;
esac

repo=$(cd "$(dirname "$0")/.." && pwd)
# The React Native this repository develops and tests against, so the app
# compiles against the same headers check:fabric-cpp and check:swift use.
rn_version=$(node -p "require('$repo/package.json').devDependencies['react-native']")
# The CLI version React Native's own template pins for that release (0.82 → 20.0.0).
cli_version=20.0.0

app=RNSMBuildCheck
if [ -n "${RNSM_APP_DIR:-}" ]; then
  work=$RNSM_APP_DIR
  mkdir -p "$work"
else
  work=$(mktemp -d "${TMPDIR:-/tmp}/rnsm-app.XXXXXX")
  trap 'if [ $? -eq 0 ]; then rm -rf "$work"; else echo "[build-test-app] left $work for inspection" >&2; fi' EXIT
fi
app_dir="$work/$app"
rm -rf "$app_dir" "$work"/react-native-selectable-markdown-*.tgz

echo "[build-test-app] packing (runs prepare, i.e. the build)…"
# prepare's own output goes to stdout too; npm prints the tarball name last.
# --loglevel=warn rather than --silent, which hides npm's errors as well.
tarball="$work/$(cd "$repo" && npm pack --loglevel=warn --pack-destination "$work" | tail -n 1)"
test -f "$tarball"

echo "[build-test-app] scaffolding React Native $rn_version in $app_dir"
(
  cd "$work"
  npx --yes "@react-native-community/cli@$cli_version" init "$app" \
    --version "$rn_version" \
    --directory "$app_dir" \
    --pm npm \
    --skip-git-init \
    --install-pods false
)

cd "$app_dir"
npm install --no-audit --no-fund "$tarball"

case "$platform" in
  android)
    cd android
    # One ABI: the C++ is the same for all four, and each one is another full
    # NDK build of md4c and of the app's libappmodules.so.
    #
    # Naming :react-native-selectable-markdown also proves autolinking found
    # the package: without it Gradle stops with "project not found" instead
    # of building an app that does not contain us.
    ./gradlew \
      -PreactNativeArchitectures=arm64-v8a \
      :app:assembleDebug \
      :react-native-selectable-markdown:testDebugUnitTest
    ;;

  ios)
    cd ios
    # fmt 11.0.2, which React Native 0.82 pins, does not compile its own
    # format.cc under Apple clang 21 (Xcode 26.4+): "call to consteval function
    # … is not a constant expression". That breaks every 0.82 app, with or
    # without this package; 0.83 moved to fmt 12. Building that one pod as
    # C++17 sidesteps consteval. It has to come after react_native_post_install,
    # which sets c++20 on every pod target, and it stops applying once React
    # Native no longer ships fmt 11.
    if grep -q 'spec.version = "11\.' ../node_modules/react-native/third-party-podspecs/fmt.podspec; then
      node - Podfile << 'EOF'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const hook = /(react_native_post_install\([\s\S]*?\n    \)\n)/;
if (!hook.test(source)) {
  console.error('[build-test-app] no react_native_post_install(...) call in the Podfile to patch after');
  process.exit(1);
}
fs.writeFileSync(file, source.replace(hook, `$1    installer.pods_project.targets.each do |target|
      next unless target.name == 'fmt'
      target.build_configurations.each do |config|
        config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
      end
    end
`));
EOF
    fi
    # A pod on PATH (every GitHub macOS image has one) skips a bundle install
    # that system Ruby cannot do without sudo; the template's Gemfile is the
    # fallback.
    if command -v pod > /dev/null; then
      pod install
    else
      bundle config set --local path vendor/bundle
      bundle install
      bundle exec pod install
    fi
    # A build without the pod would still succeed, having compiled nothing of ours.
    if ! grep -q -- '- SelectableMarkdown (' Podfile.lock; then
      echo "[build-test-app] SelectableMarkdown is not in Podfile.lock — autolinking did not find the podspec" >&2
      exit 1
    fi
    # Debug on the simulator skips the JS bundle, which is not what this checks.
    # One architecture, the host's, for the same reason Android builds one ABI.
    xcodebuild \
      -workspace "$app.xcworkspace" \
      -scheme "$app" \
      -configuration Debug \
      -sdk iphonesimulator \
      -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$work/DerivedData" \
      -quiet \
      ARCHS="$(uname -m)" \
      ONLY_ACTIVE_ARCH=NO \
      CODE_SIGNING_ALLOWED=NO \
      COMPILER_INDEX_STORE_ENABLE=NO \
      build
    ;;
esac

echo "[build-test-app] $platform build passed"
