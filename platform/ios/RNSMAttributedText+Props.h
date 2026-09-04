/*
 * RNSMAttributedText (Props) — the Fabric entry point to the one string
 * builder, and the only place codegen's sentinel encoding is decoded.
 *
 * THIS HEADER IS PRIVATE AND MUST STAY PRIVATE. It declares a C++ reference
 * parameter. The pod sets DEFINES_MODULE = YES and contains Swift, so
 * CocoaPods compiles every *public* header as Objective-C to build the module
 * map; a C++ declaration in one is a hard build failure and would also break
 * `import SelectableMarkdown`. `s.private_header_files` in
 * SelectableMarkdown.podspec covers this file for that reason.
 *
 * WHY THE SENTINEL DECODING LIVES HERE AND NOWHERE ELSE. Codegen emits a
 * plain struct with brace-initialised members — there is no std::optional
 * anywhere in its output — but the generated `fromRawValue` assigns a member
 * only when the key is present in the incoming map, so an omitted key leaves
 * the default in place and "absent" is representable as a per-type sentinel:
 * `""` for a family/weight/style/decoration, `0.0` for a font size or a line
 * height (a 0pt one of either is meaningless), and for colours SharedColor's
 * undefined value, whose `operator bool()` *is* the is-set test
 * (react/renderer/graphics/Color.h:48-50).
 *
 * That convention is a convention and not a type, which is why it is decoded
 * in exactly one function. The residual hazard it leaves is named in
 * src/view/SelectableRunHostNativeComponent.ts: an optional *boolean* added
 * to the attribute struct would read as an explicit `false` on every entry
 * that omits it, because `false` is a legal value and no sentinel exists for
 * it. The symptom would be an iOS-only styling bug — Android renders from
 * `props.rawProps` and its `hasKey` parsing is immune — that no test in this
 * repository can see. The spec file bans the shape; this file is where it
 * would bite.
 *
 * The decoded result is an array of sparse dictionaries handed to
 * +attributedStringWithText:attributes:decorations:, the single
 * builder both the measurement pass and the mounting pass go through. That
 * is deliberate rather than lazy: it means a run cannot be measured
 * differently from how it is drawn, and it means the sparse "absent means
 * inherit" reading exists once instead of twice. The cost is one
 * NSDictionary per styled range per commit, against a measured p50 of one
 * range and a p90 of three (docs/FABRIC-PLAN.md §6.3).
 */

#import <react/renderer/components/SelectableMarkdownSpec/Props.h>

#import "RNSMAttributedText.h"

NS_ASSUME_NONNULL_BEGIN

@interface RNSMAttributedText (Props)

/**
 * Builds the rendered string for one run straight from the Fabric props, at
 * the surface's current Dynamic Type scale.
 *
 * Called from the layout thread by RNSMRunTextMeasurer::prepareContent, whose
 * result is both what gets measured and — carried through Fabric State — what
 * gets drawn.
 *
 * `fontSizeMultiplier` is `LayoutContext::fontSizeMultiplier`, which React
 * Native fills from `RCTFontSizeMultiplier()` — the content size category
 * mapped to a scalar — and refreshes on
 * `UIContentSizeCategoryDidChangeNotification`
 * (React/Fabric/Surface/RCTFabricSurface.mm), which re-runs layout for the
 * whole surface. Every font size and line height in the string below is
 * multiplied by it, and nothing else is: paddings, insets and an embed's
 * declared reservation are points a consumer or the theme chose, exactly like
 * the paddings on a React Native `<View>`, and they do not scale.
 *
 * IT IS A PARAMETER RATHER THAN A READ OF THE CURRENT CATEGORY, and that is
 * what makes scaling safe here. This runs on the layout thread, and the
 * string it returns is both measured and (through Fabric State) drawn, so the
 * two cannot disagree about the size. Reading `RCTFontSizeMultiplier()` in
 * here instead would sample the main thread's idea of the category at an
 * arbitrary point in a layout pass, which is the measure/draw disagreement
 * docs/FABRIC-PLAN.md §4 exists to make impossible. RNSMRunHostShadowNode
 * memoises the prepared content on this exact scalar, so a category change
 * rebuilds the string and a commit that changes nothing else does not.
 */
+ (NSAttributedString *)attributedStringWithProps:
    (const facebook::react::SelectableRunHostProps &)props
                               fontSizeMultiplier:(CGFloat)fontSizeMultiplier;

/**
 * The `decorations` prop decoded into the same sparse-dictionary wire the old
 * architecture sends, one decoder for both of its consumers: the string
 * builder above (layout-affecting fields) and the Fabric component view,
 * which hands the array to the Swift host for draw-time painting.
 */
+ (NSArray<NSDictionary *> *)decorationsWithProps:
    (const facebook::react::SelectableRunHostProps &)props;

/**
 * The `embeds` prop decoded into the same dictionary wire the string builder
 * consumes, one decoder for both of its consumers: the builder above (which
 * attaches the reservation to each placeholder) and the Fabric component
 * view, which hands the array to the Swift host for rect reporting through
 * `onEmbedLayout`.
 */
+ (NSArray<NSDictionary *> *)embedsWithProps:
    (const facebook::react::SelectableRunHostProps &)props;

@end

NS_ASSUME_NONNULL_END
