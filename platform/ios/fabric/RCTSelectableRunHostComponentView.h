/*
 * RCTSelectableRunHostComponentView — the Fabric mounting-layer view for
 * <SelectableRunHost> on iOS.
 *
 * WHAT IT IS FOR. Fabric's mounting layer needs one `RCTViewComponentView`
 * subclass per component: it is what the component registry instantiates, what
 * receives props, state, the event emitter and layout metrics, and what gets
 * pooled and handed to the next run. It does not draw anything itself. The
 * actual text view is SelectableRunHostView (Swift), added here as
 * `contentView`; it owns selection, the edit menu, the text splice and the
 * clamped event payload (docs/SELECTION.md is the contract).
 *
 * THE FILE IS ENTIRELY INSIDE #ifdef RCT_NEW_ARCH_ENABLED, INCLUDES AND ALL,
 * which is always true at the react-native >= 0.82 floor.
 *
 * Keep this header in `s.private_header_files`: CocoaPods compiles public
 * headers as Objective-C for the module map, and the C++ this imports would
 * break `import SelectableMarkdown` in every consumer.
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
 * Compatibility only: at react-native >= 0.82 the component is found through
 * `codegenConfig.ios.componentProvider`, where a bad entry fails silently at
 * mount. React Natives that still call this symbol fail to link without it;
 * scripts/check-codegen.mjs pins both spellings.
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
