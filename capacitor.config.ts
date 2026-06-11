import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.debttracker.app",
  appName: "Debt Tracker",
  webDir: "public",
  server: {
    // Replace with your deployed Next.js URL (Vercel / Railway / Fly etc.)
    // For local testing on real iPhone: use your Mac LAN IP, e.g. http://192.168.1.50:5000
    url: process.env.CAP_SERVER_URL || "https://your-debt-tracker.vercel.app",
    cleartext: false,
    androidScheme: "https",
    iosScheme: "https",
  },
  ios: {
    contentInset: "automatic",
    backgroundColor: "#020617",
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
