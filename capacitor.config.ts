import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.danishali.fuloos",
  appName: "Fuloos",
  webDir: "dist",
  server: {
    androidScheme: "https",
    iosScheme: "https",
  },
  android: {
    backgroundColor: "#f5f7f3",
    allowMixedContent: false,
  },
  ios: {
    backgroundColor: "#f5f7f3",
    contentInset: "automatic",
    scheme: "Fuloos",
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      style: "LIGHT",
      backgroundColor: "#f5f7f3",
    },
  },
};

export default config;
