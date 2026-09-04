/*
 * RCTSelectableRunHostComponentView — the Fabric mounting-layer view for
 * <SelectableRunHost> on iOS.
 *
 * WHAT IT IS FOR. Fabric's mounting layer needs one `RCTViewComponentView`
 * subclass per component: it is what the component registry instantiates, what
 * receives props, state, the event emitter and layout metrics, and what gets
 * pooled and handed to the next run. It does not draw anything itself. The
 * actual text view is SelectableRunHostView (Swift), added here as
 * `contentView` — so selection, the edit menu, the selection-preserving text
 * splice and the clamped event payload live in one architecture-neutral
 * implementation rather than in the mounting layer, which is what let the
 * old-architecture view manager be deleted whole at the `react-native >=
 * 0.82` floor without rewriting any of it (docs/SELECTION.md is the contract;
 * §5 of docs/FABRIC-PLAN.md is why none of it was rewritten).
 *
 * THE FILE IS ENTIRELY INSIDE #ifdef RCT_NEW_ARCH_ENABLED, INCLUDES AND ALL,
 * BUT THAT IS NOT AN ARCHITECTURE GATE — there is no architecture left to
 * select. The import below comes from React-RCTFabric, which this pod depends
 * on through `install_modules_dependencies`, and the podspec calls that
 * unconditionally (it is also what defines the macro), because from
 * react-native 0.82 — this package's peer floor — React Native refuses to
 * install the old architecture at all. So the guard is always true here; it
 * stays as a statement of what these includes need, not as a switch.
 *
 * WHAT IS STILL LOAD-BEARING is this header's place in
 * `s.private_header_files`. The pod sets DEFINES_MODULE = YES and contains
 * Swift, so CocoaPods compiles every *public* header as Objective-C while
 * building the module map. `RCTViewComponentView.h` reaches React-RCTFabric's
 * C++ renderer headers, which that compile cannot take, so listing this file
 * public would break `import SelectableMarkdown` in every consumer — not only
 * in some of them.
 */

#ifdef RCT_NEW_ARCH_ENABLED

#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface RCTSelectableRunHostComponentView : RCTViewComponentView
@end

NS_ASSUME_NONNULL_END

#ifdef __cplusplus
extern "C" {
#endif

/*
 * THE SYMBOL THAT USED TO BE THE WHOLE iOS FABRIC CONTRACT, KEPT FOR THE
 * REACT NATIVES THAT STILL CALL IT — NOT WHAT REGISTERS THE COMPONENT HERE.
 *
 * iOS Fabric component discovery is by name, but the mechanism moved and this
 * package's peer floor is on the far side of the move. It used to be that
 * codegen generated `RCTThirdPartyFabricComponentsProvider` with a lookup
 * entry calling `SelectableRunHostCls()` — the component name from
 * `codegenNativeComponent('SelectableRunHost')` with `Cls` appended
 * (GenerateThirdPartyFabricComponentsProviderH.js, LookupFuncTemplate) —
 * declared `__attribute__((used))` rather than `weak`, so a package that
 * shipped the codegenConfig and no definition failed to link the app.
 *
 * At `react-native >= 0.82` that is no longer how this component is found.
 * Codegen emits `RCTThirdPartyComponentsProvider.mm` as a name ->
 * `NSClassFromString(...)` dictionary built from `codegenConfig.ios
 * .componentProvider` in this package's package.json ("SelectableRunHost":
 * "RCTSelectableRunHostComponentView"), and `RCTComponentViewFactory` looks
 * the class up in that dictionary. Nothing on that path declares
 * `SelectableRunHostCls`, so its absence is not a link error there — a
 * missing or misspelled `componentProvider` entry is instead a *silent* miss,
 * and `RunHost` throwing at mount is the only symptom. That is the failure
 * scripts/check-codegen.mjs asserts against; its componentProvider check and
 * its NATIVE_REGISTRATIONS entry for this symbol are the current statement of
 * which mechanism is live on which React Native.
 *
 * So the definition at the bottom of the .mm is compatibility, not
 * registration: it keeps working on the React Natives that still call the
 * symbol directly, and check-codegen pins its exact spelling because on those
 * a misnamed definition is still a link failure in a consuming app.
 *
 * It is declared here inside `extern "C"` for the same reason React Native
 * declares its own in RCTFabricComponentsPlugins.h: the generated provider
 * declares it with C linkage, and a definition compiled with C++ linkage
 * would produce a differently mangled symbol that satisfies nothing.
 */
Class<RCTComponentViewProtocol> SelectableRunHostCls(void);

#ifdef __cplusplus
}
#endif

#endif // RCT_NEW_ARCH_ENABLED
