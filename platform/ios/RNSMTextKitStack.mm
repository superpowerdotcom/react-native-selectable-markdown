#import "RNSMTextKitStack.h"

/*
 * The single place `usesFontLeading` is decided.
 *
 * It is a file-local function and not a public class method on purpose. A
 * second caller building its own layout manager is precisely the failure this
 * class exists to prevent, and an exported +makeLayoutManager is an
 * invitation to write one. Everything that needs a layout manager reaches it
 * through the storage returned below, so there is exactly one configured
 * stack shape in the package.
 *
 * `usesFontLeading = NO` matches React Native's own text measurement
 * (RCTTextLayoutManager.mm:183) rather than UIKit's default. The value itself
 * matters less than that both sides of this package use the same one; matching
 * RN means a run and an adjacent RN <Text> at least agree about leading, which
 * is what a consumer laying the two out together would expect.
 */
static NSLayoutManager *RNSMMakeLayoutManager(void)
{
  NSLayoutManager *layoutManager = [NSLayoutManager new];
  layoutManager.usesFontLeading = NO;
  return layoutManager;
}

@implementation RNSMTextKitStack

+ (NSTextStorage *)makeTextStackWithSize:(CGSize)size
{
  NSTextContainer *textContainer = [[NSTextContainer alloc] initWithSize:size];

  // UIKit's default is 5 points on each edge, which would wrap the drawn text
  // at a width 10 points narrower than the width it was measured at.
  textContainer.lineFragmentPadding = 0.0;

  // Every value below is set explicitly even where it looks like the default,
  // because "the default" is not the same object on both sides: the container
  // UITextView builds for itself and the one +alloc/initWithSize: builds are
  // documented separately and have differed. The whole point of this factory
  // is that the measured stack and the drawn stack are configured by the same
  // lines of code, so nothing here may be left to a default that could drift.
  textContainer.maximumNumberOfLines = 0;
  textContainer.lineBreakMode = NSLineBreakByWordWrapping;

  // Only meaningful once a UITextView adopts this container: it is what makes
  // the drawn text re-wrap to the view's width. With no text view attached —
  // the measurement case — the container has nothing to track and the flag is
  // inert, which is why one factory can serve both callers. Without it the
  // view would keep whatever width was passed in here forever and the text
  // would not wrap at all.
  textContainer.widthTracksTextView = YES;
  textContainer.heightTracksTextView = NO;

  NSLayoutManager *layoutManager = RNSMMakeLayoutManager();
  [layoutManager addTextContainer:textContainer];

  // A layout manager with no text storage is a half-built stack. UITextView
  // is documented to adopt the container's layout manager and storage; what it
  // does when the storage is missing is not documented, and the failure would
  // be UIKit quietly substituting a stack of its own — i.e. exactly the
  // TextKit configuration this class exists to take away from it.
  NSTextStorage *textStorage = [NSTextStorage new];
  [textStorage addLayoutManager:layoutManager];

  // THE STORAGE, NOT THE CONTAINER. It is the root of the ownership graph, and
  // returning the container instead — which this method used to do — released
  // it here and left every caller holding a container whose `layoutManager` was
  // nil. The header documents both failure modes that produced; the short
  // version is that one of them is silent and renders nothing.
  return textStorage;
}

+ (NSTextContainer *)textContainerOfStack:(NSTextStorage *)stack
{
  // The walk back down the graph the header describes. Both `firstObject`
  // hops are total for a stack this class built: +makeTextStackWithSize: adds
  // exactly one layout manager and one container, in that order, and nothing
  // in this package adds a second of either.
  NSTextContainer *textContainer = stack.layoutManagers.firstObject.textContainers.firstObject;

  // The assertion is here because the failure it catches is not
  // self-announcing. A half-collapsed stack reaches UITextView as a container
  // with no layout manager and aborts the process from inside an initialiser,
  // and reaches the measurement below as `{0, 0}` and renders nothing at all.
  // Naming the invariant in a debug build is the difference between one line of
  // console output and re-deriving this from a disassembly.
  NSAssert(textContainer != nil && textContainer.layoutManager != nil,
           @"RNSMTextKitStack: the stack has collapsed — the storage was not kept alive. "
           @"See the ownership note in RNSMTextKitStack.h.");

  return textContainer;
}

+ (CGSize)measureAttributedString:(NSAttributedString *)string
                            width:(CGFloat)width
{
  // Yoga measures with an infinite maximum width whenever the parent does not
  // constrain it (the intrinsic-size pass). CGFLOAT_MAX is TextKit's own
  // spelling of "unbounded" — React Native passes it for the height on every
  // measurement (RCTTextLayoutManager.mm:48) — and it produces a finite used
  // rect, which infinity does not.
  CGFloat containerWidth = isfinite(width) ? width : CGFLOAT_MAX;

  // `textStorage` is a strong local and it has to stay one for the whole
  // method: it is the only thing holding the layout manager and the container
  // up, so letting it go out of scope early — or never binding it, and reaching
  // the storage back through `textContainer.layoutManager.textStorage` — is the
  // bug this method used to have. Every message below would go to nil and the
  // used rect would come back `{0, 0}`, which Yoga turns into a run of zero
  // height rather than into anything anyone could debug.
  NSTextStorage *textStorage =
      [self makeTextStackWithSize:CGSizeMake(containerWidth, CGFLOAT_MAX)];
  NSLayoutManager *layoutManager = textStorage.layoutManagers.firstObject;
  NSTextContainer *textContainer = layoutManager.textContainers.firstObject;
  [textStorage setAttributedString:string];

  // usedRectForTextContainer is documented to force layout only for the
  // glyphs it needs, so the explicit ensureLayout is what makes the answer
  // cover the whole string rather than the part that happened to be laid out.
  // Same two calls, same order, as RCTTextLayoutManager._measureTextStorage
  // (:281-286).
  [layoutManager ensureLayoutForTextContainer:textContainer];
  CGSize size = [layoutManager usedRectForTextContainer:textContainer].size;

  // The origin of the used rect is deliberately dropped, exactly as React
  // Native drops it: the view draws through the same layout manager at the
  // same origin, so a non-zero origin offsets the drawing by as much as it
  // would have added to the height. Adding it here would make the run taller
  // than what is drawn in it.

  return size;
}

@end
