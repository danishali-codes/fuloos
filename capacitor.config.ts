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
    backgroundColor: "#f7f8f5",
    allowMixedContent: false,
  },
  ios: {
    backgroundColor: "#f7f8f5",
    contentInset: "automatic",
    scheme: "Fuloos",
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      style: "LIGHT",
      backgroundColor: "#fcfcfa",
    },
  },
};

export default config;
