/*
 * The Fabric mounting-layer view. Read RCTSelectableRunHostComponentView.h
 * first: it says what this class is for, why the whole file is inside the
 * new-architecture guard, and why `SelectableRunHostCls` at the bottom is kept.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: build a string. `text` and
 * `attributes` are props, they arrive here, and they are ignored on purpose.
 * The string this view draws is the exact NSAttributedString
 * RNSMRunHostShadowNode::measureContent already laid out on the layout thread,
 * carried across in Fabric State (RNSMRunHostState) and applied in
 * -updateState:oldState: below. Rebuilding an equal-looking string here from
 * the same props would put a second string builder on the main thread, and the
 * moment the two drift the run is measured at one height and drawn at another
 * — text clipped at the bottom of the run, worse the longer the run, and not
 * reproducible by anything in this repository (docs/FABRIC-PLAN.md §4).
 */

#ifdef RCT_NEW_ARCH_ENABLED

#import "RCTSelectableRunHostComponentView.h"

#import <React/RCTConversions.h>
#import <react/renderer/components/SelectableMarkdownSpec/EventEmitters.h>
#import <react/renderer/components/SelectableMarkdownSpec/Props.h>
#import <react/renderer/components/SelectableMarkdownSpec/RCTComponentViewHelpers.h>
#import <react/utils/ManagedObjectWrapper.h>

#import "RNSMAttributedText+Props.h"
#import "RNSMRunHostComponentDescriptor.h"
#import "RNSMRunHostShadowNode.h"

/*
 * The Swift half of this pod, reached through the header the Swift compiler
 * generates for it. Both spellings are needed and neither is redundant:
 * CocoaPods emits the generated header into the module's umbrella directory
 * when the pod is built as a framework (`use_frameworks!`) and next to the
 * other private headers when it is built as a static library, which is the
 * default. Picking one and hoping is how a library builds for its author and
 * not for the first person who turns on `use_frameworks!`.
 *
 * The two React imports must come first: the generated header declares the
 * Swift classes in terms of `RCTViewManager` and `RCTDirectEventBlock` but
 * imports nothing itself, so whoever includes it owes it those types.
 */
#import <React/RCTComponent.h>
#import <React/RCTViewManager.h>
#if __has_include(<SelectableMarkdown/SelectableMarkdown-Swift.h>)
#import <SelectableMarkdown/SelectableMarkdown-Swift.h>
#else
#import "SelectableMarkdown-Swift.h"
#endif

using namespace facebook::react;

/* In a class extension so the generated C++ helpers header stays out of ours. */
@interface RCTSelectableRunHostComponentView () <RCTSelectableRunHostViewProtocol>
@end

/*
 * Codegen gives `selectionActions` an ordered std::vector<std::string> rather
 * than the bitmask a string-enum array would have produced, because the menu
 * is ordered and a bitmask loses order
 * (src/view/SelectableRunHostNativeComponent.ts says so at the point of
 * decision). Order therefore has to survive this conversion too, which is why
 * it is a plain in-order copy and not a set.
 *
 * Elements stay packed as `identifier[U+001F title]`; SelectableRunHostView's
 * `parseSelectionAction` unpacks them.
 */
static NSArray<NSString *> *RCTSelectableRunHostActions(const std::vector<std::string> &actions)
{
  NSMutableArray<NSString *> *result = [NSMutableArray arrayWithCapacity:actions.size()];
  for (const auto &action : actions) {
    [result addObject:RCTNSStringFromString(action)];
  }
  return result;
}

/*
 * The dictionary keys are SelectableRunHostView's `pressables` parser — the
 * same shape paper's RCT_EXPORT_VIEW_PROPERTY(pressables, NSArray) delivers
 * from JS directly, so the Swift view has exactly one wire format to parse.
 */
static NSArray<NSDictionary *> *RCTSelectableRunHostPressables(
    const std::vector<SelectableRunHostPressablesStruct> &pressables)
{
  NSMutableArray<NSDictionary *> *result = [NSMutableArray arrayWithCapacity:pressables.size()];
  for (const auto &pressable : pressables) {
    [result addObject:@{
      @"start" : @(pressable.start),
      @"end" : @(pressable.end),
      @"pressableId" : @(pressable.pressableId),
    }];
  }
  return result;
}

/*
 * Codegen emits no operator== for the decorations struct either, and a
 * field-by-field comparison of fourteen members is exactly the sort of list
 * that rots when the spec gains one. The structs are plain data decoded from
 * the same wire, so the honest comparison is on the decoded form: convert
 * both sides through the ONE decoder (RNSMAttributedText decorationsWithProps)
 * and let NSDictionary equality do the rest. The conversion cost is bounded
 * by the decoration count — single digits per run — and it is paid only on
 * commits, not per frame.
 */
static bool RCTSelectableRunHostDecorationsEqual(
    const SelectableRunHostProps &lhs,
    const SelectableRunHostProps &rhs)
{
  if (lhs.decorations.size() != rhs.decorations.size()) {
    return false;
  }
  if (lhs.decorations.empty()) {
    return true;
  }
  return [[RNSMAttributedText decorationsWithProps:lhs]
      isEqualToArray:[RNSMAttributedText decorationsWithProps:rhs]];
}

/*
 * Same decoded-form comparison as decorations, for the same reason: one
 * decoder (RNSMAttributedText embedsWithProps) already exists for the string
 * builder, so the honest equality is on what it produces rather than a
 * member list that rots when the spec gains a field.
 */
static bool RCTSelectableRunHostEmbedsEqual(
    const SelectableRunHostProps &lhs,
    const SelectableRunHostProps &rhs)
{
  if (lhs.embeds.size() != rhs.embeds.size()) {
    return false;
  }
  if (lhs.embeds.empty()) {
    return true;
  }
  return [[RNSMAttributedText embedsWithProps:lhs]
      isEqualToArray:[RNSMAttributedText embedsWithProps:rhs]];
}

/*
 * Codegen emits no operator== for generated structs, so the prop diff below
 * compares by hand. Element-wise and in order, because order is identity
 * here: `pressableId` is JS's index into the array as sent.
 */
static bool RCTSelectableRunHostPressablesEqual(
    const std::vector<SelectableRunHostPressablesStruct> &lhs,
    const std::vector<SelectableRunHostPressablesStruct> &rhs)
{
  if (lhs.size() != rhs.size()) {
    return false;
  }
  for (size_t i = 0; i < lhs.size(); i++) {
    if (lhs[i].start != rhs[i].start || lhs[i].end != rhs[i].end ||
        lhs[i].pressableId != rhs[i].pressableId) {
      return false;
    }
  }
  return true;
}

@implementation RCTSelectableRunHostComponentView {
  SelectableRunHostView *_hostView;
  RNSMRunHostShadowNode::ConcreteState::Shared _state;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    /*
     * Required, and asserted rather than merely expected:
     * `RCTViewComponentView.updateProps:oldProps:` reads `*_props` as the
     * *old* props on the very first update, so a subclass that leaves the
     * base class's ViewProps in place would static_cast a ViewProps to a
     * SelectableRunHostProps and read past the end of it.
     */
    _props = RNSMRunHostShadowNode::defaultSharedProps();

    _hostView = [[SelectableRunHostView alloc] initWithFrame:self.bounds];

    /*
     * THE VIEW'S STATE AND `_props` MUST START IN AGREEMENT, because every
     * prop below is applied by *diffing* against `_props` and a prop that does
     * not differ is never pushed.
     *
     * The concrete failure: `selectionActions` defaults to an empty vector in
     * the generated props but to both actions in SelectableRunHostView, and JS
     * sends `[]` precisely when the app registered no `onSelectionAction`
     * listener (src/view/RunHost.tsx). Empty equals the default, so the diff
     * is empty, so the setter never runs, so the host would keep offering
     * "Copy Text" and "Copy Markdown" — two menu items that emit an event
     * nobody is listening to. The whole reason JS sends an empty list is to
     * stop the menu offering an item that would visibly do nothing.
     *
     * Recycling does not break this invariant: `prepareForRecycle` does not
     * reset `_props` (RCTViewComponentView.mm:452-470), which is exactly why
     * -[SelectableRunHostView reset] deliberately leaves both of these alone.
     */
    const auto &defaultProps = static_cast<const SelectableRunHostProps &>(*_props);
    _hostView.selectable = defaultProps.selectable;
    _hostView.selectionActions = RCTSelectableRunHostActions(defaultProps.selectionActions);

    /*
     * Weak, because the retain graph runs the other way: this view owns
     * `_hostView` through `contentView`, and `_hostView` owns this block. A
     * strong capture is a cycle that leaks a UITextView, its text storage and
     * — through the event emitter — a slice of the shadow tree, once per run
     * in every document that ever scrolled.
     */
    __weak __typeof(self) weakSelf = self;
    _hostView.onSelectionAction =
        ^(NSInteger start, NSInteger end, NSString *action, NSString *selectedText) {
          [weakSelf emitSelectionActionWithStart:start end:end action:action selectedText:selectedText];
        };
    /*
     * Weak for the identical reason. `pressables` needs no default sync
     * above, unlike `selectionActions`: the generated default (an empty
     * vector) and the host's default (an empty array) agree, so the
     * diff-then-push in updateProps starts from a true premise.
     */
    _hostView.onInlinePress = ^(NSInteger start, NSInteger end, NSInteger pressableId) {
      [weakSelf emitInlinePressWithStart:start end:end pressableId:pressableId];
    };
    /*
     * Weak for the identical reason. Like `pressables`, `embeds` needs no
     * default sync above: the generated default (an empty vector) and the
     * host's default (an empty array) agree.
     */
    _hostView.onEmbedLayout = ^(NSInteger embedId, double x, double y, double width, double height) {
      [weakSelf emitEmbedLayoutWithId:embedId x:x y:y width:width height:height];
    };
    // Weak for the identical reason. The Swift host dedupes this drag-rate event.
    _hostView.onSelectionChange = ^(NSInteger start, NSInteger end) {
      [weakSelf emitSelectionChangeWithStart:start end:end];
    };
    /*
     * `contentView` is framed for free from `updateLayoutMetrics:`
     * (RCTViewComponentView.mm:419-421), so this class needs no
     * `layoutSubviews` override — unlike the paper wrapper, which has one
     * because an old-architecture leaf view has to measure itself after the
     * fact.
     */
    self.contentView = _hostView;
  }

  return self;
}

#pragma mark - RCTComponentViewProtocol

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  /*
   * The sole iOS registration hook (RCTComponentViewFactory.mm:182-186), and
   * the reason this class exists rather than codegen's generated descriptor
   * being enough: `RNSMRunHostComponentDescriptor` is the one that hands every
   * node a measurer. Codegen's `SelectableRunHostComponentDescriptor` wraps a
   * plain ConcreteViewShadowNode with no measure function, and a Fabric
   * component with no measure function lays every run out at zero height
   * (LayoutableShadowNode.cpp:221-226 returns {}) — a blank document with no
   * error anywhere.
   */
  return concreteComponentDescriptorProvider<RNSMRunHostComponentDescriptor>();
}

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps
{
  const auto &oldViewProps = static_cast<const SelectableRunHostProps &>(*_props);
  const auto &newViewProps = static_cast<const SelectableRunHostProps &>(*props);

  /*
   * `text` and `attributes` are read by nobody here. See the file header: the
   * string was built and measured on the layout thread and arrives through
   * State. They still have to exist as props — they are what the shadow node
   * builds from, and on Android they are what the ViewManager renders from —
   * so their absence here is a decision, not an omission.
   */

  if (oldViewProps.selectable != newViewProps.selectable) {
    _hostView.selectable = newViewProps.selectable;
  }

  // No init-time sync: codegen's default and the Swift host's are both true,
  // which scripts/check-codegen.mjs asserts.
  if (oldViewProps.exclusiveSelection != newViewProps.exclusiveSelection) {
    _hostView.exclusiveSelection = newViewProps.exclusiveSelection;
  }

  if (oldViewProps.selectionActions != newViewProps.selectionActions) {
    _hostView.selectionActions = RCTSelectableRunHostActions(newViewProps.selectionActions);
  }

  if (!RCTSelectableRunHostPressablesEqual(oldViewProps.pressables, newViewProps.pressables)) {
    _hostView.pressables = RCTSelectableRunHostPressables(newViewProps.pressables);
  }

  /*
   * Unlike `text` and `attributes`, `decorations` IS read here: its
   * layout-affecting half was consumed by the string builder on the layout
   * thread (RNSMAttributedText attributedStringWithProps:fontSizeMultiplier:),
   * but the drawn half — the boxes and rules — is painted by the host view
   * itself, so the view needs the list. Same decoder as the builder used, so the two halves
   * of one decoration cannot disagree about a field.
   */
  if (!RCTSelectableRunHostDecorationsEqual(oldViewProps, newViewProps)) {
    _hostView.decorations = [RNSMAttributedText decorationsWithProps:newViewProps];
  }

  /*
   * `embeds` is read here for the same split reason as `decorations`: the
   * layout-affecting half (the attachment) was consumed by the string builder
   * on the layout thread, but the rect reports come from the host view, and
   * the view needs the list to know which placeholders to report on. Same
   * decoder as the builder used, so the two halves cannot disagree.
   */
  if (!RCTSelectableRunHostEmbedsEqual(oldViewProps, newViewProps)) {
    _hostView.embeds = [RNSMAttributedText embedsWithProps:newViewProps];
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)updateState:(const State::Shared &)state oldState:(const State::Shared &)oldState
{
  _state = std::static_pointer_cast<const RNSMRunHostShadowNode::ConcreteState>(state);

  /*
   * A null state is reachable — Fabric clears state on unmount — and is not an
   * error. Leaving the last run's text on screen would be, so it is cleared
   * through the same path recycling uses.
   */
  if (!_state) {
    [_hostView reset];
    return;
  }

  /*
   * unwrapManagedObject is the exact inverse of the wrapManagedObject in
   * RNSMRunTextMeasurer::prepareContent (react/utils/ManagedObjectWrapper.h
   * :53-62), so the `void` in `std::shared_ptr<void>` is opaque only to the
   * cross-platform code between the two — the wrap and the unwrap are the same
   * pair of lines, in the same package, for the same object.
   *
   * `-apply(attributedText:)` is what preserves the user's selection across
   * the swap (save range -> swap -> restore clamped, with Select-All
   * tracking), which is why the string is handed to the host view rather than
   * assigned to its text view directly. Streaming re-publishes state on every
   * snapshot whose content actually changed, so this is the hot path, and it
   * is also the path an in-progress selection has to survive.
   */
  NSAttributedString *attributedString =
      (NSAttributedString *)unwrapManagedObject(_state->getData().attributedString);
  [_hostView applyWithAttributedText:attributedString ?: [NSAttributedString new]];
}

- (void)prepareForRecycle
{
  /*
   * A CORRECTNESS REQUIREMENT, NOT HYGIENE. Fabric pools component views and
   * hands a used one to a different run. A recycled view that kept its
   * selection and its live edit menu would let the user tap "Copy Markdown" on
   * handles left over from the previous run: nothing throws, the offsets are
   * well-formed, and they are mapped through the *new* run's piece table — so
   * the app receives a valid-looking payload of markdown the user never
   * selected. That is the worst failure this library can have and it is
   * completely silent (docs/SELECTION.md, "View recycling").
   *
   * [super prepareForRecycle] resets `_eventEmitter` (RCTViewComponentView.mm
   * :466), which is why -emitSelectionActionWith… below checks it and why this
   * class never caches an emitter of its own: after this point an event fired
   * by a still-live gesture has nowhere to go, instead of somewhere wrong.
   */
  [super prepareForRecycle];
  _state.reset();
  [_hostView reset];
}

#pragma mark - Events

- (void)emitSelectionActionWithStart:(NSInteger)start
                                 end:(NSInteger)end
                              action:(NSString *)action
                        selectedText:(NSString *)selectedText
{
  if (!_eventEmitter) {
    return;
  }

  /*
   * The offsets are UTF-16 into the run's projected `text`, already clamped to
   * it by SelectableRunHostView, and nothing here re-derives them: this port
   * introduces no UTF-8/UTF-16 arithmetic on the selection path
   * (docs/SELECTION.md, "Offsets end to end"). RCTStringFromNSString is a
   * UTF-8 transcode of the payload strings only — `action` is an ASCII
   * identifier and `selectedText` is carried, never measured against.
   */
  static_cast<const SelectableRunHostEventEmitter &>(*_eventEmitter)
      .onSelectionAction(SelectableRunHostEventEmitter::OnSelectionAction{
          .start = static_cast<int>(start),
          .end = static_cast<int>(end),
          .action = RCTStringFromNSString(action),
          .selectedText = RCTStringFromNSString(selectedText)});
}

- (void)emitInlinePressWithStart:(NSInteger)start
                             end:(NSInteger)end
                     pressableId:(NSInteger)pressableId
{
  /*
   * The nil check matters for the same recycling reason as above: after
   * prepareForRecycle a tap that was mid-flight has nowhere to go, instead of
   * somewhere wrong. The offsets were clamped against the current text by
   * SelectableRunHostView; nothing here re-derives them.
   */
  if (!_eventEmitter) {
    return;
  }

  static_cast<const SelectableRunHostEventEmitter &>(*_eventEmitter)
      .onInlinePress(SelectableRunHostEventEmitter::OnInlinePress{
          .start = static_cast<int>(start),
          .end = static_cast<int>(end),
          .pressableId = static_cast<int>(pressableId)});
}

- (void)emitEmbedLayoutWithId:(NSInteger)embedId
                            x:(double)x
                            y:(double)y
                        width:(double)width
                       height:(double)height
{
  /*
   * The nil check matters for the same recycling reason as the two above: a
   * layout report racing prepareForRecycle has nowhere to go, instead of
   * somewhere wrong — the host's own reset() cleared its rect dedupe, so the
   * next run re-reports through a live emitter.
   */
  if (!_eventEmitter) {
    return;
  }

  static_cast<const SelectableRunHostEventEmitter &>(*_eventEmitter)
      .onEmbedLayout(SelectableRunHostEventEmitter::OnEmbedLayout{
          .embedId = static_cast<int>(embedId),
          .x = static_cast<Float>(x),
          .y = static_cast<Float>(y),
          .width = static_cast<Float>(width),
          .height = static_cast<Float>(height)});
}

- (void)emitSelectionChangeWithStart:(NSInteger)start end:(NSInteger)end
{
  /*
   * prepareForRecycle clears the emitter before -[SelectableRunHostView reset],
   * so the empty range that reset reports never reaches an unmounting JS tree. An
   * empty range is otherwise a legal payload: it is how JS learns the
   * selection went away.
   */
  if (!_eventEmitter) {
    return;
  }

  static_cast<const SelectableRunHostEventEmitter &>(*_eventEmitter)
      .onSelectionChange(SelectableRunHostEventEmitter::OnSelectionChange{
          .start = static_cast<int>(start), .end = static_cast<int>(end)});
}

#pragma mark - Native Commands

- (void)handleCommand:(const NSString *)commandName args:(const NSArray *)args
{
  // The generated dispatcher already validates arity and argument types.
  RCTSelectableRunHostHandleCommand(self, commandName, args);
}

- (void)clearSelection
{
  [_hostView clearSelection];
}

- (void)setSelection:(NSInteger)start end:(NSInteger)end
{
  // Unclamped: only the Swift host knows the current text, and JS may be a frame behind.
  [_hostView setSelection:start end:end];
}

@end

Class<RCTComponentViewProtocol> SelectableRunHostCls(void)
{
  return RCTSelectableRunHostComponentView.class;
}

#endif // RCT_NEW_ARCH_ENABLED
