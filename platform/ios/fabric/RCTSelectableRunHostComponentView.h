/*
 * RCTSelectableRunHostComponentView — the Fabric mounting-layer view for
 * <SelectableRunHost> on iOS.
 *
 * WHAT IT IS FOR. Fabric's mounting layer needs one `RCTViewComponentView`
 * subclass per component: it is what the component registry instantiates, what
 * receives props, state, the event emitter and layout metrics, and what gets
 * pooled and handed to the next run. It does not draw anything itself. The
 * actual text view is SelectableRunHostView (Swift), the same object the
 * old-architecture view manager mounts, added here as `contentView` — so
 * selection, the edit menu, the Select-All-preserving text swap and the
 * clamped event payload are one implementation on both architectures rather
 * than two that must agree (docs/SELECTION.md is the contract; §5 of
 * docs/FABRIC-PLAN.md is why none of it is rewritten).
 *
 * THE FILE IS ENTIRELY INSIDE #ifdef RCT_NEW_ARCH_ENABLED, INCLUDES AND ALL,
 * so an old-architecture app compiles it to an empty translation unit. The
 * import below comes from React-RCTFabric, which this pod only depends on
 * when `install_modules_dependencies` runs — and that call is gated on the
 * same environment variable (SelectableMarkdown.podspec). Without the guard,
 * an old-architecture app would fail to build on a header it never asked for.
 * That is also why this header is listed in `s.private_header_files`: the pod
 * sets DEFINES_MODULE = YES and contains Swift, so CocoaPods compiles every
 * *public* header while building the module map, and a header that imports
 * React-RCTFabric would break `import SelectableMarkdown` in exactly the apps
 * that do not have it.
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
 * THE ONE SYMBOL THAT MAKES THE COMPONENT EXIST ON iOS, AND THE ONE WHOSE
 * ABSENCE IS A LINK ERROR IN SOMEBODY ELSE'S APP.
 *
 * iOS Fabric component discovery is by name: `RCTComponentViewFactory`
 * (React/Fabric/Mounting/RCTComponentViewFactory.mm:119) asks
 * `RCTThirdPartyFabricComponentsProvider(name)` for a class, and that function
 * is *generated for the app* by codegen, from every package's codegenConfig.
 * For this package it is generated as a lookup entry that calls
 * `SelectableRunHostCls()` — the component name from
 * `codegenNativeComponent('SelectableRunHost')` with `Cls` appended
 * (GenerateThirdPartyFabricComponentsProviderH.js, LookupFuncTemplate).
 *
 * The generated declaration carries `__attribute__((used))`, not `weak`, so
 * this is not an optional hook: a package that ships the codegenConfig and no
 * definition of this function fails to link every new-architecture app that
 * installs it, with an "undefined symbol: _SelectableRunHostCls" naming a
 * file the app author never wrote. The definition is at the bottom of the .mm.
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
