/*
 * RNSMAttributedText — the one place a run's styled string is built on iOS.
 *
 * WHY IT IS ITS OWN CLASS. The string used to be built inside
 * SelectableRunHostView, which was fine while the view was also the only
 * thing that measured it. Under Fabric the measurement happens on the layout
 * thread, before any view exists, and the object that was measured is then
 * carried to the mounting layer through Fabric State — so the builder has to
 * be reachable from a place that must not touch UIKit view state at all. If
 * instead the shadow node built one string and the view built "the same"
 * string from the same props, the two would be one refactor away from
 * disagreeing, and the symptom of disagreement is a run clipped at its last
 * line (docs/FABRIC-PLAN.md §4). There is one builder; both sides call it.
 *
 * WHAT IT DOES NOT DO. It changes how the text LOOKS and never what it IS —
 * no character is added, removed or reordered — so the UTF-16 offsets the
 * host reports back still index the projected text exactly the way JS expects
 * (docs/SELECTION.md, "Offsets end to end"). Attribute ranges are clamped,
 * never allowed to move a character.
 *
 * THE HEADER IS PURE OBJECTIVE-C ON PURPOSE. The Swift host view calls this,
 * and it reaches it through the pod's umbrella header, which CocoaPods
 * compiles as Objective-C to build the module map. A C++ declaration here
 * would fail that compile outright and take `import SelectableMarkdown` with
 * it. The C++ entry point — the one that decodes codegen's props — is
 * therefore in RNSMAttributedText+Props.h, which is a private header.
 */

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface RNSMAttributedText : NSObject

/**
 * Builds the rendered string from the projected run text plus JS's styled
 * ranges, block decorations and embed reservations.
 *
 * THE ONE BUILDER, AND THE ONLY ENTRY POINT. There used to be two-, three-
 * and four-argument overloads that filled the trailing arguments with nil
 * and forwarded here. Nothing called them — the measurement path and the
 * mounting path both pass everything — so they were public surface whose
 * only caller was each other.
 *
 * `attributes` is an array of sparse dictionaries with `start`/`end` (UTF-16
 * offsets into `text`, end-exclusive) plus any of `fontFamily`, `fontSize`,
 * `lineHeight`, `fontWeight`, `fontStyle`, `textDecorationLine`, `color`,
 * `backgroundColor`. They are applied in array order, so a later entry
 * overriding an earlier one is how nesting is expressed — JS sends them
 * outermost-first. Each entry carries only what its construct changes and
 * inherits everything else from the ranges already applied, which is what
 * lets `**bold**` inside a heading keep the heading's size.
 *
 * `decorations` is an array of sparse dictionaries with `start`/`end` and a
 * `kind` ('box' | 'rule' | 'columns' | 'indent'). The drawn parts of a
 * decoration are painted by the view and never touch the string; the
 * LAYOUT-AFFECTING parts are applied here, because this builder is the one
 * thing the measurement path and the drawing path share:
 *
 *   - a 'box' with `textInset` indents its paragraphs (head + tail), which
 *     is what puts the code inside its box and the cells inside the table
 *     border;
 *   - a 'columns' entry computes per-column tab stops from the widest cell
 *     of each tab-separated column in its range, which is what turns "text
 *     with tabs" into aligned table columns;
 *   - an 'indent' entry is a list item's indentation: first lines at
 *     `textInset`, wrapped lines `hang` deeper so they hang under the item's
 *     text rather than its bullet.
 *
 * All of it moves where glyphs sit and never which glyphs exist, so the
 * UTF-16 offset contract is untouched.
 *
 * `embeds` is an array of dictionaries with `start`/`end` (always a 1-unit
 * range over a U+FFFC placeholder the projection emitted), `embedId`,
 * `width`, `height`. Each valid entry attaches an invisible NSTextAttachment
 * sized `width` x `height` to the placeholder character, which is how the
 * reservation reaches layout — and because this builder is shared, how it
 * reaches measurement identically.
 *
 * ATTRIBUTE-ONLY, ZERO INSERTION. The attachment is added with
 * `addAttribute:` to a character JS already put in the text; nothing here
 * ever calls `attributedStringWithAttachment:`, which would insert a second
 * U+FFFC and break the offset contract at the top of this header. An entry
 * whose range is not exactly one U+FFFC character — prop skew, a stale
 * offset — degrades to "no reservation", never to attaching over a real
 * character.
 *
 * The reservation's HEIGHT is honoured only because JS also sends a
 * `lineHeight` attribute equal to `height` over the same character: the
 * line-height pass pins min = max, so without it the attachment would be
 * clamped into the body leading (see the lineHeight comment in the .mm).
 * The two travel in one prop batch, derived from one `EmbedContent`, so
 * they cannot disagree.
 *
 * Malformed entries in any array are skipped rather than
 * trapped: a range from a newer JS bundle than this binary understands must
 * degrade to unstyled text, never to a crash in a render pass.
 */
+ (NSAttributedString *)attributedStringWithText:(NSString *)text
                                      attributes:(nullable NSArray *)attributes
                                     decorations:(nullable NSArray *)decorations
                                          embeds:(nullable NSArray *)embeds;

@end

NS_ASSUME_NONNULL_END
