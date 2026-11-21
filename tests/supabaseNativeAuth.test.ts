import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "../src/backendTypes.ts";
import { createNativeAuthStorage } from "../src/mobile/nativeAuthStorage.ts";
import {
  NATIVE_AUTH_REDIRECT,
  SUPABASE_AUTH_STORAGE_KEY,
  SupabaseBackend,
} from "../src/supabaseBackend.ts";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const USER_ID = "11111111-1111-4111-8111-111111111111";

function authPayload(tag: string) {
  const access = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({
    sub: USER_ID,
    aud: "authenticated",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    aal: "aal1",
    session_id: tag,
  })}.sig`;
  return {
    access_token: access,
    refresh_token: `refresh-${tag}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: "person@example.test",
      email_confirmed_at: "2026-11-01T00:00:00Z",
      app_metadata: { provider: "google" },
      user_metadata: {},
      created_at: "2026-11-01T00:00:00Z",
      factors: [],
    },
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Async storage, like the Android Keystore bridge. */
function fixture(handler: (url: URL, body: unknown) => Response) {
  const store = new Map<string, string>();
  const calls: Array<{ path: string; search: string; body: unknown }> = [];
  const storage = createNativeAuthStorage({
    authStorageGetItem: async (k) => store.get(k) ?? null,
    authStorageSetItem: async (k, v) => {
      store.set(k, v);
    },
    authStorageRemoveItem: async (k) => {
      store.delete(k);
    },
  });
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ path: url.pathname, search: url.search, body });
    return handler(url, body);
  }) as typeof fetch;
  const backend = new SupabaseBackend(
    "https://proj.supabase.co",
    "sb_publishable_test_key",
    storage,
    fetcher,
    {
      redirectTo: NATIVE_AUTH_REDIRECT,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  );
  return { backend, store, calls };
}

test("native auth storage swallows read errors but surfaces write errors", async () => {
  const storage = createNativeAuthStorage({
    authStorageGetItem: async () => {
      throw new Error("plugin missing");
    },
    authStorageSetItem: async () => {
      throw new Error("keystore locked");
    },
    authStorageRemoveItem: async () => {
      throw new Error("plugin missing");
    },
  });
  assert.equal(await storage.getItem("fuloos-supabase-auth"), null);
  await assert.doesNotReject(async () => storage.removeItem("fuloos-supabase-auth"));
  await assert.rejects(async () => storage.setItem("fuloos-supabase-auth", "x"), /keystore/);
});

test("Supabase session lives under the fixed key the Android workers read", async () => {
  const f = fixture((url) => {
    if (url.pathname === "/auth/v1/token") return json(authPayload("a"));
    return json({}, 404);
  });
  assert.equal(f.backend.storageKey, SUPABASE_AUTH_STORAGE_KEY);
  await f.backend.signIn("person@example.test", "pw");
  const stored = JSON.parse(f.store.get(SUPABASE_AUTH_STORAGE_KEY) ?? "{}");
  assert.equal(stored.refresh_token, "refresh-a");
  assert.equal(stored.user.id, USER_ID);
});

test("Google sign-in in the app redirects to fuloos://auth-callback and finishes with the PKCE code", async () => {
  const f = fixture((url) => {
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      return json(authPayload("g"));
    }
    return json({}, 404);
  });
  const published: Array<string | null> = [];
  f.backend.subscribe((s) => published.push(s?.token ?? null));

  // Outside a browser supabase-js only builds the URL; it still stores the PKCE verifier.
  await f.backend.signInWithGoogle();
  assert.ok(f.store.get(`${SUPABASE_AUTH_STORAGE_KEY}-code-verifier`));

  const session = await f.backend.completeAuthRedirect(
    "fuloos://auth-callback?code=abc-123",
  );
  assert.equal(session?.user.id, USER_ID);
  const exchange = f.calls.filter((c) => c.search.includes("grant_type=pkce"));
  assert.equal(exchange.length, 1);
  assert.equal((exchange[0].body as { auth_code?: string }).auth_code, "abc-123");
  assert.ok(published.at(-1));

  // The same link delivered twice (pending + live event) is only exchanged once.
  await f.backend.completeAuthRedirect("fuloos://auth-callback?code=abc-123");
  assert.equal(f.calls.filter((c) => c.search.includes("grant_type=pkce")).length, 1);
});

test("a cancelled provider redirect surfaces its error", async () => {
  const f = fixture(() => json({}, 404));
  await assert.rejects(
    () =>
      f.backend.completeAuthRedirect(
        "fuloos://auth-callback?error=access_denied&error_description=User%20cancelled",
      ),
    (e: unknown) => e instanceof BackendError && /User cancelled/.test(e.message),
  );
  assert.equal(f.calls.length, 0);
});

test("resuming the app adopts tokens the background workers rotated", async () => {
  const f = fixture((url) => {
    if (url.pathname === "/auth/v1/token") return json(authPayload("first"));
    return json({}, 404);
  });
  const first = await f.backend.signIn("person@example.test", "pw");
  const tokens: string[] = [];
  f.backend.subscribe((s) => s && tokens.push(s.token));

  // What BackgroundSyncClient.kt writes after refreshing in the background.
  const rotated = authPayload("rotated");
  f.store.set(SUPABASE_AUTH_STORAGE_KEY, JSON.stringify(rotated));
  await f.backend.syncSessionFromStorage();

  assert.notEqual(rotated.access_token, first.token);
  assert.deepEqual(tokens, [rotated.access_token]);

  // Signed out elsewhere (storage cleared): the app signs out too.
  f.store.delete(SUPABASE_AUTH_STORAGE_KEY);
  let signedOut = false;
  f.backend.subscribe((s) => {
    if (!s) signedOut = true;
  });
  await f.backend.syncSessionFromStorage();
  assert.equal(signedOut, true);
});
