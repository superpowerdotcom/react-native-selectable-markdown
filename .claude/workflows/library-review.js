export const meta = {
  name: 'library-review',
  description: 'Audit react-native-selectable-markdown: docs vs implementation, gaps, design improvements; adversarially verify every finding',
  phases: [
    { title: 'Find', detail: '13 docs-vs-impl auditors + 17 subsystem gap finders' },
    { title: 'Merge', detail: 'dedupe findings per area' },
    { title: 'Verify', detail: 'adversarial fact-check, then impact judgment' },
    { title: 'Critic', detail: 'completeness critic, targeted follow-up finders' },
    { title: 'Synthesize', detail: 'prioritize and group' },
  ],
}

const REPO = '/Users/demian/Work/superpower/react-native-selectable-markdown'
const SCRATCH = '/private/tmp/claude-501/-Users-demian-Work-superpower-react-native-selectable-markdown/74aacc70-da89-4d44-b104-cefc1375f952/scratchpad'
const AREAS = ['streaming','selection','view','native-ios','native-android','native-cpp-engine','engine-options','agui','packaging-ci-tests','docs-general','architecture-design']

const GOALS = 'a performant markdown renderer for streamed LLM output in React Native, with selection that spans paragraphs and other blocks ("document-grade" selection) and copies the exact markdown source; safe defaults for untrusted model output.'

const PREAMBLE = `You are reviewing the git repository at ${REPO} (branch main, package version 0.11.0). It is \`react-native-selectable-markdown\`. Its stated goal: ${GOALS}
Layout: parsing is md4c compiled natively (platform/cpp, vendored md4c under platform/cpp/vendor) exposed over JSI (src/engine/native); streaming in src/stream; selection runs/projection/copy in src/selection; React view layer in src/view; native hosts in platform/ios (Swift + ObjC++), android/ (Kotlin + JNI C++), and a shared Fabric shadow node in platform/fabric. Docs: README.md and docs/*.md, plus native/node/README.md. Node test harness: native/node (an addon already built at build/selectable-markdown.*.node; all 32 Jest suites currently pass). Run tests with \`npx jest <path>\` from the repo root; typecheck with \`npx tsc --noEmit\`. Do NOT run scripts/build-node-addon.mjs (the addon is built; concurrent builds would clash).
Rules: the repository is READ-ONLY for you. Never edit, create or delete files under ${REPO}. Put scratch scripts and repros under ${SCRATCH} (create a subdirectory named after your label). Read the actual code before claiming anything; every finding needs a file:line you verified by reading. No speculation presented as fact; if you could not verify something, say so in coverage_notes instead of reporting it. Do not restate the docs' own admitted gaps ("Known divergence", "known gap", the README Status table) unless you add something material, e.g. the gap is larger than described, or the description of it is wrong.`

const FINDER_OUTPUT_RULES = `## Output rules
- Return findings only with verified file:line refs (code_ref) that you read in this session. For docs-vs-impl findings also fill doc_ref (doc file:line).
- One finding per distinct issue. Do not pad. An empty list with honest coverage_notes is a valid result.
- claim = what the doc, comment or API promises (or, for gaps, what the goals require); reality = what the code does; evidence = short verbatim quotes (one or two lines each) from both sides plus any repro output.
- severity: high = misleads a user into a wrong integration, or a real bug or performance cliff on the streaming or selection path; medium = wrong or missing information a maintainer should fix, or a real gap with a workaround; low = minor drift.
- category: docs-vs-impl (doc and code disagree), bug (code is wrong on its own terms), gap (something the goals need that is missing or partial), improvement (a design alternative that would be clearly better; state the trade-off).
- area: the subsystem the finding is about, from: ${AREAS.join(', ')}.
- coverage_notes: files read fully, files skimmed, checks you could not perform.`

const FINDING_PROPS = {
  title: { type: 'string', description: 'specific, under 100 chars' },
  category: { type: 'string', enum: ['docs-vs-impl', 'bug', 'gap', 'improvement'] },
  area: { type: 'string', enum: AREAS },
  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
  doc_ref: { type: 'string', description: 'doc file:line, or empty string' },
  code_ref: { type: 'string', description: 'file:line(s) you read' },
  claim: { type: 'string' },
  reality: { type: 'string' },
  recommendation: { type: 'string' },
  evidence: { type: 'string' },
}
const FINDING_REQUIRED = ['title', 'category', 'area', 'severity', 'doc_ref', 'code_ref', 'claim', 'reality', 'recommendation', 'evidence']

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: FINDING_PROPS, required: FINDING_REQUIRED } },
    coverage_notes: { type: 'string' },
  },
  required: ['findings', 'coverage_notes'],
}

const MERGED_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'array', items: { type: 'object', properties: { ...FINDING_PROPS, source_ids: { type: 'array', items: { type: 'integer' } } }, required: [...FINDING_REQUIRED, 'source_ids'] } },
  },
  required: ['merged'],
}

const FACT_SCHEMA = {
  type: 'object',
  properties: {
    confirmed: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string', description: 'what you read or ran, and why the claim stands or falls' },
    corrected_title: { type: 'string', description: 'empty if the title is accurate' },
    corrected_code_ref: { type: 'string', description: 'empty if accurate' },
    corrected_doc_ref: { type: 'string', description: 'empty if accurate' },
    corrected_reality: { type: 'string', description: 'empty if accurate; otherwise the corrected statement of what the code does' },
  },
  required: ['confirmed', 'confidence', 'reasoning', 'corrected_title', 'corrected_code_ref', 'corrected_doc_ref', 'corrected_reality'],
}

const MAT_SCHEMA = {
  type: 'object',
  properties: {
    matters: { type: 'boolean' },
    already_documented: { type: 'boolean' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
    effort: { type: 'string', enum: ['small', 'medium', 'large'] },
    rationale: { type: 'string' },
    sharpened_recommendation: { type: 'string' },
  },
  required: ['matters', 'already_documented', 'severity', 'effort', 'rationale', 'sharpened_recommendation'],
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    assessment: { type: 'string' },
    followups: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, area: { type: 'string', enum: AREAS }, prompt: { type: 'string' } }, required: ['key', 'area', 'prompt'] } },
  },
  required: ['assessment', 'followups'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    executive_summary: { type: 'string' },
    headline_ids: { type: 'array', items: { type: 'string' } },
    themes: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, narrative: { type: 'string' }, finding_ids: { type: 'array', items: { type: 'string' } } }, required: ['title', 'narrative', 'finding_ids'] } },
    quick_wins: { type: 'array', items: { type: 'string' } },
    docs_fix_list: { type: 'array', items: { type: 'string' } },
    scope_notes: { type: 'string' },
  },
  required: ['executive_summary', 'headline_ids', 'themes', 'quick_wins', 'docs_fix_list', 'scope_notes'],
}

const finders = [
  // ---------------- docs vs implementation ----------------
  { key: 'D01-readme-install', area: 'docs-general', prompt: `Audit README.md sections "Why", "Features", "Install" and "Native setup" (plus the two intro paragraphs) against the implementation. For each factual claim locate the code that backs it: installNativeEngine return semantics and the JavaScriptCore refusal (src/engine/native/install.ts, src/engine/native/index.ts), parseDocument throwing without the module (src/engine/native.ts, src/engine/Engine.ts), SelectableMarkdown throwing during render, RunHost throwing when the Fabric component is missing and the use_frameworks! claim (src/view/RunHost.tsx, src/view/SelectableRunHostNativeComponent.ts), autolinking (react-native.config.js, SelectableMarkdown.podspec, android/build.gradle, android/src/main/java/com/selectablemarkdown/SelectableMarkdownPackage.kt), the peer range in package.json, the CommonMark score (conformance/run-commonmark.mjs), "settled blocks keep referential identity" and "plain-prose deltas skip the parser" (src/stream/StreamSession.ts), "HTML is stripped, URL schemes are allowlisted" defaults (src/engine/options.ts, src/engine/urlPolicy.ts), "A run ends at an image, a spoiler, or a block you mark standalone" and "Code blocks, tables and rules flow through runs" (src/selection/runs.ts), "Copy gives you the markdown itself" (src/selection/copy.ts). Report anything wrong, stale, over-promised or under-described.` },
  { key: 'D02-readme-quickstart', area: 'docs-general', prompt: `Audit README.md "Quick start" (Static, Streaming, ag-ui, Headless) against src/view/SelectableMarkdown.tsx, src/stream/StreamSession.ts, src/stream/smoothing.ts, src/agui/useAgUiSession.ts, src/agui/bindRunTextEvents.ts, src/document/visit.ts and src/index.ts. Check every prop, option name, default value, function signature, return type and behavioral claim in the snippets and prose: selectionActions default and "system Copy always stays", onSelectionCopy payload fields (action, plain, markdown, span), "Setting one without the other yields an empty custom menu", holdBackChars and holdIdleMs defaults, appendBuffered/flushBuffered semantics, "any synchronous call (append, replace, finalize) drains first", the StreamSession option list (smoother, repair, bufferScheduler, idleScheduler, now), createSmoother and createAdaptiveSmoother signatures and described behaviour, drained(), rewrite(full), notifyRunFinalized, finalize reasons and idempotency, useAgUiSession signature and its finalize triggers, bindRunTextEvents/useAgUiRunSessions/holding, the Node deep-path import advice (does dist/engine/Engine exist after build? does the package root really re-export react-native?). Would the snippets typecheck and behave as described? Write a scratch .ts file under the scratchpad that imports from the package src and run \`npx tsc --noEmit\` on it if useful.` },
  { key: 'D03-readme-theming-options', area: 'docs-general', prompt: `Audit README.md "Theming", "Defaults for model output" (the option table), "Custom link schemes", the embed section and the classifyBlock section against src/view/theme.ts, src/engine/options.ts, src/engine/urlPolicy.ts, src/engine/extensions/spoilers.ts, src/view/renderers.tsx, src/view/runEmbeds.ts, src/view/SelectableMarkdown.tsx, src/selection/runs.ts, and the option handling on the native side (platform/cpp/OffsetParser.cpp, platform/cpp/SelectableMarkdownJsi.cpp, src/engine/native/index.ts). Verify: the theme group list, "merge one level deep", colorScheme default and behaviour, glyphs shifting offsets, attributeForMark taking part in the per-run memo, the "Known divergence" about listIndent, every option's default in commonmark/llmChat/everything presets, DEFAULT_LINK_PREFIXES, the image scheme default, blockedLinks 'text' vs 'node', onLinkPress payload and the Linking.openURL fallback, "the link renderer does not run inside a run", the embed contract (one placeholder character, declared size, topLevel, text for copy-text, onEmbedLayout, taps owned by the card), classifyBlock semantics and "Images and spoilers are standalone already", "the document is resegmented when it changes".` },
  { key: 'D04-readme-status-bench', area: 'docs-general', prompt: `Audit README.md "Architecture" diagram, "Status (0.11.x)" table, "Benchmarks" paragraph, "Contributing" and "Prior art" against the repository: package.json version and scripts, bench/*.mjs (do the harnesses exist and produce the quoted metrics: "at most 277 characters", "2.7 µs", "43 to 53%", "15.8 MB/s"), docs/BENCHMARKS.md numbers vs README numbers, conformance/run-commonmark.mjs and conformance/vendor (651/652, example 174), the copy-menu iOS version claims vs platform/ios/SelectableRunHostView.swift, "Fabric only" vs platform/ and android/, "no example app", the "Removed in 0.10.0, restored in 0.11.0" history (git log has two commits; is there a CHANGELOG?), "CI compiles the C++ against real renderer headers and the Swift against the iOS SDK" vs .github/workflows/ci.yml and scripts/check-fabric-cpp.mjs, scripts/check-swift.mjs, "iOS preserves it" (selection), and the Contributing commands. You may run \`node bench/streaming-replay.mjs\` to spot-check the shape of its output. Report mismatches and unverifiable claims.` },
  { key: 'D05-architecture-doc', area: 'docs-general', prompt: `Audit docs/ARCHITECTURE.md against the code: the pipeline description, the "three rules", the module map (every file or directory it names must exist and do what it says; list significant files that exist but are missing from the map), the Engine interface as documented vs src/engine/Engine.ts (exact type), "Writing an engine" (is SourceSpan really the only hard requirement? find places in src/stream, src/selection and src/view that assume md4c-specific behaviour: node kinds, incomplete/synthetic flags, entity handling, smart punctuation, span widening), "The engine that ships", "Headless use from Node".` },
  { key: 'D06-streaming-doc', area: 'streaming', prompt: `Audit docs/STREAMING.md against src/stream/StreamSession.ts, repair.ts, smoothing.ts, placeholders.ts, shiftSpans.ts and the tests (incremental.test.ts, buffering.test.ts, repair.test.ts, StreamSession.test.ts, smoothing.test.ts, conformance/streaming/prefix-oracle.test.ts). Verify every claim: session lifecycle and states, pacing (holdback, idle flush, buffering), the Smoother contract, the safe anchor definition and the tail-only reparse rules, the construct-free fast path conditions, the tail repair handler table (does each documented handler exist with the documented behaviour; count the corpus, the README says 147 cases), the incomplete and synthetic flags, finalize semantics for 'end' | 'aborted' | 'failed', and the protocol edge cases. Report every mismatch, plus behaviour in the code that the doc omits and a user would need to know.` },
  { key: 'D07-selection-doc-1', area: 'selection', prompt: `Audit docs/SELECTION.md sections "Pipeline", "Runs and standalone blocks", "Projection", "Native component" (including "How RunHost resolves the component" and "Status"), "Props", "Event: onSelectionAction", "Event: onInlinePress", "Event: onEmbedLayout" and "handleSelectionAction" against src/selection/runs.ts, src/selection/mapSelection.ts, src/selection/copy.ts, src/view/RunHost.tsx, src/view/SelectableRunHostNativeComponent.ts, src/view/selectionActions.ts, src/view/runAttributes.ts, runDecorations.ts, runPressables.ts, runEmbeds.ts. Check each documented prop and event name, type, default, and the projection rules (which blocks flow, which are standalone, glyphs, code fences, tables, rules, line breaks) against the code. Report mismatches and undocumented props or events.` },
  { key: 'D08-selection-doc-2', area: 'selection', prompt: `Audit docs/SELECTION.md sections "Selection preservation across text swaps" (iOS and Android), "View recycling (Fabric)", "Tail policy (streaming)", "What a standalone block does and does not get", "Sizing", "Android layout cache and spannable handoff", "Platform hardening" and "Offsets end to end" against platform/ios/SelectableRunHostView.swift, platform/ios/RNSMAttributedText.mm, platform/ios/RNSMTextKitStack.mm, platform/ios/fabric/RCTSelectableRunHostComponentView.mm, platform/ios/fabric/RNSMRunTextMeasurer.mm, platform/fabric/*.h and *.cpp, android/src/main/java/com/selectablemarkdown/*.kt, android/src/main/jni/RNSMRunTextMeasurer.cpp, and src/view/SelectableMarkdown.tsx (tail policy). Verify every described mechanism exists and behaves as written: clamping rules, recycling resets, cache keys and invalidation, the offsets pipeline (UTF-16 vs UTF-8 vs Java char vs NSString), sizing. Report mismatches.` },
  { key: 'D09-native-doc', area: 'native-cpp-engine', prompt: `Audit docs/NATIVE.md and native/node/README.md against platform/cpp/OffsetParser.cpp/.h, FlatBuffer.cpp, SelectableMarkdownJsi.cpp/.h, Protocol.h, platform/cpp/vendor/md4c/UPSTREAM.md and patches/README.md (are the described patches actually present in md4c.c? diff against the claimed upstream version if you can reason about it), src/engine/native/install.ts, decode.ts, widen.ts, protocol.ts, index.ts, native/node/addon.cpp, native/node/index.mjs, scripts/build-node-addon.mjs, android/src/main/cpp/OnLoad.cpp, platform/ios/SelectableMarkdownModule.mm. Verify: the wire format field by field (doc vs Protocol.h vs decode.ts), ownership claims, span widening rules, decoder hot paths, the "Behaviours that look like bugs and are not" list, build instructions, "Using it in an app", "When nothing renders" troubleshooting. Report mismatches.` },
  { key: 'D10-perf-bench-docs', area: 'architecture-design', prompt: `Audit docs/PERFORMANCE.md and docs/BENCHMARKS.md against the code and bench harnesses. For every optimization claimed in PERFORMANCE.md section 2 (delta coalescing, lookahead-by-lag holdback, tail repair hardening, ASCII fast path in the offset map, decoder hot paths, Android spannable handoff and measure cache, iOS append-only attributed text) find the implementing code and confirm it exists and does what is described. Check section 1 "Where the time goes" numbers against bench/crossing.mjs output shape, section 3 "Attempted, and not done" and section 4 roadmap against what is in the tree (anything on the roadmap already done? anything described as done that is not?). For BENCHMARKS.md: do bench/*.mjs implement the described methodology, do the metrics and gates named exist, are the numbers internally consistent with README.md, is the "Running" section accurate (flags, --libs). You may run \`node bench/streaming-replay.mjs\`, \`node bench/throughput.mjs\` and \`node bench/crossing.mjs\` (not head-to-head) to spot-check output shape, not exact numbers.` },
  { key: 'D11-fabric-plan-doc', area: 'architecture-design', prompt: `Audit docs/FABRIC-PLAN.md against the shipped code; it is described as a design retrospective. Check: section 0 and 0.1 (verification status, "what the plan got wrong") vs the code; section 2 (dual-architecture strategy, 2.1 spec resolution order, 2.2 podspec, 2.3 Gradle, 2.4 layout, 2.5 supported RN range) vs package.json peer (>=0.82), react-native.config.js, SelectableMarkdown.podspec, android/build.gradle, android/CMakeLists.txt, android/src/main/jni/CMakeLists.txt (does any old-architecture path still exist? is dual-arch text stale?); section 3 (sparse attributes, colours in JS, no flattening) vs src/view/SelectableRunHostNativeComponent.ts and platform/fabric prop decoding; section 4 (measurement agreement, 4.4 "the one line that makes streaming viable") vs RNSMRunTextMeasurer on both platforms and RNSMRunHostShadowNode; section 5 selection; section 6 residual styling fixed/cut items vs code; section 7 file-by-file plan vs actual files; section 8 verification vs scripts/check-*.mjs and CI; section 9 risks. Report where the document and the code disagree and where it is stale enough to mislead a maintainer.` },
  { key: 'D12-jsdoc-api-comments', area: 'docs-general', prompt: `Audit the inline documentation (JSDoc and comments on exported types, props and functions) of the public API against behaviour. Enumerate exports from src/index.ts (it uses export * so list what each module exports), then read src/engine/options.ts, src/engine/Engine.ts, src/stream/StreamSession.ts (options and methods), src/stream/smoothing.ts, src/stream/repair.ts (RepairOptions), src/stream/placeholders.ts, src/view/SelectableMarkdown.tsx (props), src/view/RunHost.tsx (props), src/view/theme.ts, src/view/renderers.tsx, src/agui/bindRunTextEvents.ts (RunBindingPolicy), src/agui/useAgUiSession.ts, src/selection/*.ts, src/document/*.ts. Report doc comments that describe behaviour the code does not have, defaults that differ from the comment, comments referencing removed things, and exported public API that has no documentation anywhere (neither JSDoc nor README nor docs/) but a consumer needs.` },
  { key: 'D13-ops-docs-scripts', area: 'packaging-ci-tests', prompt: `Audit the operational docs and scripts: conformance/vendor/README.md, platform/cpp/vendor/md4c/UPSTREAM.md and patches/README.md, .github/workflows/ci.yml and release.yml (the long explanatory comments vs the actual steps), scripts/release.mjs, scripts/verify-pack.mjs, scripts/check-codegen.mjs, scripts/check-fabric-cpp.mjs, scripts/check-swift.mjs, scripts/emit-dist-spec-shim.mjs, jest.config.js, tsconfig.json, tsconfig.build.json, package.json (files, main/types/react-native fields, scripts, devDependencies vs peerDependencies: react-native 0.75.4 in devDependencies vs peer >=0.82; @types/react 18 vs react >=18). Do the described procedures match what the scripts do? Do CI comments match CI steps (e.g. comments citing suite counts like "19 of the 31" or "ten of twenty-six" vs the actual 32 suites)? Does the release script do what release.yml expects? Would \`npm pack\` include everything the podspec and gradle need (compare podspec source_files and android sourceSets against package.json files; run \`npm pack --dry-run\` from the repo root, it does not modify the tree, and read the file list)?` },

  // ---------------- gaps, bugs, improvements ----------------
  { key: 'G01-stream-session', area: 'streaming', prompt: `Deep-review src/stream/StreamSession.ts (and StreamSession.test.ts, buffering.test.ts) for correctness gaps, edge cases and performance problems on the streaming path. Cover: append/appendBuffered/flushBuffered/replace/rewrite/finalize/drained/notifyRunFinalized ordering and re-entrancy (a listener calling append during a notification); holdback and idle timers (leaks, timers firing after finalize or after the consumer drops the session, injectable schedulers); UTF-16 surrogate pairs and grapheme clusters split across deltas or across the holdback boundary; behaviour under React StrictMode double mount and unmount; the subscription API and memory; per-append cost (what work is proportional to the whole document rather than the delta: string concatenation, span shifting, node cloning, snapshot creation); error handling when the engine throws mid-stream; finalize reasons and what 'aborted' and 'failed' change. Prefer findings backed by a small repro you ran via \`npx jest\` (a scratch test file under the scratchpad with rootDir pointed at the repo, or a node script importing dist is NOT available; simplest is \`npx jest --rootDir ${REPO} <scratch test path>\` with the repo's jest config) over speculation.` },
  { key: 'G02-incremental-anchor', area: 'streaming', prompt: `Deep-review the incremental parsing design: the safe anchor and tail-only reparse in src/stream/StreamSession.ts and helpers, src/stream/shiftSpans.ts, src/stream/placeholders.ts, plus conformance/streaming/prefix-oracle.test.ts and src/stream/incremental.test.ts. Hunt for inputs where a later delta can legally change the parse of an already settled block: link reference definitions that arrive later, setext heading underlines, lazy continuation lines, list tightness changing when a later item gains a blank line, list item numbering or start, tables whose delimiter row arrives later, fenced code that never closes or closes with a longer fence, HTML blocks, blockquote laziness, indented code after a list, spoilers and underline extensions, math when enabled, a trailing backslash or two-space hard break, CRLF. Determine whether the anchor logic handles each and whether the prefix oracle's fixtures (conformance/fixtures) would catch a miss. Write scratch repros that feed prefixes through StreamSession and compare with a fresh parse (run with \`npx jest --rootDir ${REPO} <scratch test path>\`). Also assess the "construct-free fast path" for false positives: a delta the fast path accepts that actually changes the parse.` },
  { key: 'G03-tail-repair', area: 'streaming', prompt: `Deep-review src/stream/repair.ts (tail repair) and repair.test.ts. Enumerate the handlers. For each, look for false repairs (complete, legitimate text altered), missed cases that still flash (emphasis with underscores, nested emphasis, inline code with multiple backticks, links with titles, images, autolinks, strikethrough, spoilers, math when enabled, tables mid-row, ATX headings, setext underlines, thematic breaks vs list markers, fenced code with tildes, HTML), interaction with holdback, whether repair knows which extensions are enabled (an option-blind repair of \`~~\` or \`||\` when those extensions are off), the hideUriLikeLabels and hideBareUriSchemes behaviour, and the cost per delta (is repair O(tail) or O(document)? how is the tail located?). Back claims with repros: a scratch jest test run with \`npx jest --rootDir ${REPO} <scratch test path>\`.` },
  { key: 'G04-smoothing-agui', area: 'agui', prompt: `Deep-review src/stream/smoothing.ts, src/agui/useAgUiSession.ts, src/agui/bindRunTextEvents.ts and their tests. Smoothers: createSmoother and createAdaptiveSmoother contracts, boundary handling ('word' boundaries with CJK or Thai text that has no spaces, surrogate pairs, markdown syntax boundaries such as releasing half of \`**\`), lag targets, the run-end drain deadline, timer leaks, behaviour when the app is backgrounded (timers paused, then a burst), whether rewrite() during smoothing is sound, and whether a smoother can starve (never drain) or overshoot. ag-ui: the structural event types accepted vs the ag-ui protocol (TEXT_MESSAGE_START/CONTENT/END, RUN_STARTED/FINISHED/ERROR, and also TEXT_MESSAGE_CHUNK, MESSAGES_SNAPSHOT, STATE_SNAPSHOT/DELTA, RAW, CUSTOM, STEP_*), hook lifecycle (session creation per messageId, cleanup on unmount, StrictMode double invoke, messageId change mid-stream, events object identity changing), RunBindingPolicy semantics, and the correctness of 'holding'. Report gaps and bugs with evidence.` },
  { key: 'G05-selection-mapping', area: 'selection', prompt: `Deep-review cross-block selection correctness in src/selection/runs.ts, src/selection/mapSelection.ts, src/selection/copy.ts, their tests under src/selection/__tests__, and conformance/selection/projection-oracle.test.ts. Focus: mapping display offsets back to source across block boundaries (paragraph to list to code block to table to rule and back); glyphs (bullets, task markers, ordered numbering, nested indentation); entity and escape decoding (\`&amp;\`, \`\\\\*\`, numeric entities) where one source char count differs from display; smart punctuation; soft and hard line breaks; code fences (fence lines and info strings excluded from display but included in copy-markdown?); tables (cell separators, delimiter row, alignment, escaped pipes); nested lists and blockquotes; embeds (the placeholder char); surrogate pairs and combining marks at selection edges; selections that start or end inside syntax (inside \`**\` or a link's URL); selection spanning a standalone block boundary; whether copy-markdown yields sensible markdown when the selection starts mid-list-item or mid-table-row. Also performance: is projection recomputed for every run on every stream frame, and is any of it O(document) per token? Run the existing property tests and write scratch repros (\`npx jest --rootDir ${REPO} <scratch test path>\`).` },
  { key: 'G06-view-layer', area: 'view', prompt: `Deep-review src/view/SelectableMarkdown.tsx, src/view/RunHost.tsx and src/view/renderers.tsx for gaps and React-level performance under streaming. Trace what re-renders per streamed frame: are settled runs memoized and how (React.memo? useMemo keyed on what?), are keys stable across resegmentation, do attribute/decoration/pressable/embed arrays get rebuilt and re-sent to native every frame for the whole document or only the changing run, does the tail get its own host and what happens at run boundaries (a new paragraph appended: is the previous run's native view retained or remounted?), behaviour inside FlatList/virtualized lists and with very long documents, error boundaries and missing-engine behaviour, prop identity footguns (theme/options/renderers/embed/classifyBlock objects created inline), accessibility (accessibilityRole, screen readers on the native host, dynamic type), RTL, the tail policy (what does an unsettled tail render as while a code block or table is open?), image handling, link press, standalone renderer coverage (every node kind rendered? what does an unknown kind render?), and the session prop (switching sessions, subscribing/unsubscribing, setState per flush vs useSyncExternalStore). Report concrete gaps with file:line.` },
  { key: 'G07-attributes-theme', area: 'view', prompt: `Deep-review src/view/runAttributes.ts, runDecorations.ts, runPressables.ts, runEmbeds.ts, theme.ts, selectionActions.ts and their tests. Questions: are attributes emitted as sparse ranges or per character; are overlapping marks (bold inside link inside heading, code inside a link) merged correctly and deterministically; decoration geometry for code blocks, tables and rules across line wraps and at run ends; theme merge depth and whether nested groups (headings per level, table borders, code font) can be partially overridden without clobbering; colorScheme 'auto' reactivity (Appearance listener or useColorScheme?); font scaling (allowFontScaling, maxFontSizeMultiplier); lineHeight semantics (multiplier vs px) consistency between JS, iOS and Android; attributeForMark memo correctness and cache growth; per-frame cost of rebuilding attributes for long runs; selection action ids and localisation of 'Copy Text' / 'Copy Markdown' labels; the color format sent to native (processColor?). Report gaps with evidence.` },
  { key: 'G08-ios-host', area: 'native-ios', prompt: `Deep-review the iOS host: platform/ios/SelectableRunHostView.swift, RNSMAttributedText.mm, RNSMAttributedText+Props.h, RNSMTextKitStack.mm, SelectableMarkdownModule.mm, platform/ios/fabric/RCTSelectableRunHostComponentView.mm, platform/ios/fabric/RNSMRunTextMeasurer.mm and the shared shadow node in platform/fabric. Focus: selection preservation across text swaps (does it survive attribute-only changes; does it clamp correctly when text shrinks on rewrite; does it survive view recycling; what about the selection handles and the edit menu during a swap); the append-only attributed text path (when taken; can it leave stale attributes when a mark spanning the boundary changes, e.g. \`**bold\` completing, or a heading's setext underline arriving); measurement agreement between the measurer used by Yoga and the UITextView layout (font fallback, emoji, line spacing, paragraph spacing, exclusion paths for embeds, width rounding, textContainerInset); main-thread cost per frame (relayout of the whole text storage per delta? any layout caching?); TextKit 1 vs 2 selection and iOS version gating; UIEditMenuInteraction vs UIMenuController paths and the iOS 13.4 to 15 behaviour; link taps vs selection gesture conflict; embed overlay hit testing and layout reporting timing; retain cycles; thread safety of props into the text storage; accessibility; dynamic type. Report concrete gaps with file:line.` },
  { key: 'G09-android-host', area: 'native-android', prompt: `Deep-review the Android host: android/src/main/java/com/selectablemarkdown/*.kt (SelectableRunHostView, SelectableRunHostViewManager, RunAttributedText, RunDecorations, RunEmbeds, RunLayoutCache, RunTextMeasure, the event classes, SelectableMarkdownModule, SelectableMarkdownPackage), android/src/main/jni/RNSMRunTextMeasurer.cpp, android/src/main/cpp/OnLoad.cpp, both CMakeLists.txt, android/build.gradle, and the Fabric state/measure path in platform/fabric. Focus: the selection loss on each text swap (what exactly drops it; what a fix would require: setText vs in-place Editable edits, Selection.setSelection restore, ActionMode survival); layout cache keys and invalidation correctness (width, density, font scale, theme change, text change); measurement agreement between the JNI measurer and TextView layout (StaticLayout params, hyphenation, break strategy, includeFontPadding, fallback fonts, emoji); the spannable handoff (built on which thread, cost per frame for long runs); ActionMode / copy menu customisation parity with iOS; link and embed touch handling; view recycling resets (prepareForRecycle equivalent); threading (state updates from the shadow thread vs UI thread); leaks; accessibility; minSdk and API level gating. Report concrete gaps with file:line.` },
  { key: 'G10-cpp-jsi', area: 'native-cpp-engine', prompt: `Deep-review platform/cpp/OffsetParser.cpp/.h, FlatBuffer.cpp, SelectableMarkdownJsi.cpp/.h, Protocol.h, native/node/addon.cpp, src/engine/native/decode.ts, widen.ts, install.ts, protocol.ts, index.ts and the tests under src/engine/native/__tests__. Focus: UTF-8 byte to UTF-16 offset mapping correctness (astral characters, invalid UTF-8, BOM, CRLF, lone surrogates in the JS source: how is the JS string converted to UTF-8 and back, is the round trip lossless?); md4c callback coverage (every MD_BLOCKTYPE and MD_SPANTYPE handled? every MD_TEXTTYPE: entities, nullchar, softbr, br, html, latexmath); buffer growth and integer overflow on large input; error paths (md_parse returning non-zero, allocation failure); ownership and lifetime of the ArrayBuffer returned to JS; thread affinity of the JSI host function (can it be called from a worklet or a background thread?); the JavaScriptCore refusal rationale; config and option encoding (does every EngineOptions field reach md4c? what md4c flags are not exposed: MD_FLAG_PERMISSIVEURLAUTOLINKS, PERMISSIVEWWWAUTOLINKS, LATEXMATHSPANS, WIKILINKS, HARD_SOFT_BREAKS, NOINDENTEDCODEBLOCKS, NOHTMLBLOCKS vs NOHTMLSPANS); the vendored md4c patches under platform/cpp/vendor/md4c/patches (applied? documented?); decode.ts hot path allocations. Write scratch repros against the addon (native/node/index.mjs) where possible. Report concrete gaps with file:line.` },
  { key: 'G11-engine-options-policy', area: 'engine-options', prompt: `Deep-review src/engine/options.ts, urlPolicy.ts, entities.ts, extensions/spoilers.ts, Engine.ts, native.ts, document/nodes.ts, document/visit.ts, document/span.ts and their tests. Focus: URL policy holes (scheme case-insensitivity, leading whitespace or control characters, \`javascript&colon;\` and other entity-encoded forms as md4c delivers them, protocol-relative //, data: images, IDN and unicode, percent-encoded schemes, whether the policy is applied equally to autolinks, reference links, images and to mailto: with header parameters); html:'strip' semantics (is inline HTML removed or shown as text? does stripping preserve spans?); entity decoding vs the CommonMark entity table; the spoilers extension (nested, across emphasis, streaming with unbalanced ||, interaction with tables where | is a separator); node model completeness (node kinds without a renderer or a projection rule; footnotes, wikilinks, math node shapes); visit() API ergonomics; preset composition. Write scratch repros with the addon where helpful. Report concrete gaps.` },
  { key: 'G12-tests-ci', area: 'packaging-ci-tests', prompt: `Assess test coverage and CI for gaps relative to the goals (streaming performance, cross-block selection). Read jest.config.js, the test file list under src/ and conformance/, .github/workflows/ci.yml, scripts/check-codegen.mjs, check-fabric-cpp.mjs, check-swift.mjs. Identify: subsystems with no automated tests (React components, native iOS/Android behaviour beyond compile checks, JSI install path, ag-ui hooks under React), property tests present vs missing, whether the prefix oracle covers the extension options and the repair options and holdback combinations, whether any performance regression gate exists, whether the check-* scripts exercise the real code or only compile stubs, the devDependency react-native 0.75.4 vs peer >=0.82 (what does jest test against, what codegen version does check-codegen run, does the shipped spec depend on 0.82 behaviour?), and flaky or skipped tests. Run \`npx jest --listTests\` and \`npx jest\` and report the actual pass/skip state (note the stack trace printed from src/engine/native/__tests__/hostBinding.test.ts:152 during a passing run: what is it?). Report concrete gaps.` },
  { key: 'G13-packaging-build', area: 'packaging-ci-tests', prompt: `Assess packaging, build and consumer-integration gaps: package.json (files, main/types/react-native fields, absence of an exports map, sideEffects, prepare/prepack running tsc during a consumer's git install, engines), SelectableMarkdown.podspec (source_files, dependencies, install_modules_dependencies, new-arch flags, Swift and ObjC++ mixing, module map, header search paths, the platform/fabric/android-include exclusion), android/build.gradle and both CMakeLists.txt (RN version detection, prefab targets, namespace, minSdk, Kotlin version, codegen output dir, ABI filters), react-native.config.js, the codegenConfig (jsSrcsDir src/view: does codegen also try to parse non-spec files there?), scripts/emit-dist-spec-shim.mjs (what the dist spec shim is for), scripts/verify-pack.mjs, scripts/release.mjs and .github/workflows/release.yml. Check whether shipping TS via the react-native field while main points at dist is consistent for Metro, Expo and type resolution, and whether Expo config plugin needs exist. Run \`npm pack --dry-run\` (read-only) to inspect the file list. Report concrete gaps with file:line.` },
  { key: 'G14-perf-architecture', area: 'architecture-design', prompt: `Cross-cutting performance review against the goal "performant markdown renderer from streaming". Trace one streamed delta end to end: StreamSession.append (src/stream/StreamSession.ts) to engine parse (JSI crossing in src/engine/native/index.ts and platform/cpp/SelectableMarkdownJsi.cpp, FlatBuffer decode in src/engine/native/decode.ts) to document settle/diff to selection runs and projection (src/selection/runs.ts) to attributes/decorations/pressables/embeds (src/view/run*.ts) to React render (src/view/SelectableMarkdown.tsx, RunHost.tsx) to native props (src/view/SelectableRunHostNativeComponent.ts, platform/fabric props parsing and RNSMRunHostShadowNode) to shadow-node measure (RNSMRunTextMeasurer on both platforms) to the native view update (platform/ios/RNSMAttributedText.mm, SelectableRunHostView.swift; android RunAttributedText.kt, RunLayoutCache.kt). For each stage state what is proportional to the delta and what is proportional to the whole document or the whole tail run, with file:line evidence. Identify the largest wins not taken and design alternatives (per-run hosts so settled runs are never re-sent; sending deltas instead of full attribute arrays; a native-side projection; measure caching keyed on the settled prefix; avoiding double layout for measure and display; batching to frames; state-based commits vs props). Compare with how software-mansion/enriched-markdown, Expensify/react-native-live-markdown and vercel/streamdown approach the same problem where relevant (from your knowledge; do not fetch). Evaluate docs/PERFORMANCE.md's roadmap order against your analysis. Report as findings (category gap or improvement) with concrete evidence.` },
  { key: 'G15-selection-architecture', area: 'architecture-design', prompt: `Cross-cutting design review against the goal "cross paragraph selection". Evaluate the chosen architecture (one native text view per run; adjacent flowing blocks merged into a run; standalone blocks break runs) using src/selection/runs.ts, src/view/SelectableMarkdown.tsx, RunHost.tsx and the iOS and Android hosts. Assess: what still breaks selection continuity (images, spoilers, standalone-classified blocks, embeds, the streaming tail) and whether that is acceptable for a chat UI; behaviour with very long messages (one huge native text view: layout cost, memory, no virtualization, scroll performance); selection across multiple runs or across multiple messages in a chat list (is there any story for selecting across two SelectableMarkdown instances, as a document would allow?); selection during streaming (is the tail a separate run/host from the settled runs, and does that break selecting across the boundary? does selection survive the tail settling into a run?); copy-menu customisation limits (iOS 16+, Android ActionMode); hardware keyboard selection; accessibility. Propose concrete alternative designs with trade-offs (a single host for the whole document with block chrome as decorations; images and embeds via exclusion paths or attachments so they no longer split runs; a native-driven selection overlay spanning multiple views; Android in-place Editable updates). Report as findings (category gap or improvement) with evidence.` },
  { key: 'G16-api-dx', area: 'architecture-design', prompt: `Review the public API surface and developer experience. Read src/index.ts (it re-exports whole modules with export *: enumerate what leaks that looks internal), the props of SelectableMarkdown (src/view/SelectableMarkdown.tsx) and RunHost, StreamSession's API, the option and preset shapes (src/engine/options.ts), theme types, renderer override types (src/view/renderers.tsx), embed and classifyBlock contracts, event payloads. Look for: footguns (paired props; identity requirements for memoization; options that must be annotated to typecheck, as the README admits for blockedLinks: 'node'; a session that must be finalized to free timers), inconsistent naming, unclear defaults, missing escape hatches (custom selection actions beyond copy; controlled or programmatic selection; scroll-to-source-span; getting the display text; an imperative ref API; per-block renderers for flowing blocks), error messages when misused, TypeScript strictness (any, unsound casts, non-exhaustive switches), and API stability concerns for 0.11. Write a scratch consumer .tsx under the scratchpad and typecheck it against the package src to confirm any typing claim. Report concrete findings with file:line.` },
  { key: 'G17-security-robustness', area: 'engine-options', prompt: `Robustness and security review for untrusted model output. Read bench/pathological.mjs, src/engine/urlPolicy.ts, options.ts, src/stream/repair.ts, src/selection/runs.ts, platform/cpp/*.cpp and the native hosts. Look for: parser CPU blowups (md4c pathological cases: deeply nested brackets or emphasis, long runs of [, huge tables, many link reference definitions, pathological code spans) and whether anything bounds input size or nesting; JS-side quadratic paths in repair, runs, projection or attribute building on adversarial input (thousands of tiny blocks, a 1 MB single paragraph, a 100k-row table, a 10k-deep list); native crash vectors (out-of-range NSRange or Java index with emoji, flags, ZWJ sequences; negative lengths; attribute ranges beyond text length; decoration rects with NaN; embed sizes of 0 or Infinity; invalid UTF-8 from a JS string containing lone surrogates); URL policy bypasses; html:'raw' implications; memory growth in long sessions (caches without bounds: RunLayoutCache, iOS caches, JS memo maps, the repair corpus?). Write scratch repros against the addon (native/node/index.mjs) or via \`npx jest --rootDir ${REPO} <scratch test path>\` where feasible, with timing. Report concrete findings.` },
]

function finderPrompt(f, extra) {
  return `${PREAMBLE}\n\n## Your assignment (${f.key}; default area: ${f.area})\n${f.prompt}\n${extra || ''}\n${FINDER_OUTPUT_RULES}`
}

function mergePrompt(area, items) {
  return `${PREAMBLE}\n\n## Task\nYou are deduplicating review findings for the "${area}" area. Below are ${items.length} findings from several independent finders (JSON, each with an integer id). Merge findings that describe the same underlying issue (the same doc claim against the same code behaviour, or the same defect) into one, keeping the most precise refs, the strongest evidence from any duplicate, and the union of source_ids. Do NOT merge findings that share a file but describe different issues. Do not drop non-duplicates. Do not add new findings. Do not re-verify (that happens next). Keep severity as the maximum among merged duplicates. Output every surviving finding with all fields filled.\n\n\`\`\`json\n${JSON.stringify(items, null, 1)}\n\`\`\``
}

function factPrompt(f) {
  return `${PREAMBLE}\n\n## Task: adversarial fact-check of one finding\nYour default is to refute. Open every referenced file and line (and the doc section, if any). Confirm only if you can quote the code (and the doc) that establishes the claim as stated. Refute if: the code actually behaves as the doc says; the doc actually says something else, or already documents the gap the finding presents as undocumented; the refs are wrong and you cannot locate the behaviour elsewhere; the finding rests on an assumption you could not verify; or the finding misattributes behaviour outside this repo's control. For docs-vs-impl findings, quote both sides. If it is partially right, set confirmed=true only if the core claim stands, and fill the corrected_* fields for the parts that were wrong (leave them empty strings when accurate). For behaviour claims that a test can settle, run \`npx jest <path>\` or a scratch test (\`npx jest --rootDir ${REPO} <scratch test path>\`) or a node script against the addon (native/node/index.mjs); a repro beats reading. Category "improvement" findings: confirm only if the description of the current design is accurate and the proposed alternative is technically coherent for React Native Fabric.\n\n\`\`\`json\n${JSON.stringify(f, null, 1)}\n\`\`\``
}

function matPrompt(f) {
  return `${PREAMBLE}\n\n## Task: judge whether one (already fact-checked) finding matters\nRead the referenced files enough to judge impact; do not re-verify facts. Decide:\n- matters=false if it is a style nitpick, a hypothetical with no realistic trigger, advice that contradicts a deliberate documented decision without a stronger argument, or a restatement of something the docs already admit with nothing added (then also set already_documented=true).\n- severity: high = a user following the docs gets a wrong integration, a real bug, or a performance cliff on the streaming or selection path; medium = wrong or missing information a maintainer should fix, or a real gap with a workaround; low = minor drift.\n- effort: small (under an hour), medium (about a day), large (multi-day or a design change).\n- sharpened_recommendation: the most specific actionable fix in at most three sentences, naming files.\n\n\`\`\`json\n${JSON.stringify(f, null, 1)}\n\`\`\``
}

function criticPrompt(confirmed, minor, rejected, coverage) {
  const line = (f) => `- [${f.id}] (${f.category}/${f.area}/${f.severity}) ${f.title} — ${f.code_ref}`
  return `${PREAMBLE}\n\n## Task: completeness critic\nA review of this library ran ${finders.length} finders, each with an assignment:\n${finders.map(f => `- ${f.key} (${f.area}): ${f.prompt.slice(0, 220).replace(/\n/g, ' ')}...`).join('\n')}\n\nAfter adversarial verification there are ${confirmed.length} confirmed findings:\n${confirmed.map(line).join('\n')}\n\n${minor.length} confirmed-but-minor findings:\n${minor.map(line).join('\n')}\n\n${rejected.length} rejected findings (titles only):\n${rejected.map(f => `- ${f.title}`).join('\n')}\n\nFinder coverage notes:\n${coverage.map(c => `- ${c.key}: ${c.notes}`).join('\n')}\n\nAsk: what is missing? Which subsystems, files, doc sections or failure modes did no finder examine, or examined superficially (use the coverage notes)? Which confirmed findings hint at a larger class of issue that was not enumerated? Which cross-cutting questions are unaddressed (for example: Unicode handling end to end across JS, C++, Swift and Kotlin; long-session memory; RN version compatibility 0.82+ specifics; Expo integration; web platform; the TypeScript declaration output in dist; the release process; docs sections nobody audited)? Spot-check the repo yourself where it helps. Propose up to 8 targeted follow-up finder assignments, each with a concrete file list and specific questions, non-overlapping with what is already confirmed. If coverage is genuinely complete, return an empty followups list and say why.`
}

function synthPrompt(confirmed) {
  return `${PREAMBLE}\n\n## Task: synthesize verified findings into a prioritized structure\nInput: the confirmed findings (JSON) of a review of this library. Produce:\n- executive_summary: at most 220 words, plain and specific, no hype. Say what the library gets right, then the main problems, grouped by docs-vs-implementation, gaps, and design improvements.\n- headline_ids: the 8 to 12 finding ids in priority order, weighing severity, how directly it affects streaming performance or cross-block selection, and how badly the docs mislead.\n- themes: 4 to 8 themes, each with a 2 to 5 sentence narrative and member finding_ids. Every confirmed finding belongs to exactly one theme.\n- quick_wins: ids fixable in under an hour each.\n- docs_fix_list: every docs-vs-impl id.\n- scope_notes: anything the review could not establish (device behaviour, etc).\nRefer only to the given ids; invent nothing. Write plainly: short sentences, no em-dashes, no marketing language.\n\n\`\`\`json\n${JSON.stringify(confirmed.map(f => ({ id: f.id, title: f.title, category: f.category, area: f.area, severity: f.severity, effort: f.effort, doc_ref: f.doc_ref, code_ref: f.code_ref, claim: f.claim, reality: f.reality, recommendation: f.recommendation })), null, 1)}\n\`\`\``
}

// ---------------- verification of one finding ----------------
async function verifyOne(f) {
  const fact = await agent(factPrompt(f), { label: `fact:${f.id}`, phase: 'Verify', schema: FACT_SCHEMA, effort: 'high' })
  if (!fact) return { ...f, status: 'unverified', fact: null, mat: null }
  if (!fact.confirmed) return { ...f, status: 'rejected', fact, mat: null }
  const corrected = {
    ...f,
    title: fact.corrected_title || f.title,
    code_ref: fact.corrected_code_ref || f.code_ref,
    doc_ref: fact.corrected_doc_ref || f.doc_ref,
    reality: fact.corrected_reality || f.reality,
  }
  const mat = await agent(matPrompt(corrected), { label: `impact:${f.id}`, phase: 'Verify', schema: MAT_SCHEMA })
  if (!mat) return { ...corrected, status: 'confirmed', fact, mat: null, effort: 'medium' }
  return {
    ...corrected,
    status: mat.matters ? 'confirmed' : 'minor',
    severity: mat.severity,
    effort: mat.effort,
    already_documented: mat.already_documented,
    recommendation: mat.sharpened_recommendation || corrected.recommendation,
    fact,
    mat,
  }
}

function classify(list, confirmed, minor, rejected, unverified) {
  for (const r of list) {
    if (!r) continue
    if (r.status === 'confirmed') confirmed.push(r)
    else if (r.status === 'minor') minor.push(r)
    else if (r.status === 'rejected') rejected.push(r)
    else unverified.push(r)
  }
}

// ---------------- Phase 1: find ----------------
phase('Find')
log(`Launching ${finders.length} finders`)
const raw = await parallel(finders.map(f => () =>
  agent(finderPrompt(f), { label: `find:${f.key}`, phase: 'Find', schema: FINDINGS_SCHEMA })
    .then(r => (r ? { ...r, key: f.key } : null))))
const finderResults = raw.filter(Boolean)
const missingFinders = finders.filter((f, i) => !raw[i]).map(f => f.key)
if (missingFinders.length) log(`Finders that returned nothing: ${missingFinders.join(', ')}`)

let nextId = 1
const all = []
for (const r of finderResults) for (const f of r.findings || []) all.push({ ...f, id: nextId++, finder: r.key })
log(`${all.length} raw findings from ${finderResults.length}/${finders.length} finders`)

const byArea = {}
for (const f of all) {
  const a = AREAS.includes(f.area) ? f.area : 'architecture-design'
  if (!byArea[a]) byArea[a] = []
  byArea[a].push(f)
}
const areaKeys = Object.keys(byArea).filter(a => byArea[a].length > 0)
log(`Areas: ${areaKeys.map(a => `${a}=${byArea[a].length}`).join(', ')}`)

// ---------------- Phase 2+3: merge per area, then verify each merged finding ----------------
const verifiedPerArea = await pipeline(areaKeys,
  async (area) => {
    const items = byArea[area]
    if (items.length <= 1) return { area, merged: items.map(f => ({ ...f, id: `${area}-1`, source_ids: [f.id] })) }
    const r = await agent(mergePrompt(area, items), { label: `merge:${area}`, phase: 'Merge', schema: MERGED_SCHEMA })
    if (!r || !r.merged) return { area, merged: items.map((f, i) => ({ ...f, id: `${area}-${i + 1}`, source_ids: [f.id] })) }
    log(`merge:${area}: ${items.length} -> ${r.merged.length}`)
    return { area, merged: r.merged.map((m, i) => ({ ...m, area, id: `${area}-${i + 1}` })) }
  },
  async (m) => {
    const results = await parallel(m.merged.map(f => () => verifyOne(f)))
    return results.filter(Boolean)
  })

const confirmed = [], minor = [], rejected = [], unverified = []
for (const list of verifiedPerArea) if (list) classify(list, confirmed, minor, rejected, unverified)
log(`Round 0: ${confirmed.length} confirmed, ${minor.length} minor, ${rejected.length} rejected, ${unverified.length} unverified`)

// ---------------- Phase 4: completeness critic, up to 2 follow-up rounds ----------------
phase('Critic')
const coverage = finderResults.map(r => ({ key: r.key, notes: (r.coverage_notes || '').slice(0, 600) }))
const criticNotes = []
let round = 0
let critic = await agent(criticPrompt(confirmed, minor, rejected, coverage), { label: 'critic:1', phase: 'Critic', schema: CRITIC_SCHEMA })
if (critic) criticNotes.push(critic.assessment)
let followups = critic && critic.followups ? critic.followups.slice(0, 8) : []
while (followups.length && round < 2) {
  round++
  log(`Critic round ${round}: ${followups.length} follow-up finders`)
  const seenTitles = [...confirmed, ...minor, ...rejected].map(f => `- ${f.title}`).join('\n')
  const extraRaw = await parallel(followups.map(f => () =>
    agent(finderPrompt({ key: f.key, area: f.area, prompt: f.prompt }, `\nAlready reported by earlier finders (do not repeat these; add only what is new):\n${seenTitles}\n`), { label: `find${round + 1}:${f.key}`, phase: 'Critic', schema: FINDINGS_SCHEMA })
      .then(r => (r ? { ...r, key: f.key } : null))))
  const extra = []
  for (const r of extraRaw.filter(Boolean)) {
    coverage.push({ key: r.key, notes: (r.coverage_notes || '').slice(0, 600) })
    for (const f of r.findings || []) extra.push({ ...f, id: `r${round}-${nextId++}`, finder: r.key, source_ids: [] })
  }
  log(`Critic round ${round}: ${extra.length} new candidate findings`)
  const verifiedExtra = await parallel(extra.map(f => () => verifyOne(f)))
  const before = confirmed.length
  classify(verifiedExtra, confirmed, minor, rejected, unverified)
  const gained = confirmed.length - before
  log(`Critic round ${round}: +${gained} confirmed (${confirmed.length} total)`)
  if (gained === 0 || round >= 2) break
  critic = await agent(criticPrompt(confirmed, minor, rejected, coverage), { label: `critic:${round + 1}`, phase: 'Critic', schema: CRITIC_SCHEMA })
  if (critic) criticNotes.push(critic.assessment)
  followups = critic && critic.followups ? critic.followups.slice(0, 6) : []
}

// ---------------- Phase 5: synthesize ----------------
phase('Synthesize')
const synth = confirmed.length ? await agent(synthPrompt(confirmed), { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA }) : null

const strip = (f) => ({
  id: f.id, title: f.title, category: f.category, area: f.area, severity: f.severity, effort: f.effort,
  already_documented: f.already_documented === true, doc_ref: f.doc_ref, code_ref: f.code_ref,
  claim: f.claim, reality: f.reality, recommendation: f.recommendation, evidence: f.evidence,
  finder: f.finder, source_ids: f.source_ids, fact_confidence: f.fact ? f.fact.confidence : null,
  fact_reasoning: f.fact ? f.fact.reasoning : null, impact_rationale: f.mat ? f.mat.rationale : null,
})

return {
  stats: {
    finders: finders.length, findersReturned: finderResults.length, rawFindings: all.length,
    confirmed: confirmed.length, minor: minor.length, rejected: rejected.length, unverified: unverified.length,
    criticRounds: round,
  },
  synthesis: synth,
  confirmed: confirmed.map(strip),
  minor: minor.map(strip),
  rejected: rejected.map(f => ({ id: f.id, title: f.title, area: f.area, reason: f.fact ? f.fact.reasoning.slice(0, 400) : '' })),
  unverified: unverified.map(f => ({ id: f.id, title: f.title })),
  criticNotes,
  coverage,
}