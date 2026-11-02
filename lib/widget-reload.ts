import { Capacitor, registerPlugin } from "@capacitor/core";

// Native side: ios-extras/App/WidgetReloadPlugin.swift.
const WidgetReload = registerPlugin<{ reload(): Promise<void> }>("WidgetReload");

// Asks iOS to refresh the home-screen widget now, so a logged payment shows
// on it right away. iOS rations the refreshes a widget can schedule for
// itself, but ones the app requests while it's open aren't rationed. Does
// nothing in a browser, or in an app build from before the plugin existed.
export function reloadWidget() {
  if (!Capacitor.isNativePlatform()) return;
  WidgetReload.reload().catch(() => {});
}
