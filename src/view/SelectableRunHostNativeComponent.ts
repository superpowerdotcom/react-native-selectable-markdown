// `React.ElementRef<…>` is the shape codegen demands of a command's first
// parameter, and it checks the AST for that exact qualified name
// (@react-native/codegen/…/typescript/components/commands.js:20-40) — a bare
// `ElementRef` import would parse as TypeScript and be rejected by the
// generator. A namespace type import is the one spelling that satisfies both
// and still erases completely.
import type * as React from 'react';
import type {
  HostComponent,
  ProcessedColorValue,
  ViewProps,
} from 'react-native';
import type {
  DirectEventHandler,
  Float,
  Int32,
  WithDefault,
} from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeCommands from 'react-native/Libraries/Utilities/codegenNativeCommands';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

/**
 * The codegen spec for the native selection host.
 *
 * WHY THIS FILE EXISTS. It is the single declaration of the JS ↔ native prop
 * and event contract, and it serves *both* architectures. The babel plugin
 * rewrites the default export below into
 * `NativeComponentRegistry.get('SelectableRunHost', () => __INTERNAL_VIEW_CONFIG)`,
 * and `NativeComponentRegistry` resolves `getNativeComponentAttributes(name)`
 * first on paper and the static config first under bridgeless
 * (Libraries/NativeComponent/NativeComponentRegistry.js:52-72). So this one
 * file replaces `requireNativeComponent('SelectableRunHost')` on the old
 * architecture and supplies the Fabric view config on the new one; there is no
 * second declaration to keep in sync, and no `#ifdef` in JS.
 *
 * It is also the only compile-time link between this TypeScript and the native
 * setters: on Android the generated `SelectableRunHostManagerInterface` is
 * implemented by the Kotlin ViewManager, and on iOS the generated
 * `SelectableRunHostProps` is what the shadow node reads. A field renamed here
 * without a native counterpart is a build failure on both platforms rather
 * than a prop that silently stops arriving.
 *
 * THE FLOW RUNS BOTH WAYS. Props and events are JS → native and native → JS;
 * `Commands` at the bottom of this file is the third direction — JS telling
 * one mounted host to do something now (`clearSelection`, `setSelection`).
 * Commands are generated from the same schema and carry the same compile-time
 * link: the Android interface gains a method the Kotlin ViewManager must
 * implement, and iOS gains `RCTSelectableRunHostViewProtocol` plus the
 * `RCTSelectableRunHostHandleCommand` dispatcher, which the component view
 * conforms to and calls.
 *
 * THIS FILE MUST REACH METRO UNTRANSPILED, AND THE FAILURE IF IT DOES NOT IS
 * SILENT. `@react-native/babel-plugin-codegen` rewrites the default export only
 * when it sees an `ExportDefaultDeclaration` whose callee is
 * `codegenNativeComponent` (index.js:61-95 for the shape test, :161-165 for the
 * visitor). `tsc` emits CommonJS — `exports.default = ...` — which is an
 * `ExpressionStatement`, so the visitor never matches, no
 * `__INTERNAL_VIEW_CONFIG` is emitted, and the default export stays the runtime
 * `codegenNativeComponent`, which returns `requireNativeComponent`
 * (Libraries/Utilities/codegenNativeComponent.js:67-70). Under bridgeless that
 * is dead: `requireNativeComponent` reads its config through
 * `UIManager.getViewManagerConfig`, which soft-errors and returns null
 * (BridgelessUIManager.js:273-291). The component never resolves, so `RunHost`
 * finds no native host and throws at render — every run, on exactly the
 * architecture this component was ported for. The only signal before that
 * throw is a `console.warn` under `__DEV__` (codegenNativeComponent.js:38-43)
 * — nothing at all in a release build. Build-time codegen is equally blind
 * to a transpiled copy:
 * `combine-js-to-schema.js:81-85` parses a file only if its source text matches
 * `/export\s+default\s+\(?codegenNativeComponent</`, which erased type
 * arguments do not. Three things hold the line, and all three are load-bearing:
 *   1. `package.json` has `"react-native": "src/index.ts"`, which Metro
 *      prefers (`resolverMainFields` is `['react-native','browser','main']`);
 *   2. `tsconfig.build.json` excludes this file from emit, so no transpiled
 *      copy exists in `dist/` to be resolved by a bundler that does not honour
 *      that field. The exclusion only holds while nothing in the built graph
 *      *imports* this module: `exclude` filters the include glob, not the
 *      import graph, so a static import — `import type` included — puts the
 *      transpiled copy straight back. Anything that is built must therefore
 *      reach this module through a call-expression `require`, which tsc does
 *      not follow, and `check:codegen` asserts the emitted output rather than
 *      the exclude list;
 *   3. `scripts/verify-pack.mjs` asserts the packed tarball ships this file
 *      with `codegenNativeComponent<` intact.
 *
 * `scripts/check-codegen.mjs` (`npm run check:codegen`) runs the real codegen
 * pipeline over this file and asserts the generated C++ still has the
 * properties the native side depends on. Every "codegen does X" claim in the
 * comments below is asserted there, so a React Native upgrade that changes the
 * output shape fails a script instead of a device.
 */

/**
 * One styled range over `text`, mirroring `RunTextAttribute` in
 * `./runAttributes` with its colours already through `processColor`.
 *
 * ABSENCE IS ENCODED AS A SENTINEL, NOT AS `std::optional`. Codegen emits a
 * plain struct with brace-initialised members — nothing in `CppHelpers.js`'s
 * `getNativeTypeFromAnnotation` reads `prop.optional`, and no `std::optional`
 * is ever emitted — but the generated `fromRawValue` assigns a member only
 * when the key is present in the incoming map:
 *
 *     auto tmp_fontFamily = map.find("fontFamily");
 *     if (tmp_fontFamily != map.end()) {
 *       fromRawValue(context, tmp_fontFamily->second, result.fontFamily);
 *     }
 *
 * So sparseness survives the wire — an omitted key leaves the default in place
 * — and every field here has a default that cannot collide with a real value:
 * `""` for a family/weight/style/decoration or a semantic role, `0.0` for a
 * font size or line height (a 0pt one of either is meaningless), `0` for a
 * role level (level 0 is not a heading level), and for colours
 * `SharedColor`'s undefined value, whose `operator bool()` *is* the is-set
 * test (react/renderer/graphics/Color.h:48-50).
 *
 * TWO SHAPES ARE THEREFORE BANNED FROM THIS STRUCT. Both were confirmed by
 * running codegen, and both are the kind of mistake that looks obviously fine
 * in a diff:
 *
 *   - **No optional booleans.** `false` is a legal value, so no sentinel
 *     exists. A probe spec with `bolded?: boolean` in this struct generates
 *     `bool bolded{false};`, which means every entry that omits the key reads
 *     as an explicit false. The symptom is an iOS-only styling bug — Android
 *     reads `props->rawProps` and its `hasKey` parsing is immune — that no
 *     test in this repository can see.
 *
 *   - **No string enums nested in an array element.** `generateEnumString`
 *     (GeneratePropsH.js:304-341) declares an `enum class` for a top-level
 *     string-union prop and recurses into a top-level *object* prop, but never
 *     into the element type of an array. Running codegen over this very spec
 *     with `fontWeight?: WithDefault<'400' | '700', '400'>` emitted, verbatim,
 *     `SelectableRunHostFontWeight fontWeight{SelectableRunHostFontWeight::400};`
 *     — a type declared nowhere in the generated output, initialised with
 *     something that is not even a valid C++ identifier. It does not compile,
 *     and `check:codegen` reproduces the failure. `fontWeight`, `fontStyle` and
 *     `textDecorationLine` are consequently plain `string`; the permitted
 *     values are listed on each field and enforced by `RunTextAttribute`'s
 *     TypeScript union, which is what `resolveRunAttributes` produces.
 *
 * COLOURS STAY PROCESSED IN JS. `ColorValue` and `ProcessedColorValue` are the
 * same annotation to codegen (both become `SharedColor`), but the generated
 * *view config* attaches `{process: processColor}` only to **top-level**
 * colour props — `GenerateViewConfigJs.js:46-50,92` returns `true` for an
 * object type and for arrays of non-reserved element types, so this array is
 * sent through untouched. The native side cannot recover:
 * `fromRawValueShared.h:27-65`
 * accepts a packed int, a float vector or a `{space,r,g,b,a}` object and
 * otherwise falls through to `parsePlatformColor`, where a raw `"#ff0000"`
 * yields an undefined colour. `RunHost.toNativeAttribute` therefore keeps
 * calling `processColor` itself, and the type here says `ProcessedColorValue`
 * to be honest about what is on the wire. The generated C++ is identical
 * either way.
 */
type NativeRunTextAttribute = Readonly<{
  /** UTF-16 offsets into `text`, end-exclusive. */
  start: Int32;
  end: Int32;
  fontFamily?: string;
  fontSize?: Float;
  /**
   * Set by `runAttributes` on the base run and on headings. It is a
   * *measurement* input, not decoration: the Fabric shadow node measures the
   * string the view will draw, so a line height the measurer does not know
   * about is a correct measurement of the wrong typography.
   */
  lineHeight?: Float;
  /** 'normal' | 'bold' | '100'..'900' (the `ThemeFontWeight` union). String
   * because that is what RN's TextStyle uses. */
  fontWeight?: string;
  /** 'normal' | 'italic'. */
  fontStyle?: string;
  /** 'none' | 'underline' | 'line-through'. */
  textDecorationLine?: string;
  color?: ProcessedColorValue;
  backgroundColor?: ProcessedColorValue;
  /**
   * What this range IS, for a screen reader, as opposed to what it looks
   * like: `'heading'`, `'listItem'`, `'tableCell'`, or absent.
   * `src/view/runAttributes.ts`'s `RunSemanticRole` owns the set and says
   * what bounds it — every value maps to a platform primitive the reader
   * announces in its own language, so this library ships no role strings.
   *
   * WHY THE WIRE NEEDS IT AT ALL. A run is one platform text view holding
   * what the document had as several blocks, so the roles the JS renderer
   * tree sets (`accessibilityRole="header"`) never run for a block that
   * flows — and neither host can recover the role from the styling. Android
   * used to guess: `RunAccessibility.kt` looked for the font-size + line-
   * height + weight shape that only a heading and the base run emit, which
   * any `attributeForMark` could counterfeit or erase. This field replaces
   * the guess on both platforms.
   *
   * A PLAIN STRING, for the reason `NativeRunDecoration.kind` is: a string
   * union inside an array element is one of the two shapes banned above —
   * `generateEnumString` never recurses into an array's element type, and
   * emits a declared-nowhere type initialised with an invalid identifier.
   * The permitted values are enforced by `RunSemanticRole` in TypeScript,
   * which is what `resolveRunAttributes` produces, and `""` is the absent
   * sentinel exactly like `fontFamily`'s. A host that does not recognise a
   * value must ignore it — that is the forward-compatibility rule for this
   * field, and it degrades to the announcement the range had before.
   */
  role?: string;
  /**
   * The role's DEPTH where it has one — a heading's level (1-6), or a list
   * item's nesting depth (1 at top level) — with `0` as the absent sentinel
   * that `Float`/`Int32` fields use throughout this struct (there is no
   * level 0 and no depth 0, so it cannot collide).
   *
   * NEITHER HOST CONSUMES IT, because neither platform has a primitive for a
   * rank: `UIAccessibilityTraits.header` is a bit, `AccessibilityNodeInfo
   * .setHeading(true)` is a boolean, and `CollectionItemInfo` carries no
   * depth. Announcing one would mean putting "heading level 2" in the label,
   * in English, which is the one thing this channel is shaped to avoid. It
   * crosses anyway because a role that arrived without its level could not be
   * given one later without a second wire change; both hosts say so where
   * they drop it (`RunAccessibility.resolve`,
   * `SelectableRunHostView.accessibilityElements`).
   */
  roleLevel?: Int32;
  /**
   * The range's ONE-BASED position in its collection: a list item's place in
   * its list, a table cell's row (row 1 is the header row of a GFM table,
   * always, which is what lets a host flag those cells without shipping the
   * word "header" in English).
   *
   * One-based because `0` is this struct's absent sentinel and a zero-based
   * first row could not be told from an absent one. Both hosts subtract one
   * on the way into `AccessibilityNodeInfo.CollectionItemInfo`, which is
   * zero-based; the counting itself is done once in
   * `resolveRunAttributes`, where the marks that define a list's extent are.
   */
  roleRow?: Int32;
  /**
   * The size of that collection — a list's item count, a table's row count
   * including the header. Sent with `roleRow`; it is the "of 5" half of
   * TalkBack's "item 2 of 5", which the reader phrases in its own language.
   */
  roleRowCount?: Int32;
  /**
   * The range's one-based column, for the one role laid out in two
   * dimensions (`tableCell`). Absent for a list item, which both hosts read
   * as a one-column collection.
   */
  roleColumn?: Int32;
  /** The table's column count. Sent with `roleColumn`. */
  roleColumnCount?: Int32;
}>;

/**
 * One block-chrome instruction over `text`, mirroring `RunDecoration` in
 * `./runDecorations` with its colours already through `processColor`.
 *
 * The kinds are geometric ('box' | 'rule' | 'columns'), not markdown — which
 * construct gets which chrome is decided in JS, so the host stays as free of
 * markdown semantics as it is for selection and pressables. Two fields are
 * layout-affecting and are applied inside the shared string builder rather
 * than at draw time (`textInset`, and the whole 'columns' kind); everything
 * else is painted behind the text and cannot move a character.
 *
 * The sentinel rules documented on `NativeRunTextAttribute` apply verbatim:
 * no optional booleans, no string enums inside an array element (`kind`,
 * `corners` and `align` are plain strings with their permitted values
 * enforced by `RunDecoration`'s TypeScript union), `0.0` for an unset float
 * (a zero-width border, zero-thickness rule or zero inset is a no-op, so the
 * sentinel cannot collide with a meaningful value), and `SharedColor`'s
 * undefined value for colours, whose `operator bool()` is the is-set test.
 */
type NativeRunDecoration = Readonly<{
  /** UTF-16 offsets into `text`, end-exclusive; a 'rule' has start === end. */
  start: Int32;
  end: Int32;
  /** 'box' | 'rule' | 'columns' | 'indent'. */
  kind: string;
  /** Box fill / rule colour. */
  color?: ProcessedColorValue;
  borderColor?: ProcessedColorValue;
  borderWidth?: Float;
  borderRadius?: Float;
  /** 'all' | 'top'. */
  corners?: string;
  /**
   * 'box' only: a vertical stripe at the leading edge of the decoration band
   * (a blockquote's bar). Painted in its own sweep between fills and strokes
   * (so an island's fill inside the quote never severs it), full band
   * height, rounded ends of radius barWidth/2. Absent colour / 0 width = no
   * bar — the same sentinel pattern as the other colours and floats here.
   */
  barColor?: ProcessedColorValue;
  barWidth?: Float;
  paddingTop?: Float;
  paddingBottom?: Float;
  textInset?: Float;
  /** 'indent' only: extra inset for wrapped lines beyond textInset. */
  hang?: Float;
  thickness?: Float;
  /** 'center' | 'top'. */
  align?: string;
  /** Horizontal inset from each edge: a rule's, or a box band's (an island
   * inside a blockquote — see `RunDecoration.inset`). Draw-only. */
  inset?: Float;
  gap?: Float;
  /** 'columns' only: interior row-boundary padding — see
   * `RunDecoration.rowPaddingV`. Layout-affecting, like `gap`. */
  rowPaddingV?: Float;
}>;

/**
 * One tappable range over `text`, mirroring `RunPressable` in
 * `./runPressables` — except that the URL stays in JS. The host never sees
 * markdown and never sees an href: it hit-tests taps against these ranges and
 * echoes `pressableId` back through `onInlinePress`, and JS resolves the id
 * to the URL (or whatever a future pressable kind activates). That keeps the
 * host semantics-free, and it is also what makes this struct safe for
 * codegen: three required `Int32`s, so none of the sentinel/optional traps
 * documented on `NativeRunTextAttribute` above can apply.
 *
 * `pressableId` is JS's identifier for the range — in practice its index into
 * the `pressables` array as sent — carried explicitly rather than left to be
 * re-derived from array position so the event stays meaningful even if a host
 * ever reorders or filters the list on its side.
 */
type NativePressableRange = Readonly<{
  /** UTF-16 offsets into `text`, end-exclusive. */
  start: Int32;
  end: Int32;
  pressableId: Int32;
}>;

/**
 * One embedded range over `text`, mirroring `RunEmbed` in `./runEmbeds` —
 * except that, exactly as with pressables, the semantics stay in JS. The host
 * never learns what the embed *is*: it reserves `width` × `height` points of
 * layout space at the U+FFFC placeholder character JS projected at
 * `[start, end)` (an `NSTextAttachment` on iOS, a `ReplacementSpan` on
 * Android — both applied inside the shared string builder, so measurement and
 * drawing cannot disagree about the reservation), reports where that space
 * landed through `onEmbedLayout`, and JS positions the consumer's React view
 * over it. The node, the render function and the copy text never cross the
 * bridge.
 *
 * The sentinel rules documented on `NativeRunTextAttribute` apply: no
 * booleans, no string enums. `width`/`height` are required from JS and a
 * `0.0` sentinel cannot collide — a 0pt embed reserves nothing and is
 * meaningless, so hosts skip entries without a positive size, which is also
 * what absorbs a malformed entry from a newer JS.
 */
type NativeRunEmbed = Readonly<{
  /** UTF-16 offsets into `text`, end-exclusive; always `end === start + 1`,
   * covering the single U+FFFC placeholder the projection emitted. Hosts
   * must verify the character really is U+FFFC before attaching — under
   * version skew a stale offset must degrade to "no reservation", never to
   * swallowing a real character. */
  start: Int32;
  end: Int32;
  /** JS's identifier for the embed, carried explicitly for the same reason
   * `pressableId` is — and unlike `pressableId` it is NOT always this array's
   * own index: JS drops a claim whose declared size cannot be reserved
   * (non-positive, or infinite) without renumbering the entries around it.
   * Echo it back on `onEmbedLayout` verbatim; never substitute a position. */
  embedId: Int32;
  /** Declared size in points. Layout-affecting: the same values reach the
   * measurer and the view through this one prop. */
  width: Float;
  height: Float;
}>;

/**
 * Payload of `onEmbedLayout`: where one embed's reserved space landed, in the
 * host view's coordinate space, points. Fired per embed (scalar payload — an
 * array-of-objects event payload is not verifiably supported by codegen at
 * the bottom of the peer range) after layout, and re-fired only when the rect
 * actually moved: hosts dedupe against the last report per `embedId`, so
 * streaming appends past a settled embed do not re-announce it every
 * snapshot.
 */
type EmbedLayoutEvent = Readonly<{
  embedId: Int32;
  x: Float;
  y: Float;
  width: Float;
  height: Float;
}>;

/**
 * Payload of `onInlinePress`: the pressable range the tap landed on, clamped
 * against the current `text` exactly like selection offsets, plus the
 * `pressableId` JS sent with it. The offsets are informational the same way
 * `selectedText` is on `onSelectionAction` — the id is what JS routes on.
 */
type InlinePressEvent = Readonly<{
  start: Int32;
  end: Int32;
  pressableId: Int32;
}>;

/**
 * Payload of `onSelectionAction`. The guarantees on these offsets — UTF-16
 * code units into the *current* `text`, end-exclusive, clamped, ordered,
 * never empty — are the contract in docs/SELECTION.md, and nothing in the
 * Fabric port converts them: `AttributedString` is rejected precisely so no
 * second UTF-8↔UTF-16 conversion appears at this boundary.
 *
 * `action` is required here even though `SelectionActionEvent` in
 * `./RunHost` types it optional. The two are not in conflict: every native
 * binary that carries this spec emits it, and the optionality upstream exists
 * only to absorb version skew with a binary that predates the field.
 */
type SelectionActionEvent = Readonly<{
  start: Int32;
  end: Int32;
  action: string;
  /** Informational (debugging/analytics); the offsets are authoritative. */
  selectedText: string;
}>;

/**
 * Payload of `onSelectionChange`: where the run's selection stands NOW.
 *
 * THE ONE DIFFERENCE FROM `onSelectionAction`, AND IT IS THE POINT: an EMPTY
 * range is a legal payload here. `onSelectionAction` never emits one — a menu
 * item fired against no selection would be nonsense — but "the selection went
 * away" is exactly what a consumer's floating toolbar has to hear in order to
 * dismiss itself, so `start === end` is emitted and means "nothing is
 * selected in this run". Every other guarantee is `onSelectionAction`'s
 * verbatim: UTF-16 code units into the *current* `text`, end-exclusive,
 * clamped, ordered, and nothing in this port converts them.
 *
 * It carries no `selectedText`. This fires continuously while a selection
 * handle is dragged, and the string would be rebuilt and transcoded to UTF-8
 * on every one of those frames purely to be thrown away — JS already holds
 * the projected text and slices it for free. `onSelectionAction` keeps its
 * copy because it fires once, on a deliberate tap.
 *
 * BOTH HOSTS DEDUPE BEFORE EMITTING: an unchanged range is not re-announced,
 * which matters because a streamed snapshot re-applies the text (and with it
 * the selection) on every commit.
 */
type SelectionChangeEvent = Readonly<{
  start: Int32;
  end: Int32;
}>;

export interface NativeProps extends ViewProps {
  /** The projected run text. The host renders it verbatim — that is what
   * selection mapping depends on (docs/SELECTION.md). */
  text: string;
  /**
   * Styled ranges over `text`, in application order: the base run first, then
   * marks outermost-first, deliberately overlapping rather than flattened.
   * Both platforms' text stores apply attributes to arbitrary overlapping
   * ranges natively (`NSMutableAttributedString.addAttribute`,
   * `SpannableString.setSpan`), so no disjoint-fragment representation exists
   * anywhere in this port — which is the whole reason RN's `AttributedString`
   * is not adopted.
   */
  attributes?: ReadonlyArray<NativeRunTextAttribute>;
  /**
   * Block chrome over `text`: boxes behind ranges, rules at offsets, column
   * alignment for tab-separated rows. Painted by the host around the text it
   * already renders; the layout-affecting parts go through the same string
   * builder measurement uses. An older binary that predates this prop ignores
   * it, and blocks degrade to the flat text they rendered before — exactly
   * the behaviour that predates the prop.
   */
  decorations?: ReadonlyArray<NativeRunDecoration>;
  /**
   * Tappable ranges over `text`, non-overlapping — not because links cannot
   * nest (the mark stream nests them: `[<https://a.com>](https://b.com)`),
   * but because `resolveRunPressables` drops any range that starts inside one
   * it has already kept before this prop is built.
   *
   * The host intercepts single taps that land inside one — and ONLY those:
   * a tap anywhere else must fall through to the platform text view's own
   * behaviour, and selection gestures (long-press, handle drags) are never
   * intercepted at all. `RunHost` sends `[]` when no `onInlinePress` listener
   * exists, so a host with nothing to report never swallows a tap. An older
   * binary that predates this prop ignores it, and links degrade to styled
   * but inert text — exactly the behaviour that predates the prop.
   */
  pressables?: ReadonlyArray<NativePressableRange>;
  /**
   * Embedded ranges over `text`: each reserves its declared rect at the
   * U+FFFC placeholder JS projected there, so a consumer's React view can be
   * overlaid while selection sweeps across the run uninterrupted. Unlike
   * `pressables` this prop is layout-affecting, so `RunHost` sends it
   * whenever embeds exist rather than gating on a listener. An older binary
   * that predates this prop ignores it: the placeholder renders as an
   * invisible one-character gap (its attribute range carries a transparent
   * colour), no `onEmbedLayout` fires, and no overlay mounts — degraded, and
   * selection mapping stays exact.
   */
  embeds?: ReadonlyArray<NativeRunEmbed>;
  /**
   * Whether the platform selection UI is enabled for this run. Defaults to
   * true so that a host mounted without the prop is selectable, which is the
   * safe direction: the failure of the other default is a document nobody can
   * select in a library whose headline feature is selection.
   */
  selectable?: WithDefault<boolean, true>;
  /**
   * Whether this host takes part in one-active-selection coordination.
   * Defaults to true, which is the behaviour that predates the prop.
   *
   * WHAT THE COORDINATION IS. Neither platform clears one text view's
   * selection because a selection began in a different one, so a transcript
   * of per-run hosts would show two highlights at once with only the newest
   * carrying handles and a menu. Each host therefore records itself as the
   * process's one selection owner when a non-empty selection lands in it, and
   * clears the host that held the slot before.
   *
   * SET IT FALSE AND THIS HOST OPTS OUT OF THE COORDINATION IN BOTH
   * DIRECTIONS — it never clears another host, and it never takes the slot, so
   * no other host can clear it either. That symmetry is what makes the prop
   * useful rather than merely lenient: two selections held at once is only
   * reachable if the second one does not erase the first AND survives the
   * third. The trade is the one the coordination exists to prevent: several
   * highlights on screen, only the newest with handles and a menu, and it is
   * the consumer's job to make that read as deliberate.
   *
   * It is per host, not per document, because the registry it governs is
   * per process: two unrelated `<SelectableMarkdown>` trees in a split view
   * clear each other by default, and this is the prop that stops them.
   */
  exclusiveSelection?: WithDefault<boolean, true>;
  /**
   * The custom selection-menu items, in menu order — the order *is* the menu
   * order.
   *
   * ONE ENTRY IS `id` OR `id + U+001F + title`, and both hosts split at the
   * FIRST U+001F: everything before it is the identifier echoed back in
   * `onSelectionAction`, everything after it is the item's title, verbatim.
   * A bare id (no separator) means "use the host's own localised title",
   * which exists for the two built-in ids only — 'copy-text' and
   * 'copy-markdown', titled from `NSLocalizedString` on iOS and
   * `R.string.selectable_markdown_copy_*` on Android. An id the host does not
   * know and cannot title is dropped rather than rendered as a blank item, so
   * a consumer-defined action must send a title with it.
   *
   * The packing exists because this prop's TYPE is load-bearing (see below):
   * it stays one ordered `std::vector<std::string>`, so a title cannot
   * desynchronise from its id and no second prop is needed.
   * `src/view/selectionActions.ts` owns the encoder, the decoder and the
   * reasoning; `RunHost` is the only caller that builds this array.
   *
   * FORWARD AND BACKWARD COMPATIBILITY BOTH HOLD. A binary older than titles
   * reads `id + U+001F + title` as one unrecognised identifier and ignores it
   * — so JS sends a bare id whenever no title was given, which is byte-for-
   * byte the pre-title wire format for the default menu.
   *
   * THIS STAYS `ReadonlyArray<string>` AND MUST NOT BECOME A STRING UNION.
   * An array of a string union is a dead end in both directions, and both
   * were confirmed by running codegen. Written as
   * `ReadonlyArray<'copy-text' | 'copy-markdown'>` the TypeScript parser
   * refuses it outright — `A default enum value is required for
   * "selectionActions"` (componentsUtils.js:33) — and pushing the default
   * inside, `ReadonlyArray<WithDefault<'copy-text' | 'copy-markdown',
   * 'copy-text'>>`, is refused as a nested optional (:270). And if it did
   * parse, `generateArrayEnumString` (GeneratePropsH.js:212-238) emits
   * `using SelectableRunHostSelectionActionsMask = uint32_t;` with values
   * assigned `1 << index` — a **bitmask**, which has no order at all, while
   * `docs/SELECTION.md` promises the caller's order is the menu order.
   * As `ReadonlyArray<string>` it is a `std::vector<std::string>`, which also
   * keeps the documented forward compatibility: a binary that does not
   * recognise an identifier ignores it rather than rendering a dead item.
   */
  selectionActions?: ReadonlyArray<string>;
  onSelectionAction?: DirectEventHandler<SelectionActionEvent>;
  /** Fired when a single tap lands inside one of `pressables`. */
  onInlinePress?: DirectEventHandler<InlinePressEvent>;
  /** Fired per embed after layout with the reserved rect; re-fired only when
   * the rect moved. */
  onEmbedLayout?: DirectEventHandler<EmbedLayoutEvent>;
  /**
   * Fired whenever this run's selection changes — by gesture, by a
   * `setSelection`/`clearSelection` command, by another host taking the
   * one-active-selection slot, or by a text swap that moved it. An empty
   * range is a real payload; see `SelectionChangeEvent`.
   */
  onSelectionChange?: DirectEventHandler<SelectionChangeEvent>;
}

/**
 * The imperative half of the contract: what JS can TELL one host to do.
 *
 * WHY COMMANDS RATHER THAN A PROP. A selection is view state the user also
 * owns — they drag it, and the platform moves it — so "the selection is
 * currently [4, 9)" is not something a render can declare without fighting
 * whoever moved it last. A command is a one-shot instruction ordered against
 * the props by the mounting layer, which is the shape this actually is; and
 * it means no render of `<SelectableMarkdown>` can silently re-assert a
 * selection the user has since dismissed.
 *
 * OFFSETS ARE THE RUN'S, NOT THE DOCUMENT'S. `setSelection` takes UTF-16
 * offsets into this host's current `text` — the same unit every event on this
 * component reports — because the host has no idea what a source span is and
 * this contract exists to keep it that way. `<SelectableMarkdown>` takes a
 * `SourceSpan`, finds the run that covers it and maps it through that run's
 * projection before dispatching, which is the same piece table
 * `mapSelectionToSource` walks in the other direction.
 *
 * Both commands are clamped by the host and both are no-ops rather than
 * errors when the range does not survive clamping — a command can race a text
 * swap by a frame exactly like an event can.
 *
 * THE EXPORT NAME MUST BE `Commands`. React Native's babel plugin removes
 * this declaration and re-emits it from the generated view config, and it
 * throws outright on any other name for a `codegenNativeCommands` result —
 * or on a `Commands` export that is anything else
 * (@react-native/babel-plugin-codegen/index.js:120-140). `RunHost` reads it
 * off the same call-expression `require` it reads the component from, so
 * nothing imports this module statically (see the header).
 */
interface NativeCommands {
  /** Drop this host's selection and dismiss its menu. A no-op when there is
   * no selection to drop. */
  clearSelection: (
    viewRef: React.ElementRef<HostComponent<NativeProps>>,
  ) => void;
  /**
   * Select `[start, end)` of this host's current `text`, UTF-16 offsets,
   * end-exclusive. Clamped to the text and ordered by the host; an empty
   * result selects nothing rather than raising, and a host that is not
   * `selectable` takes nothing.
   *
   * It presents no menu and issues no scroll. It DOES take focus — the iOS
   * first responder, the Android view focus — because neither platform draws
   * a selection in a text view that lacks it, and a scrolling ancestor may
   * react to that.
   */
  setSelection: (
    viewRef: React.ElementRef<HostComponent<NativeProps>>,
    start: Int32,
    end: Int32,
  ) => void;
}

export const Commands: NativeCommands = codegenNativeCommands<NativeCommands>({
  supportedCommands: ['clearSelection', 'setSelection'],
});

/**
 * The component name must stay exactly `SelectableRunHost`.
 *
 * It must not acquire an `RCT` prefix: `componentNameByReactViewName`
 * (react/renderer/componentregistry/componentNameByReactViewName.cpp:13-70)
 * strips a leading `RCT`, so the C++ side would look up `SelectableRunHost`
 * while codegen's iOS lookup map would be keyed `RCTSelectableRunHost`, and
 * the two would never meet. The string here is also the key iOS Fabric looks
 * up in the generated `RCTThirdPartyComponentsProvider` dictionary, which
 * codegen builds from `codegenConfig.ios.componentProvider` in package.json
 * ("SelectableRunHost" -> "RCTSelectableRunHostComponentView"); a name that
 * does not match that entry registers nothing and raises nothing, and
 * `RunHost` throwing at mount is the only symptom. scripts/check-codegen.mjs
 * pins both halves (section 1, the componentProvider entry; section 6b, the
 * four registries this name is a key into). Finally it is what Android's
 * `FabricUIManager.measure` routes on.
 */
export default codegenNativeComponent<NativeProps>('SelectableRunHost');
