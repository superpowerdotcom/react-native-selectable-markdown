import UIKit
import React

/// Native host for one selectable markdown "run" (a merged sequence of prose
/// blocks projected to a single text). The JS side owns all markdown
/// semantics; this view's whole contract is:
///
///   props:  `text` (the projected run text), `attributes` (styled ranges
///           over that text), `pressables` (tappable ranges over that text),
///           `selectable`, `exclusiveSelection` (whether this host takes part
///           in the one-active-selection coordination), `selectionActions`
///           (the ordered menu, one string per item: an action identifier, or
///           `identifier + U+001F + title`)
///   events: `onSelectionAction({ start, end, action, selectedText })` where
///           start/end are UTF-16 code-unit offsets into the CURRENT value
///           of `text`, end-exclusive, clamped, start <= end, and `action`
///           is the identifier of the menu item the user tapped;
///           `onInlinePress({ start, end, pressableId })` when a single tap
///           lands inside one of `pressables` — same offset guarantees, and
///           `pressableId` is JS's identifier for the range, echoed verbatim;
///           `onSelectionChange({ start, end })` whenever the selection
///           moves, deduped — same offset guarantees except that an EMPTY
///           range is a real payload and means "nothing is selected here".
///   commands: `clearSelection()`, `setSelection(start:end:)` — JS telling
///           this host what to select, in the offsets the events report.
///           Dispatched through `RCTSelectableRunHostComponentView`'s
///           `handleCommand:args:`.
///
/// `onSelectionAction` fires when the user invokes one of those items from
/// the edit menu. JS maps the offsets through the run's piece table back to a
/// markdown SourceSpan and writes the payload to the pasteboard — this view
/// never touches the pasteboard for these actions itself. The system Copy
/// item is left untouched: it already yields the displayed plain text without
/// any JS involvement.
///
/// A titled entry is shown verbatim; a bare identifier is titled by
/// `defaultActionTitle(for:)`; an entry with neither is dropped.
///
/// `onInlinePress` is how a link inside a run gets to be tappable at all:
/// this view renders the whole run as one attributed string, so the per-node
/// `onPress` the standalone-block renderer uses has nothing to attach to here.
/// JS sends the ranges that are live links, this view hit-tests single taps
/// against them, and the URL never crosses the bridge — the view stays as
/// free of markdown semantics as it is for selection.
///
/// Each pressable range and each `role` range on `attributes` ('heading',
/// 'listItem', 'tableCell', set by JS so the host never infers semantics from
/// styling) becomes its own accessibility element; see `accessibilityElements`.
///
/// `attributes` is what makes this host render markdown rather than a wall
/// of system text. Each entry is a range of `text` plus the parts of a text
/// style it changes (and, on the ranges that have one, the `role` above); JS
/// derives them from the same projection that produced `text`, so they
/// describe exactly what the standalone-block renderer in `renderers.tsx`
/// draws for the same construct. Crucially none of them changes what the text
/// IS — no character is added, removed or reordered — so the offsets this
/// view reports back still index the projected text the way JS expects.
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

  /// Emitted with the clamped selection range whenever it moves, deduped. An
  /// empty range is a real emission: the selection went away.
  @objc public var onSelectionChange: ((Int, Int) -> Void)?

  /// Resolved against the app's `Bundle.main`, which may override the keys.
  /// A function, not a `static let`, so an in-place language change applies.
  private static func defaultActionTitle(for identifier: String) -> String? {
    switch identifier {
    case "copy-text":
      return NSLocalizedString(
        "Copy Text", comment: "Selection menu: copy the selected plain text")
    case "copy-markdown":
      return NSLocalizedString(
        "Copy Markdown", comment: "Selection menu: copy the markdown source")
    default:
      return nil
    }
  }

  /// A nil `title` means the built-in, looked up when the menu opens.
  private struct ResolvedAction {
    let identifier: String
    let title: String?
  }

  /// Mirrors JS's `DEFAULT_SELECTION_ACTIONS`.
  private static let defaultActions: [ResolvedAction] = [
    parseSelectionAction("copy-text"),
    parseSelectionAction("copy-markdown"),
  ].compactMap { $0 }

  private let textView: RunTextView
  private var resolvedActions: [ResolvedAction] = SelectableRunHostView.defaultActions

  /// The one host holding a selection. iOS never clears a non-editable text
  /// view's selection when another begins, and only the first responder draws
  /// one, so without this the older selection stays live but invisible.
  /// One pointer suffices because `textViewDidChangeSelection` keeps at most
  /// one owner. Main-thread only.
  private static weak var activeSelectionHost: SelectableRunHostView?

  /// Starts empty, not nil, so a host that never held a selection never emits.
  private var lastReportedSelection = NSRange(location: 0, length: 0)
  private var lastAppliedText = NSAttributedString()

  /// One tappable range: `pressables` parsed on arrival. `id` is JS's
  /// identifier for the range (its index into the prop as sent), echoed back
  /// verbatim in the event.
  private struct Pressable {
    let range: NSRange
    let id: Int
  }

  /// Never overlapping (JS's `resolveRunPressables` guarantees it), so the
  /// first containing range is the only one.
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

  private var cachedAccessibilityElements: [Any]?
  private var accessibilityCacheValid = false

  /// An outside assignment to `accessibilityElements`, which wins over the
  /// built cache and survives its invalidation.
  private var assignedAccessibilityElements: [Any]?

  private final class PressableAccessibilityElement: UIAccessibilityElement {
    /// Captures the host weakly: VoiceOver can hold an element past its host.
    var activate: (() -> Bool)?

    override func accessibilityActivate() -> Bool {
      return activate?() ?? false
    }
  }

  /// `accessibilityFocusRect` narrows VoiceOver's frame to the first prose gap
  /// the text view announces; kept in view coordinates because the transcript
  /// scrolls. Nil means UIKit's own frame.
  final class RunTextView: UITextView {
    var accessibilityFocusRect: CGRect?

    override var accessibilityFrame: CGRect {
      get {
        guard let rect = accessibilityFocusRect, window != nil else {
          return super.accessibilityFrame
        }
        return UIAccessibility.convertToScreenCoordinates(rect, in: self)
      }
      set { super.accessibilityFrame = newValue }
    }
  }

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
    /// Nonzero marks an island box, whose direction `leadingEdgeRuns(in:)` ignores.
    let textInset: CGFloat
  }

  /// `decorations` parsed on arrival, in prop order. Painted in `draw(_:)`
  /// behind the text view — fills, then blockquote bars, then strokes, so a
  /// table's header band never covers the border drawn around it and an
  /// island's fill never covers a quote's bar.
  private var resolvedDecorations: [Decoration] = []

  /// Read off the measured string, never derived from `decorations`, so it
  /// matches the height the shadow node measured.
  private var runEdgeInsets: UIEdgeInsets = .zero

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
    textView = RunTextView(
      frame: .zero,
      textContainer: RNSMTextKitStack.textContainer(ofStack: stack))
    super.init(frame: frame)

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
    //
    // `contentMode` is owned by the `decorations` setter: `.redraw` only while
    // there is chrome to paint.
    isOpaque = false

    // No `adjustsFontForContentSizeCategory`: it would scale at draw time a
    // string the shadow node already measured at `fontSizeMultiplier`.

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
    fatalError("SelectableRunHostView must be created programmatically")
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    // The measured height includes `runEdgeInsets`; geometry elsewhere follows
    // `textView.frame.origin`.
    let edge = runEdgeInsets
    let previousFrame = textView.frame
    textView.frame = CGRect(
      x: 0,
      y: edge.top,
      width: bounds.width,
      height: max(0, bounds.height - edge.top))
    // A width change re-wraps the text, so every link's frame moved even
    // though no text did.
    if previousFrame != textView.frame { invalidateAccessibilityElements() }
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
      let hadDecorations = !resolvedDecorations.isEmpty
      resolvedDecorations = decorations.compactMap(Self.parseDecoration(_:))
      // A list that just became empty repaints once to erase the old chrome.
      contentMode = resolvedDecorations.isEmpty ? .scaleToFill : .redraw
      if hadDecorations || !resolvedDecorations.isEmpty {
        setNeedsDisplay()
      }
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
        // `isFinite` too: `> 0` rejects NaN but accepts infinity.
        guard let dictionary = entry as? [String: Any],
              let start = (dictionary["start"] as? NSNumber)?.intValue,
              let end = (dictionary["end"] as? NSNumber)?.intValue,
              let id = (dictionary["embedId"] as? NSNumber)?.intValue,
              let width = (dictionary["width"] as? NSNumber)?.doubleValue,
              let height = (dictionary["height"] as? NSNumber)?.doubleValue,
              start >= 0, end == start + 1,
              width.isFinite, width > 0,
              height.isFinite, height > 0 else { return nil }
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
      if !resolvedEmbeds.isEmpty {
        setNeedsLayout()
      }
    }
  }


  /// Install the newly styled string. Two paths, chosen per call:
  ///
  /// **Splice**: write only the middle `RNSMTextSplice.plan` leaves, since
  /// TextKit relays out per edited range. **Full swap**: when nothing is shared.
  /// Plans compare against `lastAppliedText`, not the storage, which UIKit's
  /// font fallback rewrites.
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

    // Ahead of the early-out: geometry must not depend on a storage check.
    let nextEdgeInsets = RNSMAttributedText.runEdgeInsets(of: attributedText)
    if nextEdgeInsets != runEdgeInsets {
      runEdgeInsets = nextEdgeInsets
      setNeedsLayout()
    }

    // Equal content: early out before any storage touch. `isEqual(to:)`
    // compares text and attributes, so a styling-only change never lands
    // here and still reaches the splice below.
    if newLength == previousLength, attributedText.isEqual(to: lastAppliedText) {
      return
    }

    let saved = textView.selectedRange
    let hadSelectAll =
      saved.length > 0 && saved.location == 0 && saved.length == previousLength

    let plan = RNSMTextSplice.plan(from: lastAppliedText, to: attributedText)
    lastAppliedText = NSAttributedString(attributedString: attributedText)
    if plan.prefix == previousLength && previousLength == newLength { return }
    if plan.isEmpty {
      textView.attributedText = attributedText
    } else {
      storage.beginEditing()
      storage.replaceCharacters(
        in: NSRange(
          location: plan.prefix,
          length: previousLength - plan.prefix - plan.suffix),
        with: attributedText.attributedSubstring(
          from: NSRange(
            location: plan.prefix,
            length: newLength - plan.prefix - plan.suffix)))
      storage.endEditing()
    }

    if saved.length > 0 {
      let restored = RNSMTextSplice.selection(
        after: plan,
        saved: saved,
        hadSelectAll: hadSelectAll,
        previousLength: previousLength,
        newLength: newLength)
      // Writing `selectedRange` fires the delegate and disturbs a presented menu.
      if restored != textView.selectedRange {
        textView.selectedRange = restored
      }
    }

    invalidateAccessibilityElements()

    // Forced only when the splice rewrote characters under an unmoved selection.
    if saved.length > 0 || lastReportedSelection.length > 0 {
      emitSelectionChange(
        force: RNSMTextSplice.rewrites(plan, saved: saved, previousLength: previousLength))
    }

    if !resolvedDecorations.isEmpty {
      setNeedsDisplay()
    }
    if !resolvedEmbeds.isEmpty {
      setNeedsLayout()
    }
  }

  @objc public var selectable: Bool = true {
    didSet { textView.isSelectable = selectable }
  }

  /// False opts out both ways: this host neither clears others nor is cleared.
  /// Its selection stays live but is drawn only while it is first responder.
  @objc public var exclusiveSelection: Bool = true {
    didSet {
      if !exclusiveSelection, Self.activeSelectionHost === self {
        Self.activeSelectionHost = nil
      }
    }
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
      invalidateAccessibilityElements()
    }
  }

  /// Each entry is an identifier or `identifier + U+001F + title`; empty when JS
  /// has no `onSelectionCopy` listener.
  @objc public var selectionActions: NSArray = ["copy-text", "copy-markdown"] {
    didSet {
      resolvedActions = selectionActions.compactMap { entry in
        guard let encoded = entry as? String else { return nil }
        return Self.parseSelectionAction(encoded)
      }
    }
  }

  /// Splits at the first U+001F, matching `src/view/selectionActions.ts`.
  private static func parseSelectionAction(_ encoded: String) -> ResolvedAction? {
    let identifier: String
    var title: String?
    if let separator = encoded.range(of: "\u{1F}") {
      identifier = String(encoded[encoded.startIndex..<separator.lowerBound])
      let sent = String(encoded[separator.upperBound...])
      title = sent.isEmpty ? nil : sent
    } else {
      identifier = encoded
    }
    guard !identifier.isEmpty else { return nil }
    guard title != nil || defaultActionTitle(for: identifier) != nil else { return nil }
    return ResolvedAction(identifier: identifier, title: title)
  }

  // MARK: - Commands

  /// Resigns first responder, the only way to dismiss UITextView's private
  /// edit menu; the coordination clear must not, as it runs mid-gesture.
  @objc public func clearSelection() {
    guard textView.selectedRange.length > 0 else { return }
    textView.selectedRange = NSRange(location: 0, length: 0)
    textView.resignFirstResponder()
  }

  /// Selects `[start, end)` in UTF-16 units, clamped to the current text. A
  /// range that clamps to empty is a raced swap, so it keeps the existing
  /// selection; `clearSelection` is how to clear. First responder is taken
  /// before the range is set: only the first responder draws a selection,
  /// and becoming it can move the selection.
  @objc(setSelection:end:) public func setSelection(start: Int, end: Int) {
    guard textView.isSelectable else { return }
    let length = ((textView.text ?? "") as NSString).length
    let low = min(max(min(start, end), 0), length)
    let high = min(max(max(start, end), 0), length)
    guard high > low else { return }
    textView.becomeFirstResponder()
    textView.selectedRange = NSRange(location: low, length: high - low)
  }

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
    lastAppliedText = NSAttributedString()
    if runEdgeInsets != .zero {
      runEdgeInsets = .zero
      setNeedsLayout()
    }
    textView.selectedRange = NSRange(location: 0, length: 0)
    textView.resignFirstResponder()
    // A recycled host stays alive in Fabric's pool, so the weak slot never empties itself.
    if Self.activeSelectionHost === self {
      Self.activeSelectionHost = nil
    }
    // Kept, it would suppress the next run's first report as a duplicate.
    lastReportedSelection = NSRange(location: 0, length: 0)
    invalidateAccessibilityElements()
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
    if !resolvedDecorations.isEmpty {
      setNeedsDisplay()
    }
  }

  // MARK: - Embed rects

  /// Report where each embed's reserved space landed, deduped against the
  /// last report per id so streaming appends past a settled embed cost one
  /// rect compare instead of one event per snapshot.
  ///
  /// Called only from `layoutSubviews`: Fabric runs `updateState` before
  /// `updateLayoutMetrics`, so a rect taken in `apply` uses a stale frame.
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
    guard bounds.width > 0 else { return }
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

  // MARK: - Accessibility

  /// One element per semantic range, per link and per prose gap between them,
  /// in document order. The text view announces only the first gap so nothing
  /// is read twice, and stays in the tree because it carries the
  /// text-selection rotor. `roleLevel` and cell coordinates are dropped: UIKit
  /// has no trait for them, and a label would need English this library cannot
  /// translate. Nil when nothing is vended.
  public override var accessibilityElements: [Any]? {
    get {
      if let assigned = assignedAccessibilityElements {
        return assigned
      }
      if accessibilityCacheValid { return cachedAccessibilityElements }
      let semantics = RNSMAttributedText.semanticRanges(of: textView.attributedText)
      guard !resolvedPressables.isEmpty || !semantics.isEmpty else {
        textView.accessibilityValue = nil
        textView.accessibilityLabel = nil
        textView.accessibilityFocusRect = nil
        accessibilityCacheValid = true
        return nil
      }
      let built = buildAccessibilityElements(semantics: semantics)
      cachedAccessibilityElements = built
      accessibilityCacheValid = true
      return built
    }
    set {
      assignedAccessibilityElements = newValue
      cachedAccessibilityElements = nil
      accessibilityCacheValid = false
    }
  }

  /// Ranges are re-clamped to the current text: JS computed them against the
  /// text it sent, which can differ under prop skew.
  private func buildAccessibilityElements(semantics: [[AnyHashable: Any]]) -> [Any] {
    var elements: [Any] = [textView]
    guard bounds.width > 0 else {
      textView.accessibilityValue = nil
      textView.accessibilityFocusRect = nil
      return elements
    }
    let layoutManager = textView.layoutManager
    guard layoutManager.numberOfGlyphs > 0 else {
      textView.accessibilityValue = nil
      textView.accessibilityFocusRect = nil
      return elements
    }
    let full = (textView.text ?? "") as NSString
    let origin = textView.frame.origin
    let container = textView.textContainer

    let textRange = NSRange(location: 0, length: full.length)

    /// Takes an already-clamped range; returns view coordinates.
    func frameFor(_ clamped: NSRange) -> CGRect? {
      let glyphRange = layoutManager.glyphRange(
        forCharacterRange: clamped, actualCharacterRange: nil)
      guard glyphRange.length > 0 else { return nil }
      var frame = layoutManager.boundingRect(forGlyphRange: glyphRange, in: container)
      frame.origin.x += origin.x
      frame.origin.y += origin.y
      guard frame.width > 0, frame.height > 0 else { return nil }
      return frame
    }

    struct Vended {
      let range: NSRange
      let element: UIAccessibilityElement
      let order: Int
    }
    var vended: [Vended] = []

    for entry in semantics {
      guard let boxed = entry[RNSMSemanticRangeKey] as? NSValue,
            let role = entry[RNSMSemanticRoleKey] as? String
      else { continue }
      let clamped = NSIntersectionRange(boxed.rangeValue, textRange)
      guard clamped.length > 0 else { continue }
      let label = full.substring(with: clamped)
      guard !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let frame = frameFor(clamped)
      else { continue }
      let element = UIAccessibilityElement(accessibilityContainer: self)
      element.accessibilityLabel = label
      // `.staticText` keeps these out of the controls rotor.
      element.accessibilityTraits = role == "heading" ? [.header, .staticText] : .staticText
      element.accessibilityFrameInContainerSpace = frame
      vended.append(Vended(range: clamped, element: element, order: vended.count))
    }

    for pressable in resolvedPressables {
      let clamped = NSIntersectionRange(pressable.range, textRange)
      guard clamped.length > 0, let frame = frameFor(clamped) else { continue }
      let element = PressableAccessibilityElement(accessibilityContainer: self)
      element.accessibilityLabel = full.substring(with: clamped)
      element.accessibilityTraits = .link
      element.accessibilityFrameInContainerSpace = frame
      element.activate = { [weak self] in
        guard let self else { return false }
        self.emitInlinePress(pressable)
        return true
      }
      vended.append(Vended(range: clamped, element: element, order: vended.count))
    }

    // Array order is swipe order. Ties go to the longer range; `order` makes
    // the sort total because Swift's `sort` is not stable.
    vended.sort { left, right in
      if left.range.location != right.range.location {
        return left.range.location < right.range.location
      }
      if left.range.length != right.range.length {
        return left.range.length > right.range.length
      }
      return left.order < right.order
    }

    // Gaps lie outside every vended range, so the merge needs no tiebreak.
    let gaps = Self.proseGaps(full, vended.map { $0.range })
    var ordered: [Any] = []
    var nextVended = 0
    for (index, gap) in gaps.enumerated() {
      while nextVended < vended.count, vended[nextVended].range.location < gap.location {
        ordered.append(vended[nextVended].element)
        nextVended += 1
      }
      if index == 0 {
        // Kept even when the gap laid out to nothing: the rotor needs it.
        textView.accessibilityFocusRect = frameFor(gap).map {
          $0.offsetBy(dx: -origin.x, dy: -origin.y)
        }
        ordered.append(textView)
        continue
      }
      guard let frame = frameFor(gap) else { continue }
      let element = UIAccessibilityElement(accessibilityContainer: self)
      element.accessibilityLabel = full.substring(with: gap)
      element.accessibilityTraits = .staticText
      element.accessibilityFrameInContainerSpace = frame
      ordered.append(element)
    }
    ordered.append(contentsOf: vended[nextVended...].map { $0.element })
    if gaps.isEmpty {
      textView.accessibilityFocusRect = nil
      ordered.append(textView)
    }
    elements = ordered
    textView.accessibilityValue = gaps.first.map { full.substring(with: $0) } ?? ""
    textView.accessibilityLabel = gaps.isEmpty
      ? NSLocalizedString("Select text", comment: "Text selection accessibility control") : nil
    return elements
  }

  /// Whitespace-trimmed stretches outside `covered`, which is sorted by location
  /// but may nest.
  static func proseGaps(_ full: NSString, _ covered: [NSRange]) -> [NSRange] {
    let content = CharacterSet.whitespacesAndNewlines.inverted
    var gaps: [NSRange] = []
    func keep(_ raw: NSRange) {
      guard raw.length > 0 else { return }
      let first = full.rangeOfCharacter(from: content, options: [], range: raw)
      guard first.location != NSNotFound else { return }
      let last = full.rangeOfCharacter(from: content, options: .backwards, range: raw)
      gaps.append(NSRange(location: first.location, length: NSMaxRange(last) - first.location))
    }
    var cursor = 0
    for range in covered {
      if range.location > cursor {
        keep(NSRange(location: cursor, length: range.location - cursor))
      }
      cursor = max(cursor, NSMaxRange(range))
    }
    if cursor < full.length {
      keep(NSRange(location: cursor, length: full.length - cursor))
    }
    return gaps
  }

  /// No `.layoutChanged` post: this runs per streamed snapshot, and the post
  /// interrupts VoiceOver's speech.
  private func invalidateAccessibilityElements() {
    cachedAccessibilityElements = nil
    accessibilityCacheValid = false
    textView.accessibilityValue = nil
    textView.accessibilityLabel = nil
    textView.accessibilityFocusRect = nil
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
      inset: number("inset"),
      textInset: number("textInset"))
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

  /// `range`'s paragraphs grouped by the direction `RNSMPinParagraphDirections`
  /// pinned on the string, so the bar and the indent share one decision.
  /// `.natural` and island paragraphs join the run before them; with none
  /// pinned, one left-to-right run.
  private func leadingEdgeRuns(in range: NSRange) -> [(start: Int, rightToLeft: Bool)] {
    let storage = textView.textStorage
    let text = storage.string as NSString
    let end = min(NSMaxRange(range), storage.length)
    let islands = resolvedDecorations
      .filter { $0.kind == .box && $0.textInset > 0 }
      .map(\.range)
    var runs: [(start: Int, rightToLeft: Bool)] = []
    var index = range.location
    while index < end {
      let paragraphEnd = min(
        NSMaxRange(text.paragraphRange(for: NSRange(location: index, length: 0))), end)
      guard paragraphEnd > index else { break }
      let inIsland = islands.contains { NSLocationInRange(index, $0) }
      if !inIsland,
         let style = storage.attribute(
           .paragraphStyle, at: index, effectiveRange: nil) as? NSParagraphStyle,
         style.baseWritingDirection != .natural {
        let rightToLeft = style.baseWritingDirection == .rightToLeft
        if runs.isEmpty {
          runs.append((range.location, rightToLeft))
        } else if runs[runs.count - 1].rightToLeft != rightToLeft {
          runs.append((index, rightToLeft))
        }
      }
      index = paragraphEnd
    }
    return runs.isEmpty ? [(range.location, false)] : runs
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
    // Padding fits in the '\n\n' separators or `runEdgeInsets`; the clamps
    // guard an entry asking for more than JS reserved.
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
      //
      // One segment per direction run, at its leading edge: the head indent is
      // measured from there, so `box.minX` would cover right-to-left text.
      if let barColor = decoration.barColor, decoration.barWidth > 0 {
        let runs = leadingEdgeRuns(in: clamped)
        context.saveGState()
        barColor.setFill()
        for (offset, run) in runs.enumerated() {
          let segmentTop = offset == 0
            ? top
            : max(top, lineBand(for: NSRange(location: run.start, length: 1))?.top ?? top)
          let segmentBottom = offset == runs.count - 1
            ? bottom
            : min(
              bottom,
              lineBand(for: NSRange(location: runs[offset + 1].start, length: 1))?.top
                ?? bottom)
          guard segmentBottom > segmentTop else { continue }
          let barX = run.rightToLeft ? box.maxX - decoration.barWidth : box.minX
          let bar = CGRect(
            x: barX, y: segmentTop, width: decoration.barWidth,
            height: segmentBottom - segmentTop)
          UIBezierPath(
            roundedRect: bar,
            cornerRadius: min(decoration.barWidth, bar.height) / 2
          ).fill()
        }
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

  /// `force` re-announces an unchanged non-empty range whose characters were
  /// rewritten; forcing every snapshot would defeat the dedupe.
  private func emitSelectionChange(force: Bool = false) {
    let range = textView.selectedRange
    let full = ((textView.text ?? "") as NSString).length
    let start = min(max(range.location, 0), full)
    let end = min(max(range.location + range.length, 0), full)
    let clamped = end > start ? NSRange(location: start, length: end - start) : NSRange(location: 0, length: 0)
    if (!force || clamped.length == 0), NSEqualRanges(clamped, lastReportedSelection) {
      return
    }
    lastReportedSelection = clamped
    // Recorded even with no listener, so a late listener gets no replay.
    guard let emit = onSelectionChange else { return }
    emit(clamped.location, clamped.location + clamped.length)
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

  /// Reports before clearing the previous owner, so JS hears the new selection
  /// before the old one's empty report and the toolbar does not flicker.
  /// Clearing re-enters with an empty range, which returns at the guard.
  public func textViewDidChangeSelection(_ textView: UITextView) {
    emitSelectionChange()
    guard textView.selectedRange.length > 0, exclusiveSelection else { return }
    if let previous = Self.activeSelectionHost, previous !== self,
       previous.textView.selectedRange.length > 0 {
      previous.textView.selectedRange = NSRange(location: 0, length: 0)
    }
    Self.activeSelectionHost = self
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
    let custom: [UIMenuElement] = resolvedActions.compactMap { action -> UIMenuElement? in
      guard let title = action.title ?? Self.defaultActionTitle(for: action.identifier)
      else { return nil }
      return UIAction(
        title: title,
        identifier: UIAction.Identifier("selectable-markdown." + action.identifier)
      ) { [weak self] _ in
        guard let self else { return }
        // The live selection, since `apply` can move it while the menu is up;
        // the captured range covers a selection cleared under the menu.
        let live = self.textView.selectedRange
        self.emitSelectionAction(
          range: live.length > 0 ? live : range, action: action.identifier)
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
