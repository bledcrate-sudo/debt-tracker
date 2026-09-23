import "./globals.css";
import type { Viewport } from "next";
import { Providers } from "./providers";

export const metadata = { title: "Debt Tracker", description: "Track debt, income, expenses" };

// viewport-fit=cover lets the layout read the iPhone safe areas (notch, home
// indicator) through env(safe-area-inset-*), used by the phone tab bar and
// bottom sheets.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
