import UIKit
import React

/// Native host for one selectable markdown "run" (a merged sequence of prose
/// blocks projected to a single text). The JS side owns all markdown
/// semantics; this view's whole contract is:
///
///   props:  `text` (the projected run text), `attributes` (styled ranges
///           over that text), `pressables` (tappable ranges over that text),
///           `selectable`, `selectionActions` (ordered action identifiers:
///           "copy-text" | "copy-markdown")
///   events: `onSelectionAction({ start, end, action, selectedText })` where
///           start/end are UTF-16 code-unit offsets into the CURRENT value
///           of `text`, end-exclusive, clamped, start <= end, and `action`
///           is the identifier of the menu item the user tapped;
///           `onInlinePress({ start, end, pressableId })` when a single tap
///           lands inside one of `pressables` — same offset guarantees, and
///           `pressableId` is JS's identifier for the range, echoed verbatim.
///
/// `onSelectionAction` fires when the user invokes "Copy Text" or "Copy
/// Markdown" from the edit menu. JS maps the offsets through the run's piece
/// table back to a markdown SourceSpan and writes the payload to the
/// pasteboard — this view never touches the pasteboard for these actions
/// itself. The system Copy item is left untouched: it already yields the
/// displayed plain text without any JS involvement.
///
/// `onInlinePress` is how a link inside a run gets to be tappable at all:
/// this view renders the whole run as one attributed string, so the JS
/// fallback's per-node `onPress` has nothing to attach to here. JS sends the
/// ranges that are live links, this view hit-tests single taps against them,
/// and the URL never crosses the bridge — the view stays as free of markdown
/// semantics as it is for selection.
///
/// `attributes` is what makes this host render markdown rather than a wall
/// of system text. Each entry is a range of `text` plus the parts of a text
/// style it changes; JS derives them from the same projection that produced
/// `text`, so they describe exactly what the JS fallback's `<Text>` tree
/// renders. Crucially they change how the text LOOKS and never what it IS —
/// no character is added, removed or reordered — so the offsets this view
/// reports back still index the projected text the way JS expects.
///
/// Mounted by `RCTSelectableRunHostComponentView` (platform/ios/fabric/), and
/// only by it. The old-architecture view manager that used to be the other
/// wrapper is gone with the package's `react-native >= 0.82` floor, where the
/// new architecture is the only architecture (React Native's own
/// react_native_pods.rb refuses `RCT_NEW_ARCH_ENABLED=0` from 0.82 on).
///
/// One consequence is worth stating because it used to be the other way
/// round: this class does not build its own string. The run was measured by
/// `RNSMRunHostShadowNode::measureContent` on the layout thread before the
/// frame was committed, and the finished `NSAttributedString` arrives through
/// `apply(attributedText:)`. Nothing here may be `#if`'d on the architecture
/// either — `RCT_NEW_ARCH_ENABLED` reaches `spec.compiler_flags` and
/// `OTHER_CPLUSPLUSFLAGS` only (new_architecture.rb:89,101) and is never a
/// Swift compilation condition.
///
/// Full contract documentation: docs/SELECTION.md.
@objc(SelectableRunHostView)
public final class SelectableRunHostView: UIView {

  /// Emitted with the clamped selection range, the action identifier and the
  /// selected text. Wired by whichever wrapper mounted this view.
  ///
  /// A plain Swift closure rather than an `RCTDirectEventBlock`: Fabric wants
  /// a C++ struct handed to the component's `EventEmitter`, so this class
  /// emits values and the mounting layer owns the wire format. Typing it as a
  /// block taking an `NSDictionary` would make the mounting layer build one
  /// purely to take it apart again.
  @objc public var onSelectionAction: ((Int, Int, NSString, NSString) -> Void)?

  /// Emitted when a single tap lands inside one of `pressables`, with the
  /// range (clamped to the current text) and JS's identifier for it. A plain
  /// closure for the same reason `onSelectionAction` is: the mounting layer
  /// owns the wire format, so this class emits values.
  @objc public var onInlinePress: ((Int, Int, Int) -> Void)?

  /// Emitted per embed once layout has placed its reserved space, with the
  /// embed's id and the rect in this view's coordinates — and re-emitted only
  /// when the rect actually moved (see `reportEmbedRects`). A plain closure
  /// for the same reason the other two are: the mounting layer owns the wire
  /// format, so this class emits values.
  @objc public var onEmbedLayout: ((Int, Double, Double, Double, Double) -> Void)?

  /// Menu titles for the action identifiers JS may send. Unknown
  /// identifiers (newer JS driving an older binary) are dropped rather than
  /// rendered as untitled items.
  private static let actionTitles: [String: String] = [
    "copy-text": NSLocalizedString(
      "Copy Text", comment: "Selection menu: copy the selected plain text"),
    "copy-markdown": NSLocalizedString(
      "Copy Markdown", comment: "Selection menu: copy the markdown source"),
  ]

  private let textView: UITextView
  /// `selectionActions` sanitized to known identifiers, in prop order.
  private var resolvedActions: [String] = ["copy-text", "copy-markdown"]

  /// Every live host, weakly, for one-active-selection coordination: iOS
  /// never clears one non-editable text view's selection because another
  /// began one, so a transcript of many runs could show two highlighted
  /// selections at once — and only the newest has the handles and the menu.
  /// `textViewDidChangeSelection` sweeps this table and clears every other
  /// host's selection the moment a non-empty selection lands here. Weak
  /// objects, so unmounted hosts fall out on their own; main-thread only,
  /// like every other UIKit touch in this file.
  private static let liveHosts = NSHashTable<SelectableRunHostView>.weakObjects()

  /// One tappable range: `pressables` parsed on arrival. `id` is JS's
  /// identifier for the range (its index into the prop as sent), echoed back
  /// verbatim in the event.
  private struct Pressable {
    let range: NSRange
    let id: Int
  }

  /// `pressables` parsed to well-formed ranges, in prop order. Ranges never
  /// overlap (links cannot nest), so the first containing range found is the
  /// only one.
  private var resolvedPressables: [Pressable] = []

  /// One embedded range: `embeds` parsed on arrival. `id` is JS's identifier
  /// for the embed (its index into the prop as sent), echoed back verbatim in
  /// `onEmbedLayout`; `size` is the declared reservation, reported rather
  /// than re-measured so the overlay is sized by the same numbers the
  /// attachment reserved.
  private struct Embed {
    let range: NSRange
    let id: Int
    let size: CGSize
  }

  /// `embeds` parsed to well-formed entries, in prop order.
  private var resolvedEmbeds: [Embed] = []

  /// The last rect reported per embed id — the dedupe that keeps streaming
  /// appends past a settled embed from re-announcing it every snapshot. Keyed
  /// by id rather than index so a prop update that reorders entries still
  /// compares each embed against its own last report.
  private var lastEmbedRects: [Int: CGRect] = [:]


  /// One block-chrome instruction, parsed from the `decorations` prop. Only
  /// the two DRAWN kinds are kept — 'columns' is layout, consumed entirely by
  /// the string builder, and holding it here would imply draw code that does
  /// not exist.
  private struct Decoration {
    enum Kind {
      case box
      case rule
    }
    let kind: Kind
    let range: NSRange
    let fill: UIColor?
    let borderColor: UIColor?
    let borderWidth: CGFloat
    let borderRadius: CGFloat
    let topCornersOnly: Bool
    let barColor: UIColor?
    let barWidth: CGFloat
    let paddingTop: CGFloat
    let paddingBottom: CGFloat
    let thickness: CGFloat
    let alignTop: Bool
    let inset: CGFloat
  }

  /// `decorations` parsed on arrival, in prop order. Painted in `draw(_:)`
  /// behind the text view — fills, then blockquote bars, then strokes, so a
  /// table's header band never covers the border drawn around it and an
  /// island's fill never covers a quote's bar.
  private var resolvedDecorations: [Decoration] = []

  /// Recognizes single taps on pressable ranges. Created after `super.init`
  /// (its target is `self`), so the slot is optional; it is never nil once
  /// init returns. Disabled whenever `resolvedPressables` is empty — JS sends
  /// an empty list when nothing listens — so a host with nothing to report
  /// never participates in the text view's gesture arbitration at all, and
  /// the delegate gate below keeps even an enabled recognizer from receiving
  /// touches that land outside every pressable range. Selection gestures
  /// (long-press, handle drags) are different recognizers and are never
  /// contested.
  private var inlineTapRecognizer: UITapGestureRecognizer?
  public override init(frame: CGRect) {
    // TextKit 1 opt-in. On iOS 16+ UITextView defaults to TextKit 2, which
    // rebuilds layout (and visibly drops the selection UI) when the backing
    // store is swapped mid-stream. Keeping TextKit 1 keeps selection geometry
    // stable across the text swaps that streaming performs on every
    // settled-prefix update.
    //
    // The opt-in is done by handing UITextView a container from
    // RNSMTextKitStack rather than by asking for
    // `UITextView(usingTextLayoutManager: false)`, and the difference is the
    // whole reason that factory exists. `initWithFrame:textContainer:` adopts
    // the entire stack we built — storage, layout manager, container — so this
    // view draws with `usesFontLeading = NO` and `lineFragmentPadding = 0`,
    // which are the same values the Fabric shadow node measured with. The
    // `usingTextLayoutManager:` initializer leaves `usesFontLeading` at
    // UIKit's YES, and the resulting half-point-per-line disagreement between
    // the measured height and the drawn height shows up as a run clipped at
    // its last line, worse the longer the run. On the old architecture that
    // could not happen — the view measured itself with `sizeThatFits` — so
    // this is new exposure that came in with the port, not an old bug.
    //
    // The initial container size is only a starting value: the factory sets
    // `widthTracksTextView`, so the width follows this view's bounds, and the
    // height stays unbounded because the RN ancestry owns scrolling.
    // THE STACK IS BOUND TO A LOCAL BEFORE THE CONTAINER IS TAKEN OUT OF IT,
    // and it must be. The storage is the root of the TextKit 1 graph and the
    // container is the leaf (RNSMTextKitStack.h documents the ownership at
    // length), so a nested call that let the storage die would hand
    // `initWithFrame:textContainer:` a container with no layout manager, and
    // UIKit raises `NSInternalInconsistencyException` — "text container must
    // already have a layout manager" — out of an initialiser Swift cannot
    // catch. That is a hard crash on the first run that mounts.
    //
    // `with:`, not `withSize:` — Swift's omit-needless-words import drops
    // the `Size` from `+makeTextStackWithSize:` because the parameter's
    // type is already `CGSize`, leaving the bare preposition. Spelling the
    // Objective-C selector here instead is a compile error, and it is the
    // kind that only surfaces in a consumer's `xcodebuild`, so
    // `npm run check:swift` compiles this file against React Native's real
    // headers rather than leaving it to review.
    // `CGFloat.greatestFiniteMagnitude` written out: with a bare `0` for the
    // width there is nothing to pin the literal type, and `CGSize` has
    // initialisers taking CGFloat, Double and Int, so `.greatestFiniteMagnitude`
    // alone is `error: ambiguous use of 'greatestFiniteMagnitude'`.
    let stack = RNSMTextKitStack.makeTextStack(
      with: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    // No stored property for `stack`: `UITextView` adopts the container's whole
    // stack and retains the storage itself, so it outlives this local and dies
    // with the view. That is verified behaviour, not an assumption — but it is
    // also the reason the local exists at all, so do not inline it back.
    textView = UITextView(
      frame: .zero,
      textContainer: RNSMTextKitStack.textContainer(ofStack: stack))
    super.init(frame: frame)

    // One-active-selection coordination — see `liveHosts`.
    Self.liveHosts.add(self)

    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false // the RN ancestry owns scrolling
    textView.backgroundColor = .clear
    // UITextView adds {8,0,8,0} of its own, which the measurement — which
    // knows only about the text container — cannot see. Zeroing it here is
    // what makes `sizeThatFits` and RNSMTextKitStack agree; the container's
    // own padding is already zeroed by the factory.
    textView.textContainerInset = .zero
    textView.delegate = self

    // Decoration drawing. The host's own layer content renders BELOW its
    // subviews, which is exactly where block chrome belongs: boxes and rules
    // behind the text, the platform's selection highlight above them.
    // `.redraw` because every decoration is positioned off the text layout,
    // and a width change relays out the text.
    isOpaque = false
    contentMode = .redraw

    // Dynamic Type is deliberately not enabled here, and this note exists so
    // it is not re-added as an obvious one-liner. This view used to set
    // `adjustsFontForContentSizeCategory = true`, which did nothing: it only
    // scales fonts built through UIFontMetrics, and every font in
    // RNSMAttributedText comes from `UIFont(name:size:)` or
    // `UIFont.systemFont(ofSize:)`. So it was a line that claimed a feature
    // the view did not have. A *working* version would be worse than useless
    // under Fabric: it scales at draw time, on the main thread, against a
    // string the shadow node already measured unscaled, so every run would be
    // laid out at one size and drawn at another. Doing it properly means
    // threading `layoutContext.fontSizeMultiplier`
    // (react/renderer/core/LayoutContext.h:55, set at
    // React/Fabric/Surface/RCTFabricSurface.mm) into the string builder and
    // re-measuring on UIContentSizeCategoryDidChangeNotification, which is
    // its own diff (docs/FABRIC-PLAN.md §6.2).

    addSubview(textView)

    // On the text view, not on self: the hit test converts the touch point
    // straight into the text container's coordinates, and the text view is
    // the view whose bounds the glyphs are laid out in.
    let tap = UITapGestureRecognizer(target: self, action: #selector(handleInlineTap(_:)))
    tap.delegate = self
    tap.isEnabled = false
    textView.addGestureRecognizer(tap)
    inlineTapRecognizer = tap
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("SelectableRunHostView is created from the view manager only")
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    // A width change moves where every embed's line wraps to, with no text
    // change to trigger a report — the dedupe in reportEmbedRects makes the
    // no-move case one dictionary compare per embed.
    reportEmbedRects()
  }

  // MARK: - Props

  /// Block chrome over `text`: an array of dictionaries with `start`/`end`
  /// (UTF-16 offsets, end-exclusive), a `kind` ('box' | 'rule' | 'columns' |
  /// 'indent') and the kind's styling. Two lives, one prop: the drawn kinds
  /// are parsed here and painted in `draw(_:)`, and the layout-affecting
  /// parts ('columns', 'indent', a box's `textInset`) were consumed by the
  /// string builder on the layout thread — the measured string arrives
  /// through State, built from these same props, so only the
  /// parse-for-drawing half matters here.
  @objc public var decorations: NSArray = [] {
    didSet {
      resolvedDecorations = decorations.compactMap(Self.parseDecoration(_:))
      setNeedsDisplay()
    }
  }

  /// Embedded ranges over `text`: an array of dictionaries with `start`/`end`
  /// (always a 1-unit range over the U+FFFC placeholder JS projected),
  /// `embedId`, `width`, `height`. The layout-affecting half — the invisible
  /// attachment that reserves the declared size — was consumed by the string
  /// builder on the layout thread, exactly like a decoration's insets: the
  /// measured string arrives through State, built from these same props. Only
  /// the parse-for-reporting half matters here: `reportEmbedRects` reads this
  /// list to say where each reservation landed.
  @objc public var embeds: NSArray = [] {
    didSet {
      resolvedEmbeds = embeds.compactMap { entry in
        guard let dictionary = entry as? [String: Any],
              let start = (dictionary["start"] as? NSNumber)?.intValue,
              let end = (dictionary["end"] as? NSNumber)?.intValue,
              let id = (dictionary["embedId"] as? NSNumber)?.intValue,
              let width = (dictionary["width"] as? NSNumber)?.doubleValue,
              let height = (dictionary["height"] as? NSNumber)?.doubleValue,
              start >= 0, end == start + 1, width > 0, height > 0 else { return nil }
        return Embed(
          range: NSRange(location: start, length: 1),
          id: id,
          size: CGSize(width: width, height: height))
      }
      // A changed list invalidates every previous report: an id that no
      // longer exists must not suppress a future report for a reused id, and
      // an embed whose size changed must re-report even if its origin did
      // not move.
      lastEmbedRects.removeAll()
    }
  }


  /// Install the newly styled string. Two paths, chosen per call:
  ///
  /// **Append fast path** — the new string is strictly longer and its prefix
  /// of the old length equals the current storage content (text AND
  /// attributes). Streaming re-publishes a complete string on every snapshot
  /// even when only the tail changed — a block settling used to relayout the
  /// ENTIRE accumulated run — but TextKit invalidates layout per edited
  /// range, so splicing only the suffix into the storage relayouts only the
  /// new tail. The prefix compare is O(prefix) character-and-attribute
  /// equality with no glyph shaping, far cheaper than the full relayout it
  /// avoids. An in-progress selection lives in the untouched prefix, so it
  /// stays valid by construction — no save/clamp/restore at all.
  ///
  /// **Full swap** — every other case: a shrink (reset/replace), a prefix
  /// that changed (a styling pass over settled prose, or UIKit's own
  /// attribute fixing having mutated the storage since it was set — the
  /// compare then fails and the swap is the safe degradation), preserving
  /// the selection save -> swap -> restore clamped. Equal input returns
  /// without touching the storage: nothing moved, nothing to lay out, draw
  /// or report.
  ///
  /// It takes a finished string rather than building one because on Fabric the
  /// string this view must draw is the exact object the shadow node measured,
  /// carried across through Fabric State. Rebuilding an equal-looking string
  /// here would reintroduce the possibility that the measured and the drawn
  /// text differ, which is the one failure the port is shaped to make
  /// impossible (docs/FABRIC-PLAN.md §4).
  @objc public func apply(attributedText: NSAttributedString) {
    // The TextKit 1 storage adopted in init; `textView.attributedText` reads
    // and writes the same object, so its length is the previous text's
    // UTF-16 length.
    let storage = textView.textStorage
    let previousLength = storage.length
    let newLength = attributedText.length

    // Equal content: early out before any storage touch. `isEqual(to:)`
    // compares text and attributes, so a styling-only change never lands
    // here and still reaches the swap below.
    if newLength == previousLength, attributedText.isEqual(to: storage) {
      return
    }

    if newLength > previousLength,
      attributedText.attributedSubstring(
        from: NSRange(location: 0, length: previousLength)
      ).isEqual(to: storage) {
      let saved = textView.selectedRange
      // Same Select-All policy as the full-swap restore below: a selection
      // covering the whole old text keeps meaning "all of it" and extends
      // over the appended tail. Any other selection is inside the prefix
      // (clamped there by every previous apply) and is left alone.
      let hadSelectAll =
        saved.length > 0 && saved.location == 0 && saved.length == previousLength
      // NSRange boundaries are UTF-16 code-unit offsets, and previousLength
      // was a boundary of this very prefix, so the splice point can never
      // split a scalar that was previously whole.
      storage.beginEditing()
      storage.replaceCharacters(
        in: NSRange(location: previousLength, length: 0),
        with: attributedText.attributedSubstring(
          from: NSRange(
            location: previousLength, length: newLength - previousLength)))
      storage.endEditing()
      if hadSelectAll {
        textView.selectedRange = NSRange(location: 0, length: newLength)
      }
      // Appended text can move end-anchored decorations and always moves the
      // measured height.
      setNeedsDisplay()
      // Settled embeds live in the untouched prefix, so their rects almost
      // never move on an append — the dedupe makes this a per-embed compare.
      reportEmbedRects()
      return
    }

    let saved = textView.selectedRange
    // Select-All preservation: a selection that covered the whole old text
    // keeps meaning "all of it" and tracks the growing document, instead of
    // freezing at the old end on every streamed append.
    let hadSelectAll =
      saved.length > 0 && saved.location == 0 && saved.length == previousLength

    textView.attributedText = attributedText

    if saved.length > 0 {
      if hadSelectAll {
        textView.selectedRange = NSRange(location: 0, length: newLength)
      } else {
        // Clamp instead of dropping: prefix-append streaming means the old
        // range is almost always still valid; a shrink (reset/replace) must
        // not leave an out-of-bounds selection.
        let start = min(saved.location, newLength)
        let end = min(saved.location + saved.length, newLength)
        textView.selectedRange = NSRange(location: start, length: end - start)
      }
    }
    // Text moved, so every decoration's geometry did too.
    setNeedsDisplay()
    reportEmbedRects()
  }

  @objc public var selectable: Bool = true {
    didSet { textView.isSelectable = selectable }
  }

  /// Tappable ranges over `text`: an array of dictionaries with `start`/`end`
  /// (UTF-16 offsets, end-exclusive) and `pressableId` (JS's identifier for
  /// the range, echoed back verbatim in `onInlinePress`). Parsed on arrival,
  /// like `selectionActions`: a malformed or empty entry is dropped rather
  /// than trusted at hit-test time.
  ///
  /// Deliberately NOT part of the styled string: what is tappable and what is
  /// drawn are independent channels, so a pressables-only update never
  /// remeasures — which on this platform would put an in-progress selection
  /// through a needless save/clamp/restore.
  @objc public var pressables: NSArray = [] {
    didSet {
      resolvedPressables = pressables.compactMap { entry in
        guard let dictionary = entry as? [String: Any],
              let start = (dictionary["start"] as? NSNumber)?.intValue,
              let end = (dictionary["end"] as? NSNumber)?.intValue,
              let id = (dictionary["pressableId"] as? NSNumber)?.intValue,
              start >= 0, end > start else { return nil }
        return Pressable(range: NSRange(location: start, length: end - start), id: id)
      }
      inlineTapRecognizer?.isEnabled = !resolvedPressables.isEmpty
    }
  }

  /// Ordered action identifiers for the custom edit-menu items. JS sends an
  /// empty array when no `onSelectionCopy` listener exists, so the menu
  /// never offers an item that would visibly do nothing.
  @objc public var selectionActions: NSArray = ["copy-text", "copy-markdown"] {
    didSet {
      resolvedActions = selectionActions.compactMap { entry in
        guard let identifier = entry as? String,
              Self.actionTitles[identifier] != nil else { return nil }
        return identifier
      }
    }
  }

  // MARK: - Commands


  // MARK: - Recycling

  /// Drop everything about the run this view was last showing.
  ///
  /// Called from the Fabric component view's `prepareForRecycle`, and it is a
  /// correctness requirement rather than hygiene. Fabric pools component views
  /// and hands a used one to a different run; a recycled host that kept its
  /// selection and its live edit menu would let the user tap "Copy Markdown"
  /// on handles left over from the previous run. Nothing throws — the offsets
  /// are valid — they are simply mapped through the *new* run's piece table,
  /// and the app receives a well-formed payload of markdown the user never
  /// selected. That is the worst failure this library can have and it is
  /// completely silent (docs/SELECTION.md, "View recycling").
  ///
  /// It deliberately does NOT touch `selectable`, `selectionActions` or
  /// `pressables`. Those
  /// are prop-derived, and `RCTViewComponentView` diffs incoming props against
  /// the props it last applied — which survive recycling, because
  /// `prepareForRecycle` does not reset `_props`
  /// (React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm
  /// :452-470). Resetting a prop-derived value here would leave the view
  /// disagreeing with `_props`, and the next run would silently skip the
  /// setter that would have fixed it: a run mounted `selectable={false}` by
  /// the tail policy would come back selectable.
  ///
  /// Resigning first responder is what dismisses a live edit menu. UITextView
  /// owns its `UIEditMenuInteraction` privately on iOS 16+, so there is no
  /// menu object to dismiss directly; losing first responder is the supported
  /// route and it also drops the selection handles.
  @objc public func reset() {
    textView.attributedText = NSAttributedString()
    textView.selectedRange = NSRange(location: 0, length: 0)
    textView.resignFirstResponder()
    // The rect dedupe is NOT prop-derived — it is layout history — so unlike
    // `resolvedEmbeds` (which stays, like `resolvedDecorations` and
    // `pressables`: props survive recycling) it must go: a recycled host that
    // kept it would silently skip reporting a rect the next run's overlay
    // happens to share, and JS would position that overlay from a rect the
    // previous run reported — the same stale-state failure class as the
    // selection reset above.
    lastEmbedRects.removeAll()
    // `resolvedDecorations` is deliberately NOT cleared — it is prop-derived,
    // like `pressables`, and the props survive recycling. The redraw is what
    // matters: with the text emptied, `draw(_:)` paints nothing (it guards on
    // text length), so no chrome from the previous run outlives it.
    setNeedsDisplay()
  }

  // MARK: - Embed rects

  /// Report where each embed's reserved space landed, deduped against the
  /// last report per id so streaming appends past a settled embed cost one
  /// rect compare instead of one event per snapshot.
  ///
  /// Geometry comes off the SAME TextKit stack the view draws with, through
  /// the same primitives the hit test uses: `glyphRange(forCharacterRange:)`
  /// then `boundingRect(forGlyphRange:in:)`, which forces layout for the
  /// range if needed. Container coordinates are view points here — the
  /// container's `lineFragmentPadding` and the view's `textContainerInset`
  /// are both zeroed in init — plus the text view's frame origin, exactly as
  /// `lineBand` adds it for decorations.
  ///
  /// Every embed is re-verified against the CURRENT text (in range, still
  /// U+FFFC underneath), the same skew discipline as the builder: a stale
  /// entry reports nothing rather than a rect over prose.
  private func reportEmbedRects() {
    guard let emit = onEmbedLayout, !resolvedEmbeds.isEmpty else { return }
    let layoutManager = textView.layoutManager
    guard layoutManager.numberOfGlyphs > 0 else { return }
    let full = (textView.text ?? "") as NSString
    let origin = textView.frame.origin
    for embed in resolvedEmbeds {
      guard embed.range.location < full.length,
            full.character(at: embed.range.location) == 0xFFFC else { continue }
      let glyphRange = layoutManager.glyphRange(
        forCharacterRange: embed.range, actualCharacterRange: nil)
      guard glyphRange.length > 0 else { continue }
      var rect = layoutManager.boundingRect(
        forGlyphRange: glyphRange, in: textView.textContainer)
      rect.origin.x += origin.x
      rect.origin.y += origin.y
      if let last = lastEmbedRects[embed.id],
         abs(last.origin.x - rect.origin.x) <= 0.5,
         abs(last.origin.y - rect.origin.y) <= 0.5,
         abs(last.width - rect.width) <= 0.5,
         abs(last.height - rect.height) <= 0.5 {
        continue
      }
      lastEmbedRects[embed.id] = rect
      emit(embed.id, rect.origin.x, rect.origin.y, rect.width, rect.height)
    }
  }

  // MARK: - Decorations

  /// One entry off the wire, or nil for one this binary cannot use. Colours
  /// arrive as UIColor from the Fabric conversion; an 0xAARRGGBB NSNumber is
  /// still accepted so the wire format matches `attributes`, whose entries
  /// JS pre-processes with `processColor`.
  private static func parseDecoration(_ entry: Any) -> Decoration? {
    guard let dictionary = entry as? [String: Any],
          let start = (dictionary["start"] as? NSNumber)?.intValue,
          let end = (dictionary["end"] as? NSNumber)?.intValue,
          let kindName = dictionary["kind"] as? String,
          start >= 0, end >= start else { return nil }
    let kind: Decoration.Kind
    switch kindName {
    case "box": kind = .box
    case "rule": kind = .rule
    // 'columns' and 'indent' are builder-only (layout, no drawn half);
    // unknown kinds are newer JS driving an older binary.
    default: return nil
    }
    let number = { (key: String) -> CGFloat in
      CGFloat((dictionary[key] as? NSNumber)?.doubleValue ?? 0)
    }
    return Decoration(
      kind: kind,
      range: NSRange(location: start, length: end - start),
      fill: Self.decorationColor(dictionary["color"]),
      borderColor: Self.decorationColor(dictionary["borderColor"]),
      borderWidth: number("borderWidth"),
      borderRadius: number("borderRadius"),
      topCornersOnly: (dictionary["corners"] as? String) == "top",
      barColor: Self.decorationColor(dictionary["barColor"]),
      barWidth: number("barWidth"),
      paddingTop: number("paddingTop"),
      paddingBottom: number("paddingBottom"),
      thickness: number("thickness"),
      alignTop: (dictionary["align"] as? String) == "top",
      inset: number("inset"))
  }

  private static func decorationColor(_ value: Any?) -> UIColor? {
    if let color = value as? UIColor { return color }
    guard let number = value as? NSNumber else { return nil }
    // Through the Int32 bit pattern: processColor hands Android the signed
    // form and this side the same 32 bits, and a direct UInt32(truncating:)
    // of a negative double-boxed value would trap or saturate.
    let argb = UInt32(bitPattern: number.int32Value)
    return UIColor(
      red: CGFloat((argb >> 16) & 0xFF) / 255.0,
      green: CGFloat((argb >> 8) & 0xFF) / 255.0,
      blue: CGFloat(argb & 0xFF) / 255.0,
      alpha: CGFloat((argb >> 24) & 0xFF) / 255.0)
  }

  /// Paints the block chrome behind the text: code boxes, table borders and
  /// row rules, thematic breaks. Three passes — every fill, then every
  /// blockquote bar, then every stroke — so paint order cannot depend on the
  /// order JS happened to emit entries: a bar survives an island's opaque
  /// fill painted inside its quote (the marks sort quote-first, so the fill
  /// would otherwise land on top of it), while strokes stay above both.
  ///
  /// All geometry is read off the SAME TextKit stack the text view draws with
  /// (the RNSMTextKitStack opt-in in `init`), so a box hugs exactly the lines
  /// its range laid out to. Nothing here moves text: the layout-affecting
  /// half of a decoration (indent, tab stops) was already applied inside the
  /// string builder, where measurement sees it too.
  public override func draw(_ rect: CGRect) {
    super.draw(rect)
    guard !resolvedDecorations.isEmpty,
          let context = UIGraphicsGetCurrentContext() else { return }
    let length = textView.attributedText?.length ?? 0
    guard length > 0, textView.layoutManager.numberOfGlyphs > 0 else { return }

    for pass in 0...2 {
      for decoration in resolvedDecorations {
        switch decoration.kind {
        case .box:
          drawBox(decoration, pass: pass, in: context, textLength: length)
        case .rule:
          if pass == 2 {
            drawRule(decoration, in: context, textLength: length)
          }
        }
      }
    }
  }

  /// The vertical band a character range's line fragments occupy, in this
  /// view's coordinates, or nil for a range that laid out to nothing.
  private func lineBand(for characterRange: NSRange) -> (top: CGFloat, bottom: CGFloat)? {
    let layoutManager = textView.layoutManager
    let glyphRange = layoutManager.glyphRange(
      forCharacterRange: characterRange, actualCharacterRange: nil)
    guard glyphRange.length > 0 else { return nil }
    let first = layoutManager.lineFragmentRect(
      forGlyphAt: glyphRange.location, effectiveRange: nil)
    let last = layoutManager.lineFragmentRect(
      forGlyphAt: NSMaxRange(glyphRange) - 1, effectiveRange: nil)
    let origin = textView.frame.origin
    return (first.minY + origin.y, last.maxY + origin.y)
  }

  private func boxPath(_ rect: CGRect, decoration: Decoration) -> UIBezierPath {
    guard decoration.borderRadius > 0 else { return UIBezierPath(rect: rect) }
    guard decoration.topCornersOnly else {
      return UIBezierPath(roundedRect: rect, cornerRadius: decoration.borderRadius)
    }
    // The table header band: it shares the table box's top corners, and its
    // bottom edge sits mid-table on the first row rule, where a rounded
    // corner would read as a gap in the border.
    return UIBezierPath(
      roundedRect: rect,
      byRoundingCorners: [.topLeft, .topRight],
      cornerRadii: CGSize(width: decoration.borderRadius, height: decoration.borderRadius))
  }

  /// Pass 0 paints the box's fill, pass 1 its blockquote bar, pass 2 its
  /// border stroke; see `draw(_:)` for why the three are separate sweeps.
  private func drawBox(
    _ decoration: Decoration, pass: Int, in context: CGContext, textLength: Int
  ) {
    // Clamped, never dropped — the same prop-skew discipline as attribute
    // ranges: offsets were computed against the text JS sent, which can
    // differ in length from the text in hand.
    let clamped = NSIntersectionRange(
      decoration.range, NSRange(location: 0, length: textLength))
    guard clamped.length > 0, let band = lineBand(for: clamped) else { return }
    // Padding extends into the blank separator lines around the block, and
    // the clamp is what keeps a box at the very edge of a run inside the
    // host instead of painted over a neighbouring view.
    let top = max(0, band.top - decoration.paddingTop)
    let bottom = min(bounds.height, band.bottom + decoration.paddingBottom)
    guard bottom > top else { return }
    // `inset` pulls the band off both edges — an island box inside a
    // blockquote starts at the quote body's edge instead of crossing the bar
    // at x = 0 (runDecorations.ts documents the field).
    let box = CGRect(
      x: decoration.inset,
      y: top,
      width: bounds.width - decoration.inset * 2,
      height: bottom - top)
    guard box.width > 0 else { return }

    if pass == 0 {
      if let fill = decoration.fill {
        context.saveGState()
        fill.setFill()
        boxPath(box, decoration: decoration).fill()
        context.restoreGState()
      }
      return
    }
    if pass == 1 {
      // The blockquote bar: a capsule at the box's leading edge, independent
      // of the fill (a bar-only quote has no fill), spanning the same padded
      // band. Its own pass, above every fill: an island's opaque background
      // inside the quote must not sever it. Pure paint: the quote body's
      // inset arrives in separate 'indent' entries, applied in the string
      // builder, not here.
      if let barColor = decoration.barColor, decoration.barWidth > 0 {
        let bar = CGRect(
          x: box.minX, y: top, width: decoration.barWidth, height: bottom - top)
        context.saveGState()
        barColor.setFill()
        UIBezierPath(
          roundedRect: bar,
          cornerRadius: min(decoration.barWidth, bar.height) / 2
        ).fill()
        context.restoreGState()
      }
      return
    }
    guard let borderColor = decoration.borderColor, decoration.borderWidth > 0 else { return }
    context.saveGState()
    borderColor.setStroke()
    // Inset by half the stroke so the border draws fully inside the box.
    let path = boxPath(
      box.insetBy(dx: decoration.borderWidth / 2, dy: decoration.borderWidth / 2),
      decoration: decoration)
    path.lineWidth = decoration.borderWidth
    path.stroke()
    context.restoreGState()
  }

  private func drawRule(_ decoration: Decoration, in context: CGContext, textLength: Int) {
    guard let color = decoration.fill, decoration.thickness > 0 else { return }
    // A rule is an anchor, not a range: the line fragment containing its
    // offset decides where it sits. Clamped, because a zero-length anchor is
    // allowed to sit at text end (a trailing thematic break).
    let anchor = min(max(0, decoration.range.location), textLength - 1)
    let layoutManager = textView.layoutManager
    let glyphIndex = layoutManager.glyphIndexForCharacter(at: anchor)
    let fragment = layoutManager.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: nil)
    let y = (decoration.alignTop ? fragment.minY : fragment.midY) + textView.frame.origin.y
    let rule = CGRect(
      x: decoration.inset,
      y: y - decoration.thickness / 2,
      width: bounds.width - decoration.inset * 2,
      height: decoration.thickness)
    guard rule.width > 0 else { return }
    context.saveGState()
    color.setFill()
    context.fill(rule)
    context.restoreGState()
  }

  // MARK: - Event emission

  fileprivate func emitSelectionAction(range: NSRange, action: String) {
    guard let emit = onSelectionAction else { return }
    let full = (textView.text ?? "") as NSString
    // Clamp to the current text so JS can trust the offsets unconditionally.
    let start = min(range.location, full.length)
    let end = min(range.location + range.length, full.length)
    guard end > start else { return }
    let clamped = NSRange(location: start, length: end - start)
    emit(start, end, action as NSString, full.substring(with: clamped) as NSString)
  }

  private func emitInlinePress(_ pressable: Pressable) {
    guard let emit = onInlinePress else { return }
    let length = ((textView.text ?? "") as NSString).length
    // Same clamp discipline as emitSelectionAction: the ranges were computed
    // against the text JS sent, which under prop skew can differ in length
    // from the text in hand, and JS must be able to trust the offsets
    // unconditionally.
    let start = min(pressable.range.location, length)
    let end = min(pressable.range.location + pressable.range.length, length)
    guard end > start else { return }
    emit(start, end, pressable.id)
  }

  // MARK: - Inline presses

  @objc private func handleInlineTap(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended else { return }
    // Re-resolved at recognition time rather than trusted from the
    // shouldReceive gate: the text (and with it the layout) can change
    // between touch-down and recognition on a streaming run.
    guard let pressable = pressable(at: recognizer.location(in: textView)) else { return }
    emitInlinePress(pressable)
  }

  /// The pressable range under a point in the text view's coordinates, or
  /// nil — and nil is the load-bearing answer: it is what makes a tap
  /// anywhere else fall through to the text view's own behaviour untouched.
  ///
  /// TextKit 1 hit test, on the same layout manager the view draws with (the
  /// RNSMTextKitStack opt-in in `init` is what guarantees `textView
  /// .layoutManager` is that stack rather than a lazily-created TextKit 2
  /// bridge). `glyphIndex(for:in:)` alone is not enough: it answers with the
  /// *nearest* glyph, so a tap in the empty space past a line's end — or
  /// below the last line — would "hit" the line's last character and turn
  /// half the padding around a trailing link into a tap target. The bounding
  /// -rect check is what rejects those.
  private func pressable(at point: CGPoint) -> Pressable? {
    guard !resolvedPressables.isEmpty else { return nil }
    let layoutManager = textView.layoutManager
    let container = textView.textContainer
    // textContainerInset is zeroed in init, but the subtraction stays: the
    // hit test must be correct, not coincidentally correct.
    var location = point
    location.x -= textView.textContainerInset.left
    location.y -= textView.textContainerInset.top
    guard layoutManager.numberOfGlyphs > 0 else { return nil }
    let glyphIndex = layoutManager.glyphIndex(for: location, in: container)
    let glyphRect = layoutManager.boundingRect(
      forGlyphRange: NSRange(location: glyphIndex, length: 1), in: container)
    guard glyphRect.contains(location) else { return nil }
    let characterIndex = layoutManager.characterIndexForGlyph(at: glyphIndex)
    return resolvedPressables.first { NSLocationInRange(characterIndex, $0.range) }
  }
}

// MARK: - UITextViewDelegate

extension SelectableRunHostView: UITextViewDelegate {

  /// One active selection across the document. iOS clears a text view's
  /// selection when the user taps INSIDE that view, but not when a selection
  /// begins in a different one — so with one host per run, a reader who
  /// selected in one stretch and then long-pressed in another used to see
  /// both highlights, only one of them live. The moment a non-empty
  /// selection lands here, every other live host's selection is cleared.
  /// Recursion-safe by construction: clearing another host fires its
  /// delegate with an empty range, which returns at the guard.
  public func textViewDidChangeSelection(_ textView: UITextView) {
    guard textView.selectedRange.length > 0 else { return }
    for host in Self.liveHosts.allObjects where host !== self {
      if host.textView.selectedRange.length > 0 {
        host.textView.selectedRange = NSRange(location: 0, length: 0)
      }
    }
  }

  /// iOS 16+ edit-menu hook: append the configured custom actions after the
  /// system ones, in `selectionActions` order. The system Copy is never
  /// removed, reordered, or intercepted — it already produces the displayed
  /// plain text, straight to the pasteboard with no JS round-trip. The
  /// custom "Copy Text" exists alongside it so apps that want to observe or
  /// enrich plain-text copies (analytics, both-flavor pasteboard items) get
  /// the same `{start, end, action}` event path as "Copy Markdown".
  @available(iOS 16.0, *)
  public func textView(
    _ textView: UITextView,
    editMenuForTextIn range: NSRange,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    guard range.length > 0, !resolvedActions.isEmpty else {
      return UIMenu(children: suggestedActions)
    }
    let custom: [UIMenuElement] = resolvedActions.map { identifier in
      UIAction(
        title: Self.actionTitles[identifier] ?? identifier,
        identifier: UIAction.Identifier("selectable-markdown." + identifier)
      ) { [weak self] _ in
        self?.emitSelectionAction(range: range, action: identifier)
      }
    }
    return UIMenu(children: suggestedActions + custom)
  }

  // Pre-iOS 16 there is no per-selection menu hook with custom UIActions on
  // UITextView; those devices get the system menu only (plain copy), and
  // onSelectionAction never fires. Documented in docs/SELECTION.md.
}

// MARK: - UIGestureRecognizerDelegate

extension SelectableRunHostView: UIGestureRecognizerDelegate {

  /// The gate that makes the tap recognizer invisible outside link ranges.
  /// A recognizer that received every touch and only *failed* on non-links
  /// would still have entered gesture arbitration with UITextView's own
  /// recognizers for every tap on the run; refusing the touch up front means
  /// a tap on plain prose behaves exactly as it did before this recognizer
  /// existed. The result is advisory — text can move between touch-down and
  /// recognition on a streaming run — which is why `handleInlineTap`
  /// re-resolves against the layout of the moment instead of trusting it.
  public func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldReceive touch: UITouch
  ) -> Bool {
    guard gestureRecognizer === inlineTapRecognizer else { return true }
    return pressable(at: touch.location(in: textView)) != nil
  }
}
