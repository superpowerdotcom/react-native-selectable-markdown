/*
 * RNSMTextKitStack — the one TextKit 1 configuration this package renders and
 * measures with, and the off-main-thread measurement built on it.
 *
 * WHY A FACTORY AT ALL, RATHER THAN "SET THE SAME THREE PROPERTIES IN TWO
 * PLACES". Under Fabric the shadow node measures a run on the layout thread
 * and the component view draws it on the main thread. If the two use text
 * engines that are configured even slightly differently they disagree, and
 * the symptom is text clipped at the bottom of a run — a rendering bug, not a
 * build error, that gets worse with every line and cannot be reproduced by
 * anything in this repository (docs/FABRIC-PLAN.md §4.3 specifies the device
 * tests that would catch it, and §8 is blunt that none of them can run here).
 * So the design removes the opportunity rather than testing for it: there is
 * one place that builds the layout stack, both sides call it, and the
 * properties below are decided exactly once.
 *
 * THE FOUR AXES ON WHICH A STOCK UITextView AND REACT NATIVE'S OWN TEXT
 * MEASUREMENT DISAGREE. This class exists because all four are traps, and
 * three of them are silent:
 *
 *   NSLayoutManager.usesFontLeading   RN measures with NO
 *                                     (RCTTextLayoutManager.mm:183); UIKit
 *                                     defaults to YES. For any face with
 *                                     non-zero leading this changes every
 *                                     line's height, and the error accumulates
 *                                     down the run.
 *   textContainer.lineFragmentPadding RN uses 0 (:176); UIKit defaults to 5,
 *                                     on both edges, so the text wraps at a
 *                                     different width than it was measured at.
 *   textContainerInset                UITextView adds {8,0,8,0} of its own.
 *   TextKit generation                UITextView is TextKit 2 on iOS 16+,
 *                                     which lays out through an entirely
 *                                     different engine (NSTextLayoutManager)
 *                                     than the NSLayoutManager measurement
 *                                     below.
 *
 * On the old architecture SelectableRunHostView got away with the fourth by
 * measuring with `sizeThatFits` — the same object it draws with, so whatever
 * the engine did, it did to both. Under Fabric that escape hatch is gone: the
 * measurement happens before the view exists, on a thread that must not touch
 * UIKit view state at all.
 *
 * WHY -initWithFrame:textContainer: AND NOT UITextView(usingTextLayoutManager:
 * false). Both opt into TextKit 1, but the initializer that takes a container
 * hands us the whole stack — storage, layout manager, container — so we own
 * `usesFontLeading`, which `usingTextLayoutManager:` leaves at UIKit's YES.
 * As a bonus `textView.textLayoutManager` is nil by construction rather than
 * by request, so there is no iOS version in which the view quietly gets
 * TextKit 2 back.
 *
 * THREAD SAFETY. NSTextStorage, NSLayoutManager and NSTextContainer are not
 * UIKit views and are safe to use off the main thread as long as no single
 * instance is shared across threads. Every stack this class hands out is
 * freshly built and owned by its caller, which is what makes
 * +measureAttributedString:width: legal on Fabric's layout
 * thread. Nothing here reads a UIScreen, a UITraitCollection or a view — see
 * the `pointScaleFactor` parameter, which exists precisely so that this file
 * never has to.
 */

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * The chip line-breaking contract between the string builder (which stamps
 * these) and the stack below (which obeys them). A chip does not break
 * across lines (docs/SELECTION.md), and both keep the text untouched, so
 * every UTF-16 offset and copied character stays what JS sent.
 *
 * `RNSMChipUnbreakableAttributeName` sits on every chip character but the
 * first, with the chip's whole reserved width (lead + text + trail); the
 * layout manager's delegate refuses a soft break before any of them unless
 * that width exceeds the line, the one case that has to break somewhere.
 *
 * `RNSMChipWrapLeadAttributeName` sits on a chip's first character when its
 * lead was kerned onto the character before it (anywhere but a paragraph
 * start). If a soft wrap puts the chip first on a line, that kern stays on
 * the previous line; the container then gives the new line this much room on
 * its leading edge, so the padding wraps with the chip.
 */
extern NSString *const RNSMChipUnbreakableAttributeName;
extern NSString *const RNSMChipWrapLeadAttributeName;

@interface RNSMTextKitStack : NSObject

/**
 * A complete TextKit 1 stack — an empty NSTextStorage, an NSLayoutManager
 * with `usesFontLeading = NO`, and a container of `size` with
 * `lineFragmentPadding = 0` — returned by its STORAGE, which is the only
 * handle that keeps the stack alive.
 *
 * THE RETURN TYPE IS THE WHOLE POINT, AND IT USED TO BE WRONG. TextKit 1
 * ownership runs in exactly one direction: `NSTextStorage` strongly retains
 * its layout managers (`NSTextStorage.h`, `layoutManagers` is `copy`), and
 * `NSLayoutManager` strongly retains its text containers. The back-pointers —
 * `NSTextContainer.layoutManager` and `NSLayoutManager.textStorage` — are
 * `assign`. So the storage is the root and the container is the leaf, and an
 * earlier version of this method returned the leaf: ARC released the storage
 * on the way out, the layout manager went with it, and every container this
 * factory handed out had `layoutManager == nil`. Both callers then failed, in
 * different ways and neither of them loudly. The measurement below sent
 * `setAttributedString:`, `ensureLayoutForTextContainer:` and
 * `usedRectForTextContainer:` to nil and returned `{0, 0}`, so Yoga laid every
 * run out at zero height — invisible text, no hit area, nothing to select, no
 * error anywhere. `-[UITextView initWithFrame:textContainer:]` was the tolerant
 * one only by comparison: it raises `NSInternalInconsistencyException`, "text
 * container must already have a layout manager", and takes the process with it.
 *
 * Returning the root is also what React Native's own equivalent does
 * (`RCTTextLayoutManager.mm`, which returns an `NSTextStorage` and reaches back
 * down through `textStorage.layoutManagers.firstObject.textContainers
 * .firstObject`), and `+textContainerOfStack:` below is that walk.
 *
 * The storage is created here rather than left for UITextView to supply
 * because a container whose layout manager has no text storage is a
 * half-built stack, and what UIKit does with one is not documented.
 */
+ (NSTextStorage *)makeTextStackWithSize:(CGSize)size;

/**
 * The container of a stack built by `+makeTextStackWithSize:` — the handle
 * `-[UITextView initWithFrame:textContainer:]` wants.
 *
 * Callers must keep the `stack` they pass in alive for as long as they intend
 * to use the container: it is the root, and nothing else in the graph holds it
 * up. A `UITextView` initialised with the returned container adopts the whole
 * stack and retains the storage itself, so a local that dies at the end of the
 * initialiser is enough there — but only there.
 */
+ (NSTextContainer *)textContainerOfStack:(NSTextStorage *)stack;

/**
 * Lays `string` out in a fresh stack `width` points wide and returns the size
 * it occupies, unrounded; the Fabric measurer rounds to device pixels.
 *
 * A `width` that is not finite means "measure unconstrained" — Yoga passes an
 * infinite maximum width whenever the parent does not constrain it — and is
 * turned into TextKit's own unbounded-dimension convention, CGFLOAT_MAX.
 * Handing infinity to NSTextContainer instead would come back as an infinite
 * used rect, and an infinite width flows into Yoga as a frame no error ever
 * mentions.
 */
+ (CGSize)measureAttributedString:(NSAttributedString *)string
                            width:(CGFloat)width;

@end

NS_ASSUME_NONNULL_END
