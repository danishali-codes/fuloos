import assert from "node:assert/strict";
import test from "node:test";
import {
  BackendError,
  MfaRequiredError,
  MissingCollectionError,
  resolveBackendConfig,
} from "../src/backendTypes.ts";
import { SupabaseBackend } from "../src/supabaseBackend.ts";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({
    sub: "11111111-1111-4111-8111-111111111111",
    aud: "authenticated",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    aal: "aal1",
    ...payload,
  })}.sig`;
}

function makeAuthPayload(overrides?: {
  aal?: "aal1" | "aal2";
  factors?: Array<{ id: string; factor_type: string; status: string }>;
  emailConfirmed?: boolean;
}) {
  const token = makeJwt({ aal: overrides?.aal ?? "aal1" });
  return {
    access_token: token,
    refresh_token: "refresh-tok-1",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      aud: "authenticated",
      role: "authenticated",
      email: "danish@example.test",
      email_confirmed_at:
        overrides?.emailConfirmed === false ? null : "2026-11-01T00:00:00Z",
      app_metadata: { provider: "email" },
      user_metadata: {},
      created_at: "2026-11-01T00:00:00Z",
      factors: overrides?.factors ?? [],
    },
  };
}

const json = (value: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers:
      status === 204
        ? headers
        : { "Content-Type": "application/json", ...headers },
  });

type RouteHandler = (
  url: URL,
  init: RequestInit,
  body: unknown,
) => Response | Promise<Response>;

function createFixture(handler: RouteHandler) {
  const calls: Array<{
    method: string;
    path: string;
    search: string;
    headers: Headers;
    body: unknown;
  }> = [];
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(rawUrl);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let parsedBody: unknown = undefined;
    if (typeof init.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    } else if (init.body !== undefined) {
      parsedBody = init.body;
    }
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      headers,
      body: parsedBody,
    });
    return handler(url, init, parsedBody);
  }) as typeof fetch;

  const backend = new SupabaseBackend(
    "https://proj.supabase.co",
    "sb_publishable_test_key",
    storage,
    fetcher,
    {
      redirectTo: "https://fuloos.danishali.dev/",
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  );
  return { backend, calls, store };
}

test("resolveBackendConfig defaults to pocketbase and switches to supabase", () => {
  assert.equal(resolveBackendConfig({}), null);
  assert.deepEqual(
    resolveBackendConfig({ VITE_POCKETBASE_URL: "https://pb.danishali.dev" }),
    { kind: "pocketbase", url: "https://pb.danishali.dev" },
  );
  assert.deepEqual(
    resolveBackendConfig({
      VITE_BACKEND: "supabase",
      VITE_SUPABASE_URL: "https://proj.supabase.co",
      VITE_SUPABASE_ANON_KEY: "anon-key",
    }),
    {
      kind: "supabase",
      url: "https://proj.supabase.co",
      anonKey: "anon-key",
    },
  );
  assert.deepEqual(
    resolveBackendConfig({
      VITE_BACKEND: "supabase",
      VITE_SUPABASE_URL: "https://proj.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_123",
    }),
    {
      kind: "supabase",
      url: "https://proj.supabase.co",
      anonKey: "sb_publishable_123",
    },
  );
  assert.equal(
    resolveBackendConfig({
      VITE_BACKEND: "supabase",
      VITE_SUPABASE_URL: "https://proj.supabase.co",
    }),
    null,
  );
});

test("SupabaseBackend validates HTTPS origin and anon key", () => {
  assert.throws(
    () => new SupabaseBackend("http://example.test", "key"),
    /HTTPS/,
  );
  assert.throws(
    () => new SupabaseBackend("https://proj.supabase.co", "   "),
    /key is required/i,
  );
  assert.doesNotThrow(
    () => new SupabaseBackend("http://127.0.0.1:54321", "key"),
  );
});

test("SupabaseBackend auth: signIn, googleEnabled, signUp, signOutEverywhere", async () => {
  const authPayload = makeAuthPayload();
  const f = createFixture((url, init, body) => {
    if (url.pathname === "/auth/v1/settings") {
      return json({ external: { email: true, google: true } });
    }
    if (
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "password"
    ) {
      const creds = body as { email?: string; password?: string };
      if (creds.password === "wrong") {
        return json(
          { error: "invalid_grant", error_description: "Invalid login credentials" },
          400,
        );
      }
      return json(authPayload);
    }
    if (url.pathname === "/auth/v1/signup") {
      const creds = body as { email?: string };
      if (creds.email === "dup@example.test") {
        return json({
          id: "22222222-2222-4222-8222-222222222222",
          email: "dup@example.test",
          identities: [],
        });
      }
      return json({
        id: "33333333-3333-4333-8333-333333333333",
        email: creds.email,
        identities: [{ id: "id-1" }],
      });
    }
    if (url.pathname === "/auth/v1/logout") {
      assert.equal(url.searchParams.get("scope"), "global");
      return json(null, 204);
    }
    throw new Error(`Unhandled ${init.method ?? "GET"} ${url.pathname}`);
  });

  assert.equal(await f.backend.googleEnabled(), true);

  await assert.rejects(
    f.backend.signIn("danish@example.test", "wrong"),
    (e: unknown) =>
      e instanceof BackendError && e.message === "Incorrect email or password.",
  );

  await assert.rejects(
    f.backend.signUp("dup@example.test", "password123"),
    (e: unknown) =>
      e instanceof BackendError &&
      e.fields.email?.code === "validation_not_unique",
  );

  const pendingSignUp = await f.backend.signUp(
    "new@example.test",
    "password123",
  );
  assert.equal(pendingSignUp.session, null);
  assert.equal(pendingSignUp.verificationRequired, true);

  const events: unknown[] = [];
  f.backend.subscribe((s) => events.push(s));
  const session = await f.backend.signIn("danish@example.test", "secret123");
  assert.equal(session.user.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(session.user.email, "danish@example.test");
  assert.equal(session.user.verified, true);
  assert.equal(session.user.mfaEnabled, false);
  assert.equal(events.length, 1);

  await f.backend.signOutEverywhere();
  assert.equal(events.at(-1), null);
  await assert.rejects(f.backend.load(), /sign in/i);
});

test("SupabaseBackend TOTP MFA: signIn challenge -> verifyMfaTotp -> enroll/disable", async () => {
  const verifiedFactor = {
    id: "factor-totp-1",
    factor_type: "totp",
    status: "verified",
  };
  let currentAal: "aal1" | "aal2" = "aal1";
  let enrolled = true;

  const f = createFixture((url, init, body) => {
    if (url.pathname === "/auth/v1/token") {
      return json(
        makeAuthPayload({
          aal: "aal1",
          factors: enrolled ? [verifiedFactor] : [],
        }),
      );
    }
    if (url.pathname === "/auth/v1/user") {
      return json(
        makeAuthPayload({
          aal: currentAal,
          factors: enrolled ? [verifiedFactor] : [],
        }).user,
      );
    }
    if (
      url.pathname === "/auth/v1/factors/factor-totp-1/challenge" &&
      (init.method ?? "GET").toUpperCase() === "POST"
    ) {
      return json({
        id: "challenge-99",
        type: "totp",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      });
    }
    if (url.pathname === "/auth/v1/factors/factor-totp-1/verify") {
      const payload = body as { code?: string };
      if (payload.code !== "654321") {
        return json({ message: "Invalid TOTP code supplied" }, 422);
      }
      currentAal = "aal2";
      return json(
        makeAuthPayload({ aal: "aal2", factors: [verifiedFactor] }),
      );
    }
    if (
      url.pathname === "/auth/v1/factors/factor-totp-1" &&
      (init.method ?? "GET").toUpperCase() === "DELETE"
    ) {
      enrolled = false;
      return json({ id: "factor-totp-1" });
    }
    if (
      url.pathname === "/auth/v1/factors" &&
      (init.method ?? "GET").toUpperCase() === "POST"
    ) {
      return json({
        id: "factor-totp-2",
        type: "totp",
        totp: {
          qr_code: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
          secret: "JBSWY3DPEHPK3PXP",
          uri: "otpauth://totp/Fuloos?secret=JBSWY3DPEHPK3PXP",
        },
      });
    }
    if (url.pathname === "/auth/v1/factors/factor-totp-2/challenge") {
      return json({
        id: "challenge-enroll",
        type: "totp",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      });
    }
    if (url.pathname === "/auth/v1/factors/factor-totp-2/verify") {
      enrolled = true;
      currentAal = "aal2";
      return json(
        makeAuthPayload({
          aal: "aal2",
          factors: [{ id: "factor-totp-2", factor_type: "totp", status: "verified" }],
        }),
      );
    }
    throw new Error(`Unhandled ${init.method ?? "GET"} ${url.pathname}`);
  });

  const published: unknown[] = [];
  f.backend.subscribe((s) => published.push(s));

  let mfaErr: MfaRequiredError | null = null;
  await assert.rejects(
    f.backend.signIn("danish@example.test", "secret123"),
    (err: unknown) => {
      assert.ok(err instanceof MfaRequiredError);
      assert.equal(err.method, "totp");
      assert.equal(err.factorId, "factor-totp-1");
      assert.equal(err.challengeId, "challenge-99");
      mfaErr = err;
      return true;
    },
  );
  // Must not publish AAL1 session while MFA challenge is pending
  assert.equal(published.length, 0);

  await assert.rejects(
    f.backend.verifyMfaTotp(mfaErr!.factorId!, mfaErr!.challengeId!, "000000"),
    /Invalid or expired verification code/,
  );

  const verified = await f.backend.verifyMfaTotp(
    mfaErr!.factorId!,
    mfaErr!.challengeId!,
    " 654321 ",
  );
  assert.equal(verified.user.mfaEnabled, true);
  assert.equal(published.length, 1);

  const disabled = await f.backend.setMfaEnabled(false);
  assert.equal(disabled.user.mfaEnabled, false);

  const enrollment = await f.backend.enrollTotpMfa();
  assert.equal(enrollment.factorId, "factor-totp-2");
  assert.equal(enrollment.secret, "JBSWY3DPEHPK3PXP");
  assert.ok(enrollment.qrCode.startsWith("data:image/svg+xml;utf-8,"));

  const reEnabled = await f.backend.verifyTotpEnrollment(
    enrollment.factorId,
    "111222",
  );
  assert.equal(reEnabled.user.mfaEnabled, true);
});

test("SupabaseBackend translates empty strings to NULL on writes and normalizes NULLs on reads", async () => {
  const f = createFixture((url, init, body) => {
    if (url.pathname === "/auth/v1/token") {
      return json(makeAuthPayload());
    }
    if (
      url.pathname === "/rest/v1/fuloos_transactions" &&
      (init.method ?? "GET").toUpperCase() === "POST"
    ) {
      const row = body as Record<string, unknown>;
      assert.equal(row.user_id, "11111111-1111-4111-8111-111111111111");
      assert.equal(row.category_id, null);
      assert.equal(row.to_account_id, "acc2");
      assert.equal(row.original_currency, "AED");
      assert.equal(row.original_amount, 4500);
      assert.equal(row.fx_rate, 1);
      assert.equal(row.fx_source, "same_currency");
      assert.equal(row.fx_status, "exact");
      return json({
        id: "tx0000000000001",
        type: "transfer",
        amount: 4500,
        account_id: "acc1",
        to_account_id: "acc2",
        category_id: null,
        date: "2026-11-20",
        payee: null,
        notes: null,
        tags: null,
        splits: null,
        receipt: null,
        original_currency: "AED",
        original_amount: 4500,
        fx_rate: 1,
        fx_rate_date: "2026-11-20",
        fx_source: "same_currency",
        fx_status: "exact",
      });
    }
    if (
      url.pathname === "/rest/v1/fuloos_budgets" &&
      (init.method ?? "GET").toUpperCase() === "PATCH"
    ) {
      const row = body as Record<string, unknown>;
      assert.equal("user_id" in row, false);
      assert.equal(row.end_month, null);
      return json({
        id: "bud000000000001",
        category_id: "cat1",
        amount: 250000,
        start_month: "2026-11",
        end_month: null,
        household_id: null,
      });
    }
    throw new Error(`Unhandled ${init.method ?? "GET"} ${url.pathname}`);
  });

  await f.backend.signIn("danish@example.test", "secret123");
  const tx = await f.backend.save("transactions", {
    type: "transfer",
    amount: 4500,
    account_id: "acc1",
    to_account_id: "acc2",
    category_id: "",
    date: "2026-11-20",
    payee: "",
    notes: "",
    original_currency: "AED",
    original_amount: 4500,
    fx_rate: 1,
    fx_rate_date: "2026-11-20",
    fx_source: "same_currency",
    fx_status: "exact",
    user_id: "spoofed-id",
  });
  assert.equal(tx.id, "tx0000000000001");
  assert.equal(tx.category_id, null);
  assert.equal(tx.payee, "");
  assert.equal(tx.notes, "");
  assert.deepEqual(tx.tags, []);
  assert.deepEqual(tx.splits, []);
  assert.equal("receipt" in tx, false);
  assert.equal(tx.original_currency, "AED");
  assert.equal(tx.original_amount, 4500);
  assert.equal(tx.fx_rate, 1);
  assert.equal(tx.fx_source, "same_currency");
  assert.equal(tx.fx_status, "exact");

  const budget = await f.backend.save(
    "budgets",
    {
      category_id: "cat1",
      amount: 250000,
      start_month: "2026-11",
      end_month: "",
      user_id: "spoofed-id",
    },
    "bud000000000001",
  );
  assert.equal(budget.end_month, null);
  assert.equal("household_id" in budget, false);
});

test("SupabaseBackend probeCollection and load detect PGRST205 missing tables cleanly", async () => {
  const f = createFixture((url) => {
    if (url.pathname === "/auth/v1/token") return json(makeAuthPayload());
    if (url.pathname === "/rest/v1/fuloos_accounts") {
      return json([
        {
          id: "acc1",
          name: "Checking",
          type: "current",
          opening_balance: 10000,
          opening_date: "2026-01-01",
          color: "#1d5b48",
          emoji: null,
          currency: null,
          household_id: null,
        },
      ]);
    }
    if (url.pathname === "/rest/v1/fuloos_categories") {
      return json([
        {
          id: "cat1",
          name: "Food",
          description: null,
          color: "#ff0000",
          emoji: null,
          household_id: null,
        },
      ]);
    }
    if (url.pathname === "/rest/v1/fuloos_transactions") {
      return json([]);
    }
    if (url.pathname === "/rest/v1/fuloos_goals") {
      return json(
        {
          code: "PGRST205",
          message:
            "Could not find the table 'public.fuloos_goals' in the schema cache",
        },
        404,
      );
    }
    return json([]);
  });

  await f.backend.signIn("danish@example.test", "secret123");
  assert.equal(await f.backend.probeCollection("accounts"), true);
  assert.equal(await f.backend.probeCollection("goals"), false);

  const ledger = await f.backend.load();
  assert.equal(ledger.accounts.length, 1);
  assert.equal(ledger.categories[0].description, "");
  assert.deepEqual(ledger.goals, []);
});

test("SupabaseBackend batch operations (createMany, updateTransactions, removeMany)", async () => {
  const f = createFixture((url, init, body) => {
    if (url.pathname === "/auth/v1/token") return json(makeAuthPayload());
    if (
      url.pathname === "/rest/v1/fuloos_transactions" &&
      (init.method ?? "GET").toUpperCase() === "POST"
    ) {
      const rows = body as Array<Record<string, unknown>>;
      return json(
        rows.map((r, idx) => ({
          ...r,
          id: `created_${idx}`,
        })),
      );
    }
    if (url.pathname === "/rest/v1/rpc/fuloos_update_transactions") {
      const { rows } = body as { rows: Array<Record<string, unknown>> };
      return json(rows);
    }
    if (
      url.pathname === "/rest/v1/fuloos_transactions" &&
      (init.method ?? "GET").toUpperCase() === "DELETE"
    ) {
      return json(null, 204);
    }
    throw new Error(`Unhandled ${init.method ?? "GET"} ${url.pathname}`);
  });

  await f.backend.signIn("danish@example.test", "secret123");
  const txDrafts = Array.from({ length: 105 }, (_, i) => ({
    type: "expense" as const,
    amount: 100 + i,
    account_id: "acc1",
    to_account_id: null,
    category_id: "cat1",
    date: "2026-11-20",
    payee: `Shop ${i}`,
    notes: "",
  }));

  const createProgress: number[] = [];
  await f.backend.createMany("transactions", txDrafts, (n) =>
    createProgress.push(n),
  );
  assert.deepEqual(createProgress, [100, 105]);

  const toUpdate = txDrafts.slice(0, 2).map((t, i) => ({
    ...t,
    id: `tx_${i}`,
  }));
  const updateProgress: number[] = [];
  await f.backend.updateTransactions(toUpdate, (n, recs) => {
    updateProgress.push(n);
    assert.equal(recs[0].id, "tx_0");
  });
  assert.deepEqual(updateProgress, [2]);

  const deletedBatches: string[][] = [];
  await f.backend.removeMany("transactions", ["tx_0", "tx_1"], (ids) =>
    deletedBatches.push(ids),
  );
  assert.deepEqual(deletedBatches, [["tx_0", "tx_1"]]);
});

test("SupabaseBackend receipts use Storage bucket and signed URLs", async () => {
  const f = createFixture((url, init) => {
    if (url.pathname === "/auth/v1/token") return json(makeAuthPayload());
    if (
      url.pathname === "/rest/v1/fuloos_transactions" &&
      (init.method ?? "GET").toUpperCase() === "POST"
    ) {
      return json({
        id: "txreceipt000001",
        type: "expense",
        amount: 5000,
        account_id: "acc1",
        to_account_id: null,
        category_id: "cat1",
        date: "2026-11-20",
        payee: "Cafe",
        notes: "",
        receipt: null,
      });
    }
    if (
      url.pathname ===
        "/storage/v1/object/receipts/txreceipt000001/coffee_bill.pdf" &&
      (init.method ?? "GET").toUpperCase() === "POST"
    ) {
      return json({ Key: "receipts/txreceipt000001/coffee_bill.pdf" });
    }
    if (
      url.pathname === "/rest/v1/fuloos_transactions" &&
      (init.method ?? "GET").toUpperCase() === "PATCH"
    ) {
      return json({
        id: "txreceipt000001",
        type: "expense",
        amount: 5000,
        account_id: "acc1",
        to_account_id: null,
        category_id: "cat1",
        date: "2026-11-20",
        payee: "Cafe",
        notes: "",
        receipt: "coffee_bill.pdf",
      });
    }
    if (
      url.pathname ===
        "/storage/v1/object/sign/receipts/txreceipt000001/coffee_bill.pdf" &&
      (init.method ?? "GET").toUpperCase() === "POST"
    ) {
      return json({
        signedURL:
          "/object/sign/receipts/txreceipt000001/coffee_bill.pdf?token=signed-abc",
      });
    }
    if (
      url.pathname ===
        "/storage/v1/object/sign/receipts/txreceipt000001/coffee_bill.pdf" &&
      url.searchParams.get("token") === "signed-abc"
    ) {
      return new Response("PDF-BYTES", {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    throw new Error(`Unhandled ${init.method ?? "GET"} ${url.pathname}${url.search}`);
  });

  await f.backend.signIn("danish@example.test", "secret123");
  const file = new File(["PDF-BYTES"], "coffee bill.pdf", {
    type: "application/pdf",
  });
  const saved = await f.backend.saveTransactionWithReceipt(
    {
      type: "expense",
      amount: 5000,
      account_id: "acc1",
      category_id: "cat1",
      date: "2026-11-20",
      payee: "Cafe",
      notes: "",
    },
    undefined,
    file,
  );
  assert.equal(saved.receipt, "coffee_bill.pdf");

  const blob = await f.backend.getReceiptBlob("txreceipt000001", "coffee_bill.pdf");
  assert.equal(await blob.text(), "PDF-BYTES");
});

test("SupabaseBackend RPCs and Edge Functions preserve contracts and errors", async () => {
  const f = createFixture((url, init, body) => {
    if (url.pathname === "/auth/v1/token") return json(makeAuthPayload());
    if (url.pathname === "/rest/v1/rpc/fuloos_household_invite") {
      assert.deepEqual(body, { household_id: "hh1", role: "viewer" });
      return json({
        id: "mem1",
        household_id: "hh1",
        user_id: null,
        role: "viewer",
        status: "pending",
        invite_code: "ABCD2345",
        member_email: null,
      });
    }
    if (url.pathname === "/rest/v1/rpc/fuloos_household_join") {
      assert.deepEqual(body, { code: "ABCD2345" });
      return json({
        household: { id: "hh1", name: "Home", owner_id: "owner-1" },
        member: {
          id: "mem1",
          household_id: "hh1",
          user_id: "11111111-1111-4111-8111-111111111111",
          role: "viewer",
          status: "active",
          invite_code: null,
          member_email: "danish@example.test",
        },
      });
    }
    if (url.pathname === "/rest/v1/rpc/fuloos_rotate_capture_token") {
      return json({
        id: "tok1",
        token: "flc_plain_secret",
        token_preview: "flc_plai…",
        enabled: true,
        default_account_id: null,
      });
    }
    if (url.pathname === "/functions/v1/notify-test") {
      return json({ ok: true, message: "Test email sent." });
    }
    if (url.pathname === "/functions/v1/push-test") {
      return json({ message: "Not Found" }, 404);
    }
    if (url.pathname === "/rest/v1/rpc/fuloos_delete_account") {
      return json(
        {
          code: "PGRST202",
          message:
            "Could not find the function public.fuloos_delete_account in the schema cache",
        },
        404,
      );
    }
    throw new Error(`Unhandled ${init.method ?? "GET"} ${url.pathname}`);
  });

  await f.backend.signIn("danish@example.test", "secret123");

  const invite = await f.backend.createHouseholdInvite("hh1", "viewer");
  assert.equal(invite.invite_code, "ABCD2345");
  assert.equal(invite.user_id, null);

  const joined = await f.backend.joinHouseholdByCode(" abcd2345 ");
  assert.equal(joined.household.id, "hh1");
  assert.equal(joined.member.status, "active");

  const rotated = await f.backend.rotateCaptureToken();
  assert.equal(rotated.token, "flc_plain_secret");

  const emailRes = await f.backend.sendTestNotificationEmail();
  assert.equal(emailRes.ok, true);

  await assert.rejects(
    f.backend.sendTestPushNotification(),
    (e: unknown) => e instanceof MissingCollectionError && e.status === 404,
  );

  await assert.rejects(
    f.backend.deleteAccount(),
    /Account deletion isn't enabled on the server yet/,
  );
});
