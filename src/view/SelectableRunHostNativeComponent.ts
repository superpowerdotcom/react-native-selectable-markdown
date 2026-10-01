// Codegen matches the literal `React.ElementRef<…>` on a command's first
// parameter, so it needs this namespace import.
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
 * (BridgelessUIManager.js:273-291), so `RunHost` throws at render, and a
 * release build logs nothing first. Build-time codegen is equally blind
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
  /** A `RunSemanticRole` or `""`, a plain string under the array-enum ban
   * above; hosts ignore values they do not know. */
  role?: string;
  /** Heading level or list depth, `0` when absent. No host reads it yet; it
   * ships so adding a reader needs no wire change. */
  roleLevel?: Int32;
  /** One-based so `0` stays the absent sentinel; row 1 is a GFM table's
   * header row. */
  roleRow?: Int32;
  /** The collection's size, a table's header row included. */
  roleRowCount?: Int32;
  /** One-based column, `tableCell` only; a list item reads as one column. */
  roleColumn?: Int32;
  roleColumnCount?: Int32;
}>;

/**
 * One block-chrome instruction over `text`, mirroring `RunDecoration` in
 * `./runDecorations` with its colours already through `processColor`.
 *
 * The kinds are geometric ('box' | 'rule' | 'columns' | 'indent'), not markdown — which
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
  /** Not always this array's index: JS drops unreservable claims without
   * renumbering, so hosts echo it verbatim on `onEmbedLayout`. */
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
 * Payload of `onSelectionChange`. Unlike `onSelectionAction`, `start === end`
 * is legal and means nothing is selected; hosts never re-announce an unchanged range.
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
   * Tappable ranges over `text`, non-overlapping because `resolveRunPressables`
   * drops nested links.
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
   * When false this host neither clears other hosts' selections nor can be
   * cleared by them. Coordination is process-wide, so two `<SelectableMarkdown>`
   * trees clear each other by default.
   */
  exclusiveSelection?: WithDefault<boolean, true>;
  /**
   * Menu items in order, each `id` or `id + U+001F + title`, split at the first
   * U+001F. Hosts title a bare id only for the built-ins and drop one they
   * cannot title; `selectionActions.ts` owns the encoding.
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
  /** Fires on command-, coordination- and text-swap-driven changes too, not
   * just gestures. */
  onSelectionChange?: DirectEventHandler<SelectionChangeEvent>;
}

/**
 * Offsets are UTF-16 into this host's `text`, not the document; hosts clamp
 * and no-op on a range that does not survive.
 *
 * The export must be named `Commands`: the codegen babel plugin throws on any
 * other name (@react-native/babel-plugin-codegen/index.js:120-140).
 */
interface NativeCommands {
  clearSelection: (
    viewRef: React.ElementRef<HostComponent<NativeProps>>,
  ) => void;
  /** Takes focus, since neither platform draws a selection without it, but
   * shows no menu and issues no scroll. */
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
 * the two would never meet. It must also match
 * `codegenConfig.ios.componentProvider` in package.json or iOS silently registers nothing (pinned by
 * scripts/check-codegen.mjs). Finally it is what Android's
 * `FabricUIManager.measure` routes on.
 */
export default codegenNativeComponent<NativeProps>('SelectableRunHost');
