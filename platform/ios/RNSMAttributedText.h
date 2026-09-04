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

/** Keys of the dictionaries `semanticRangesOfAttributedString:` returns:
 * the boxed `NSRange`, and the role as it crossed the wire. */
extern NSString *const RNSMSemanticRangeKey;
extern NSString *const RNSMSemanticRoleKey;

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
 * The two indenting kinds ('box' with a `textInset`, and 'indent') also PIN
 * the paragraph's writing direction to the one their own text resolves to,
 * because a head indent is measured from the LEADING edge and TextKit
 * otherwise decides which edge that is per paragraph, from the paragraph's
 * first strong character, with no reference to the app's UI direction. The
 * host paints a blockquote's bar against that same edge and reads the pinned
 * direction back out of this string, so the chrome and the text it belongs to
 * cannot end up on opposite sides — see `RNSMResolvedWritingDirection` in the
 * .mm and `paragraphIsRightToLeft(at:)` in SelectableRunHostView.swift. The
 * pin reproduces TextKit's own rule rather than overriding it, so no document
 * that renders today moves.
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
 * The reservation's HEIGHT reaches layout through the `lineHeight` attribute
 * JS sends over the same character: the line-height pass pins min = max, so
 * without a pin at least as tall as the reservation the attachment would be
 * clamped into the body leading (see the lineHeight comment in the .mm). The
 * two travel in one prop batch, derived from one `EmbedContent`, so they
 * cannot disagree — and because a pinned line height is a font metric that
 * scales with Dynamic Type while a declared reservation does not, the embed
 * pass RAISES a pin that scaling has left shorter than the reservation.
 *
 * Malformed entries in any array are skipped rather than
 * trapped: a range from a newer JS bundle than this binary understands must
 * degrade to unstyled text, never to a crash in a render pass.
 */
+ (NSAttributedString *)attributedStringWithText:(NSString *)text
                                      attributes:(nullable NSArray *)attributes
                                     decorations:(nullable NSArray *)decorations
                                          embeds:(nullable NSArray *)embeds;

/**
 * The vertical room a run needs BEYOND its own text, in points: `top` above
 * the first line, `bottom` below the last. `left` and `right` are always 0.
 *
 * WHAT IT IS FOR. A box decoration's `paddingTop`/`paddingBottom` normally
 * costs nothing, because the projection separates blocks with '\n\n'
 * (docs/SELECTION.md) and the box is painted into the blank line that leaves.
 * A box at the very EDGE of a run has no such blank line to borrow: a table
 * that closes an answer ends at the run's last character, so its bottom
 * border would be drawn on the baseline of its last row, and a code block
 * that opens one starts at offset 0, so its top border would be drawn through
 * the first line of code. This is the room that case needs, and it is room
 * the text layout itself does not ask for.
 *
 * THE VALUE IS COMPUTED ONCE, BY THE BUILDER ABOVE, AND CARRIED ON THE STRING
 * IT RETURNS — which is what makes the two sides unable to disagree. The
 * measurer (RNSMRunTextMeasurer::measure) adds `top + bottom` to the height it
 * reports, so Fabric frames a view that tall; the host view offsets its text
 * view down by `top`, so the drawn text sits inside the room that was
 * measured for it. Both read this method, on the same object.
 *
 * Zero for the ordinary run — no box at either edge, or a box whose padding
 * a block separator already absorbs — in which case the view is exactly as
 * tall as its text and nothing moves.
 *
 * Where several boxes share an edge (an island inside a blockquote, both
 * starting at offset 0) the LARGEST padding wins rather than their sum: they
 * are drawn from the same edge, so the room the outermost one needs is the
 * room they all need.
 */
+ (UIEdgeInsets)runEdgeInsetsOfAttributedString:(nullable NSAttributedString *)string;

/**
 * Every character range of `string` that JS gave a screen-reader role, in
 * document order: one dictionary each, with `RNSMSemanticRangeKey` boxing the
 * `NSRange` and `RNSMSemanticRoleKey` naming the role.
 *
 * WHY THE HOST NEEDS THIS. A run is one `UITextView` holding what the
 * document had as several blocks, so the `accessibilityRole` the JS renderer
 * tree sets never runs for a block that flows into a run: VoiceOver reached a
 * heading as prose in a larger font, heading-by-heading rotor navigation
 * could not find it, and a list or a table was one undifferentiated wall of
 * text with no way to step through it. `SelectableRunHostView` vends one
 * `UIAccessibilityElement` per range returned here, next to the elements it
 * already vends for links.
 *
 * THE ROLE'S COORDINATES ARE NOT CARRIED, and that is the whole of what iOS
 * cannot say. `roleLevel`, `roleRow`/`roleRowCount` and
 * `roleColumn`/`roleColumnCount` do cross the wire — Android turns them into
 * `CollectionItemInfo`, which is how TalkBack says "item 2 of 5" in the
 * reader's own language — but `UIAccessibilityTraits.header` is a bit and not
 * a rank, and there is no list-item or table-cell trait at all. Announcing a
 * position here would mean this library shipping the English words for it. So
 * the roles buy NAVIGATION on iOS: one element per heading, item and cell
 * instead of one for the whole run. The day a trait exists, the builder
 * stamps the coordinates then; storing them now would be carrying a value
 * nothing reads.
 *
 * IT IS A WIRE FIELD AND NOT AN INFERENCE. The `role` field on each attribute
 * entry says which ranges these are (`RunSemanticRole` in
 * src/view/runAttributes.ts owns the set, and says what bounds it). Android
 * used to guess headings from a font-size + line-height + weight shape, which
 * any `attributeForMark` could counterfeit or erase; both hosts read the
 * field now.
 *
 * READ OFF THE STRING FOR THE SAME REASON `runEdgeInsetsOfAttributedString:`
 * is: the builder stamped it while it had the props in hand, and the host is
 * handed the identical object through Fabric State, so there is no second
 * decoding of the same prop to disagree with.
 *
 * A ROLE THIS BINARY DOES NOT KNOW NEVER GETS HERE — the builder ignores it,
 * which leaves the range announced as the prose it already was. That is the
 * forward-compatibility rule for a newer JS bundle driving this binary.
 *
 * Empty for the ordinary run, which is most of them.
 */
+ (NSArray<NSDictionary *> *)semanticRangesOfAttributedString:(nullable NSAttributedString *)string;

@end

NS_ASSUME_NONNULL_END
