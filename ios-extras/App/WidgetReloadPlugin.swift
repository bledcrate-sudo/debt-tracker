// Lets the web app ask iOS to refresh the Debty home-screen widget right
// away (lib/widget-reload.ts calls it after a payment is logged or the
// challenge changes). Refreshes the app asks for while it's open don't count
// against the small daily budget iOS gives widgets to refresh themselves.

import Capacitor
import Foundation
import WidgetKit

@objc(WidgetReloadPlugin)
public class WidgetReloadPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetReloadPlugin"
    public let jsName = "WidgetReload"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise)
    ]

    @objc public func reload(_ call: CAPPluginCall) {
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }
}
