import "./globals.css";
import { Providers } from "./providers";

export const metadata = { title: "Debt Tracker", description: "Track debt, income, expenses" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
