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
/// THE MENU'S STRINGS COME FROM JS WHEN JS SENDS THEM, and from this file
/// otherwise. An entry with no U+001F is a bare identifier, which is titled
/// from `defaultActionTitle(for:)` below — `NSLocalizedString` against
/// `Bundle.main`, resolved each time a menu is built so an in-app language
/// change is reflected without a relaunch, so an app can also translate the
/// two built-in items by adding "Copy Text" and
/// "Copy Markdown" keys to its own `Localizable.strings`. An entry that
/// carries a title uses it verbatim, which is what lets a consumer localise
/// both platforms from one place and what lets it define items this file has
/// never heard of. An identifier this view cannot title — unknown, and no
/// title sent — is dropped rather than rendered as a blank menu item, which
/// is also the forward-compatibility rule for a newer JS bundle driving this
/// binary.
///
/// `onInlinePress` is how a link inside a run gets to be tappable at all:
/// this view renders the whole run as one attributed string, so the per-node
/// `onPress` the standalone-block renderer uses has nothing to attach to here.
/// JS sends the ranges that are live links, this view hit-tests single taps
/// against them, and the URL never crosses the bridge — the view stays as
/// free of markdown semantics as it is for selection.
///
/// `pressables` is half of this view's accessibility vocabulary. A run is one
/// text view, so VoiceOver reads it as one element and every link inside it
/// used to be unreachable — announced as prose, activatable only by sighted
/// tap. The host vends one `UIAccessibilityElement` per pressable range over
/// the glyphs it covers (see `accessibilityElements`), so a link is announced
/// as a link, reachable by swipe, and double-tap emits the same
/// `onInlinePress` a sighted tap does.
///
/// The other half is the `role` field on `attributes`, and it exists because
/// the host must not GUESS. Run merging flattens a document's blocks into one
/// text view, so a heading inside a run had no role at all — read as prose in
/// a bigger font, and invisible to the headings rotor. Nothing about the
/// styling identifies it (a 26pt bold range is whatever a consumer's
/// `attributeForMark` returned), and inferring it from a font size would put
/// markdown semantics in the host, which is exactly what this contract exists
/// to keep out. So JS says it: `resolveRunAttributes` marks the range
/// `role: 'heading'`, `'listItem'` or `'tableCell'`, the string builder
/// stamps it, and this view vends one element per range next to the link
/// elements — a `.header` trait for a heading, and for the other two a plain
/// focus stop, because iOS has no trait for a list item or a cell and their
/// positions ("item 2 of 5") could only be announced in a language this
/// library would have to ship.
/// WHAT IS STILL FLAT: code-block and blockquote structure, which have no
/// first-class trait on this platform either and no position to navigate by.
/// `RunSemanticRole` in src/view/runAttributes.ts is where the next role
/// would be added, and docs/SELECTION.md records the trade.
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

  /// Emitted with the clamped selection range whenever this host's selection
  /// MOVES — a gesture, a command, another host taking the one-active-selection
  /// slot, or a streamed text swap that shifted it. A plain closure for the
  /// same reason the other three are: the mounting layer owns the wire format.
  ///
  /// AN EMPTY RANGE IS A REAL EMISSION HERE, unlike `onSelectionAction`, and
  /// it is the point: "the selection went away" is what a consumer's floating
  /// toolbar needs to hear. `emitSelectionChange` dedupes, so an unchanged
  /// range is never re-announced.
  @objc public var onSelectionChange: ((Int, Int) -> Void)?

  /// The built-in title for one of the two action identifiers this file
  /// implements, or nil for an identifier it has never heard of — the
  /// fallback for an entry that arrives without a title of its own.
  ///
  /// `NSLocalizedString` resolves against `Bundle.main`, i.e. the CONSUMING
  /// APP's bundle: this pod ships no `.strings` table of its own, so an app
  /// can translate or reword these two items by adding "Copy Text" / "Copy
  /// Markdown" keys to its own `Localizable.strings`. That path is iOS-only
  /// and per-platform; sending a `title` from JS is the one that reaches both
  /// hosts, and it wins over this function (see `parseSelectionAction`).
  ///
  /// A FUNCTION AND NOT A `static let` TABLE, and that is the whole point of
  /// its shape. A `static let` is resolved once, lazily, and then frozen for
  /// the life of the process — so an app that switches language in place (a
  /// settings screen that sets `AppleLanguages` and re-renders, rather than
  /// asking the user to relaunch) kept whichever language happened to be
  /// current when the first menu was built. `NSLocalizedString` is a lookup
  /// in an already-loaded bundle table, this runs at most twice per menu
  /// presentation, and a menu presentation is a human gesture — so there was
  /// nothing to cache and a stale language to lose.
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

  /// One menu item as this view will build it: the identifier to report, and
  /// the title JS sent for it if it sent one.
  ///
  /// `title` NIL MEANS "USE THE BUILT-IN, WHATEVER IT SAYS WHEN THE MENU
  /// OPENS". Only the parse — which entries survive at all, and how the
  /// string splits — happens when the prop arrives; the localised default is
  /// looked up by `defaultActionTitle(for:)` at presentation time, so it
  /// follows the app's current language rather than the language of the first
  /// menu ever built. An entry that could not be titled at all never becomes
  /// one of these.
  private struct ResolvedAction {
    let identifier: String
    let title: String?
  }

  /// The menu a host shows before any prop arrives: literally what the JS
  /// default (`DEFAULT_SELECTION_ACTIONS`) encodes to — the two bare
  /// identifiers, run through the same parse as any other entry, so there is
  /// one place where a built-in item picks up its title.
  private static let defaultActions: [ResolvedAction] = [
    parseSelectionAction("copy-text"),
    parseSelectionAction("copy-markdown"),
  ].compactMap { $0 }

  private let textView: UITextView
  /// `selectionActions` resolved to titled items, in prop order.
  private var resolvedActions: [ResolvedAction] = SelectableRunHostView.defaultActions

  /// The one host that currently holds a selection, weakly, for
  /// one-active-selection coordination: iOS never clears one non-editable
  /// text view's selection because another began one, so a transcript of many
  /// runs would otherwise keep several live `selectedRange`s at once.
  /// `textViewDidChangeSelection` clears this host's selection and takes the
  /// slot the moment a non-empty selection lands somewhere else.
  ///
  /// WHAT THE SECOND SELECTION LOOKS LIKE, EXACTLY: not a second highlight.
  /// A non-editable UITextView draws no selection at all unless it is the
  /// first responder (the same fact `setSelection` is built around), and only
  /// one view in a window is, so the older selection goes INVISIBLE the
  /// instant the newer one begins — while still being a real range this host
  /// has already reported through `onSelectionChange`. That is the state this
  /// coordination removes: a selection nobody can see, dismiss or drag, which
  /// JS nonetheless believes in.
  ///
  /// ONE POINTER, NOT A REGISTRY OF EVERY LIVE HOST, and the difference is
  /// worth stating because the registry is the obvious shape. This handler is
  /// itself what maintains "at most one host holds a selection", so the set of
  /// hosts a new selection has to clear is never larger than one, and walking
  /// every mounted host to find it was O(all live hosts) plus a fresh array
  /// (`NSHashTable.allObjects`) on a callback that fires continuously while a
  /// selection handle is dragged. In a long transcript that was a per-frame
  /// walk of hundreds of views to clear at most one of them.
  ///
  /// Weak, so a host that is deallocated leaves the slot empty on its own;
  /// `reset()` gives it up explicitly, because a recycled host stays alive in
  /// Fabric's pool and would otherwise keep a slot it can no longer be the
  /// selection owner of. Main-thread only, like every other UIKit touch in
  /// this file.
  private static weak var activeSelectionHost: SelectableRunHostView?

  /// The last range handed to `onSelectionChange`, so an unchanged selection is
  /// never re-announced.
  ///
  /// IT MATTERS BECAUSE THE DELEGATE IS NOISY. `textViewDidChangeSelection`
  /// fires continuously while a handle is dragged AND on every write of
  /// `selectedRange`, including the ones `apply` performs on every streamed
  /// snapshot to keep a selection in place across a text swap. Without this,
  /// a document that is merely streaming would emit a selection event per run
  /// per snapshot.
  ///
  /// It starts at the empty range rather than nil, so a host that has never
  /// held a selection emits nothing at all: an empty report is meaningful only
  /// as the END of a selection this host previously announced.
  private var lastReportedSelection = NSRange(location: 0, length: 0)

  /// One tappable range: `pressables` parsed on arrival. `id` is JS's
  /// identifier for the range (its index into the prop as sent), echoed back
  /// verbatim in the event.
  private struct Pressable {
    let range: NSRange
    let id: Int
  }

  /// `pressables` parsed to well-formed ranges, in prop order. Ranges never
  /// overlap — JS's `resolveRunPressables` drops any range starting inside one
  /// it already kept, which is what makes the guarantee true (link marks
  /// themselves do nest) — so the first containing range found is the only
  /// one.
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

  /// The vended accessibility elements, built on demand and dropped whenever
  /// the text, the pressable ranges or the frame move. Nil means "not built
  /// since the last change", not "none" — see `accessibilityElements`.
  private var cachedAccessibilityElements: [Any]?

  /// Whatever was assigned to `accessibilityElements` from outside, kept
  /// separate from the built cache so an explicit assignment still wins and
  /// is not silently dropped by the next invalidation — which is what UIKit's
  /// own storage would do. Nothing in this package assigns it; the slot
  /// exists so that overriding the property does not quietly change what the
  /// property means.
  private var assignedAccessibilityElements: [Any]?

  /// One VoiceOver-reachable link. `UIAccessibilityElement` is a plain object
  /// rather than a view, so this costs no layer and nothing in the view
  /// hierarchy; `accessibilityActivate()` is the double-tap.
  private final class PressableAccessibilityElement: UIAccessibilityElement {
    /// Emits the host's `onInlinePress` for the range this element covers.
    /// Set at build time and captured weakly, so an element that outlives its
    /// host (VoiceOver holds the last focused element) activates to nothing
    /// instead of resurrecting it.
    var activate: (() -> Bool)?

    override func accessibilityActivate() -> Bool {
      return activate?() ?? false
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
  }

  /// `decorations` parsed on arrival, in prop order. Painted in `draw(_:)`
  /// behind the text view — fills, then blockquote bars, then strokes, so a
  /// table's header band never covers the border drawn around it and an
  /// island's fill never covers a quote's bar.
  private var resolvedDecorations: [Decoration] = []

  /// The room a box at the very edge of the run needs above its first line
  /// and below its last, in points — `RNSMAttributedText.runEdgeInsets(of:)`
  /// on the string this view was last handed. Zero for the ordinary run.
  ///
  /// READ OFF THE STRING, NEVER COMPUTED HERE, which is what makes it safe to
  /// use as geometry: the same value was added to the height the shadow node
  /// measured, by the measurer, off the identical object (`apply` receives
  /// exactly what was measured, through Fabric State). A second derivation
  /// from `decorations` in this file would be one refactor away from
  /// disagreeing with the frame this view was given, and the symptom is a
  /// border drawn outside the view or a gap under the last line.
  ///
  /// `layoutSubviews` is the only consumer: it pushes the text view down by
  /// `top`, and everything else in this file that converts between text and
  /// view coordinates already goes through `textView.frame.origin`.
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
    textView = UITextView(
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
    // `contentMode` is deliberately left at UIKit's default here rather than
    // pinned to `.redraw`, and the `decorations` setter owns it instead.
    // `draw(_:)` returns at its first guard when there is no decoration to
    // paint — which is every prose run, i.e. the common streaming case — and
    // `.redraw` on such a view buys nothing but a display pass per bounds
    // change. A run that DOES paint chrome needs `.redraw` for the reason it
    // always did (a decoration is positioned off the text layout, and a width
    // change relays the text out), and that is where the setter turns it on.
    isOpaque = false

    // DYNAMIC TYPE IS NOT THIS VIEW'S JOB, AND THIS NOTE EXISTS SO
    // `adjustsFontForContentSizeCategory = true` IS NOT RE-ADDED AS AN
    // OBVIOUS ONE-LINER. That line used to be here and did nothing: it only
    // scales fonts built through UIFontMetrics, and every font in
    // RNSMAttributedText comes from `UIFont(name:size:)` or
    // `UIFont.systemFont(ofSize:)`. A *working* version of it would be worse
    // than useless under Fabric — it scales at draw time, on the main thread,
    // against a string the shadow node already measured, so every run would
    // be laid out at one size and drawn at another.
    //
    // Scaling instead happens where measurement can see it: the string
    // arriving through `apply(attributedText:)` was built at
    // `layoutContext.fontSizeMultiplier` (React Native fills it from
    // `RCTFontSizeMultiplier()` and refreshes it on
    // UIContentSizeCategoryDidChangeNotification, which re-lays out the
    // surface — RCTFabricSurface.mm), so a run is measured and drawn at the
    // user's text size, from one object. RNSMAttributedText+Props.h has the
    // long form.

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
    // OFFSET BY THE RUN-EDGE INSET, not simply `bounds`.
    //
    // A box decoration at the very edge of a run has no block separator to be
    // painted into — a table that closes an answer ends at the last
    // character, a code block that opens one starts at offset 0 — so the
    // string builder records the room it needs and the measurer adds it to
    // the height Fabric framed this view at
    // (`RNSMAttributedText.runEdgeInsets(of:)`). Pushing the text view down
    // by the top half is what puts the text inside that room instead of at
    // the very top of it, and it is why the box geometry below can stay
    // exactly as it was: `lineBand` already adds `textView.frame.origin.y`,
    // as do the embed rects and the accessibility frames, so every offset in
    // this file follows the text without knowing why it moved.
    //
    // Zero for the ordinary run, where the frame is `bounds` verbatim.
    let edge = runEdgeInsets
    textView.frame = CGRect(
      x: 0,
      y: edge.top,
      width: bounds.width,
      height: max(0, bounds.height - edge.top))
    // A width change re-wraps the text, so every link's frame moved even
    // though no text did.
    invalidateAccessibilityElements()
    // THE ONLY PLACE EMBED RECTS ARE REPORTED FROM, and that is the point: a
    // rect is only meaningful once the view has been framed for the run it is
    // showing. A width change also moves where every embed's line wraps to
    // with no text change to trigger a report, and the dedupe in
    // reportEmbedRects makes the no-move case one rect compare per embed —
    // so a text change asks for layout (`setNeedsLayout`) instead of
    // measuring geometry the host has not been framed for yet.
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
      // The one place `contentMode` is decided, and the one invalidate that
      // is not conditional on there being something to paint: a list that
      // just became empty has to repaint once to ERASE the chrome the last
      // list drew. Everything else — `.redraw` only while chrome exists —
      // is what keeps a decoration-free run out of the display pass
      // entirely (see `init` and `draw(_:)`).
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
        // `isFinite` and not just `> 0`: a size arrives from a consumer's
        // `EmbedContent`, so it can be anything a JS number can be.
        // `width > 0` alone already rejects NaN (every comparison against
        // NaN is false) but ACCEPTS an infinity, and an infinite reservation
        // is not a rect this view can report or TextKit can lay out. Both
        // are rejected here to "no reservation", the same degradation every
        // other malformed field gets.
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
      // And ask for the layout pass that will re-report them. Rects are only
      // ever emitted from `layoutSubviews` (see `reportEmbedRects`), so a
      // prop change that moves a reservation has to schedule one rather than
      // measure here, where the view may not yet be framed for this run.
      if !resolvedEmbeds.isEmpty {
        setNeedsLayout()
      }
    }
  }


  /// Install the newly styled string. Two paths, chosen per call:
  ///
  /// **Splice** — the common one. Streaming re-publishes a complete string on
  /// every snapshot even when only the tail changed, and assigning it
  /// wholesale relayouts the ENTIRE accumulated run each time, so the first
  /// question here is which part of the storage actually has to change.
  /// `RNSMTextSplice.plan` answers it — the longest head and the longest tail
  /// the two strings share, character AND attribute — and one
  /// `replaceCharacters(in:with:)` writes the middle. TextKit invalidates
  /// layout per edited range, so a snapshot relayouts the changed middle and
  /// what follows it instead of the whole run. The scan is character
  /// comparison and one dictionary compare per styled range, no glyph
  /// shaping, far cheaper than the relayout it avoids.
  ///
  /// The tail half of that plan is not generality for its own sake. It used
  /// to be a prefix-only test — "is the whole old string a prefix of the new
  /// one" — which is true for streamed prose and false for every delta inside
  /// a fenced code block, because an unclosed block projects its literal with
  /// a trailing newline and each delta therefore inserts BEFORE the last
  /// character. The most common long construct in model output took the full
  /// swap on every snapshot for its whole duration. A pure append is now the
  /// degenerate case of the same plan (an empty tail) and costs what it
  /// always did.
  ///
  /// The selection is *preserved* wherever the plan makes that meaningful
  /// rather than restored positionally: one that lives entirely in the
  /// retained head is not touched at all (those offsets did not move), one
  /// entirely in the retained tail is shifted by the length delta so it keeps
  /// covering the same characters, a Select-All keeps meaning "all of it" and
  /// extends over the new text, and only a selection that overlapped the
  /// replaced middle is clamped — see `RNSMTextSplice.selection(after:)`.
  ///
  /// **Full swap** — the fallback for a new string that shares nothing at
  /// either end: a reset, a replace, or UIKit's own attribute fixing having
  /// mutated the storage since it was set. Splicing there would replace
  /// everything and buy nothing, so `attributedText` is assigned and the
  /// selection clamped. Equal input returns without touching the storage:
  /// nothing moved, nothing to lay out, draw or report.
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

    // The run-edge room this string asks for, before the storage is touched
    // AND BEFORE THE EQUAL-CONTENT EARLY-OUT BELOW. A change here moves the
    // text view's frame, which only a layout pass can do, so it is requested
    // explicitly: an append that leaves the insets alone (the common streamed
    // case — a trailing table's padding is the same 6pt on every snapshot)
    // requests nothing.
    //
    // It sits ahead of the early-out because the geometry must not depend on
    // a return that is about the STORAGE. Equal strings do carry equal
    // insets, so ordering it the other way is correct today and stale after
    // the first refactor that makes the early-out cheaper than a full
    // `isEqual(to:)` — the kind of coupling that is invisible until a view
    // draws a border on the wrong pixel. The cost of getting it right is one
    // attribute read at index 0.
    let nextEdgeInsets = RNSMAttributedText.runEdgeInsets(of: attributedText)
    if nextEdgeInsets != runEdgeInsets {
      runEdgeInsets = nextEdgeInsets
      setNeedsLayout()
    }

    // Equal content: early out before any storage touch. `isEqual(to:)`
    // compares text and attributes, so a styling-only change never lands
    // here and still reaches the splice below.
    if newLength == previousLength, attributedText.isEqual(to: storage) {
      return
    }

    let saved = textView.selectedRange
    // A selection that covered the whole old text keeps meaning "all of it"
    // and tracks the growing document, instead of freezing at the old end on
    // every streamed snapshot.
    let hadSelectAll =
      saved.length > 0 && saved.location == 0 && saved.length == previousLength

    let plan = RNSMTextSplice.plan(from: storage, to: attributedText)
    if plan.isEmpty {
      textView.attributedText = attributedText
    } else {
      // Neither boundary of the plan falls inside a surrogate pair
      // (RNSMTextSplice guarantees it), so no splice point can split a scalar
      // that was previously whole — the offsets this view reports back keep
      // indexing the projected text exactly as JS expects.
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
      // Assigned only when it has to move. Writing `selectedRange` is
      // observable — it runs `textViewDidChangeSelection`, and under a
      // presented edit menu it is not a no-op — so a selection the splice
      // left alone is left alone here too.
      if restored != textView.selectedRange {
        textView.selectedRange = restored
      }
    }

    // The text moved, so every vended link element's label and frame is
    // stale. Dropping them is one store; they are rebuilt only if an
    // assistive technology asks (see `accessibilityElements`).
    invalidateAccessibilityElements()

    // And the selection report, if there is a selection to report. This goes
    // through the SAME dedupe the delegate uses (`lastReportedSelection`), so
    // a selection whose offsets did not move is not re-announced and a
    // document that is merely streaming stays quiet — which is the whole
    // reason that dedupe exists.
    //
    // The one thing a range compare cannot see is a splice that rewrote the
    // characters UNDER an unmoved selection: the offsets are identical and
    // the text JS would derive from them is not. That case, and only that
    // case, forces — `RNSMTextSplice.rewrites` is the exact complement of the
    // two cases in which `selection(after:)` keeps the same characters, so
    // the decision to re-announce and the decision to preserve are one
    // answer rather than two that can drift.
    if textView.selectedRange.length > 0 {
      emitSelectionChange(
        force: RNSMTextSplice.rewrites(plan, saved: saved, previousLength: previousLength))
    }

    // Chrome and geometry, once, whichever path ran. Both are conditional:
    // `draw(_:)` paints nothing without decorations (so a prose run must not
    // ask for a display pass per snapshot), and embed rects are reported from
    // the layout pass rather than from here — see `reportEmbedRects`.
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

  /// Whether this host takes part in the one-active-selection coordination
  /// (see `activeSelectionHost`). Defaults to true, which is what every host
  /// did before the prop existed.
  ///
  /// FALSE OPTS OUT IN BOTH DIRECTIONS. `textViewDidChangeSelection` neither
  /// clears the previous owner nor takes the slot, so this host cannot erase
  /// another's selection and — because it is never the recorded owner — no
  /// other host can erase its. An opt-out that only stopped the clearing would
  /// be useless: the first selection would still die the moment a second one
  /// began.
  ///
  /// WHAT `false` BUYS, AND WHAT IT DOES NOT. It buys several simultaneous
  /// `selectedRange`s that survive each other, each reported by its own host
  /// through `onSelectionChange` — which is what makes "select in A, select
  /// in B, merge the two payloads" reachable at all. It does NOT buy several
  /// visible highlights. A non-editable UITextView draws no selection, no
  /// handles and no menu unless it is the first responder (see
  /// `setSelection`), and only one view in a window is, so the earlier
  /// selections are live and invisible: the user sees the highlight move to
  /// whichever run they touched last. Anything built on this therefore has to
  /// give its own feedback for the spans it is accumulating — the platform
  /// will not.
  ///
  /// The `didSet` gives the slot up rather than waiting for the next selection
  /// change, because a host that opted out while holding it would otherwise be
  /// cleared once more by the next selection elsewhere — after it had already
  /// stopped participating.
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
      // The vended link elements are one per entry here, labelled and framed
      // from these ranges.
      invalidateAccessibilityElements()
    }
  }

  /// The ordered custom edit-menu items, one string per item: an action
  /// identifier, or `identifier + U+001F + title`. JS sends an empty array
  /// when no `onSelectionCopy` listener exists, so the menu never offers an
  /// item that would visibly do nothing.
  ///
  /// Parsed on arrival, like `pressables`: the menu is built inside a
  /// UIKit callback that must not do string work, and an entry this view
  /// cannot title has to disappear before it can be presented.
  @objc public var selectionActions: NSArray = ["copy-text", "copy-markdown"] {
    didSet {
      resolvedActions = selectionActions.compactMap { entry in
        guard let encoded = entry as? String else { return nil }
        return Self.parseSelectionAction(encoded)
      }
    }
  }

  /// One `selectionActions` entry, split the way
  /// `src/view/selectionActions.ts` packs it.
  ///
  /// The split is at the FIRST U+001F and the rest is the title verbatim, so
  /// a title containing one survives; an identifier could not, which is why
  /// the encoder refuses to send one. An empty identifier, and an identifier
  /// with no built-in title of its own, both yield nil — the item is dropped
  /// rather than rendered blank. That is the same forward-compatibility rule
  /// this view has always had for an identifier it does not recognise, now
  /// with the escape hatch that sending a title is enough to make ANY
  /// identifier renderable.
  ///
  /// The droppability test calls `defaultActionTitle(for:)` and throws the
  /// string away: WHETHER an identifier has a built-in title is a property of
  /// this binary and cannot change, so it is settled here, while WHAT that
  /// title says depends on the app's current language and is therefore looked
  /// up again when the menu is presented.
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

  /// Drop this host's selection and dismiss the menu over it.
  ///
  /// IT RESIGNS FIRST RESPONDER, WHICH THE COORDINATION CLEAR DOES NOT, and
  /// the difference is deliberate. The coordination clear
  /// (`textViewDidChangeSelection`) runs while the user is mid-gesture in a
  /// *different* host, and stealing first responder there would fight the
  /// gesture that is in flight. This command is an app saying "no selection",
  /// typically on navigation, where a live edit menu with no selection under
  /// it is exactly the artifact to remove — and on iOS 16+ resigning is the
  /// only supported way to dismiss it, since UITextView owns its
  /// `UIEditMenuInteraction` privately.
  ///
  /// A no-op when nothing is selected, so a defensive call from JS costs one
  /// comparison. The emission is left to the delegate the write triggers.
  @objc public func clearSelection() {
    guard textView.selectedRange.length > 0 else { return }
    textView.selectedRange = NSRange(location: 0, length: 0)
    textView.resignFirstResponder()
  }

  /// Select `[start, end)` of the current text, UTF-16 offsets,
  /// end-exclusive — the same unit and the same clamping discipline as every
  /// event this view emits, because JS computed these offsets against text
  /// that may have moved on by a frame.
  ///
  /// FIRST RESPONDER IS TAKEN, and it has to be: a non-editable UITextView
  /// draws no selection, no handles and no menu unless it is the first
  /// responder, so setting the range alone would be an invisible selection —
  /// present in `selectedRange`, absent from the screen, and reported to JS as
  /// real. The range is set AFTER becoming first responder, because becoming
  /// one can move the selection itself.
  ///
  /// A run that is not selectable takes nothing: the platform's selection UI
  /// is off there (the Android tail policy's iOS counterpart, or an explicit
  /// `selectable={false}`), so a selection would be state nobody can see or
  /// dismiss.
  ///
  /// A RANGE THAT CLAMPS TO EMPTY IS A NO-OP AND LEAVES ANY EXISTING
  /// SELECTION ALONE. It used to clear instead, which made the command
  /// destructive in exactly the case it is least sure of itself: the offsets
  /// were computed against text that may have moved on by a frame, so an
  /// empty clamp is "I raced a swap", not "the app asked for nothing". A user
  /// mid-sweep in this run would have lost their selection to a `setSelection`
  /// aimed at text that is no longer here, and JS could not even report it —
  /// the walk in `selectSpanInRuns` answers true for a run that took the
  /// command, which would have been true of a run that had just cleared.
  /// Clearing is a thing an app asks for explicitly, and `clearSelection` is
  /// the command that does it. Nothing changes here, so nothing is emitted:
  /// `onSelectionChange` still describes the selection the run actually has.
  /// Android's `setSelection` follows the same rule, for the same reason.
  ///
  /// The other half of that honesty lives in JS: `RunHostHandle.setSelection`
  /// returning true means the command was dispatched, never that the
  /// resulting range is the one asked for.
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
    // Geometry derived from the previous run's string, not from a prop, so it
    // must go the way `lastEmbedRects` does: a recycled host that kept it
    // would offset the next run's text by a padding that run never asked for.
    // `apply` re-reads it from the string the next run arrives with.
    runEdgeInsets = .zero
    textView.selectedRange = NSRange(location: 0, length: 0)
    textView.resignFirstResponder()
    // And give up the one-active-selection slot if this host held it. The
    // weak reference alone is not enough here: a recycled host stays alive in
    // Fabric's pool, so it would keep a slot it can no longer be the owner of
    // and the next selection elsewhere would spend its clear on a host that
    // has no selection to clear.
    if Self.activeSelectionHost === self {
      Self.activeSelectionHost = nil
    }
    // Selection-report history, like `lastEmbedRects` below: it describes the
    // previous run's offsets. A recycled host that kept it could suppress the
    // first real report of the NEXT run's selection as a duplicate — the same
    // stale-state failure class, one channel over. The write above already
    // fired the delegate with an empty range, so this assignment is the last
    // word rather than a race with it.
    lastReportedSelection = NSRange(location: 0, length: 0)
    // Layout history, like `lastEmbedRects` below: the elements were framed
    // and labelled from the previous run's text, and a recycled host must not
    // hand VoiceOver a link out of a document it is no longer showing.
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
    // text length), so no chrome from the previous run outlives it. Nothing
    // to erase when there was no decoration to paint, which is why this is
    // conditional like every other invalidate in this file.
    if !resolvedDecorations.isEmpty {
      setNeedsDisplay()
    }
  }

  // MARK: - Embed rects

  /// Report where each embed's reserved space landed, deduped against the
  /// last report per id so streaming appends past a settled embed cost one
  /// rect compare instead of one event per snapshot.
  ///
  /// CALLED FROM `layoutSubviews` AND NOWHERE ELSE. The documented guarantee
  /// is that a reported rect comes from the layout the host draws with
  /// (docs/SELECTION.md, "Event: onEmbedLayout"), and the text update is not
  /// that moment: Fabric mounts a component view by calling `updateState`
  /// (which lands here through `apply`) BEFORE `updateLayoutMetrics`, so a
  /// fresh view is still at `CGRectZero` and a recycled one still carries the
  /// previous run's width. Reporting from there emitted one event per mount
  /// from geometry the host never drew with, immediately followed by the
  /// right one — a consumer that positions its overlay per event saw a frame
  /// of it in the wrong place. `apply` and the `embeds` setter therefore ask
  /// for a layout pass instead, and the pass reports once, framed.
  ///
  /// The zero-width guard below is the same rule stated defensively: a
  /// container that has not been given a width has not laid the text out,
  /// and every rect measured in it would be wrong.
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

  /// The run's accessibility tree: the text view, then one element per
  /// semantic range and one per live link, in DOCUMENT ORDER.
  ///
  /// WHY LINKS NEED ELEMENTS OF THEIR OWN. A run is one attributed string in
  /// one `UITextView`, so a link inside prose is not a view and has no
  /// `onPress` — it is a character range this class hit-tests taps against
  /// (`pressable(at:)`). VoiceOver has nothing to hit-test with: it reads the
  /// text view's whole text as one element, and a link in the middle of it is
  /// neither announced as a link nor reachable, so the only way to follow one
  /// was to see it and tap it. The elements below make every link a focus
  /// stop of its own, announced with the `.link` trait (which is also what
  /// VoiceOver's links rotor filters on), and make double-tap emit exactly
  /// the `onInlinePress` a sighted tap emits.
  ///
  /// WHY BLOCK ROLES NEED THEM TOO, AND WHY THE ANSWER COULD NOT BE INFERRED.
  /// Run merging is what makes one sweep select across a whole answer, and it
  /// is also what flattens the document's structure: the
  /// `accessibilityRole`s in `renderers.tsx` run for standalone blocks only,
  /// so a heading that flowed into a run was prose in a bigger font —
  /// announced without its role and invisible to the headings rotor — and a
  /// list or a table was one undifferentiated wall of text with no way to
  /// step through it. The host cannot recover any of that from the styling (a
  /// 26pt bold range could be anything a consumer's `attributeForMark`
  /// returned), so JS says it on the wire and the string builder stamps it:
  /// `RNSMAttributedText.semanticRanges(of:)` is the read.
  ///
  /// WHAT EACH ROLE BUYS HERE. `heading` gets the `.header` trait, which is
  /// announced and rotor-navigable in the reader's own language. `listItem`
  /// and `tableCell` get no trait at all, because iOS has none for them and
  /// the alternative would be this library shipping the English words "item"
  /// and "cell" — the same reason no link element carries a role description.
  /// What they buy instead is GRANULARITY: one focus stop per item and per
  /// cell, so a list can be stepped through, rather than one stop for the
  /// whole run. One element per construct, over the characters that construct
  /// alone contributes: a list item's range stops where its sublist begins,
  /// so a nested list is as many focus stops as it has items (JS narrows it —
  /// `resolveRunSemantics` in src/view/runAttributes.ts).
  ///
  /// THE COORDINATES DO NOT LAND HERE, AND NO PLATFORM PRIMITIVE COULD HOLD
  /// THEM. `roleLevel` (a heading's rank, a list item's depth) and the row and
  /// column do cross the wire and are dropped by this host, because UIKit has
  /// nowhere to put them: `UIAccessibilityTraits.header` is a single bit with
  /// no rank — there is no API on `UIAccessibilityElement` that carries a
  /// heading level — and there is no list-item or table-cell trait to carry a
  /// position. The only remaining vehicle is the label, and putting "heading
  /// level 2" or "row 2, column 3" there means shipping English this library
  /// cannot translate. So they are never stamped onto the string either;
  /// `RNSMAttributedText.mm` records that at the one place the decision is
  /// made. Android has the primitives — `CollectionItemInfo` for the
  /// coordinates, which TalkBack phrases in the reader's own language — and
  /// none for a heading's level either, so it drops that one for the same
  /// reason this host does.
  ///
  /// THE TEXT VIEW STAYS FIRST, AND THAT IS LOAD-BEARING. Returning only the
  /// range elements would replace the run's text with a list of its
  /// fragments: `UITextView` is what reads the prose and what carries the
  /// text-selection rotor, which is this library's entire subject.
  ///
  /// AND IT NO LONGER READS THE RANGES THE OTHER ELEMENTS READ. With the text
  /// view announcing the whole run and an element repeating each heading,
  /// item, cell and link, every one of those was spoken twice — a list of
  /// five items was read once as prose and then five more times. So
  /// `buildAccessibilityElements` sets `textView.accessibilityValue` to the
  /// prose BETWEEN the vended ranges, and each character is announced exactly
  /// once, in document order, by whichever element owns it. This is the
  /// option that keeps the selection rotor: the alternative — silencing the
  /// container so the text view is not an element at all — would take the
  /// rotor with it, and the rotor is the feature. It is safe because
  /// VoiceOver's text navigation and selection go through `UITextInput`
  /// against the REAL text, not through the announced value; only the spoken
  /// summary changes. The value is cleared again the moment a snapshot has no
  /// ranges to vend, so a run that stops holding any reads its whole self.
  ///
  /// NIL WHEN THERE IS NOTHING TO ADD, which is the common case and the reason
  /// this costs nothing: `RunHost` sends an empty `pressables` when the
  /// consumer has no `onInlinePress` listener (a link that activates nothing
  /// must not be announced as activatable), and a plain prose run carries no
  /// semantic ranges — so it answers nil and UIKit's default subview
  /// traversal, the text view, is used unchanged. The getter is also only
  /// ever called by an assistive technology, so the TextKit geometry below is
  /// off the streaming path entirely.
  public override var accessibilityElements: [Any]? {
    get {
      if let assigned = assignedAccessibilityElements {
        return assigned
      }
      if let cached = cachedAccessibilityElements {
        return cached
      }
      // Read before the emptiness test rather than after, because it IS the
      // test for the role half: the ranges live on the string the shadow
      // node measured, not in a prop this view keeps.
      let semantics = RNSMAttributedText.semanticRanges(of: textView.attributedText)
      guard !resolvedPressables.isEmpty || !semantics.isEmpty else {
        // Nothing is vended, so nothing must be elided: a run that HAD ranges
        // and no longer does would otherwise keep announcing the gaps of a
        // string it is not showing any more.
        textView.accessibilityValue = nil
        return nil
      }
      let built = buildAccessibilityElements(semantics: semantics)
      cachedAccessibilityElements = built
      return built
    }
    set {
      assignedAccessibilityElements = newValue
      cachedAccessibilityElements = nil
    }
  }

  /// Geometry comes off the SAME TextKit stack the view draws with, through
  /// the same primitives `reportEmbedRects` and the hit test use, and every
  /// range is re-clamped against the CURRENT text: a pressable range and a
  /// heading range were both computed against the text JS sent, which under
  /// prop skew can be shorter or longer than the text in hand.
  ///
  /// The frame is `accessibilityFrameInContainerSpace` rather than a screen
  /// rect or an `accessibilityPath`, because UIKit converts it on demand: a
  /// transcript scrolls, and a stored screen rect would be stale the moment
  /// it did, while this cache is only invalidated when the text or the
  /// layout changes. A link that wraps across lines gets the union of its
  /// line fragments — one rect, slightly larger than the glyphs on the short
  /// line — which is what `boundingRect(forGlyphRange:in:)` returns and is
  /// accurate enough for a focus rect.
  private func buildAccessibilityElements(semantics: [[AnyHashable: Any]]) -> [Any] {
    var elements: [Any] = [textView]
    guard bounds.width > 0 else {
      textView.accessibilityValue = nil
      return elements
    }
    let layoutManager = textView.layoutManager
    guard layoutManager.numberOfGlyphs > 0 else {
      textView.accessibilityValue = nil
      return elements
    }
    let full = (textView.text ?? "") as NSString
    let origin = textView.frame.origin
    let container = textView.textContainer

    let textRange = NSRange(location: 0, length: full.length)

    /// The focus rect for an ALREADY-CLAMPED character range, in this view's
    /// coordinates, or nil for a range that laid out to nothing. Shared by
    /// both loops so a role and a link are framed by identical primitives.
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

    /// One vended element and the range it took over from the text view.
    struct Vended {
      let range: NSRange
      let element: Any
    }
    var vended: [Vended] = []

    for entry in semantics {
      guard let boxed = entry[RNSMSemanticRangeKey] as? NSValue,
            let role = entry[RNSMSemanticRoleKey] as? String
      else { continue }
      let clamped = NSIntersectionRange(boxed.rangeValue, textRange)
      guard clamped.length > 0 else { continue }
      let label = full.substring(with: clamped)
      // A range whose text is only whitespace is a fragment, not a construct.
      // JS emits none — an item's range is trimmed of the separator in front
      // of its sublist, and an empty table cell gets no entry — so this is a
      // guard against a bundle that does, not a shape the current one
      // produces. There would be nothing to announce and a focus stop on a
      // tab is worse than none.
      guard !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let frame = frameFor(clamped)
      else { continue }
      let element = UIAccessibilityElement(accessibilityContainer: self)
      element.accessibilityLabel = label
      // `.header` is the one role iOS has a trait for. `.staticText` is what
      // RN's own accessibility layer sets for a non-interactive label and is
      // what keeps these out of the "controls" rotor they do not belong in;
      // a list item and a table cell get it alone, because iOS has no trait
      // for either and an English word would be worse than none.
      element.accessibilityTraits = role == "heading" ? [.header, .staticText] : .staticText
      element.accessibilityFrameInContainerSpace = frame
      vended.append(Vended(range: clamped, element: element))
    }

    for pressable in resolvedPressables {
      let clamped = NSIntersectionRange(pressable.range, textRange)
      guard clamped.length > 0, let frame = frameFor(clamped) else { continue }
      let element = PressableAccessibilityElement(accessibilityContainer: self)
      // The link's own text. The URL is deliberately not here: it never
      // crosses the bridge (docs/SELECTION.md), so this view does not have it
      // to announce, and the `.link` trait is what tells VoiceOver to say
      // "link" after the label.
      element.accessibilityLabel = full.substring(with: clamped)
      element.accessibilityTraits = .link
      element.accessibilityFrameInContainerSpace = frame
      element.activate = { [weak self] in
        guard let self else { return false }
        // The same emission a tap makes, clamped the same way — so a link
        // followed by VoiceOver and a link followed by touch are one event
        // path, not two.
        self.emitInlinePress(pressable)
        return true
      }
      vended.append(Vended(range: clamped, element: element))
    }

    // DOCUMENT ORDER, because the order of this array IS the VoiceOver swipe
    // order: a reader swiping through a run must meet its constructs in the
    // order they are written, not headings-then-links. Ties go to the longer
    // range, so a link that begins where its heading begins is read inside
    // it. `sort` is not stable in Swift, hence a total order rather than two
    // keys and a hope.
    vended.sort { left, right in
      if left.range.location != right.range.location {
        return left.range.location < right.range.location
      }
      return left.range.length > right.range.length
    }
    elements.append(contentsOf: vended.map { $0.element })

    // What is left for the text view to say: the prose no element above
    // covers. See `accessibilityElements` for why this is set at all — every
    // character is announced exactly once — and why it is safe.
    textView.accessibilityValue = uncoveredText(full, vended.map { $0.range })
    return elements
  }

  /// `full` with `covered` removed, the survivors joined by a space.
  ///
  /// The ranges arrive sorted by location but may NEST (a link inside a
  /// heading) and may therefore overlap, so this walks a high-water mark
  /// rather than assuming they tile. The join is a space and not an empty
  /// string because the gaps either side of a removed range are separate
  /// phrases: run together, "the" + "guide" would be spoken as one word.
  private func uncoveredText(_ full: NSString, _ covered: [NSRange]) -> String {
    var pieces: [String] = []
    var cursor = 0
    for range in covered {
      if range.location > cursor {
        let gap = full.substring(with: NSRange(location: cursor, length: range.location - cursor))
        let trimmed = gap.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { pieces.append(trimmed) }
      }
      cursor = max(cursor, NSMaxRange(range))
    }
    if cursor < full.length {
      let tail = full.substring(from: cursor).trimmingCharacters(in: .whitespacesAndNewlines)
      if !tail.isEmpty { pieces.append(tail) }
    }
    return pieces.joined(separator: " ")
  }

  /// Drop the built elements. Called wherever the text, the pressable ranges
  /// or the frame move — the three things every element's label and frame are
  /// derived from.
  ///
  /// THE TEXT VIEW'S ELIDED ANNOUNCEMENT GOES WITH THEM, and that ordering is
  /// the safe one: until the next build the text view reads its whole text
  /// again, which is a construct announced twice — the behaviour before any
  /// of this existed — rather than the gaps of a string it is no longer
  /// showing.
  ///
  /// NO `UIAccessibility.post(notification: .layoutChanged, …)` HERE, and the
  /// omission is deliberate rather than forgotten: this is called on every
  /// streamed snapshot, and that notification interrupts VoiceOver's speech
  /// and moves focus. Interrupting a reader once per token to announce that a
  /// link moved four points is worse than letting UIKit re-read the elements
  /// the next time focus moves, which it does.
  private func invalidateAccessibilityElements() {
    cachedAccessibilityElements = nil
    textView.accessibilityValue = nil
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

  /// Whether the paragraph containing `characterIndex` was laid out
  /// right-to-left, i.e. whether its leading edge is the box's right edge.
  ///
  /// READ OFF THE STRING, NOT DECIDED HERE, and that is the whole point.
  /// TextKit resolves a paragraph's direction from its own first strong
  /// character when `baseWritingDirection` is left at `.natural`, with no
  /// reference to the app's UI direction — so a single Arabic or Hebrew quote
  /// inside an English transcript indents from the right while the process
  /// stays left-to-right. The string builder therefore pins the direction it
  /// resolved onto every paragraph it indents (RNSMAttributedText.mm,
  /// `RNSMResolvedWritingDirection`), and this reads that decision back out of
  /// the one object measurement and drawing share. The chrome and the text
  /// cannot end up on opposite edges, because only one of them ever chooses.
  ///
  /// `.natural` (nothing pinned — a decoration with no layout-affecting half
  /// reached this range) answers false, which is the left edge this code
  /// always used.
  private func paragraphIsRightToLeft(at characterIndex: Int) -> Bool {
    let storage = textView.textStorage
    guard characterIndex >= 0, characterIndex < storage.length else { return false }
    let style = storage.attribute(
      .paragraphStyle, at: characterIndex, effectiveRange: nil) as? NSParagraphStyle
    return style?.baseWritingDirection == .rightToLeft
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
    // Padding is normally painted into the blank separator lines the
    // projection's '\n\n' leaves around the block, so it costs no height. At
    // the EDGE of a run there is no such line, and the room comes from
    // `runEdgeInsets` instead: the measurer added it to this view's height
    // and `layoutSubviews` pushed the text down by the top half, so
    // `band.top` for a box starting at offset 0 is already `paddingTop` or
    // more, and `bounds.height` for one ending at the last character is
    // already `paddingBottom` or more past `band.bottom`.
    //
    // THE CLAMPS THEREFORE NO LONGER BITE FOR A WELL-FORMED DECORATION, and
    // they stay because that is not the only kind that can arrive: an entry
    // from a newer JS bundle can name a padding larger than the room JS asked
    // to reserve, and a box painted over a neighbouring view is worse than
    // one drawn a point short. They were a bug when they were the ONLY thing
    // standing between a trailing table and a border on its own baseline.
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
      // LEADING EDGE, NOT LEFT EDGE, and the difference is not cosmetic. That
      // inset is a head indent, which TextKit measures from the leading edge,
      // so in a right-to-left quote the body moves to the right and a bar
      // painted at `box.minX` lands on top of the first glyphs of every line.
      // The side is read from the layout the text was actually laid out with
      // — see `paragraphIsRightToLeft(at:)` — rather than inferred here, so
      // the bar and the indent cannot disagree.
      if let barColor = decoration.barColor, decoration.barWidth > 0 {
        let barX = paragraphIsRightToLeft(at: clamped.location)
          ? box.maxX - decoration.barWidth
          : box.minX
        let bar = CGRect(
          x: barX, y: top, width: decoration.barWidth, height: bottom - top)
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

  /// Report where the selection stands, deduped against the last report.
  ///
  /// The clamp is `emitSelectionAction`'s, minus its "never empty" rule: an
  /// empty range is the whole reason this event exists, so it is emitted —
  /// once — when it follows a non-empty one.
  ///
  /// `force` re-announces an unchanged RANGE, and `apply` is the only caller
  /// that passes it — for the one case the range compare cannot see. A
  /// streamed snapshot can leave the numbers alone while rewriting the
  /// characters under them (the repaired tail), and the payload JS derives
  /// from those offsets — the source span, the selected text — is then stale.
  ///
  /// IT IS NOT PASSED FOR EVERY SNAPSHOT, and that distinction is the point:
  /// `apply` forces only when the splice's replaced middle actually overlaps
  /// the selection. Forcing unconditionally would emit one event per run per
  /// snapshot for as long as a selection existed anywhere — which is the
  /// noise `lastReportedSelection` exists to remove, and which contradicts
  /// `onSelectionChange`'s own promise to fire when the selection MOVES.
  private func emitSelectionChange(force: Bool = false) {
    let range = textView.selectedRange
    let full = ((textView.text ?? "") as NSString).length
    let start = min(max(range.location, 0), full)
    let end = min(max(range.location + range.length, 0), full)
    let clamped = NSRange(location: start, length: max(0, end - start))
    if !force, NSEqualRanges(clamped, lastReportedSelection) {
      return
    }
    lastReportedSelection = clamped
    // Recorded even with no listener, so that attaching one later does not
    // replay a selection the user made before anyone was watching.
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

  /// One active selection across the document. iOS clears a text view's
  /// selection when the user taps INSIDE that view, but not when a selection
  /// begins in a different one — so with one host per run, a reader who
  /// selected in one stretch and then long-pressed in another used to leave
  /// the first range live but undrawn (only the first responder draws a
  /// selection, and the newer host is it), still reported to JS as real. The
  /// moment a non-empty selection lands here, the host that previously held
  /// one gives it up.
  ///
  /// One pointer is enough because this handler is what maintains the
  /// invariant it relies on — see `activeSelectionHost` for why that replaced
  /// a sweep of every mounted host. Recursion-safe by construction: clearing
  /// the previous host fires its delegate with an empty range, which returns
  /// at the guard below before it can take the slot back.
  ///
  /// THE ORDER OF THE TWO HALVES IS LOAD-BEARING. This host reports its own
  /// change FIRST and coordinates second, so that a hand-off reaches JS as
  /// "B now holds [4,9)" followed by "A holds nothing" — which JS can drop as
  /// stale, because it already knows B is the owner. Coordinating first would
  /// deliver those two in the opposite order: a null (the toolbar dismisses)
  /// and then the real selection (it comes back), one visible flicker per
  /// hand-off, for no gain.
  ///
  /// A host with `exclusiveSelection == false` still REPORTS; it only skips
  /// the coordination. Opting out of clearing other hosts is not opting out of
  /// telling JS what the user selected.
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
  ///
  /// Every item here is a `ResolvedAction`, so the only string work left is
  /// one bundle lookup per untitled item: which entries survive, and what a
  /// titled one says, were both decided when the prop arrived, and an item
  /// that could not be titled at all was already dropped. The BUILT-IN titles
  /// are looked up here rather than there, so an app that changes language in
  /// place gets the new words on its next menu instead of the words that were
  /// current when it built its first one — see `defaultActionTitle(for:)`.
  /// Both the item's identifier and the event's `action` come from the same
  /// `ResolvedAction`, so a consumer-defined item reports its own id.
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
      // Nil is unreachable — `parseSelectionAction` kept only the entries
      // that have one of the two — but a blank menu item is a worse failure
      // than a missing one, so it is skipped rather than forced.
      guard let title = action.title ?? Self.defaultActionTitle(for: action.identifier)
      else { return nil }
      return UIAction(
        title: title,
        identifier: UIAction.Identifier("selectable-markdown." + action.identifier)
      ) { [weak self] _ in
        guard let self else { return }
        // The selection AS IT STANDS WHEN THE ITEM IS TAPPED, not the one
        // this menu was built for. The two can differ: `apply` deliberately
        // moves the live selection on a streamed snapshot (a Select-All
        // extends over the new text, a selection in the retained tail
        // shifts), and a menu presented before that snapshot is still up
        // after it. Emitting the captured range would then copy less than
        // the highlight shows — well-formed and wrong. Android reads
        // `textView.selectionStart/End` at invocation time for the same
        // reason (SelectableRunHostView.kt), so this is also what makes the
        // two platforms emit the same event.
        //
        // The captured range remains the fallback for the one case a live
        // read cannot cover: the selection having been cleared out from
        // under the menu, where an empty range would emit nothing at all.
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
