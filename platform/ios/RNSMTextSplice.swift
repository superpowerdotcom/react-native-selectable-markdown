import Foundation

/// The smallest edit that turns the text view's current storage into the
/// string the shadow node just measured: how much of the old and the new
/// string are identical at the head and at the tail, so that only what lies
/// between them has to be spliced into the storage.
///
/// WHY THE SPLICE MATTERS AT ALL. Streaming re-publishes a COMPLETE string on
/// every snapshot even when only the tail changed. Assigning it wholesale
/// relays out the entire accumulated run per snapshot, which is quadratic in
/// the length of the answer; TextKit invalidates layout per edited range, so
/// replacing only the part that changed relays out only that part and what
/// follows it. `SelectableRunHostView.apply(attributedText:)` is the caller,
/// and the comment there covers the selection half.
///
/// WHY A PREFIX ALONE IS NOT ENOUGH, WHICH IS WHY THIS FILE EXISTS. The
/// obvious version of this test — "is the whole old string a prefix of the
/// new one" — is true for streamed prose and false for the single most common
/// long construct in model output. An unclosed fenced code block projects its
/// literal with a trailing newline, so every delta inside the block is an
/// insertion BEFORE the last character ("fu\n" -> "func\n" -> "functi\n"): a
/// prefix-only test misses on every snapshot for the whole duration of the
/// block, and the run takes the full-swap path — full assignment, full
/// relayout, and a positional selection restore onto text whose characters
/// moved — hundreds of times in a row. With a suffix too, that block is a
/// two-character insert at a stable offset, and a plain append is the same
/// plan with an empty suffix.
///
/// WHY IT IS ITS OWN TYPE RATHER THAN A METHOD ON THE VIEW. It touches no
/// UIKit — `NSAttributedString` and `NSString` are the entire surface — so
/// unlike everything in `SelectableRunHostView` it can be compiled and run
/// outside a simulator, and it is the one part of `apply` that is pure:
/// same two strings in, same plan out, no view state anywhere. That is
/// exactly the part worth being able to exercise.
enum RNSMTextSplice {

  /// A retained prefix and a retained suffix, in UTF-16 code units, measured
  /// from the two strings' respective ends. Both are counts, not offsets, so
  /// the retained prefix is `0 ..< prefix` in both strings while the retained
  /// suffix is the last `suffix` units of each — which is the whole point:
  /// the same characters sit at different offsets on the two sides, and the
  /// difference is exactly the length delta.
  ///
  /// The guarantees the caller relies on, all established below:
  ///
  ///   * `prefix + suffix <= min(current.length, next.length)`, so the two
  ///     regions never overlap and the replaced middle is never negative;
  ///   * the retained regions are equal in BOTH strings, character and
  ///     attribute, so splicing the middle produces exactly `next`;
  ///   * neither boundary falls between a surrogate pair, so no splice can
  ///     cut a scalar that was previously whole.
  struct Plan: Equatable {
    let prefix: Int
    let suffix: Int

    /// Nothing is shared: the caller's cue to take the full-swap path rather
    /// than a replace-everything splice, which buys nothing.
    var isEmpty: Bool { prefix == 0 && suffix == 0 }
  }

  /// UTF-16 units compared per `getCharacters` call. Chunked rather than
  /// per-character (`character(at:)` is an Objective-C message per unit) and
  /// rather than whole-string (a full copy of both sides just to find that
  /// the first unit differs). The size is arbitrary within reason: big
  /// enough that the call overhead disappears, small enough that a one-unit
  /// answer copies almost nothing.
  private static let chunk = 512

  /// The plan for turning `current` into `next`.
  ///
  /// Both halves are computed in two stages — characters first, then
  /// attributes — because they fail at different places and the character
  /// scan is by far the cheaper of the two. A styling pass over settled
  /// prose (a block finishing, a link resolving) changes attributes without
  /// changing a character, so the attribute stage is what shortens the
  /// retained region to where the styling actually diverged, instead of
  /// throwing the whole snapshot at the full-swap path.
  static func plan(from current: NSAttributedString, to next: NSAttributedString) -> Plan {
    let currentLength = current.length
    let nextLength = next.length
    // The most either half can retain: the whole shorter string. Both being
    // zero is the answer for an empty side, and it is the caller's full-swap
    // cue rather than a special case here.
    let ceiling = min(currentLength, nextLength)
    if ceiling == 0 {
      return Plan(prefix: 0, suffix: 0)
    }

    let currentString = current.string as NSString
    let nextString = next.string as NSString

    var prefix = commonPrefixLength(currentString, nextString, limit: ceiling)
    prefix = attributeEqualPrefixLength(current, next, limit: prefix)
    // A boundary immediately after a high surrogate would cut a pair in half
    // and hand `replaceCharacters` a lone half of a scalar. Backing off one
    // unit is always safe: the pair is then wholly inside the replaced
    // middle, which is written from `next` verbatim.
    if prefix > 0, isHighSurrogate(currentString.character(at: prefix - 1)) {
      prefix -= 1
    }

    // `ceiling - prefix` keeps the two regions disjoint: whatever the prefix
    // claimed, the suffix may not claim again.
    var suffix = commonSuffixLength(currentString, nextString, limit: ceiling - prefix)
    suffix = attributeEqualSuffixLength(current, next, limit: suffix)
    // Same surrogate rule at the other boundary, one unit later instead of
    // one earlier: a suffix that STARTS on a low surrogate would leave its
    // high half in the replaced middle.
    if suffix > 0, isLowSurrogate(currentString.character(at: currentLength - suffix)) {
      suffix -= 1
    }

    return Plan(prefix: prefix, suffix: suffix)
  }

  // MARK: - Selection

  /// Whether the splice REWROTE the characters `saved` covers — as opposed to
  /// leaving them alone, at these offsets or at shifted ones.
  ///
  /// It is the exact complement of `selection(after:)`'s two preserving
  /// cases, and the two must stay that way: a selection wholly inside the
  /// retained head or wholly inside the retained tail keeps covering the same
  /// characters, and everything else — including a Select-All and a plan that
  /// retained nothing — overlaps text the splice replaced.
  ///
  /// The caller is `apply`, deciding whether to re-announce a selection whose
  /// OFFSETS did not move. A range compare cannot see this: a repaired tail
  /// can rewrite the characters under an unmoved selection, and the payload
  /// JS derives from those offsets is then stale. An insertion whose replaced
  /// middle is EMPTY still counts when it lands inside the selection, which
  /// is why this is a case test and not a range intersection — `NSRange`
  /// arithmetic makes a zero-length middle intersect nothing.
  static func rewrites(_ plan: Plan, saved: NSRange, previousLength: Int) -> Bool {
    if saved.length == 0 { return false }
    if NSMaxRange(saved) <= plan.prefix { return false }
    if saved.location >= previousLength - plan.suffix { return false }
    return true
  }

  /// Where a non-empty selection belongs once `plan` has been spliced in.
  ///
  /// Here rather than in the view for the same reason `plan` is: it is a
  /// function of the plan and the pre-edit range and of nothing else, so it
  /// can be exercised without a text view. The four cases are ordered by how
  /// much they know, from "the same characters at the same offsets" down to
  /// "those characters are gone, clamp".
  ///
  /// `hadSelectAll` is the caller's answer to "did this cover the whole old
  /// text": such a selection keeps meaning "all of it" and extends over the
  /// new text rather than freezing at the old end on every streamed snapshot.
  static func selection(
    after plan: Plan,
    saved: NSRange,
    hadSelectAll: Bool,
    previousLength: Int,
    newLength: Int
  ) -> NSRange {
    if hadSelectAll {
      return NSRange(location: 0, length: newLength)
    }
    // Wholly inside the retained head: nothing under it moved. (`rewrites`
    // above is the complement of this test and the next one; keep the three
    // in step.)
    if NSMaxRange(saved) <= plan.prefix {
      return saved
    }
    // Wholly inside the retained tail: the same characters, at offsets
    // shifted by however much the replaced middle grew or shrank. This is
    // what keeps a selection inside settled prose valid while a code block
    // above it is still streaming.
    if saved.location >= previousLength - plan.suffix {
      return NSRange(
        location: saved.location + (newLength - previousLength), length: saved.length)
    }
    // Overlapping the replaced middle: some of the selected characters are
    // gone, so clamp instead of dropping — the offsets stay in bounds, which
    // is what lets JS trust an event unconditionally, and a shrink
    // (reset/replace) cannot leave an out-of-bounds selection.
    let start = min(saved.location, newLength)
    let end = min(saved.location + saved.length, newLength)
    return NSRange(location: start, length: end - start)
  }

  // MARK: - Characters

  private static func isHighSurrogate(_ unit: unichar) -> Bool {
    unit >= 0xD800 && unit <= 0xDBFF
  }

  private static func isLowSurrogate(_ unit: unichar) -> Bool {
    unit >= 0xDC00 && unit <= 0xDFFF
  }

  /// Leading UTF-16 units `a` and `b` share, at most `limit`.
  private static func commonPrefixLength(_ a: NSString, _ b: NSString, limit: Int) -> Int {
    var matched = 0
    var bufferA = [unichar](repeating: 0, count: chunk)
    var bufferB = [unichar](repeating: 0, count: chunk)
    while matched < limit {
      let span = min(chunk, limit - matched)
      a.getCharacters(&bufferA, range: NSRange(location: matched, length: span))
      b.getCharacters(&bufferB, range: NSRange(location: matched, length: span))
      var index = 0
      while index < span, bufferA[index] == bufferB[index] {
        index += 1
      }
      matched += index
      if index < span {
        break
      }
    }
    return matched
  }

  /// Trailing UTF-16 units `a` and `b` share, at most `limit` — counted from
  /// each string's own end, which is what makes this work across a length
  /// change.
  private static func commonSuffixLength(_ a: NSString, _ b: NSString, limit: Int) -> Int {
    var matched = 0
    var bufferA = [unichar](repeating: 0, count: chunk)
    var bufferB = [unichar](repeating: 0, count: chunk)
    while matched < limit {
      let span = min(chunk, limit - matched)
      a.getCharacters(
        &bufferA, range: NSRange(location: a.length - matched - span, length: span))
      b.getCharacters(
        &bufferB, range: NSRange(location: b.length - matched - span, length: span))
      var index = 0
      while index < span, bufferA[span - 1 - index] == bufferB[span - 1 - index] {
        index += 1
      }
      matched += index
      if index < span {
        break
      }
    }
    return matched
  }

  // MARK: - Attributes

  /// Whether two attribute dictionaries are the same styling.
  ///
  /// Through `NSDictionary` rather than a Swift `==`: the values are
  /// `UIFont`, `UIColor`, `NSParagraphStyle`, `NSNumber` and (for an embed)
  /// an `NSTextAttachment` — Objective-C objects whose equality is
  /// `-isEqual:`, which is also the equality `NSAttributedString.isEqual(to:)`
  /// applies. Comparing them any other way would answer a different question
  /// from the one the caller's early-out asks.
  private static func attributesEqual(
    _ a: [NSAttributedString.Key: Any], _ b: [NSAttributedString.Key: Any]
  ) -> Bool {
    NSDictionary(dictionary: a).isEqual(NSDictionary(dictionary: b))
  }

  /// The longest `p <= limit` for which `a` and `b` carry identical
  /// attributes over `0 ..< p`.
  ///
  /// Walked by attribute RUN rather than by character:
  /// `attributes(at:longestEffectiveRange:in:)` answers with the whole span
  /// over which the dictionary is constant, so this costs one dictionary
  /// compare per styled range rather than one per character — and a run's
  /// styling is a handful of ranges (docs/FABRIC-PLAN.md §6.3 measures a p50
  /// of one and a p90 of three).
  private static func attributeEqualPrefixLength(
    _ a: NSAttributedString, _ b: NSAttributedString, limit: Int
  ) -> Int {
    var index = 0
    while index < limit {
      var rangeA = NSRange(location: 0, length: 0)
      var rangeB = NSRange(location: 0, length: 0)
      let search = NSRange(location: index, length: limit - index)
      let attributesA = a.attributes(at: index, longestEffectiveRange: &rangeA, in: search)
      let attributesB = b.attributes(at: index, longestEffectiveRange: &rangeB, in: search)
      guard attributesEqual(attributesA, attributesB) else {
        return index
      }
      // The shorter of the two runs: past it, one side's styling changes and
      // the other's may not, so that is where the next compare belongs.
      index = min(NSMaxRange(rangeA), NSMaxRange(rangeB))
    }
    return limit
  }

  /// The longest `s <= limit` for which the last `s` units of `a` and of `b`
  /// carry identical attributes. Same run walk as the prefix version, from
  /// the other end and against each string's own length.
  private static func attributeEqualSuffixLength(
    _ a: NSAttributedString, _ b: NSAttributedString, limit: Int
  ) -> Int {
    var kept = 0
    let searchA = NSRange(location: a.length - limit, length: limit)
    let searchB = NSRange(location: b.length - limit, length: limit)
    while kept < limit {
      let indexA = a.length - kept - 1
      let indexB = b.length - kept - 1
      var rangeA = NSRange(location: 0, length: 0)
      var rangeB = NSRange(location: 0, length: 0)
      let attributesA = a.attributes(at: indexA, longestEffectiveRange: &rangeA, in: searchA)
      let attributesB = b.attributes(at: indexB, longestEffectiveRange: &rangeB, in: searchB)
      guard attributesEqual(attributesA, attributesB) else {
        return kept
      }
      // How far back both runs reach from here, inclusive of the unit just
      // compared. Both effective ranges are clipped to the search ranges, so
      // this can never step past `limit`.
      kept += min(indexA - rangeA.location, indexB - rangeB.location) + 1
    }
    return limit
  }
}
