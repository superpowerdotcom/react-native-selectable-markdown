#!/usr/bin/env node
// Runs React Native's real codegen over the component spec and asserts the
// generated C++, Java and view config still have the shape the native port is
// built on.
//
// Why this exists
// ---------------
// `src/view/SelectableRunHostNativeComponent.ts` is not a description of the
// native contract — it is the *input to a code generator*, and the generator
// lives in node_modules and changes between React Native releases. Every
// design decision in docs/FABRIC-PLAN.md §3 rests on a property of that
// generator's output rather than on anything this repository controls:
//
//   * absence is encoded as a per-type sentinel, because the generated
//     `fromRawValue` assigns a member only when the key is present and the
//     struct has no `std::optional` anywhere;
//   * colours arrive as `SharedColor`, whose `operator bool()` is the is-set
//     test;
//   * `selectionActions` is a `std::vector<std::string>` and therefore
//     ordered — a string-literal union would compile to a `uint32_t` bitmask
//     and lose the menu order docs/SELECTION.md promises;
//   * no type is referenced that codegen never declares (the shape a string
//     enum nested in an array element produces, which does not compile).
//
// If a React Native upgrade changes any of those, the native code in
// `platform/fabric/` and `platform/ios/` decodes something that is no longer
// there. Some of those failures are compile errors, but the interesting ones
// are not: a sentinel that stops meaning "unset" is a *styling* bug on iOS
// only — Android reads `props->rawProps` and its `hasKey` parsing is immune —
// and no jest test in this repository can see it. So this script is the gate:
// it runs the same two CLIs the Gradle plugin and the CocoaPods script phase
// run, and fails loudly, naming the invariant, when the output stops matching.
//
// What it proves, and what it does not
// ------------------------------------
// It proves the generator's output. It does not compile that output — that is
// `npm run check:fabric-cpp`, which builds real translation units against the
// genuine RN headers. The two are complementary: this one catches a shape
// change in a header no `-c` run would object to (a `Float` that became a
// `double`, a sentinel that became a `std::optional`, a vector that became a
// bitmask), and that one catches everything about how our code uses it.
//
// The last two stages are about the JS half, and one of them is a deliberate
// negative control in the spirit of `check-fabric-cpp.mjs --selftest`. First it
// runs React Native's babel preset over the spec and asserts a view config
// really comes out, with the event registration and the unprocessed nested
// colours §3.2 depends on. Then it transpiles the spec the way tsc would if the
// file were not excluded from the build, runs the preset over *that*, and
// asserts NO view config comes out — the silent degradation this whole
// arrangement exists to prevent, and the only place it is observable without a
// bridgeless app. Finally it builds `tsconfig.build.json` into a scratch
// directory and fails if a transpiled spec appears there anyway, which is what
// happens the moment something in the built graph imports the module.
//
// Usage
//   node scripts/check-codegen.mjs            # run every stage
//   node scripts/check-codegen.mjs --keep     # keep the tsc scratch trees too
//   node scripts/check-codegen.mjs --print    # also print the generated Props.h
//
// Generated artifacts go to build/codegen/, which is gitignored: they are
// derived from the spec and from whichever React Native is installed, so a
// committed copy would be a second source of truth that rots. The generated
// specs are left there to be read; the two tsc scratch trees are deleted
// unless --keep, because an `emit/` tree that looks like dist/ invites someone
// to consume it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repoRoot, 'package.json'));

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const PRINT = argv.includes('--print');

const outRoot = path.join(repoRoot, 'build', 'codegen');
const schemaPath = path.join(outRoot, 'schema.json');
const iosOut = path.join(outRoot, 'ios');
const androidOut = path.join(outRoot, 'android');
const probeOut = path.join(outRoot, 'probe');

const failures = [];
const fail = (message) => failures.push(message);
const die = (message) => {
  console.error(`\n[check-codegen] ${message}`);
  process.exit(1);
};
const log = (message) => console.log(`[check-codegen] ${message}`);

/** Asserts `haystack` contains `needle` verbatim; `why` explains what breaks. */
const expectText = (haystack, needle, label, why) => {
  if (haystack.includes(needle)) return true;
  fail(`${label}: expected to find\n      ${needle}\n    ${why}`);
  return false;
};

/** Asserts `haystack` does NOT contain `needle`. */
const expectNoText = (haystack, needle, label, why) => {
  if (!haystack.includes(needle)) return true;
  fail(`${label}: found ${needle}, which must not appear.\n    ${why}`);
  return false;
};

const read = (file, label) => {
  if (!fs.existsSync(file)) {
    fail(`${label}: codegen did not produce ${path.relative(repoRoot, file)}`);
    return null;
  }
  return fs.readFileSync(file, 'utf8');
};

// ---------------------------------------------------------------------------
// 1. The configuration, read from package.json rather than duplicated here.
// ---------------------------------------------------------------------------

// The whole point of the gate is that it exercises the *real* configuration.
// Hardcoding "SelectableMarkdownSpec" and "src/view" would let someone change
// codegenConfig, break every consuming app's build, and still see this script
// pass — which is the same class of mistake the script exists to catch.
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const codegenConfig = manifest.codegenConfig;
if (!codegenConfig) {
  die(
    'package.json has no "codegenConfig". Without it neither the Gradle plugin\n' +
      '  nor the CocoaPods script phase generates anything for this library, and the\n' +
      '  component resolves to nothing in a new-architecture app.',
  );
}
for (const [key, expected] of [
  ['name', 'SelectableMarkdownSpec'],
  ['type', 'components'],
  ['jsSrcsDir', 'src/view'],
]) {
  if (codegenConfig[key] !== expected) {
    fail(
      `codegenConfig.${key} is ${JSON.stringify(codegenConfig[key])}, expected ${JSON.stringify(expected)}.\n` +
        '    The generated target name, the include path the Android seam shadows\n' +
        '    (docs/FABRIC-PLAN.md §2.3) and the app-side autolinking entry are all\n' +
        '    derived from these, so changing one is an app-build change, not a rename.',
    );
  }
}
if (codegenConfig.android?.javaPackageName !== 'com.selectablemarkdown') {
  fail(
    `codegenConfig.android.javaPackageName is ${JSON.stringify(codegenConfig.android?.javaPackageName)},` +
      ' expected "com.selectablemarkdown".\n' +
      '    It has to match the Kotlin package that implements the generated\n' +
      '    SelectableRunHostManagerInterface, or the ViewManager cannot implement it.',
  );
}
// THE ONE ASSERTION THAT WAS MISSING, AND THE BUG IT LET THROUGH. §6b below
// reasons about `RCTThirdPartyFabricComponentsProvider`, whose generated body
// called `<Name>Cls()` directly — so a correctly named `Cls` symbol was the
// whole iOS Fabric contract, and this repository owned both halves of it. That
// is no longer true. React Native now generates
// `RCTThirdPartyComponentsProvider.mm` as a name → `NSClassFromString(...)`
// dictionary, and it builds that dictionary from `codegenConfig.ios`:
//
//   * a library with `ios.componentProvider` is read straight out of the
//     manifest (generateRCTThirdPartyComponents.js, "Old API");
//   * a library with no `ios` key AT ALL is dropped by `parseiOSAnnotations`
//     on its first line (`if (!iosConfig) continue`), which means it never
//     reaches `librariesToCrawl` — and the `.mm`-crawling fallback that used
//     to find `SelectableRunHostCls` unconditionally now runs only for
//     libraries that already declared some `ios` block.
//
// So a package can generate a flawless spec, compile its component view into
// the app, export `SelectableRunHostCls` — every assertion in this file and in
// check-fabric-cpp.mjs green — and still be absent from the provider
// dictionary. `UIManager.hasViewManagerConfig('SelectableRunHost')` then
// answers false, RunHost falls to its `<Text selectable>` tier, and on iOS
// Fabric that tier is not selection at all: a long-press block Copy menu, no
// handles, no range, and `onSelectionAction` never fires. No error, no warning,
// in a release build or a debug one. That is exactly what shipped at 0.2.0.
//
// The class name is compared against the `@implementation` rather than merely
// being present, because `NSClassFromString` returning nil is the same silence
// one level down.
const componentProvider = codegenConfig.ios?.componentProvider;
const PROVIDER_CLASS = 'RCTSelectableRunHostComponentView';
if (componentProvider?.SelectableRunHost !== PROVIDER_CLASS) {
  fail(
    `codegenConfig.ios.componentProvider.SelectableRunHost is ${JSON.stringify(componentProvider?.SelectableRunHost)},` +
      ` expected ${JSON.stringify(PROVIDER_CLASS)}.\n` +
      "    This entry is the ONLY thing that puts the component in the app's\n" +
      '    generated RCTThirdPartyComponentsProvider.mm. Without it iOS Fabric\n' +
      '    resolves nothing, every run silently falls back to <Text selectable>,\n' +
      '    and that fallback has no range selection and no custom menu items.',
  );
} else {
  const implFile = path.join(repoRoot, 'platform/ios/fabric/RCTSelectableRunHostComponentView.mm');
  const impl = fs.existsSync(implFile) ? fs.readFileSync(implFile, 'utf8') : '';
  if (!impl.includes(`@implementation ${PROVIDER_CLASS}`)) {
    fail(
      `codegenConfig.ios.componentProvider names ${PROVIDER_CLASS}, but no\n` +
        `    \`@implementation ${PROVIDER_CLASS}\` exists in platform/ios/fabric/.\n` +
        '    The provider looks the class up with NSClassFromString, which returns nil\n' +
        '    for a name nothing implements — and a nil entry degrades exactly like a\n' +
        '    missing one, silently.',
    );
  }
}

if (manifest['react-native'] !== 'src/index.ts') {
  fail(
    `package.json "react-native" is ${JSON.stringify(manifest['react-native'])}, expected "src/index.ts".\n` +
      "    Metro's resolverMainFields is ['react-native','browser','main'], and this\n" +
      '    field is what makes Metro read the untranspiled spec instead of dist/.\n' +
      '    The negative control below shows exactly what a dist/ copy would do.',
  );
}

const SPEC_RELATIVE = 'src/view/SelectableRunHostNativeComponent.ts';
const SPEC_BASENAME = path.basename(SPEC_RELATIVE, '.ts');
const specPath = path.join(repoRoot, SPEC_RELATIVE);
const specSource = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf8') : null;
if (specSource === null) die(`${SPEC_RELATIVE} does not exist — there is nothing to generate from.`);

// ---------------------------------------------------------------------------
// 2. Run the two CLIs, exactly the ones the real builds run.
// ---------------------------------------------------------------------------

const combineCli = path.join(
  repoRoot,
  'node_modules/@react-native/codegen/lib/cli/combine/combine-js-to-schema-cli.js',
);
const generateCli = path.join(
  repoRoot,
  'node_modules/react-native/scripts/generate-specs-cli.js',
);
for (const cli of [combineCli, generateCli]) {
  if (!fs.existsSync(cli)) {
    die(
      `cannot find ${path.relative(repoRoot, cli)}.\n` +
        '  React Native moved a codegen entry point. Both the Gradle plugin and the\n' +
        '  CocoaPods script phase invoke these two by path, so this is not just a\n' +
        '  problem for this script — find where they went and update both this file\n' +
        '  and docs/FABRIC-PLAN.md §8.',
    );
  }
}

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

const run = (args, what) => {
  try {
    return execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    die(`${what} failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
};

log(`combining ${codegenConfig.jsSrcsDir} into a schema…`);
// No --platform: `filterJSFile` then accepts only platform-agnostic specs
// (`<name>.ts`, two filename components), which is what this package ships.
const combineOutput = run(
  [combineCli, schemaPath, path.join(repoRoot, codegenConfig.jsSrcsDir)],
  'combine-js-to-schema-cli.js',
);
// The CLI writes `{"modules": {}}` and exits 0 when it finds no spec — it only
// logs. That silent-empty case is exactly how a renamed spec file, or one that
// no longer matches `/export\s+default\s+\(?codegenNativeComponent</`, would
// ship: nothing is generated, and every app that installs this package gets a
// component that resolves to nothing.
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const found = Object.keys(schema.modules ?? {});
if (found.length === 0) {
  die(
    'the schema is empty — codegen found no component spec at all.\n' +
      `  combine-js-to-schema said: ${combineOutput.trim() || '(nothing)'}\n` +
      '  It parses a file only when the basename matches /^(Native.+|.+NativeComponent)/\n' +
      '  AND the source text matches /export\\s+default\\s+\\(?codegenNativeComponent</\n' +
      '  (combine-utils.js:25, combine-js-to-schema.js:82-85). Both are required, and\n' +
      '  neither produces an error when it does not hold: the CLI writes an empty\n' +
      '  schema and exits 0.',
  );
}
if (!schema.modules.SelectableRunHost?.components?.SelectableRunHost) {
  die(
    `the schema has no SelectableRunHost component; it has: ${found.join(', ')}.\n` +
      '  The component name is the string passed to codegenNativeComponent, and it\n' +
      '  must stay exactly "SelectableRunHost". In particular it must not gain an\n' +
      '  RCT prefix: componentNameByReactViewName strips a leading RCT, so C++ would\n' +
      "  look up SelectableRunHost while codegen's iOS lookup map stayed keyed on the\n" +
      '  prefixed name, and the two would never meet.',
  );
}

log('generating iOS specs…');
// `--libraryType` mirrors codegenConfig.type, which is how the CocoaPods
// script phase invokes it.
run(
  [
    generateCli,
    '--platform', 'ios',
    '--schemaPath', schemaPath,
    '--outputDir', iosOut,
    '--libraryName', codegenConfig.name,
    '--libraryType', codegenConfig.type,
  ],
  'generate-specs-cli.js --platform ios',
);

log('generating Android specs…');
// Deliberately no `--libraryType` here: GenerateCodegenArtifactsTask never
// passes one, so Android always generates `all` regardless of
// codegenConfig.type. That is what makes `#include <SelectableMarkdownSpec.h>`
// in the app's generated autolinking.cpp resolve even though this package
// ships zero TurboModules (docs/FABRIC-PLAN.md §2.3), so the gate has to
// reproduce it rather than the iOS invocation.
run(
  [
    generateCli,
    '--platform', 'android',
    '--schemaPath', schemaPath,
    '--outputDir', androidOut,
    '--libraryName', codegenConfig.name,
    '--javaPackageName', codegenConfig.android.javaPackageName,
  ],
  'generate-specs-cli.js --platform android',
);

const specDir = `react/renderer/components/${codegenConfig.name}`;
const iosSpec = (file) => path.join(iosOut, specDir, file);
const androidSpec = (file) => path.join(androidOut, 'jni', specDir, file);

// ---------------------------------------------------------------------------
// 3. The attribute struct: sentinel encoding, colours, banned shapes.
// ---------------------------------------------------------------------------

const propsH = read(iosSpec('Props.h'), 'Props.h');

// Every member type here must have a value that cannot also be a legitimate
// setting, because that value *is* how the native decoder reads "this range
// says nothing about this attribute" (docs/FABRIC-PLAN.md §3.1). `bool` is
// absent from this table on purpose and is rejected explicitly below.
const SENTINELS = {
  int: '0',
  Float: '0.0 — a 0pt font size or line height is meaningless',
  'std::string': '"" — no family/weight/style/decoration',
  SharedColor: 'the undefined colour, whose operator bool() is the is-set test',
};
const EXPECTED_ATTRIBUTE_MEMBERS = {
  start: 'int',
  end: 'int',
  fontFamily: 'std::string',
  fontSize: 'Float',
  lineHeight: 'Float',
  fontWeight: 'std::string',
  fontStyle: 'std::string',
  textDecorationLine: 'std::string',
  color: 'SharedColor',
  backgroundColor: 'SharedColor',
};

// The decorations struct rides the identical sentinel encoding: plain strings
// for the kind/corners/align unions (a nested string enum does not compile —
// see the spec file), 0.0 floats (a zero-width border, zero-thickness rule or
// zero inset is a no-op, so the sentinel cannot collide with a real value),
// and SharedColor for the two colours.
const EXPECTED_DECORATION_MEMBERS = {
  start: 'int',
  end: 'int',
  kind: 'std::string',
  color: 'SharedColor',
  borderColor: 'SharedColor',
  borderWidth: 'Float',
  borderRadius: 'Float',
  corners: 'std::string',
  barColor: 'SharedColor',
  barWidth: 'Float',
  paddingTop: 'Float',
  paddingBottom: 'Float',
  textInset: 'Float',
  hang: 'Float',
  thickness: 'Float',
  align: 'std::string',
  inset: 'Float',
  gap: 'Float',
  rowPaddingV: 'Float',
};

// The embeds struct: all five members are required from JS, but codegen
// guards every assignment the same way, so the sparse machinery applies
// verbatim. The 0.0 float sentinel cannot collide — a 0pt embed reserves
// nothing, and both hosts skip entries without a positive size.
const EXPECTED_EMBED_MEMBERS = {
  start: 'int',
  end: 'int',
  embedId: 'int',
  width: 'Float',
  height: 'Float',
};

/**
 * Asserts one generated array-element struct keeps the sparse sentinel
 * contract: expected members with expected sentinel types, no strays, no
 * bools, no undeclared (nested-enum) types, and a fromRawValue overload whose
 * every assignment sits under an only-if-present guard.
 */
const checkSparseStruct = (structName, expectedMembers, readers) => {
  const body = new RegExp(`struct ${structName} \\{\\n([\\s\\S]*?)\\n\\};`).exec(propsH)?.[1];
  if (!body) {
    fail(
      `Props.h: no \`struct ${structName}\`.\n` +
        '    The prop stopped generating a struct — either the prop was renamed\n' +
        '    (the struct name is derived from it) or codegen changed how it\n' +
        '    represents an array of objects.',
    );
    return;
  }
  const members = new Map();
  for (const line of body.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_:<>, ]*?)\s+([A-Za-z_]\w*)\s*\{([^}]*)\};\s*$/.exec(line);
    if (!m) {
      fail(`Props.h: cannot parse member declaration in ${structName}: ${line.trim()}`);
      continue;
    }
    members.set(m[2], { type: m[1], init: m[3] });
  }

  for (const [name, expectedType] of Object.entries(expectedMembers)) {
    const member = members.get(name);
    if (!member) {
      fail(
        `Props.h: ${structName} has no member \`${name}\`.\n` +
          '    Either the spec dropped the field or codegen stopped emitting it.\n' +
          `    ${readers} read it by name.`,
      );
      continue;
    }
    if (member.type !== expectedType) {
      fail(
        `Props.h: ${structName}.${name} is \`${member.type}\`, expected \`${expectedType}\`.\n` +
          `    Absence is encoded as this type's sentinel (${SENTINELS[expectedType] ?? 'no sentinel documented'}),\n` +
          '    so a type change silently changes what "unset" means on the wire.',
      );
    }
    if (member.init !== '' && !/^(0|0\.0|true|false|"")$/.test(member.init)) {
      fail(
        `Props.h: ${structName}.${name} is brace-initialised with \`${member.init}\`.\n` +
          '    A non-default initialiser means the sentinel is no longer the value an\n' +
          '    absent key leaves behind. See §3.1: the nested-string-enum shape emits\n' +
          '    an initialiser that is not even a valid identifier.',
      );
    }
  }

  for (const [name, member] of members) {
    if (!(name in expectedMembers)) {
      fail(
        `Props.h: ${structName} gained a member \`${member.type} ${name}\`.\n` +
          '    A new field is a contract change: add it to the expected-member table\n' +
          "    here, to the sentinel table in the spec file's comment, and to\n" +
          `    ${readers}. An entry no reader consumes silently does nothing.`,
      );
    }
    if (member.type === 'bool') {
      fail(
        `Props.h: ${structName}.${name} is a bool.\n` +
          '    Optional booleans are banned from this struct: `false` is a legal\n' +
          '    value, so no sentinel exists and every entry that omits the key reads\n' +
          '    as an explicit false. The symptom is an iOS-only styling bug (Android\n' +
          '    reads rawProps and is immune) that no test in this repo can see.',
      );
    }
    // `bool` is a builtin and is rejected above for its own reason, so it is
    // in this set: reporting it a second time as "undeclared" would bury the
    // message that actually explains the problem.
    const builtin = new Set([...Object.keys(SENTINELS), 'bool', 'double']);
    if (!builtin.has(member.type)) {
      const declared =
        propsH.includes(`struct ${member.type} `) ||
        propsH.includes(`enum class ${member.type} `) ||
        propsH.includes(`enum class ${member.type}:`);
      fail(
        declared
          ? `Props.h: ${structName}.${name} has unexpected declared type \`${member.type}\`.`
          : `Props.h: ${structName}.${name} has type \`${member.type}\`, which is never declared.\n` +
              '    This is the nested-string-enum failure: generateEnumString\n' +
              '    (GeneratePropsH.js:304-341) declares enums for top-level props and\n' +
              "    recurses into a top-level object prop, but never into an array's\n" +
              '    element type — so a string union inside this struct emits a type\n' +
              '    nobody declares, initialised with something that is not even a valid\n' +
              '    identifier. It does not compile. Keep such fields plain `string`.',
      );
    }
  }

  expectNoText(
    body,
    'std::optional',
    `Props.h (${structName})`,
    'The native decoders read absence as a per-type sentinel because codegen has\n' +
      '    never emitted std::optional here. If that changed, the decoding in\n' +
      "    RNSMAttributedText's props overloads should be rewritten to use it — the\n" +
      '    sentinel convention exists only because there was no alternative.',
  );

  // The sparse read is the mechanism the whole encoding depends on: a member is
  // assigned only when the key is present, so an omitted key leaves the
  // brace-initialised sentinel in place.
  const fromRaw = new RegExp(
    `static inline void fromRawValue\\(const PropsParserContext& context, const RawValue &value, ${structName} &result\\) \\{\\n([\\s\\S]*?)\\n\\}`,
  ).exec(propsH)?.[1];
  if (!fromRaw) {
    fail(
      `Props.h: no fromRawValue overload for ${structName}.\n` +
        '    Without it nothing parses an entry at all: every one would arrive\n' +
        '    fully defaulted and the prop would silently do nothing.',
    );
    return;
  }
  for (const name of Object.keys(expectedMembers)) {
    const guarded = new RegExp(
      `auto tmp_${name} = map\\.find\\("${name}"\\);\\s*\\n\\s*if \\(tmp_${name} != map\\.end\\(\\)\\) \\{\\s*\\n\\s*fromRawValue\\(context, tmp_${name}->second, result\\.${name}\\);`,
    );
    if (!guarded.test(fromRaw)) {
      fail(
        `Props.h: fromRawValue does not assign \`${name}\` under an only-if-present guard.\n` +
          '    Unconditional assignment would overwrite the sentinel with a\n' +
          '    default-converted value for every entry that omits the key, and the\n' +
          '    whole sparse contract (docs/SELECTION.md) collapses: every entry\n' +
          '    would claim to set every field.',
      );
    }
  }
  // And nothing may be assigned outside a guard.
  for (const m of fromRaw.matchAll(/result\.(\w+)/g)) {
    const before = fromRaw.slice(Math.max(0, m.index - 200), m.index);
    if (!before.includes(`if (tmp_${m[1]} != map.end())`)) {
      fail(
        `Props.h: fromRawValue assigns result.${m[1]} outside an only-if-present guard.`,
      );
    }
  }
};

if (propsH) {
  checkSparseStruct(
    'SelectableRunHostAttributesStruct',
    EXPECTED_ATTRIBUTE_MEMBERS,
    "both platforms' string builders (RNSMAttributedText, RunAttributedText)",
  );
  checkSparseStruct(
    'SelectableRunHostDecorationsStruct',
    EXPECTED_DECORATION_MEMBERS,
    'both decoration decoders (RNSMAttributedText decorationsWithProps, RunDecorations.parse)',
  );
  checkSparseStruct(
    'SelectableRunHostEmbedsStruct',
    EXPECTED_EMBED_MEMBERS,
    'both embed decoders (RNSMAttributedText embedsWithProps, RunEmbeds.parse)',
  );

  // The pressables struct. Deliberately boring — three required Int32s — so
  // none of the sentinel machinery above applies; what is asserted is that it
  // stays boring, plus that a parse overload exists at all.
  const pressablesStructName = 'SelectableRunHostPressablesStruct';
  const pressablesBody = new RegExp(`struct ${pressablesStructName} \\{\\n([\\s\\S]*?)\\n\\};`).exec(
    propsH,
  )?.[1];
  if (!pressablesBody) {
    fail(
      `Props.h: no \`struct ${pressablesStructName}\`.\n` +
        '    The pressables prop stopped generating a struct — either the prop was\n' +
        '    renamed (the struct name is derived from it) or codegen changed how it\n' +
        '    represents an array of objects. The iOS component view converts this\n' +
        '    struct by name (RCTSelectableRunHostPressables).',
    );
  } else {
    for (const member of ['int start{0};', 'int end{0};', 'int pressableId{0};']) {
      expectText(
        pressablesBody,
        member,
        `Props.h (${pressablesStructName})`,
        'The pressable range contract is three required Int32s: UTF-16 offsets the\n' +
          '    hosts hit-test taps against, and the identifier they echo back through\n' +
          '    onInlinePress (docs/SELECTION.md, "Event: onInlinePress").',
      );
    }
    const extraMembers = pressablesBody
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^int (start|end|pressableId)\{0\};$/.test(line));
    if (extraMembers.length > 0) {
      fail(
        `Props.h: ${pressablesStructName} has unexpected member(s): ${extraMembers.join(' ')}\n` +
          "    A new field here is a contract change: it must be read by both hosts'\n" +
          '    pressable parsers and carried through the iOS Fabric conversion, or it\n' +
          '    silently does nothing.',
      );
    }
    if (!propsH.includes(`static inline void fromRawValue(const PropsParserContext& context, const RawValue &value, ${pressablesStructName} &result)`)) {
      fail(
        `Props.h: no fromRawValue overload for ${pressablesStructName}.\n` +
          '    Without it no pressable range parses at all and every link inside a run\n' +
          '    is styled but inert on iOS Fabric — the exact failure the prop exists\n' +
          '    to fix.',
      );
    }
  }

  // The props class itself. Each line is quoted whole because the type *and*
  // the default are both load-bearing.
  expectText(
    propsH,
    'class SelectableRunHostProps final : public ViewProps',
    'Props.h',
    'The props must extend ViewProps — `style`, `testID` and the touch handling\n' +
      '    the component view inherits all come from there.',
  );
  expectText(
    propsH,
    'std::string text{};',
    'Props.h',
    'The host renders `text` verbatim; it is the string every selection offset\n' +
      '    in docs/SELECTION.md indexes into.',
  );
  expectText(
    propsH,
    'std::vector<SelectableRunHostAttributesStruct> attributes{};',
    'Props.h',
    'The sparse, overlapping attribute list must survive as a vector of structs:\n' +
      '    no flattening into disjoint fragments happens anywhere in this port\n' +
      '    (docs/FABRIC-PLAN.md §3.3).',
  );
  expectText(
    propsH,
    'std::vector<SelectableRunHostDecorationsStruct> decorations{};',
    'Props.h',
    'The block chrome arrives as a vector whose default is empty — empty is\n' +
      '    "no chrome", which is what a host mounted without the prop (or by an\n' +
      '    older JS bundle) must render: the flat text it rendered before the\n' +
      '    prop existed.',
  );
  expectText(
    propsH,
    'std::vector<SelectableRunHostPressablesStruct> pressables{};',
    'Props.h',
    'The tappable ranges arrive as an ordered vector whose default is empty —\n' +
      '    empty is the "intercept no taps" value JS sends when nothing listens,\n' +
      '    and it must be what a host mounted without the prop gets.',
  );
  expectText(
    propsH,
    'std::vector<SelectableRunHostEmbedsStruct> embeds{};',
    'Props.h',
    'The embedded ranges arrive as a vector whose default is empty — empty is\n' +
      '    "reserve nothing", which is what a host mounted without the prop (or by\n' +
      '    an older JS bundle) must render: the flat text it rendered before the\n' +
      '    prop existed.',
  );
  expectText(
    propsH,
    'bool selectable{true};',
    'Props.h',
    'WithDefault<boolean, true> must keep defaulting to true. A default of false\n' +
      '    would make every host mounted without the prop unselectable — the one\n' +
      '    failure mode this library cannot ship.',
  );
  expectText(
    propsH,
    'std::vector<std::string> selectionActions{};',
    'Props.h',
    'selectionActions is an ORDERED menu. A string-literal union compiles to a\n' +
      '    uint32_t bitmask, which has no order at all, and docs/SELECTION.md\n' +
      '    promises the caller\'s order is the menu order. Keep it\n' +
      '    ReadonlyArray<string> in the spec.',
  );
  expectNoText(
    propsH,
    'uint32_t',
    'Props.h',
    'A uint32_t in this header is the bitmask a string-literal union generates.\n' +
      '    It is unordered, so it cannot carry selectionActions.',
  );
}

// ---------------------------------------------------------------------------
// 4. The event, the component name, and the descriptor alias.
// ---------------------------------------------------------------------------

const eventEmittersH = read(iosSpec('EventEmitters.h'), 'EventEmitters.h');
if (eventEmittersH) {
  expectText(
    eventEmittersH,
    'class SelectableRunHostEventEmitter : public ViewEventEmitter',
    'EventEmitters.h',
    'The component view emits through this class; it is the Fabric replacement\n' +
      "    for paper's RCTDirectEventBlock and, on Android, for RCTEventEmitter.",
  );
  for (const member of ['int start;', 'int end;', 'std::string action;', 'std::string selectedText;']) {
    expectText(
      eventEmittersH,
      member,
      'EventEmitters.h',
      'The OnSelectionAction payload is the JS ↔ native selection contract\n' +
        '    (docs/SELECTION.md, "Event: onSelectionAction"). Offsets are UTF-16 code\n' +
        '    units into the current `text` and nothing in this port converts them.',
    );
  }
  expectText(
    eventEmittersH,
    'void onSelectionAction(OnSelectionAction value) const;',
    'EventEmitters.h',
    'This is the exact signature both component views call.',
  );
  expectText(
    eventEmittersH,
    'int pressableId;',
    'EventEmitters.h',
    'The OnInlinePress payload carries the identifier JS routes a press on\n' +
      '    (docs/SELECTION.md, "Event: onInlinePress"); start/end are already\n' +
      '    asserted above via the OnSelectionAction members.',
  );
  expectText(
    eventEmittersH,
    'void onInlinePress(OnInlinePress value) const;',
    'EventEmitters.h',
    'This is the exact signature the iOS Fabric component view calls for a\n' +
      '    press on a link range.',
  );
  for (const member of ['int embedId;', 'Float x;', 'Float y;', 'Float width;', 'Float height;']) {
    expectText(
      eventEmittersH,
      member,
      'EventEmitters.h',
      'The OnEmbedLayout payload is the rect-report contract (docs/SELECTION.md,\n' +
        '    "Event: onEmbedLayout"): one embed per event, scalar members only —\n' +
        '    an array payload is not verifiably supported by codegen across the\n' +
        '    whole peer range.',
    );
  }
  expectText(
    eventEmittersH,
    'void onEmbedLayout(OnEmbedLayout value) const;',
    'EventEmitters.h',
    'This is the exact signature the iOS Fabric component view calls after\n' +
      '    layout for each embed whose rect moved.',
  );
}

const eventEmittersCpp = read(iosSpec('EventEmitters.cpp'), 'EventEmitters.cpp');
if (eventEmittersCpp) {
  expectText(
    eventEmittersCpp,
    'dispatchEvent("selectionAction"',
    'EventEmitters.cpp',
    'The native event name feeds the `topSelectionAction` registration in the\n' +
      "    view config and Android's getExportedCustomDirectEventTypeConstants. All\n" +
      '    three have to agree or the handler never fires — with no error.',
  );
  expectText(
    eventEmittersCpp,
    'dispatchEvent("inlinePress"',
    'EventEmitters.cpp',
    'Same three-way agreement as selectionAction, for the `topInlinePress`\n' +
      '    registration: view config, Android event constants, and this dispatch.',
  );
  expectText(
    eventEmittersCpp,
    'dispatchEvent("embedLayout"',
    'EventEmitters.cpp',
    'Same three-way agreement as selectionAction, for the `topEmbedLayout`\n' +
      '    registration: view config, Android event constants, and this dispatch.',
  );
}

const shadowNodesCpp = read(iosSpec('ShadowNodes.cpp'), 'ShadowNodes.cpp');
if (shadowNodesCpp) {
  expectText(
    shadowNodesCpp,
    'extern const char SelectableRunHostComponentName[] = "SelectableRunHost";',
    'ShadowNodes.cpp',
    'The component name must stay unprefixed: componentNameByReactViewName strips\n' +
      '    a leading RCT, so an `RCTSelectableRunHost` here would be looked up as\n' +
      "    `SelectableRunHost` by C++ while codegen's iOS map stayed keyed on the\n" +
      '    prefixed name, and the two would never meet.',
  );
}

const descriptorsH = read(iosSpec('ComponentDescriptors.h'), 'ComponentDescriptors.h');
if (descriptorsH) {
  expectText(
    descriptorsH,
    'using SelectableRunHostComponentDescriptor = ConcreteComponentDescriptor<SelectableRunHostShadowNode>;',
    'ComponentDescriptors.h',
    "This alias is the name the app's generated autolinking.cpp registers, and\n" +
      '    the name our own header takes over by include order on Android\n' +
      '    (docs/FABRIC-PLAN.md §2.3). If it changes, that seam breaks in the\n' +
      "    consuming app's build, not here.",
  );
}

// The Android seam works by putting our headers earlier on the include path,
// and that only works while every reference to the three headers we shadow
// spells the full path in angle brackets. So the assertion is exactly that:
// any `#include` naming ShadowNodes.h, ComponentDescriptors.h or States.h must
// be `#include <react/renderer/components/<spec>/X.h>`, character for
// character.
//
// THE PREVIOUS VERSION CHECKED THE ONE FORM THAT IS HARMLESS, and that is the
// interesting part. It failed on `#include "react/renderer/components/<spec>/X.h"`
// — but a quoted include first tries the *including file's* directory, which
// for the generated `<spec>/ComponentDescriptors.h` would be
// `<spec>/react/renderer/components/<spec>/X.h`, a path that does not exist,
// so it falls through to the `-I` search and lands on our alias exactly as the
// angle form does. The seam survives it.
//
// The two forms that actually break the seam were both unchecked:
//
//   * `#include "ShadowNodes.h"` — a bare *sibling* quoted include. That one
//     resolves relative to the including file and finds codegen's own
//     non-measurable header no matter what `-I` order we set. This is not a
//     hypothetical style: codegen already emits it today, in this very
//     directory — `SelectableMarkdownSpecJSI-generated.cpp:10` is
//     `#include "SelectableMarkdownSpecJSI.h"`. The generator simply has not
//     used it for these three files yet.
//   * `#include <ShadowNodes.h>` — a bare angle include. RN's own generated
//     CMakeLists puts the component directory on the include path
//     (`target_include_directories(react_codegen_<lib> PUBLIC . react/renderer/
//     components/<lib>)`, GenerateModuleJniH.js:71), and our android-include
//     tree holds only the deep path, so the bare name resolves to codegen's.
//
// Either one leaves every configure-time assertion in
// android/src/main/jni/CMakeLists.txt true, the app builds green, and every
// run lays out at zero height with no error anywhere. The documented fallback
// is to declare react_codegen_SelectableMarkdownSpec ourselves
// (docs/FABRIC-PLAN.md §2.3).
const SHADOWED_HEADERS = ['ShadowNodes.h', 'ComponentDescriptors.h', 'States.h'];

for (const dir of [path.join(iosOut, specDir), path.join(androidOut, 'jni', specDir)]) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      const include = /^\s*#\s*include\s+([<"])([^>"]+)[>"]/.exec(line);
      if (!include) continue;
      const [, bracket, target] = include;
      // Compared as a whole basename, not a suffix: React Native has headers
      // such as BaseTextShadowNode.h, and matching those would demand a spec
      // path for a header that has nothing to do with the seam.
      if (!SHADOWED_HEADERS.includes(path.basename(target))) continue;
      const expected = `${specDir}/${path.basename(target)}`;
      if (bracket !== '<' || target !== expected) {
        fail(
          `${file}: ${line.trim()}\n` +
            `    The Android seam (docs/FABRIC-PLAN.md §2.3) shadows codegen's\n` +
            '    ShadowNodes.h/ComponentDescriptors.h/States.h by -I order, which\n' +
            '    only the exact angle-bracket form respects. Expected\n' +
            `    #include <${expected}>. A bare quoted sibling resolves next to the\n` +
            '    generated file and a bare angle name resolves through the generated\n' +
            "    CMakeLists' own component directory; either way the app registers\n" +
            '    codegen\'s non-measuring descriptor and every run lays out at zero\n' +
            '    height with no build error.',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Android: the Java delegate is the compile-time link to the Kotlin.
// ---------------------------------------------------------------------------

const javaDir = path.join(androidOut, 'java', 'com', 'facebook', 'react', 'viewmanagers');
const managerInterface = read(
  path.join(javaDir, 'SelectableRunHostManagerInterface.java'),
  'SelectableRunHostManagerInterface.java',
);
if (managerInterface) {
  for (const method of [
    'void setText(T view, @Nullable String value);',
    'void setAttributes(T view, @Nullable ReadableArray value);',
    'void setDecorations(T view, @Nullable ReadableArray value);',
    'void setPressables(T view, @Nullable ReadableArray value);',
    'void setEmbeds(T view, @Nullable ReadableArray value);',
    'void setSelectable(T view, boolean value);',
    'void setSelectionActions(T view, @Nullable ReadableArray value);',
  ]) {
    expectText(
      managerInterface,
      method,
      'SelectableRunHostManagerInterface.java',
      'The Kotlin ViewManager implements this interface, which is the only\n' +
        '    compile-time link between the TypeScript spec and the native setters. A\n' +
        '    method that changes shape is a Kotlin compile error — which is the point.',
    );
  }
  // setAttributes takes a ReadableArray, not the codegen struct: on Fabric the
  // Java side is handed `props->rawProps`, so RunAttributedText's sparse
  // `hasKey` reading — and its skip-a-key-this-binary-does-not-know forward
  // compatibility — keeps working unchanged (docs/FABRIC-PLAN.md §3.3).
  expectNoText(
    managerInterface,
    'SelectableRunHostAttributesStruct',
    'SelectableRunHostManagerInterface.java',
    'The Java setter must keep taking a ReadableArray. If codegen started handing\n' +
      "    Java the parsed struct, RunAttributedText's hasKey-based sparse reading\n" +
      '    would be bypassed and unset attributes would arrive as sentinels.',
  );
}
read(path.join(javaDir, 'SelectableRunHostManagerDelegate.java'), 'SelectableRunHostManagerDelegate.java');

// Android's Props.h is generated from the same schema and is what Fabric uses
// for prop diffing there. If the two platforms ever diverge, one of them is
// decoding a struct the other does not produce.
const androidPropsH = read(androidSpec('Props.h'), 'Props.h (android)');
if (propsH && androidPropsH && propsH !== androidPropsH) {
  fail(
    'Props.h differs between the iOS and Android generator runs.\n' +
      '    The shared C++ shadow node in platform/fabric/ compiles against both.',
  );
}

// ---------------------------------------------------------------------------
// 6. The view config, and the negative control that explains tsconfig.build.json.
// ---------------------------------------------------------------------------

// Nothing above proves the *JS* half: codegen's C++ comes from the CLI, but the
// view config comes from the babel plugin, and the two can disagree. This stage
// runs React Native's own preset, once over the shipped source and once over
// what tsc would emit.
let babel;
let preset;
try {
  babel = require('@babel/core');
  preset = require('@react-native/babel-preset');
} catch (error) {
  die(
    'cannot load @babel/core / @react-native/babel-preset from node_modules\n' +
      `  (${error.message}).\n` +
      '  Both arrive with react-native. Without them the view-config stage cannot\n' +
      '  run, and the silent-degrade check below is the only place in this repo\n' +
      '  where that failure is observable.',
  );
}

const transform = (code, filename) =>
  babel.transformSync(code, {
    filename,
    presets: [[preset, {}]],
    babelrc: false,
    configFile: false,
    sourceType: 'unambiguous',
  }).code;

log('transforming the spec with @react-native/babel-preset…');
const viewConfig = transform(specSource, specPath);
expectText(
  viewConfig,
  '__INTERNAL_VIEW_CONFIG',
  'view config',
  'The babel plugin did not rewrite the default export. Under bridgeless the\n' +
    '    static view config is the only way the component resolves\n' +
    '    (NativeComponentRegistry.js:55-70); without it the default export stays\n' +
    "    the runtime codegenNativeComponent, which returns requireNativeComponent —\n" +
    '    dead on the new architecture.',
);
expectText(
  viewConfig,
  "uiViewClassName:'SelectableRunHost'",
  'view config',
  'The registered name must match the C++ component name and the iOS\n' +
    '    SelectableRunHostCls() symbol exactly.',
);
// Asserted per registration rather than as one exact directEventTypes blob,
// so adding a third event extends this list instead of rewriting a string
// that encodes the map's member order.
expectText(
  viewConfig,
  "topSelectionAction:{registrationName:'onSelectionAction'}",
  'view config',
  'This is the mapping that turns the native "selectionAction" event into the\n' +
    '    onSelectionAction prop. Both native hosts dispatch topSelectionAction.',
);
expectText(
  viewConfig,
  "topInlinePress:{registrationName:'onInlinePress'}",
  'view config',
  'This is the mapping that turns the native "inlinePress" event into the\n' +
    '    onInlinePress prop. Both native hosts dispatch topInlinePress.',
);
expectText(
  viewConfig,
  "topEmbedLayout:{registrationName:'onEmbedLayout'}",
  'view config',
  'This is the mapping that turns the native "embedLayout" event into the\n' +
    '    onEmbedLayout prop. Both native hosts dispatch topEmbedLayout.',
);
// §3.2: nested colours are NOT processed by the generated view config, which is
// why RunHost.toNativeAttribute calls processColor itself. `attributes: true`
// is codegen saying "pass this through untouched".
expectText(
  viewConfig,
  'attributes:true',
  'view config',
  'Codegen attaches {process: processColor} only to TOP-LEVEL colour props\n' +
    '    (GenerateViewConfigJs.js:36,92), so the colours inside `attributes` cross\n' +
    '    unprocessed and RunHost.toNativeAttribute must keep calling processColor.\n' +
    '    If this ever became a processed entry, colours would be converted twice.',
);
expectText(viewConfig, 'selectionActions:true', 'view config', 'The ordered action list is passed through as-is.');
expectText(viewConfig, 'pressables:true', 'view config', 'The tappable ranges are passed through as-is.');
expectText(viewConfig, 'embeds:true', 'view config', 'The embedded ranges are passed through as-is.');
expectText(
  viewConfig,
  'decorations:true',
  'view config',
  'The block chrome is passed through as-is — its nested colours cross\n' +
    '    unprocessed exactly like the ones in `attributes` (§3.2), which is why\n' +
    '    RunHost.toNativeDecoration calls processColor itself.',
);

// ---------------------------------------------------------------------------
// 6b. The four places the component name is written, and the one it comes from.
// ---------------------------------------------------------------------------

// The name in the spec is not a label — it is a lookup key, resolved
// independently by four registries that never see each other, and every
// mismatch between them is silent:
//
//   * iOS Fabric looks the class up in the app's generated
//     RCTThirdPartyComponentsProvider dictionary, keyed by this name — see the
//     codegenConfig.ios.componentProvider assertion in §1, which is what puts
//     an entry there at all. Older React Natives generated a
//     RCTThirdPartyFabricComponentsProvider that *called* `<Name>Cls()`, making
//     a misnamed symbol a link error in the consuming app; today's provider
//     goes through NSClassFromString, so the same mistake is silent. The `Cls`
//     symbol still has to exist and keep its name, because that is what
//     codegen's own `RCTComponentViewClassDescriptorProvider` path uses when it
//     is the one doing the lookup.
//   * iOS paper resolves through the exported ObjC module name with a trailing
//     "Manager" stripped (RCTComponentData.m:548-557).
//   * Android resolves through ViewManager.getName() on both architectures.
//   * C++ resolves through the generated SelectableRunHostComponentName, which
//     §5 above already pins to the spec.
//
// Nothing else in this repository compares them, so a rename in the spec file
// would leave every native side registered under a key nothing looks up, and
// `RunHost` throws rather than rendering — see the tier list in RunHost.tsx.
const NATIVE_REGISTRATIONS = [
  {
    file: 'platform/ios/fabric/RCTSelectableRunHostComponentView.mm',
    needle: 'Class<RCTComponentViewProtocol> SelectableRunHostCls(void)',
    why:
      'iOS Fabric discovery resolves this exact name. Codegen declares the symbol\n' +
      '    with __attribute__((used)), not weak, so on the React Natives that call it\n' +
      '    directly a misnamed definition is a link failure in the consuming app; on\n' +
      '    the ones that go through RCTThirdPartyComponentsProvider it is instead a\n' +
      '    silent miss, which is what the componentProvider assertion in §1 covers.',
  },
  {
    file: 'android/src/main/java/com/selectablemarkdown/SelectableRunHostViewManager.kt',
    needle: 'const val COMPONENT_NAME = "SelectableRunHost"',
    why: 'ViewManager.getName() is what both Android architectures register under.',
  },
];

for (const { file, needle, why } of NATIVE_REGISTRATIONS) {
  const full = path.join(repoRoot, file);
  if (!fs.existsSync(full)) {
    fail(`native registration: ${file} does not exist, so nothing registers the component there.`);
    continue;
  }
  // Whitespace-insensitive: clang-format and ktlint both reflow these lines,
  // and a check that fails on a reformat is a check people delete.
  const haystack = fs.readFileSync(full, 'utf8').replace(/\s+/g, ' ');
  if (!haystack.includes(needle.replace(/\s+/g, ' '))) {
    fail(`native registration (${file}): expected to find\n      ${needle}\n    ${why}`);
  }
}

const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tscBin)) {
  die(`cannot find ${path.relative(repoRoot, tscBin)} — typescript is a devDependency of this package.`);
}

log('negative control: transpiling the spec the way tsc would…');
// This is the silent degradation docs/FABRIC-PLAN.md §0 correction 1 is about,
// reproduced so it cannot come back unnoticed. tsc emits CommonJS, so
// `export default …` becomes `exports.default = …`, and the babel plugin's
// ExportDefaultDeclaration visitor
// (@react-native/babel-plugin-codegen/index.js:155-160) never matches it. No
// view config is emitted, nothing throws, and the component resolves to
// nothing in a bridgeless app.
//
// `--module commonjs` mirrors tsconfig.json, which tsconfig.build.json
// extends; that is the emit a `dist/` copy would actually have.
fs.mkdirSync(probeOut, { recursive: true });
run(
  [
    tscBin,
    specPath,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    '--outDir', probeOut,
  ],
  'tsc (negative control)',
);
const transpiledPath = path.join(probeOut, `${SPEC_BASENAME}.js`);
const transpiledConfig = transform(fs.readFileSync(transpiledPath, 'utf8'), transpiledPath);
if (transpiledConfig.includes('__INTERNAL_VIEW_CONFIG')) {
  // Not a disaster — it would mean the spec survives transpilation — but it
  // invalidates the reasoning behind the tsconfig exclusion and the
  // "react-native" entry, so it must not pass unnoticed.
  fail(
    'negative control: a transpiled spec now DOES produce a view config.\n' +
      '    The tsconfig.build.json exclusion and the package.json "react-native"\n' +
      '    entry exist because it did not. Re-read docs/FABRIC-PLAN.md §0 and\n' +
      '    update the reasoning in the spec file before relaxing anything.',
  );
} else {
  log('  confirmed: the transpiled spec produces no view config (silently)');
}

// And the exclusion has to actually take effect, which is not the same thing
// as being written down. `exclude` only filters the `include` glob: a file
// reached by an `import` — `import type` included — is pulled back into the
// program and emitted anyway (verified against tsc 5.5). So the assertion that
// matters is on the OUTPUT of the real build config, not on its exclude list.
// A static import added to RunHost.tsx would put a transpiled spec back in
// dist/ with nothing else to warn about it.
log('building tsconfig.build.json into a scratch dir…');
const emitOut = path.join(outRoot, 'emit');
run(
  [
    tscBin,
    '-p', path.join(repoRoot, 'tsconfig.build.json'),
    '--outDir', emitOut,
    // Declarations and maps are irrelevant here and roughly double the run.
    '--declaration', 'false',
    '--declarationMap', 'false',
    '--sourceMap', 'false',
  ],
  'tsc -p tsconfig.build.json (emit check)',
);
// Walked rather than looked up at `view/`, because the emit path follows
// rootDir and a directory move would otherwise turn this assertion into a
// silent pass — which is precisely the failure mode it exists to catch.
const leaked = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.startsWith(SPEC_BASENAME)) leaked.push(path.relative(emitOut, full));
  }
};
walk(emitOut);
if (leaked.length > 0) {
  fail(
    `the build emitted ${leaked.join(', ')} despite the tsconfig.build.json exclusion.\n` +
      '    Something in the built graph imports the spec module. `exclude` does not\n' +
      '    stop tsc emitting a file reached by an import (or an `import type`), so\n' +
      '    the transpiled copy is back in dist/ — where a bundler that ignores the\n' +
      '    "react-native" field will load it and get no view config at all (see the\n' +
      '    negative control above). Reach the spec through a call-expression\n' +
      '    `require`, which tsc does not follow.',
  );
} else {
  log('  confirmed: the build emits no transpiled copy of the spec');
}

// ---------------------------------------------------------------------------

if (PRINT && propsH) {
  console.log(`\n${propsH}`);
}

if (!KEEP) {
  // The generated specs are the interesting artifact and are left in place for
  // reading; the two tsc scratch trees are not, and leaving an `emit/` tree
  // that looks like dist/ next to them invites someone to consume it.
  fs.rmSync(probeOut, { recursive: true, force: true });
  fs.rmSync(path.join(outRoot, 'emit'), { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('');
  for (const failure of failures) console.error(`[check-codegen] FAIL ${failure}\n`);
  console.error(
    `[check-codegen] ${failures.length} assertion(s) failed.\n` +
      '                React Native codegen no longer produces the output the native\n' +
      '                port is written against. Read docs/FABRIC-PLAN.md §3 before\n' +
      '                changing either side: several of these invariants fail\n' +
      '                silently at runtime rather than at compile time.',
  );
  process.exit(1);
}

log(`ok — schema + iOS/Android specs generated into ${path.relative(repoRoot, outRoot)}/`);
