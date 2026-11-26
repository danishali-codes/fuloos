import { isNativePlatform } from "../mobile/platformBridge";
export {
  evaluateCalculatorExpression,
  hexAlpha,
  lightenHex,
} from "./mobileCalc";

/**
 * Returns true when running inside the Capacitor APK (Android/iOS native shell).
 * In local Vite dev mode, `?apk=1` also enables the native mobile UI for visual QA
 * without affecting web users in production builds.
 */
export function isMobileApkMode(): boolean {
  if (isNativePlatform()) return true;
  if (
    typeof window !== "undefined" &&
    typeof import.meta !== "undefined" &&
    (import.meta as { env?: { DEV?: boolean } }).env?.DEV
  ) {
    try {
      return new URLSearchParams(window.location.search).get("apk") === "1";
    } catch {
      return false;
    }
  }
  return false;
}
