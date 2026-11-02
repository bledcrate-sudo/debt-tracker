// Capacitor's own view controller, plus the app's local plugins. Plugins
// that live in the app target (rather than an npm package) have to be
// registered here; ios-extras/add-widget.rb points Main.storyboard at this
// class instead of CAPBridgeViewController.

import Capacitor
import UIKit

class DebtyBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(WidgetReloadPlugin())
    }
}
