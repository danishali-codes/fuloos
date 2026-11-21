import type { SessionStorageLike } from "../supabaseBackend.ts";

export interface NativeAuthStorageBridge {
  authStorageGetItem(key: string): Promise<string | null>;
  authStorageSetItem(key: string, value: string): Promise<void>;
  authStorageRemoveItem(key: string): Promise<void>;
}

/**
 * supabase-js session storage backed by the Android Keystore (SecureAuthStore.kt).
 *
 * The app and the background SMS workers then share one session: whichever side
 * refreshes the access token writes the rotated refresh token here, and the other
 * side reads it on its next request. supabase-js reads storage before every token
 * check, so nothing is cached on this side.
 */
export function createNativeAuthStorage(
  bridge: NativeAuthStorageBridge,
): SessionStorageLike {
  return {
    getItem: async (key) => {
      try {
        return await bridge.authStorageGetItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => bridge.authStorageSetItem(key, value),
    removeItem: async (key) => {
      try {
        await bridge.authStorageRemoveItem(key);
      } catch {
        /* Nothing stored, or the plugin is unavailable. */
      }
    },
  };
}
