import Foundation

/// The head and tail two attributed strings share, so `apply` splices only the middle.
/// The tail matters: an unclosed code fence streams every insert before its trailing "\n".
enum RNSMTextSplice {

  /// UTF-16 counts; `suffix` is measured from each string's own end. Guarantees:
  /// `prefix + suffix <= min(current.length, next.length)`, both retained regions are
  /// equal in characters and attributes, and neither boundary splits a surrogate pair.
  struct Plan: Equatable {
    let prefix: Int
    let suffix: Int

    /// Nothing shared: callers take the full-swap path instead of splicing.
    var isEmpty: Bool { prefix == 0 && suffix == 0 }
  }

  /// UTF-16 units per `getCharacters` call; `character(at:)` costs an Objective-C message per unit.
  private static let chunk = 512

  static func plan(from current: NSAttributedString, to next: NSAttributedString) -> Plan {
    let currentLength = current.length
    let nextLength = next.length
    let ceiling = min(currentLength, nextLength)
    if ceiling == 0 {
      return Plan(prefix: 0, suffix: 0)
    }

    let currentString = current.string as NSString
    let nextString = next.string as NSString

    var prefix = commonPrefixLength(currentString, nextString, limit: ceiling)
    prefix = attributeEqualPrefixLength(current, next, limit: prefix)
    // Never end the prefix on a high surrogate; the whole pair then lands in the replaced middle.
    if prefix > 0, isHighSurrogate(currentString.character(at: prefix - 1)) {
      prefix -= 1
    }

    var suffix = commonSuffixLength(currentString, nextString, limit: ceiling - prefix)
    suffix = attributeEqualSuffixLength(current, next, limit: suffix)
    // Never start the suffix on a low surrogate.
    if suffix > 0, isLowSurrogate(currentString.character(at: currentLength - suffix)) {
      suffix -= 1
    }

    return Plan(prefix: prefix, suffix: suffix)
  }

  // MARK: - Selection

  /// Whether the splice rewrote characters under `saved`: the exact complement of
  /// `selection(after:)`'s two preserving cases. A case test, not `NSIntersectionRange`,
  /// because an empty replaced middle inside the selection intersects nothing yet still counts.
  static func rewrites(_ plan: Plan, saved: NSRange, previousLength: Int) -> Bool {
    if saved.length == 0 { return false }
    if NSMaxRange(saved) <= plan.prefix { return false }
    if saved.location >= previousLength - plan.suffix { return false }
    return true
  }

  /// Where a non-empty `saved` selection lands after the splice;
  /// `hadSelectAll` extends it over the new text.
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
    // `rewrites` is the complement of these two tests; keep them in step.
    if NSMaxRange(saved) <= plan.prefix {
      return saved
    }
    if saved.location >= previousLength - plan.suffix {
      return NSRange(
        location: saved.location + (newLength - previousLength), length: saved.length)
    }
    // Clamp rather than drop: JS trusts these offsets without a bounds check.
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

  /// Through `NSDictionary.isEqual`: the `-isEqual:` that `NSAttributedString.isEqual(to:)` uses.
  private static func attributesEqual(
    _ a: [NSAttributedString.Key: Any], _ b: [NSAttributedString.Key: Any]
  ) -> Bool {
    // The host applies edge insets to its container, outside the text storage.
    let metadata = NSAttributedString.Key("RNSMRunEdgeInsets")
    var left = a
    var right = b
    left.removeValue(forKey: metadata)
    right.removeValue(forKey: metadata)
    return NSDictionary(dictionary: left).isEqual(NSDictionary(dictionary: right))
  }

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
      index = min(NSMaxRange(rangeA), NSMaxRange(rangeB))
    }
    return limit
  }

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
      // Effective ranges are clipped to the search ranges, so this never passes `limit`.
      kept += min(indexA - rangeA.location, indexB - rangeB.location) + 1
    }
    return limit
  }
}
