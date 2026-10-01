#import "RNSMAttributedText.h"

#include <cmath>

/*
 * Ranges arrive as sparse dictionaries, decoded from codegen's struct by the
 * Fabric half at the bottom of this file. The helpers below are what makes
 * "sparse" safe to read:
 * a key that is absent, null, or of a type this binary does not expect is
 * nil, and nil means "this range says nothing about that property", which is
 * the difference between inheriting an enclosing style and clearing it.
 */
static NSNumber *_Nullable RNSMNumber(id _Nullable value)
{
  return [value isKindOfClass:[NSNumber class]] ? (NSNumber *)value : nil;
}

static NSString *_Nullable RNSMString(id _Nullable value)
{
  return [value isKindOfClass:[NSString class]] ? (NSString *)value : nil;
}

/*
 * JS runs every colour through `processColor`, so what arrives on the paper
 * wire is an 0xAARRGGBB integer rather than a CSS string — which is what lets
 * a consumer theme use `rgba()`, `hsl()` or a named colour and have it mean
 * the same thing on both platforms.
 *
 * On the Fabric wire it is the same integer, but codegen's props parser has
 * already turned it into a UIColor by the time it reaches us
 * (react/renderer/graphics/platform/ios/.../HostPlatformColor.mm:99-102), so
 * that case is a pass-through. Accepting both here rather than flattening the
 * UIColor back to an integer keeps the one conversion this package performs
 * on colours — processColor, in JS — the only one, and it means a dynamic
 * (light/dark) UIColor would survive if one ever reached this component.
 */
static UIColor *_Nullable RNSMColor(id _Nullable value)
{
  if ([value isKindOfClass:[UIColor class]]) {
    return (UIColor *)value;
  }
  NSNumber *number = RNSMNumber(value);
  if (number == nil) {
    return nil;
  }
  uint32_t argb = number.unsignedIntValue;
  return [UIColor colorWithRed:(CGFloat)((argb >> 16) & 0xFF) / 255.0
                         green:(CGFloat)((argb >> 8) & 0xFF) / 255.0
                          blue:(CGFloat)(argb & 0xFF) / 255.0
                         alpha:(CGFloat)((argb >> 24) & 0xFF) / 255.0];
}

/*
 * CSS weight string -> UIKit's normalized weight-trait value. The keyword
 * forms and the two legacy numerics map onto the same regular/bold pair the
 * symbolic trait expresses; the rest are the granular weights only
 * UIFontWeightTrait can ask for. Unknown strings read as regular, which is
 * what an absent key already means.
 */
static CGFloat RNSMFontWeightTrait(NSString *weight)
{
  if ([weight isEqualToString:@"bold"]) {
    return UIFontWeightBold;
  }
  switch (weight.integerValue) {
    case 100: return UIFontWeightUltraLight;
    case 200: return UIFontWeightThin;
    case 300: return UIFontWeightLight;
    case 500: return UIFontWeightMedium;
    case 600: return UIFontWeightSemibold;
    case 700: return UIFontWeightBold;
    case 800: return UIFontWeightHeavy;
    case 900: return UIFontWeightBlack;
    default: return UIFontWeightRegular; // 'normal', '400', unknown
  }
}

/*
 * Font-affecting keys are merged into whatever font each sub-range already
 * carries; everything else is set outright.
 *
 * The interesting part is fonts. A UIFont is one object carrying family, size
 * and traits, but the ranges arrive sparse and nested — a heading sets size
 * and weight, and a code span inside it sets family and size but must not
 * clear the bold. So font-affecting keys are merged against whatever font
 * each sub-range already carries (which is why this walks `.font` with
 * enumerateAttribute instead of just calling addAttributes), while colours
 * and decorations, which do not compose, are set outright.
 */
static void RNSMApplyFont(
    NSMutableAttributedString *store,
    NSRange range,
    NSString *_Nullable family,
    NSNumber *_Nullable size,
    NSString *_Nullable weight,
    NSString *_Nullable style)
{
  if (family == nil && size == nil && weight == nil && style == nil) {
    return;
  }

  [store enumerateAttribute:NSFontAttributeName
                    inRange:range
                    options:0
                 usingBlock:^(id _Nullable value, NSRange sub, BOOL *stop) {
                   UIFont *existing = [value isKindOfClass:[UIFont class]] ? (UIFont *)value : nil;
                   CGFloat pointSize = size != nil ? (CGFloat)size.doubleValue
                       : (existing != nil ? existing.pointSize : [UIFont systemFontSize]);

                   // Traits carry over from whatever is already applied,
                   // INCLUDING across a family change: a code span inside a
                   // bold heading stays bold, which is what the nested <Text>
                   // fallback does and therefore what the two render paths
                   // have to agree on.
                   UIFontDescriptorSymbolicTraits traits =
                       existing != nil ? existing.fontDescriptor.symbolicTraits : 0;
                   if (weight != nil) {
                     // The coarse half: the symbolic bit at the CSS >= 600
                     // cut, which is what trait carry-over composes on. The
                     // granular weights the bit cannot express are resolved
                     // below, after the face is chosen.
                     BOOL bold = [weight isEqualToString:@"bold"] || weight.integerValue >= 600;
                     traits = bold ? (traits | UIFontDescriptorTraitBold)
                                   : (traits & ~UIFontDescriptorTraitBold);
                   }
                   if (style != nil) {
                     traits = [style isEqualToString:@"italic"] ? (traits | UIFontDescriptorTraitItalic)
                                                                : (traits & ~UIFontDescriptorTraitItalic);
                   }

                   UIFont *base;
                   if (family != nil) {
                     // "System" is the theme's default body family and is not
                     // a real installed face; UIFont(name:) would return nil
                     // for it. An unknown family falls back rather than
                     // dropping the range's other styling.
                     base = [family isEqualToString:@"System"]
                         ? [UIFont systemFontOfSize:pointSize]
                         : ([UIFont fontWithName:family size:pointSize]
                                ?: [UIFont systemFontOfSize:pointSize]);
                   } else {
                     base = existing != nil ? [existing fontWithSize:pointSize]
                                            : [UIFont systemFontOfSize:pointSize];
                   }

                   UIFontDescriptor *descriptor =
                       [base.fontDescriptor fontDescriptorWithSymbolicTraits:traits];
                   if (descriptor != nil) {
                     base = [UIFont fontWithDescriptor:descriptor size:pointSize];
                   }

                   // GRANULAR WEIGHTS, on top of the symbolic bold bit above.
                   // The bold trait can only say regular-or-bold, so on its
                   // own it renders '500' as body weight and '900' as plain
                   // bold while the <Text> fallback resolves the real faces —
                   // the two paths visibly disagreeing about the same token.
                   // For the weights the bold/regular pair cannot express,
                   // ask the descriptor for the face by UIFontWeightTrait
                   // (merged WITH the symbolic traits — a traits dictionary
                   // replaces the old one wholesale, so leaving them out
                   // would drop an italic). The keyword forms and '400'/'700'
                   // deliberately stay on the symbolic-trait path alone: it
                   // is the resolution every existing theme renders through,
                   // and for single-face custom families its fallback
                   // behaviour is known. Descriptor matching that cannot
                   // satisfy the requested weight resolves to the nearest
                   // face — worst case the one the bold bit already chose.
                   NSInteger numericWeight = weight != nil ? weight.integerValue : 0;
                   if (numericWeight != 0 && numericWeight != 400 && numericWeight != 700) {
                     UIFontDescriptor *weighted = [base.fontDescriptor
                         fontDescriptorByAddingAttributes:@{
                           UIFontDescriptorTraitsAttribute : @{
                             UIFontSymbolicTrait : @(traits),
                             UIFontWeightTrait : @(RNSMFontWeightTrait(weight)),
                           }
                         }];
                     if (weighted != nil) {
                       base = [UIFont fontWithDescriptor:weighted size:pointSize];
                     }
                   }
                   [store addAttribute:NSFontAttributeName value:base range:sub];

                   // SYNTHESIZED ITALIC for families that ship no italic
                   // face. `fontDescriptorWithSymbolicTraits:` returns nil
                   // (or an unslanted resolution) when the family cannot
                   // satisfy the italic trait — a single-face custom family
                   // is the ordinary case — and the range above then renders
                   // upright, silently erasing every *emphasis* in the
                   // document. Android does not have this failure: TextPaint
                   // fake-italicizes any typeface under StyleSpan(ITALIC).
                   // Match it with TextKit's own synthesis knob, a glyph
                   // skew. Applied per sub-range alongside the font, so the
                   // shared builder keeps measurement and drawing agreeing
                   // about it; cleared explicitly because sub-ranges of one
                   // store can be revisited across attribute entries and a
                   // stale skew must not survive a font that resolved a true
                   // italic (or a style reset to 'normal').
                   BOOL wantsItalic = (traits & UIFontDescriptorTraitItalic) != 0;
                   BOOL hasItalic =
                       (base.fontDescriptor.symbolicTraits & UIFontDescriptorTraitItalic) != 0;
                   if (wantsItalic && !hasItalic) {
                     [store addAttribute:NSObliquenessAttributeName value:@0.18 range:sub];
                   } else if (style != nil) {
                     [store removeAttribute:NSObliquenessAttributeName range:sub];
                   }
                 }];
}

/*
 * Merge a mutation into whatever NSParagraphStyle each sub-range already
 * carries, the same way RNSMApplyFont merges into fonts. Two paragraph
 * concerns exist in this file — line height from the attribute channel,
 * indents and tab stops from the decoration channel — and NSAttributedString
 * has one paragraph-style attribute, so setting a fresh style for either
 * would silently erase the other. Enumerate-and-mutate is what lets a code
 * block's indent keep the base run's line height.
 */
static void RNSMUpdateParagraphStyle(
    NSMutableAttributedString *store,
    NSRange range,
    void (^update)(NSMutableParagraphStyle *style))
{
  [store enumerateAttribute:NSParagraphStyleAttributeName
                    inRange:range
                    options:0
                 usingBlock:^(id _Nullable value, NSRange sub, BOOL *stop) {
                   NSMutableParagraphStyle *style =
                       [value isKindOfClass:[NSParagraphStyle class]]
                           ? [(NSParagraphStyle *)value mutableCopy]
                           : [NSMutableParagraphStyle new];
                   update(style);
                   [store addAttribute:NSParagraphStyleAttributeName
                                 value:[style copy]
                                 range:sub];
                 }];
}

/*
 * Clamp a decoration's offsets against the text in hand — the same discipline
 * as attribute entries, for the same prop-skew reason. Returns NO for an
 * entry that carries no usable range at all.
 */
static BOOL RNSMClampedRange(NSDictionary *spec, NSInteger length, NSRange *outRange)
{
  NSNumber *rawStart = RNSMNumber(spec[@"start"]);
  NSNumber *rawEnd = RNSMNumber(spec[@"end"]);
  if (rawStart == nil || rawEnd == nil) {
    return NO;
  }
  NSInteger start = MAX((NSInteger)0, MIN((NSInteger)rawStart.integerValue, length));
  NSInteger end = MAX(start, MIN((NSInteger)rawEnd.integerValue, length));
  *outRange = NSMakeRange((NSUInteger)start, (NSUInteger)(end - start));
  return YES;
}

/* Strong-R/AL blocks of UAX #9; only callers' letter filter makes this a strong-direction test. */
static BOOL RNSMIsRightToLeftLetter(UTF32Char scalar)
{
  return (scalar >= 0x0590 && scalar <= 0x08FF) ||
      (scalar >= 0xFB1D && scalar <= 0xFDFF) || (scalar >= 0xFE70 && scalar <= 0xFEFF) ||
      (scalar >= 0x10800 && scalar <= 0x10FFF) || (scalar >= 0x1E800 && scalar <= 0x1EFFF);
}

/*
 * Natural when `range` has no letter. Directions are pinned because TextKit
 * resolves an indent's leading edge per paragraph, and the host reads the
 * pinned value back to paint quote bars on that edge.
 */
static NSWritingDirection RNSMFirstStrongDirection(NSString *text, NSRange range)
{
  NSCharacterSet *letters = [NSCharacterSet letterCharacterSet];
  NSUInteger end = NSMaxRange(range);
  NSUInteger index = range.location;
  while (index < end) {
    UTF32Char scalar = [text characterAtIndex:index];
    index += 1;
    // Lone surrogates belong to no character set, so pairs are recombined first.
    if (CFStringIsSurrogateHighCharacter((UniChar)scalar) && index < end) {
      UniChar low = [text characterAtIndex:index];
      if (CFStringIsSurrogateLowCharacter(low)) {
        scalar = CFStringGetLongCharacterForSurrogatePair((UniChar)scalar, low);
        index += 1;
      }
    }
    if (![letters longCharacterIsMember:scalar]) {
      continue;
    }
    return RNSMIsRightToLeftLetter(scalar) ? NSWritingDirectionRightToLeft
                                           : NSWritingDirectionLeftToRight;
  }
  return NSWritingDirectionNatural;
}

/* One direction for every table row, so tab-stop columns stay aligned with the header. */
static NSWritingDirection RNSMResolvedWritingDirection(NSString *text, NSRange range)
{
  NSWritingDirection direction = RNSMFirstStrongDirection(text, range);
  return direction == NSWritingDirectionNatural ? NSWritingDirectionLeftToRight : direction;
}

/* A paragraph with no letter inherits its neighbour's direction instead of defaulting to left-to-right. */
static void RNSMPinParagraphDirections(
    NSMutableAttributedString *store,
    NSRange range,
    void (^update)(NSMutableParagraphStyle *style, NSWritingDirection direction))
{
  NSString *text = store.string;
  NSUInteger end = NSMaxRange(range);

  NSWritingDirection current = NSWritingDirectionNatural;
  for (NSUInteger index = range.location; index < end && current == NSWritingDirectionNatural;) {
    NSUInteger paragraphEnd =
        MIN(NSMaxRange([text paragraphRangeForRange:NSMakeRange(index, 0)]), end);
    if (paragraphEnd <= index) break;
    current = RNSMFirstStrongDirection(text, NSMakeRange(index, paragraphEnd - index));
    index = paragraphEnd;
  }
  if (current == NSWritingDirectionNatural) {
    current = NSWritingDirectionLeftToRight;
  }

  for (NSUInteger index = range.location; index < end;) {
    NSUInteger paragraphEnd =
        MIN(NSMaxRange([text paragraphRangeForRange:NSMakeRange(index, 0)]), end);
    if (paragraphEnd <= index) break;
    NSRange paragraph = NSMakeRange(index, paragraphEnd - index);
    NSWritingDirection own = RNSMFirstStrongDirection(text, paragraph);
    if (own != NSWritingDirectionNatural) {
      current = own;
    }
    NSWritingDirection direction = current;
    RNSMUpdateParagraphStyle(store, paragraph, ^(NSMutableParagraphStyle *style) {
      update(style, direction);
    });
    index = paragraphEnd;
  }
}

/*
 * Tab stops for one 'columns' decoration: the widest cell of each
 * tab-separated column in the range, plus the entry's gap, accumulated into
 * NSTextTab locations. Measured off `store` AFTER the attribute loop has
 * run, so a cell is measured in the font it will draw in — a bold header
 * cell is wider than its body-weight text, and the column has to fit it.
 *
 * NSTextTab locations are measured from the line fragment's leading edge,
 * not from the paragraph's head indent, which is why the entry's `textInset`
 * (where the first column starts) seeds the accumulation.
 */
static void RNSMApplyTabColumns(
    NSMutableAttributedString *store,
    NSRange range,
    CGFloat inset,
    CGFloat gap)
{
  if (range.length == 0) {
    return;
  }
  NSString *text = [store.string substringWithRange:range];
  NSWritingDirection direction = RNSMResolvedWritingDirection(store.string, range);
  RNSMUpdateParagraphStyle(store, range, ^(NSMutableParagraphStyle *style) {
    style.baseWritingDirection = direction;
  });
  NSMutableArray<NSNumber *> *columnWidths = [NSMutableArray array];

  NSUInteger rowStart = 0;
  const NSUInteger length = text.length;
  while (rowStart <= length) {
    NSRange newline = [text rangeOfString:@"\n"
                                  options:0
                                    range:NSMakeRange(rowStart, length - rowStart)];
    NSUInteger rowEnd = newline.location == NSNotFound ? length : newline.location;

    NSUInteger cellStart = rowStart;
    NSUInteger column = 0;
    while (cellStart <= rowEnd) {
      NSRange tab = [text rangeOfString:@"\t"
                                options:0
                                  range:NSMakeRange(cellStart, rowEnd - cellStart)];
      NSUInteger cellEnd = tab.location == NSNotFound ? rowEnd : tab.location;
      if (cellEnd > cellStart) {
        NSAttributedString *cell = [store attributedSubstringFromRange:
            NSMakeRange(range.location + cellStart, cellEnd - cellStart)];
        CGFloat width = ceil(cell.size.width);
        if (column < columnWidths.count) {
          if (width > columnWidths[column].doubleValue) {
            columnWidths[column] = @(width);
          }
        } else {
          [columnWidths addObject:@(width)];
        }
      } else if (column >= columnWidths.count) {
        [columnWidths addObject:@(0)];
      }
      if (tab.location == NSNotFound) {
        break;
      }
      cellStart = cellEnd + 1;
      column += 1;
    }

    if (newline.location == NSNotFound) {
      break;
    }
    rowStart = rowEnd + 1;
  }

  if (columnWidths.count < 2) {
    // One column has no tabs to align; leave the platform defaults alone.
    return;
  }

  NSMutableArray<NSTextTab *> *stops = [NSMutableArray arrayWithCapacity:columnWidths.count];
  CGFloat location = inset;
  for (NSNumber *width in columnWidths) {
    location += width.doubleValue + gap;
    [stops addObject:[[NSTextTab alloc] initWithTextAlignment:NSTextAlignmentLeft
                                                     location:location
                                                      options:@{}]];
  }
  RNSMUpdateParagraphStyle(store, range, ^(NSMutableParagraphStyle *style) {
    style.tabStops = stops;
  });
}

/*
 * Interior row padding for one 'columns' decoration: paragraph spacing at the
 * row boundaries INSIDE the range — spacing after every row but the last,
 * spacing before every row but the first — so each boundary opens by twice
 * the padding and the row rule (anchored 'top' to the following row's first
 * line fragment, whose rect includes its paragraphSpacingBefore) sits centred
 * in the gap.
 *
 * Interior-only is load-bearing, not caution. The first and last paragraph
 * edges of the range are exactly where paragraph spacing is unreliable:
 * usedRectForTextContainer — the Fabric measurement in RNSMTextKitStack —
 * does not extend past the last line's used rect, so trailing
 * paragraphSpacing on a table that ends the run would draw taller than it
 * measured; and paragraphSpacingBefore on the container's first paragraph is
 * typesetter-defined. The table's outer padding therefore stays on the box
 * decoration's paddingTop/paddingBottom, painted into the block-separator
 * slack as it always was.
 */
static void RNSMApplyRowPadding(
    NSMutableAttributedString *store,
    NSRange range,
    CGFloat padding)
{
  NSString *text = [store.string substringWithRange:range];
  const NSUInteger length = text.length;
  NSUInteger rowStart = 0;
  while (rowStart <= length) {
    NSRange newline = [text rangeOfString:@"\n"
                                  options:0
                                    range:NSMakeRange(rowStart, length - rowStart)];
    NSUInteger rowEnd = newline.location == NSNotFound ? length : newline.location;
    if (rowEnd > rowStart) {
      // The style range excludes the row's terminating '\n'; TextKit resolves
      // paragraph properties from the paragraph's first character, which the
      // range covers either way.
      NSRange row = NSMakeRange(range.location + rowStart, rowEnd - rowStart);
      BOOL isFirstRow = rowStart == 0;
      BOOL isLastRow = newline.location == NSNotFound;
      RNSMUpdateParagraphStyle(store, row, ^(NSMutableParagraphStyle *style) {
        if (!isFirstRow) {
          style.paragraphSpacingBefore = padding;
        }
        if (!isLastRow) {
          style.paragraphSpacing = padding;
        }
      });
    }
    if (newline.location == NSNotFound) {
      break;
    }
    rowStart = rowEnd + 1;
  }
}

/*
 * The space an embed reserves at its U+FFFC placeholder. Draws nothing — the
 * consumer's React view is overlaid at the rect the host reports through
 * onEmbedLayout — so the only things this class contributes are its bounds
 * (the reservation) and its equality.
 */
@interface RNSMEmbedAttachment : NSTextAttachment

@property (nonatomic, readonly) NSInteger embedId;

- (instancetype)initWithEmbedId:(NSInteger)embedId
                         bounds:(CGRect)bounds NS_DESIGNATED_INITIALIZER;
- (instancetype)initWithData:(nullable NSData *)contentData
                      ofType:(nullable NSString *)uti NS_UNAVAILABLE;
- (nullable instancetype)initWithCoder:(NSCoder *)coder NS_UNAVAILABLE;

@end

@implementation RNSMEmbedAttachment

- (instancetype)initWithEmbedId:(NSInteger)embedId bounds:(CGRect)bounds
{
  if (self = [super initWithData:nil ofType:nil]) {
    _embedId = embedId;
    self.bounds = bounds;
  }
  return self;
}

/*
 * Nothing to draw: no image, whatever the bounds. Without the override a
 * contentless NSTextAttachment can render its "missing attachment" glyph,
 * and the reservation must read as empty space under the overlaid card.
 */
- (nullable UIImage *)imageForBounds:(CGRect)imageBounds
                       textContainer:(nullable NSTextContainer *)textContainer
                      characterIndex:(NSUInteger)charIndex
{
  return nil;
}

/*
 * VALUE EQUALITY, AND IT IS LOAD-BEARING. NSTextAttachment inherits pointer
 * `isEqual:`, and the builder allocates a fresh attachment on every rebuild —
 * which under streaming is every snapshot. The host's append fast path
 * (SelectableRunHostView.apply) compares the new string's prefix against the
 * storage with `isEqual(to:)`, which compares attribute values via `isEqual:`
 * — so a pointer-identity attachment would fail that compare on every append
 * and silently demote each one to a full swap: full relayout of the settled
 * prefix plus a save/clamp/restore of the selection, the exact costs the fast
 * path exists to remove, with rendering that stays perfectly correct. Two
 * attachments are the same reservation iff they reserve the same rect for the
 * same embed.
 */
- (BOOL)isEqual:(id)object
{
  if (self == object) {
    return YES;
  }
  if (![object isKindOfClass:[RNSMEmbedAttachment class]]) {
    return NO;
  }
  RNSMEmbedAttachment *other = (RNSMEmbedAttachment *)object;
  return _embedId == other->_embedId && CGRectEqualToRect(self.bounds, other.bounds);
}

- (NSUInteger)hash
{
  CGRect bounds = self.bounds;
  return (NSUInteger)_embedId ^ ((NSUInteger)bounds.size.width << 8) ^
      ((NSUInteger)bounds.size.height << 16);
}

@end

/* Carried on the string so the measurer and the host view read one value off one object. */
static NSString *const RNSMRunEdgeInsetsAttributeName = @"RNSMRunEdgeInsets";

/* Unlike the full-cover edge insets, covers only its construct's range, which frames the element. */
static NSString *const RNSMSemanticRoleAttributeName = @"RNSMSemanticRole";

NSString *const RNSMSemanticRangeKey = @"range";
NSString *const RNSMSemanticRoleKey = @"role";

/* Unknown roles from a newer JS bundle stay unstamped and read as plain prose. */
static BOOL RNSMKnownSemanticRole(NSString *_Nullable role)
{
  return [role isEqualToString:@"heading"] || [role isEqualToString:@"listItem"] ||
      [role isEqualToString:@"tableCell"];
}

@implementation RNSMAttributedText

+ (NSArray<NSDictionary *> *)semanticRangesOfAttributedString:(nullable NSAttributedString *)string
{
  const NSUInteger length = string.length;
  if (length == 0) {
    return @[];
  }
  NSMutableArray<NSDictionary *> *ranges = [NSMutableArray array];
  // Longest effective ranges so each construct is one range; nested roles would
  // merge, which is why JS narrows a list item to stop where its sublist begins.
  [string enumerateAttribute:RNSMSemanticRoleAttributeName
                     inRange:NSMakeRange(0, length)
                     options:0
                  usingBlock:^(id value, NSRange range, BOOL *stop) {
                    NSString *role = RNSMString(value);
                    if (role == nil || range.length == 0) {
                      return;
                    }
                    [ranges addObject:@{
                      RNSMSemanticRangeKey : [NSValue valueWithRange:range],
                      RNSMSemanticRoleKey : role,
                    }];
                  }];
  return ranges;
}

+ (UIEdgeInsets)runEdgeInsetsOfAttributedString:(nullable NSAttributedString *)string
{
  if (string.length == 0) {
    return UIEdgeInsetsZero;
  }
  // The builder applies this over the whole string or not at all.
  id value = [string attribute:RNSMRunEdgeInsetsAttributeName atIndex:0 effectiveRange:NULL];
  if (![value isKindOfClass:[NSValue class]]) {
    return UIEdgeInsetsZero;
  }
  return ((NSValue *)value).UIEdgeInsetsValue;
}

+ (NSAttributedString *)attributedStringWithText:(NSString *)text
                                      attributes:(nullable NSArray *)attributes
                                     decorations:(nullable NSArray *)decorations
                                          embeds:(nullable NSArray *)embeds
{
  NSMutableAttributedString *store = [[NSMutableAttributedString alloc] initWithString:text ?: @""];
  NSInteger length = (NSInteger)store.length;
  if (length == 0) {
    return store;
  }

  for (id entry in attributes) {
    if (![entry isKindOfClass:[NSDictionary class]]) {
      continue;
    }
    NSDictionary *spec = (NSDictionary *)entry;
    NSNumber *rawStart = RNSMNumber(spec[@"start"]);
    NSNumber *rawEnd = RNSMNumber(spec[@"end"]);
    if (rawStart == nil || rawEnd == nil) {
      continue;
    }
    // Clamp: JS offsets are computed against the text it sent, and under prop
    // skew that can be a different length than the text in hand.
    NSInteger start = MAX(0, MIN((NSInteger)rawStart.integerValue, length));
    NSInteger end = MAX(start, MIN((NSInteger)rawEnd.integerValue, length));
    if (end <= start) {
      continue;
    }
    NSRange range = NSMakeRange((NSUInteger)start, (NSUInteger)(end - start));

    RNSMApplyFont(
        store,
        range,
        RNSMString(spec[@"fontFamily"]),
        RNSMNumber(spec[@"fontSize"]),
        RNSMString(spec[@"fontWeight"]),
        RNSMString(spec[@"fontStyle"]));

    // Innermost role wins over an overlap; JS narrows list items so roles never nest.
    NSString *role = RNSMString(spec[@"role"]);
    if (RNSMKnownSemanticRole(role)) {
      [store addAttribute:RNSMSemanticRoleAttributeName value:role range:range];
    }

    UIColor *color = RNSMColor(spec[@"color"]);
    if (color != nil) {
      [store addAttribute:NSForegroundColorAttributeName value:color range:range];
    }
    UIColor *background = RNSMColor(spec[@"backgroundColor"]);
    if (background != nil) {
      [store addAttribute:NSBackgroundColorAttributeName value:background range:range];
    }
    NSString *decoration = RNSMString(spec[@"textDecorationLine"]);
    if (decoration != nil) {
      [store addAttribute:NSUnderlineStyleAttributeName
                    value:@([decoration isEqualToString:@"underline"] ? NSUnderlineStyleSingle : 0)
                    range:range];
      [store addAttribute:NSStrikethroughStyleAttributeName
                    value:@([decoration isEqualToString:@"line-through"] ? NSUnderlineStyleSingle : 0)
                    range:range];
    }

    /*
     * Line height is a paragraph attribute, and applying it to a character
     * range is correct here for a reason worth stating: TextKit resolves
     * NSParagraphStyle per paragraph, from the style on the paragraph's first
     * character, and the projection separates blocks with '\n\n'
     * (docs/SELECTION.md), so a heading is already a paragraph of its own.
     * A range that covers a whole block therefore sets that block's line
     * height and nothing else's. This is also why `resolveRunAttributes` only
     * ever sets lineHeight alongside a font size, on the base run and on
     * headings: a mid-paragraph mark carrying its own line height would set
     * the whole enclosing paragraph's, from wherever its first character
     * happened to fall.
     *
     * min and max are both set, which is what pins the line box to exactly
     * this height instead of only raising or only capping it — the same pair
     * React Native sets for the same prop (Libraries/Text/RCTTextAttributes.mm
     * :133-134). Without it the run would draw at the platform's natural
     * leading while the JS <Text> fallback drew at baseSize x
     * theme.fonts.lineHeight, and under Fabric it is worse than cosmetic: the
     * shadow node would have measured a height the drawn text does not fit
     * into.
     */
    NSNumber *lineHeight = RNSMNumber(spec[@"lineHeight"]);
    if (lineHeight != nil && lineHeight.doubleValue > 0.0) {
      // Merged, not replaced (RNSMUpdateParagraphStyle): the decoration pass
      // below writes indents and tab stops into the same one paragraph-style
      // attribute, and whichever of the two runs second must not erase the
      // first.
      RNSMUpdateParagraphStyle(store, range, ^(NSMutableParagraphStyle *style) {
        style.minimumLineHeight = (CGFloat)lineHeight.doubleValue;
        style.maximumLineHeight = (CGFloat)lineHeight.doubleValue;
      });
    }
  }

  /*
   * The layout-affecting slice of the decoration channel. Runs AFTER the
   * attribute loop on purpose: tab-stop columns are computed by measuring
   * cell substrings, and a cell must be measured in the font the attributes
   * gave it.
   *
   * From a box it takes only the text inset and the run-edge padding; chrome
   * and rules are painted by the view.
   */
  UIEdgeInsets edgeInsets = UIEdgeInsetsZero;
  for (id entry in decorations) {
    if (![entry isKindOfClass:[NSDictionary class]]) {
      continue;
    }
    NSDictionary *spec = (NSDictionary *)entry;
    NSString *kind = RNSMString(spec[@"kind"]);
    NSRange range;
    if (kind == nil || !RNSMClampedRange(spec, length, &range) || range.length == 0) {
      continue;
    }

    if ([kind isEqualToString:@"box"]) {
      // Only padding at the run's edge needs measured room; elsewhere it sits in
      // the '\n\n' separator line. Max, not sum: boxes sharing an edge share it.
      if (range.location == 0) {
        NSNumber *paddingTop = RNSMNumber(spec[@"paddingTop"]);
        if (paddingTop != nil) {
          edgeInsets.top = MAX(edgeInsets.top, (CGFloat)paddingTop.doubleValue);
        }
      }
      if ((NSInteger)NSMaxRange(range) == length) {
        NSNumber *paddingBottom = RNSMNumber(spec[@"paddingBottom"]);
        if (paddingBottom != nil) {
          edgeInsets.bottom = MAX(edgeInsets.bottom, (CGFloat)paddingBottom.doubleValue);
        }
      }

      NSNumber *textInset = RNSMNumber(spec[@"textInset"]);
      if (textInset != nil && textInset.doubleValue > 0.0) {
        CGFloat inset = (CGFloat)textInset.doubleValue;
        RNSMPinParagraphDirections(store, range, ^(NSMutableParagraphStyle *style, NSWritingDirection direction) {
          style.baseWritingDirection = direction;
          style.firstLineHeadIndent = inset;
          style.headIndent = inset;
          // Negative means "inset from the trailing edge"; zero would mean
          // "no trailing limit at all", so this is the one spelling that
          // gives the box symmetrical padding.
          style.tailIndent = -inset;
        });
      }
    } else if ([kind isEqualToString:@"columns"]) {
      NSNumber *gap = RNSMNumber(spec[@"gap"]);
      NSNumber *inset = RNSMNumber(spec[@"textInset"]);
      RNSMApplyTabColumns(
          store,
          range,
          inset != nil ? (CGFloat)inset.doubleValue : 0.0,
          gap != nil ? (CGFloat)gap.doubleValue : 0.0);
      // Row padding is independent of the tab stops (which bail for a
      // one-column table): a single-column table still pads its rows.
      NSNumber *rowPadding = RNSMNumber(spec[@"rowPaddingV"]);
      if (rowPadding != nil && rowPadding.doubleValue > 0.0) {
        RNSMApplyRowPadding(store, range, (CGFloat)rowPadding.doubleValue);
      }
    } else if ([kind isEqualToString:@"indent"]) {
      /*
       * List indentation: the first line at `textInset` (the marker column)
       * and wrapped lines `hang` deeper, under the item's text. Assigned, not
       * added — JS sends these ranges DISJOINT (runDecorations.ts explains
       * why: Android's margin spans are additive, so overlap resolution
       * happens there, once, for both platforms), which is what makes plain
       * assignment correct here.
       */
      NSNumber *textInset = RNSMNumber(spec[@"textInset"]);
      NSNumber *hang = RNSMNumber(spec[@"hang"]);
      CGFloat first = textInset != nil ? (CGFloat)textInset.doubleValue : 0.0;
      CGFloat rest = first + (hang != nil ? (CGFloat)hang.doubleValue : 0.0);
      if (first > 0.0 || rest > 0.0) {
        RNSMPinParagraphDirections(
            store, range, ^(NSMutableParagraphStyle *style, NSWritingDirection direction) {
          // Per paragraph: one segment can hold a whole quote body in mixed scripts.
          style.baseWritingDirection = direction;
          style.firstLineHeadIndent = first;
          style.headIndent = rest;
        });
      }
    }
  }

  // Full cover or nothing: the reader reads index 0, and RNSMTextSplice only
  // keeps splicing while the value is uniform across the string.
  if (edgeInsets.top > 0.0 || edgeInsets.bottom > 0.0) {
    [store addAttribute:RNSMRunEdgeInsetsAttributeName
                  value:[NSValue valueWithUIEdgeInsets:edgeInsets]
                  range:NSMakeRange(0, (NSUInteger)length)];
  }

  /*
   * The embed reservations, last: they read the font the attribute loop gave
   * the placeholder (for the baseline offset below), and they touch nothing
   * the decoration loop wrote. Every guard here degrades a bad entry to "no
   * reservation" — never a crash, never an attachment over a real character.
   * Sizes come from consumers, so NaN and infinity need the explicit finite test.
   */
  for (id entry in embeds) {
    if (![entry isKindOfClass:[NSDictionary class]]) {
      continue;
    }
    NSDictionary *spec = (NSDictionary *)entry;
    NSRange range;
    if (!RNSMClampedRange(spec, length, &range) || range.length != 1) {
      continue;
    }
    NSNumber *embedId = RNSMNumber(spec[@"embedId"]);
    NSNumber *width = RNSMNumber(spec[@"width"]);
    NSNumber *height = RNSMNumber(spec[@"height"]);
    if (embedId == nil || width == nil || height == nil ||
        !std::isfinite(width.doubleValue) || width.doubleValue <= 0.0 ||
        !std::isfinite(height.doubleValue) || height.doubleValue <= 0.0) {
      continue;
    }
    // The skew guard: only ever attach over the U+FFFC placeholder the
    // projection emitted. Under prop skew a clamped range can land on prose,
    // and an attachment there would visually swallow a real character.
    if ([store.string characterAtIndex:range.location] != 0xFFFC) {
      continue;
    }
    /*
     * The attachment sits ON the baseline by default, leaving the line's
     * descent below it unused — so a card as tall as its (min = max pinned)
     * line would poke out the top by exactly the descent. Dropping the origin
     * to the placeholder's font descender (a negative number) aligns the
     * attachment's bottom with the descent floor instead, which keeps the
     * whole reservation inside the line pinned for it below.
     */
    id fontValue = [store attribute:NSFontAttributeName
                            atIndex:range.location
                     effectiveRange:nil];
    CGFloat descender =
        [fontValue isKindOfClass:[UIFont class]] ? ((UIFont *)fontValue).descender : 0.0;
    RNSMEmbedAttachment *attachment = [[RNSMEmbedAttachment alloc]
        initWithEmbedId:embedId.integerValue
                 bounds:CGRectMake(
                            0.0,
                            descender,
                            (CGFloat)width.doubleValue,
                            (CGFloat)height.doubleValue)];
    [store addAttribute:NSAttachmentAttributeName value:attachment range:range];

    /*
     * JS's line-height twin over the placeholder arrives Dynamic Type-scaled but
     * the reservation does not scale, so the line is re-pinned at max(height,
     * tallest other line height), as RunEmbeds.applyLineHeights does on Android.
     * The twin is the LAST exact-range entry; JS appends embed geometry last.
     */
    CGFloat floorHeight = 0.0;
    BOOL hasTwin = NO;
    CGFloat twinHeight = 0.0;
    for (id candidate in attributes) {
      if (![candidate isKindOfClass:[NSDictionary class]]) {
        continue;
      }
      NSDictionary *attribute = (NSDictionary *)candidate;
      NSNumber *lineHeight = RNSMNumber(attribute[@"lineHeight"]);
      NSRange covered;
      // Same guards as the attribute loop, so only applied line heights count.
      if (lineHeight == nil || !(lineHeight.doubleValue > 0.0) ||
          !RNSMClampedRange(attribute, length, &covered) || covered.length == 0 ||
          !NSLocationInRange(range.location, covered)) {
        continue;
      }
      const CGFloat value = (CGFloat)lineHeight.doubleValue;
      if (NSEqualRanges(covered, range)) {
        if (hasTwin) {
          floorHeight = MAX(floorHeight, twinHeight);
        }
        hasTwin = YES;
        twinHeight = value;
      } else {
        floorHeight = MAX(floorHeight, value);
      }
    }
    if (hasTwin || floorHeight > 0.0) {
      const CGFloat pinnedHeight = MAX((CGFloat)height.doubleValue, floorHeight);
      RNSMUpdateParagraphStyle(store, range, ^(NSMutableParagraphStyle *style) {
        style.minimumLineHeight = pinnedHeight;
        style.maximumLineHeight = pinnedHeight;
      });
    }
  }

  return store;
}

@end

/*
 * THE FABRIC HALF. The guard is always true at the react-native >= 0.82 floor;
 * it only keeps the C++ and codegen includes out of the Objective-C half above.
 */
#ifdef RCT_NEW_ARCH_ENABLED

#import <React/RCTConversions.h>

#import "RNSMAttributedText+Props.h"

using namespace facebook::react;

@implementation RNSMAttributedText (Props)

+ (NSArray<NSDictionary *> *)decorationsWithProps:(const SelectableRunHostProps &)props
{
  /*
   * Sentinel -> present/absent, same convention as the attribute entries
   * below and decoded in the same file for the same reason. Exposed as its
   * own method because TWO consumers need the dictionary form: this
   * category's string builder (for the layout-affecting fields) and
   * RCTSelectableRunHostComponentView (which hands the same array to the
   * Swift view for drawing). One decoder means the two cannot disagree about
   * what an absent key means.
   */
  NSMutableArray<NSDictionary *> *decorations =
      [NSMutableArray arrayWithCapacity:props.decorations.size()];
  for (const auto &decoration : props.decorations) {
    NSMutableDictionary *entry = [NSMutableDictionary dictionaryWithCapacity:16];
    entry[@"start"] = @(decoration.start);
    entry[@"end"] = @(decoration.end);
    if (!decoration.kind.empty()) {
      entry[@"kind"] = RCTNSStringFromString(decoration.kind);
    }
    if (decoration.color) {
      entry[@"color"] = RCTUIColorFromSharedColor(decoration.color);
    }
    if (decoration.borderColor) {
      entry[@"borderColor"] = RCTUIColorFromSharedColor(decoration.borderColor);
    }
    if (decoration.borderWidth != 0.0) {
      entry[@"borderWidth"] = @(decoration.borderWidth);
    }
    if (decoration.borderRadius != 0.0) {
      entry[@"borderRadius"] = @(decoration.borderRadius);
    }
    if (!decoration.corners.empty()) {
      entry[@"corners"] = RCTNSStringFromString(decoration.corners);
    }
    if (decoration.barColor) {
      entry[@"barColor"] = RCTUIColorFromSharedColor(decoration.barColor);
    }
    if (decoration.barWidth != 0.0) {
      entry[@"barWidth"] = @(decoration.barWidth);
    }
    if (decoration.paddingTop != 0.0) {
      entry[@"paddingTop"] = @(decoration.paddingTop);
    }
    if (decoration.paddingBottom != 0.0) {
      entry[@"paddingBottom"] = @(decoration.paddingBottom);
    }
    if (decoration.textInset != 0.0) {
      entry[@"textInset"] = @(decoration.textInset);
    }
    if (decoration.hang != 0.0) {
      entry[@"hang"] = @(decoration.hang);
    }
    if (decoration.thickness != 0.0) {
      entry[@"thickness"] = @(decoration.thickness);
    }
    if (!decoration.align.empty()) {
      entry[@"align"] = RCTNSStringFromString(decoration.align);
    }
    if (decoration.inset != 0.0) {
      entry[@"inset"] = @(decoration.inset);
    }
    if (decoration.gap != 0.0) {
      entry[@"gap"] = @(decoration.gap);
    }
    if (decoration.rowPaddingV != 0.0) {
      entry[@"rowPaddingV"] = @(decoration.rowPaddingV);
    }
    [decorations addObject:entry];
  }
  return decorations;
}

+ (NSArray<NSDictionary *> *)embedsWithProps:(const SelectableRunHostProps &)props
{
  /*
   * All five members are required from JS, so unlike the sparse structs above
   * every key is written unconditionally — the builder's own guards (a
   * positive finite size, a 1-unit range, U+FFFC underneath) are what
   * absorb a defaulted or malformed entry. Its own method for the same reason decorationsWithProps
   * is: the string builder and the Fabric component view both need the
   * dictionary form, and one decoder means they cannot disagree.
   */
  NSMutableArray<NSDictionary *> *embeds =
      [NSMutableArray arrayWithCapacity:props.embeds.size()];
  for (const auto &embed : props.embeds) {
    [embeds addObject:@{
      @"start" : @(embed.start),
      @"end" : @(embed.end),
      @"embedId" : @(embed.embedId),
      @"width" : @(embed.width),
      @"height" : @(embed.height),
    }];
  }
  return embeds;
}

+ (NSAttributedString *)attributedStringWithProps:(const SelectableRunHostProps &)props
                               fontSizeMultiplier:(CGFloat)fontSizeMultiplier
{
  // Unreachable through RCTFontSizeMultiplier, but a NaN size here would
  // measure a blank run with no error anywhere.
  const CGFloat scale =
      (std::isfinite(fontSizeMultiplier) && fontSizeMultiplier > 0.0) ? fontSizeMultiplier : 1.0;

  /*
   * `props.text` is a std::string because that is the only thing codegen
   * emits for a string prop, so this is a UTF-8 -> UTF-16 conversion — and
   * this package is otherwise strict that the single UTF-8/UTF-16 conversion
   * point is platform/cpp/FlatBuffer.cpp (docs/ARCHITECTURE.md). It does not
   * break that rule, because it is offset-preserving and no offset arithmetic
   * happens on either side of it: JS computed the attribute offsets against
   * the JS string, the same code points come back out here, and a code point
   * occupies the same number of UTF-16 code units whichever encoding carried
   * it. The conversion RN's AttributedString would have forced on us — the
   * one docs/FABRIC-PLAN.md §1 rejects — is a different thing entirely:
   * arithmetic *in* UTF-8 offsets, at the boundary where selection ranges are
   * computed.
   *
   * RCTNSStringFromString yields @"" rather than nil for text this
   * NSStringEncoding cannot decode (RCTConversions.h:19-24), which renders an
   * empty run instead of raising inside a layout pass — the same choice the
   * builder above makes for a malformed attribute entry.
   */
  NSString *text = RCTNSStringFromString(props.text);

  NSMutableArray *attributes = [NSMutableArray arrayWithCapacity:props.attributes.size()];
  for (const auto &attribute : props.attributes) {
    /*
     * Sentinel -> present/absent, in the one function that is allowed to know
     * the encoding. A key is written only when the value is distinguishable
     * from codegen's brace-initialised default, because writing it anyway
     * would turn every omitted key into an assertion: an empty font family
     * would resolve to the system font and overwrite an enclosing one, a 0pt
     * size would collapse the range, and a `textDecorationLine` of "" would
     * clear an underline the enclosing mark set. Absent has to keep meaning
     * "inherit".
     */
    NSMutableDictionary *entry = [NSMutableDictionary dictionaryWithCapacity:10];
    entry[@"start"] = @(attribute.start);
    entry[@"end"] = @(attribute.end);
    if (!attribute.fontFamily.empty()) {
      entry[@"fontFamily"] = RCTNSStringFromString(attribute.fontFamily);
    }
    // Only these two scale; lineHeight must, or min = max pins scaled glyphs into
    // an unscaled line box. The embed twin is scaled too and re-pinned by the builder.
    if (attribute.fontSize != 0.0) {
      entry[@"fontSize"] = @(attribute.fontSize * scale);
    }
    if (attribute.lineHeight != 0.0) {
      entry[@"lineHeight"] = @(attribute.lineHeight * scale);
    }
    if (!attribute.fontWeight.empty()) {
      entry[@"fontWeight"] = RCTNSStringFromString(attribute.fontWeight);
    }
    if (!attribute.fontStyle.empty()) {
      entry[@"fontStyle"] = RCTNSStringFromString(attribute.fontStyle);
    }
    if (!attribute.textDecorationLine.empty()) {
      entry[@"textDecorationLine"] = RCTNSStringFromString(attribute.textDecorationLine);
    }
    // SharedColor::operator bool() *is* the is-set test — an unset colour is
    // HostPlatformColor::UndefinedColor, not a transparent black that a
    // component check could confuse with a real one.
    if (attribute.color) {
      entry[@"color"] = RCTUIColorFromSharedColor(attribute.color);
    }
    if (attribute.backgroundColor) {
      entry[@"backgroundColor"] = RCTUIColorFromSharedColor(attribute.backgroundColor);
    }
    // roleLevel/roleRow/roleColumn are not copied: iOS has no trait that reads them.
    if (!attribute.role.empty()) {
      entry[@"role"] = RCTNSStringFromString(attribute.role);
    }
    [attributes addObject:entry];
  }

  return [self attributedStringWithText:text
                             attributes:attributes
                            decorations:[self decorationsWithProps:props]
                                 embeds:[self embedsWithProps:props]];
}

@end

#endif // RCT_NEW_ARCH_ENABLED
