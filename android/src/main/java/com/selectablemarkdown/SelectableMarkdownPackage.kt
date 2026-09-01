package com.selectablemarkdown

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class SelectableMarkdownPackage : ReactPackage {

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        // The md4c-backed parser module (binding OffsetParser over JSI).
        // Registering it only exposes install(); a failed install does not
        // break this package's view hosting — selection and rendering are
        // independent of where the document came from — but nothing will
        // have parsed a document to render, because md4c is the only parser
        // the package ships. JS reports that at the first parse.
        return listOf(SelectableMarkdownModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return listOf(SelectableRunHostViewManager())
    }
}
