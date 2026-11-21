import {
  createClient,
  type Session as SupabaseSession,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  defaultNotificationPreferences,
  defaultRecurringPreferences,
  type Account,
  type Budget,
  type CaptureAlertStatus,
  type CaptureTokenInfo,
  type CapturedAlert,
  type Category,
  type GoalContribution,
  type Household,
  type HouseholdMember,
  type Ledger,
  type NotificationPreferences,
  type RecurringOccurrenceRecord,
  type RecurringSchedule,
  type SavingsGoal,
  type Transaction,
  type TransactionRule,
} from "./domain.ts";
import type { NetWorthItem, NetWorthSnapshot } from "./netWorth.ts";
import {
  BackendError,
  IMPORT_BATCH_SIZE,
  MfaRequiredError,
  MissingCollectionError,
  normalizeRecord,
  serializeDismissedKeys,
  validateBackendOrigin,
  type CsvPresetRecord,
  type FuloosBackend,
  type PushSubscriptionRecord,
  type RecordTypes,
  type SavedNotificationPreferences,
  type SavedRecurringPreferences,
  type Session,
  type StorageLike,
  type Table,
  type TotpEnrollment,
} from "./backendTypes.ts";

/**
 * Expected Supabase RPC and Edge Function names paired with this client:
 *
 * SQL RPCs (Phase 3):
 * - `fuloos_household_invite(household_id, role)` -> HouseholdMember
 * - `fuloos_household_join(code)` -> { household, member }
 * - `fuloos_share_account(account_id, household_id)` -> Account
 * - `fuloos_share_budget(budget_id, household_id)` -> Budget
 * - `fuloos_contribute_goal(goal_id, payload)` -> { goal, contribution, transaction }
 * - `fuloos_remove_goal_contribution(contribution_id)` -> SavingsGoal
 * - `fuloos_import_captured_alert(alert_id, transaction)` -> Transaction
 * - `fuloos_save_net_worth_item(draft, item_id, operation_key)` -> { item, snapshots }
 * - `fuloos_save_net_worth_valuation(item_id, value, date, notes, operation_key)` -> { item, snapshots }
 * - `fuloos_delete_net_worth_snapshot(snapshot_id)` -> { item, snapshots }
 * - `fuloos_rotate_capture_token()` -> { id, token, token_preview, enabled, default_account_id }
 * - `fuloos_update_transactions(rows)` -> Transaction[]
 * - `fuloos_delete_account()` -> void
 *
 * Edge Functions (Phase 4):
 * - `notify-test` (POST, JWT) -> { ok, message }
 * - `push-test` (POST, JWT) -> { ok, message }
 * - `inbound-capture` (POST, capture token) -> webhook endpoint shown in UI
 *
 * Storage bucket (Phase 1/2):
 * - `receipts` (private bucket, object key `<transaction_id>/<filename>`)
 */

const RECEIPTS_BUCKET = "receipts";
const PAGE_SIZE = 500;

const NULLABLE_TEXT_FIELDS = new Set([
  "to_account_id",
  "category_id",
  "end_date",
  "match_source",
  "match_reason",
  "end_month",
  "target_date",
  "account_id",
  "transaction_id",
  "set_category_id",
  "currency",
  "original_currency",
  "household_id",
  "default_account_id",
  "parsed_date",
  "consent_at",
  "invite_code",
  "receipt",
  "emoji",
  "sms_sender",
  "card_last4",
]);

const NULLABLE_NUMERIC_FIELDS = new Set([
  "credit_limit",
  "statement_day",
  "payment_due_day",
  "apr_bps",
  "minimum_payment",
  "min_amount",
  "max_amount",
  "original_amount",
  "fx_rate",
]);

/** supabase-js accepts async storage; the Android app keeps the session in the Keystore. */
export interface SessionStorageLike {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/**
 * Fixed so the Android background workers can find the session supabase-js stores
 * (see android/.../SecureAuthStore.kt, which only accepts keys with this prefix).
 */
export const SUPABASE_AUTH_STORAGE_KEY = "fuloos-supabase-auth";

/** Deep link the Android app registers for OAuth and email redirects. */
export const NATIVE_AUTH_REDIRECT = "fuloos://auth-callback";

export interface SupabaseBackendOptions {
  redirectTo?: string;
  autoRefreshToken?: boolean;
  detectSessionInUrl?: boolean;
  storageKey?: string;
}

interface SupabaseLikeError {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
  status?: number;
}

function isMissingRelationError(
  err: SupabaseLikeError | null | undefined,
  status?: number,
): boolean {
  if (status === 404) return true;
  const code = err?.code ?? "";
  if (code === "PGRST205" || code === "PGRST202" || code === "42P01") {
    return true;
  }
  const msg = err?.message ?? "";
  return (
    /Could not find the (table|function)/i.test(msg) ||
    /relation .* does not exist/i.test(msg)
  );
}

function sanitizeFilename(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "receipt";
}

function hasVerifiedTotpFactor(user: SupabaseSession["user"]): boolean {
  const factors = (
    user as { factors?: Array<{ factor_type?: string; status?: string }> }
  ).factors;
  if (!Array.isArray(factors)) return false;
  return factors.some(
    (f) => f.factor_type === "totp" && f.status === "verified",
  );
}

export class SupabaseBackend implements FuloosBackend {
  readonly kind = "supabase" as const;
  readonly mfaMethod = "totp" as const;
  readonly url: string;
  readonly anonKey: string;
  private client: SupabaseClient;
  private session: Session | null = null;
  private pendingMfa = false;
  private listeners = new Set<(session: Session | null) => void>();
  private fetcher: typeof fetch;
  private redirectTo?: string;
  readonly storageKey: string;
  private handledRedirects = new Set<string>();

  constructor(
    url: string,
    anonKey: string,
    storage?: StorageLike | SessionStorageLike,
    fetcher?: typeof fetch,
    options: SupabaseBackendOptions = {},
  ) {
    this.url = validateBackendOrigin(url, "Supabase");
    const trimmedKey = anonKey.trim();
    if (!trimmedKey) {
      throw new Error("Supabase anon/publishable key is required.");
    }
    this.anonKey = trimmedKey;
    const baseFetch: typeof fetch =
      fetcher ?? ((input, init) => fetch(input, init));
    this.fetcher = async (input, init) => {
      const nextInit: RequestInit =
        init?.signal != null
          ? init
          : { ...init, signal: AbortSignal.timeout(20000) };
      return baseFetch(input, nextInit);
    };
    const isBrowser = typeof window !== "undefined";
    this.redirectTo =
      options.redirectTo ??
      (isBrowser
        ? `${window.location.origin}${window.location.pathname}`
        : undefined);
    this.storageKey = options.storageKey ?? SUPABASE_AUTH_STORAGE_KEY;

    this.client = createClient(this.url, this.anonKey, {
      auth: {
        storage,
        storageKey: this.storageKey,
        persistSession: Boolean(storage),
        autoRefreshToken: options.autoRefreshToken ?? (isBrowser && !fetcher),
        detectSessionInUrl:
          options.detectSessionInUrl ?? (isBrowser && !fetcher),
        flowType: "pkce",
      },
      global: {
        fetch: this.fetcher,
      },
    });

    this.client.auth.onAuthStateChange((event, sbSession) => {
      if (event === "SIGNED_OUT") {
        this.pendingMfa = false;
        this.publish(null);
        return;
      }
      if (
        (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") &&
        sbSession?.user &&
        !this.pendingMfa &&
        this.session
      ) {
        this.publish({
          token: sbSession.access_token,
          refreshToken: sbSession.refresh_token,
          user: {
            id: sbSession.user.id,
            email: sbSession.user.email ?? this.session.user.email,
            verified: Boolean(sbSession.user.email_confirmed_at),
            mfaEnabled:
              hasVerifiedTotpFactor(sbSession.user) ||
              this.session.user.mfaEnabled,
          },
        });
      }
    });
  }

  private publish(session: Session | null) {
    this.session = session;
    for (const listener of this.listeners) listener(session);
  }

  subscribe(listener: (session: Session | null) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  signOut() {
    this.pendingMfa = false;
    this.publish(null);
    void this.client.auth.signOut({ scope: "local" }).catch(() => {});
  }

  private toError(
    err: SupabaseLikeError | null | undefined,
    status?: number,
    context?: { table?: Table; batch?: boolean; fn?: string },
  ): Error {
    const code = status ?? err?.status ?? 400;
    const message = err?.message || `Supabase request failed (${code}).`;
    if (
      code === 0 ||
      /Failed to fetch|NetworkError|fetch failed|Load failed|AbortError|timed out/i.test(
        message,
      )
    ) {
      if (context?.batch) {
        return new Error(
          "Could not confirm the batch result. It may have been saved. Reload the ledger before retrying.",
        );
      }
      return new Error(
        "Could not reach Supabase. Check the connection and try again.",
      );
    }
    if (isMissingRelationError(err, code)) {
      if (context?.table?.startsWith("recurring")) {
        return new MissingCollectionError(
          "Recurring features aren't installed on the server yet. Apply the latest Supabase migrations to enable them.",
          404,
        );
      }
      if (context?.fn) {
        return new MissingCollectionError(
          `Supabase function "${context.fn}" is not installed on the server yet. Apply the latest Supabase migrations or Edge Functions.`,
          404,
        );
      }
      return new MissingCollectionError(
        "Fuloos backend is not configured yet. Apply the Supabase migrations before using live accounts.",
        404,
      );
    }
    if (code === 401 && this.session) {
      this.publish(null);
    }
    return new BackendError(message, code);
  }

  private async resolveSession(sbSession: SupabaseSession): Promise<Session> {
    const { data: aal } =
      await this.client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2") {
      const { data: factorsData, error: factorsErr } =
        await this.client.auth.mfa.listFactors();
      if (factorsErr) throw this.toError(factorsErr);
      const verifiedTotp = factorsData?.totp?.find(
        (f) => f.status === "verified",
      );
      if (verifiedTotp) {
        const { data: challenge, error: chErr } =
          await this.client.auth.mfa.challenge({ factorId: verifiedTotp.id });
        if (chErr || !challenge) {
          throw this.toError(
            chErr ?? { message: "Could not start authenticator challenge." },
          );
        }
        this.pendingMfa = true;
        this.session = null;
        throw new MfaRequiredError(
          challenge.id,
          "Multi-factor authentication required.",
          {
            method: "totp",
            factorId: verifiedTotp.id,
            challengeId: challenge.id,
            email: sbSession.user.email ?? "",
          },
        );
      }
    }

    const mfaEnabled =
      aal?.currentLevel === "aal2" ||
      aal?.nextLevel === "aal2" ||
      hasVerifiedTotpFactor(sbSession.user);

    const session: Session = {
      token: sbSession.access_token,
      refreshToken: sbSession.refresh_token,
      user: {
        id: sbSession.user.id,
        email: sbSession.user.email ?? "",
        verified: Boolean(sbSession.user.email_confirmed_at),
        mfaEnabled,
      },
    };
    this.pendingMfa = false;
    this.publish(session);
    return session;
  }

  async getSession(): Promise<Session | null> {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw this.toError(error);
    if (!data.session) {
      this.pendingMfa = false;
      this.publish(null);
      return null;
    }
    return this.resolveSession(data.session);
  }

  /**
   * Finishes an OAuth or email-link redirect that reopened the app through
   * `fuloos://auth-callback` (PKCE code, or an error from the provider).
   */
  async completeAuthRedirect(url: string): Promise<Session | null> {
    if (this.handledRedirects.has(url)) return this.session;
    this.handledRedirects.add(url);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BackendError("The sign-in link was not valid.", 400);
    }
    const params = new URLSearchParams(parsed.search);
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const errorDescription =
      params.get("error_description") ?? hash.get("error_description");
    if (errorDescription || params.get("error") || hash.get("error")) {
      throw new BackendError(
        errorDescription || "Sign-in was cancelled or failed.",
        400,
      );
    }
    const code = params.get("code");
    if (!code) return this.session;
    const { data, error } = await this.client.auth.exchangeCodeForSession(code);
    if (error) throw this.toError(error);
    if (!data.session) return null;
    return this.resolveSession(data.session);
  }

  /**
   * Picks up tokens another process rotated in the shared storage (the Android
   * background workers refresh the session while the app is closed).
   */
  async syncSessionFromStorage(): Promise<void> {
    if (!this.session || this.pendingMfa) return;
    const current = this.session;
    const { data } = await this.client.auth.getSession();
    const next = data.session;
    if (!next) {
      if (this.session === current) this.publish(null);
      return;
    }
    if (
      next.user.id === current.user.id &&
      next.access_token !== current.token &&
      this.session === current
    ) {
      this.publish({
        ...current,
        token: next.access_token,
        refreshToken: next.refresh_token,
      });
    }
  }

  async googleEnabled(): Promise<boolean> {
    try {
      const response = await this.fetcher(`${this.url}/auth/v1/settings`, {
        headers: { apikey: this.anonKey },
      });
      if (!response.ok) return false;
      const data = (await response.json().catch(() => null)) as {
        external?: { google?: boolean };
      } | null;
      return Boolean(data?.external?.google);
    } catch {
      return false;
    }
  }

  async signInWithGoogle(): Promise<Session | null> {
    const { error } = await this.client.auth.signInWithOAuth({
      provider: "google",
      options: this.redirectTo ? { redirectTo: this.redirectTo } : undefined,
    });
    if (error) throw this.toError(error);
    return null;
  }

  async signIn(email: string, password: string): Promise<Session> {
    const { data, error } = await this.client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) {
      if (
        error.status === 400 ||
        /invalid login credentials/i.test(error.message)
      ) {
        throw new BackendError("Incorrect email or password.", 400);
      }
      throw this.toError(error);
    }
    if (!data.session) {
      throw new BackendError("Could not establish a session.", 401);
    }
    return this.resolveSession(data.session);
  }

  async requestOtp(_email: string): Promise<{ otpId: string }> {
    throw new BackendError(
      "Supabase accounts use authenticator app (TOTP) two-factor verification.",
      400,
    );
  }

  async verifyMfaOtp(
    _mfaId: string,
    _otpId: string,
    _code: string,
  ): Promise<Session> {
    throw new BackendError(
      "Supabase accounts use authenticator app (TOTP) two-factor verification.",
      400,
    );
  }

  async enrollTotpMfa(): Promise<TotpEnrollment> {
    if (!this.session) throw new Error("Please sign in.");
    const { data: listed } = await this.client.auth.mfa.listFactors();
    const staleUnverified = (listed?.all ?? []).filter(
      (f) => f.factor_type === "totp" && f.status === "unverified",
    );
    for (const f of staleUnverified) {
      await this.client.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
    }
    const { data, error } = await this.client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "Fuloos Authenticator",
    });
    if (error || !data?.totp) {
      throw this.toError(
        error ?? { message: "Could not start authenticator setup." },
      );
    }
    const rawQr = data.totp.qr_code ?? "";
    const qrCode = rawQr.startsWith("data:")
      ? rawQr
      : rawQr
        ? `data:image/svg+xml;utf-8,${encodeURIComponent(rawQr)}`
        : "";
    return {
      factorId: data.id,
      qrCode,
      secret: data.totp.secret,
      uri: data.totp.uri,
    };
  }

  async verifyTotpEnrollment(factorId: string, code: string): Promise<Session> {
    if (!this.session) throw new Error("Please sign in.");
    const { data: challenge, error: chErr } =
      await this.client.auth.mfa.challenge({ factorId });
    if (chErr || !challenge) {
      throw this.toError(
        chErr ?? { message: "Could not start authenticator verification." },
      );
    }
    return this.verifyMfaTotp(factorId, challenge.id, code);
  }

  async verifyMfaTotp(
    factorId: string,
    challengeId: string,
    code: string,
  ): Promise<Session> {
    const trimmed = code.trim();
    const { error } = await this.client.auth.mfa.verify({
      factorId,
      challengeId,
      code: trimmed,
    });
    if (error) {
      if (
        error.status === 400 ||
        error.status === 422 ||
        /invalid|expired|totp/i.test(error.message)
      ) {
        throw new BackendError("Invalid or expired verification code.", 400);
      }
      throw this.toError(error);
    }
    const { data, error: sessionErr } = await this.client.auth.getSession();
    if (sessionErr || !data.session) {
      throw this.toError(
        sessionErr ?? { message: "Could not load verified session." },
        401,
      );
    }
    const session: Session = {
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: {
        id: data.session.user.id,
        email: data.session.user.email ?? "",
        verified: Boolean(data.session.user.email_confirmed_at),
        mfaEnabled: true,
      },
    };
    this.pendingMfa = false;
    this.publish(session);
    return session;
  }

  async disableTotpMfa(): Promise<Session> {
    if (!this.session) throw new Error("Please sign in.");
    const { data: factors, error: listErr } =
      await this.client.auth.mfa.listFactors();
    if (listErr) throw this.toError(listErr);
    const totpFactors = (factors?.all ?? []).filter(
      (f) => f.factor_type === "totp",
    );
    for (const f of totpFactors) {
      const { error } = await this.client.auth.mfa.unenroll({ factorId: f.id });
      if (error) throw this.toError(error);
    }
    const updated: Session = {
      ...this.session,
      user: { ...this.session.user, mfaEnabled: false },
    };
    this.publish(updated);
    return updated;
  }

  async setMfaEnabled(enabled: boolean): Promise<Session> {
    if (!this.session) throw new Error("Please sign in.");
    if (!enabled) {
      return this.disableTotpMfa();
    }
    throw new BackendError(
      "Enable two-factor authentication by scanning the authenticator QR code in Security settings.",
      400,
    );
  }

  async requestPasswordReset(email: string): Promise<void> {
    const { error } = await this.client.auth.resetPasswordForEmail(
      email.trim(),
      this.redirectTo ? { redirectTo: this.redirectTo } : undefined,
    );
    if (error) throw this.toError(error);
  }

  async confirmPasswordReset(
    token: string,
    password: string,
    passwordConfirm: string,
  ): Promise<void> {
    if (password !== passwordConfirm) {
      throw new BackendError("Passwords do not match.", 400);
    }
    const trimmed = token.trim();
    if (trimmed) {
      const { error: otpErr } = await this.client.auth.verifyOtp({
        token_hash: trimmed,
        type: "recovery",
      });
      if (otpErr) throw this.toError(otpErr);
    }
    const { error } = await this.client.auth.updateUser({ password });
    if (error) throw this.toError(error);
    this.signOut();
  }

  async requestVerification(email: string): Promise<void> {
    const { error } = await this.client.auth.resend({
      type: "signup",
      email: email.trim(),
      options: this.redirectTo
        ? { emailRedirectTo: this.redirectTo }
        : undefined,
    });
    if (error) throw this.toError(error);
  }

  async confirmVerification(token: string): Promise<void> {
    const { error } = await this.client.auth.verifyOtp({
      token_hash: token.trim(),
      type: "signup",
    });
    if (error) throw this.toError(error);
    if (this.session) {
      await this.getSession().catch(() => null);
    }
  }

  async changePassword(
    _oldPassword: string,
    password: string,
    passwordConfirm: string,
  ): Promise<void> {
    if (!this.session) throw new Error("Please sign in.");
    if (password !== passwordConfirm) {
      throw new BackendError("New passwords do not match.", 400);
    }
    const { error } = await this.client.auth.updateUser({ password });
    if (error) throw this.toError(error);
  }

  async requestEmailChange(newEmail: string): Promise<void> {
    if (!this.session) throw new Error("Please sign in.");
    const { error } = await this.client.auth.updateUser(
      { email: newEmail.trim() },
      this.redirectTo ? { emailRedirectTo: this.redirectTo } : undefined,
    );
    if (error) throw this.toError(error);
  }

  async confirmEmailChange(token: string, _password: string): Promise<void> {
    const { error } = await this.client.auth.verifyOtp({
      token_hash: token.trim(),
      type: "email_change",
    });
    if (error) throw this.toError(error);
    if (this.session) this.signOut();
  }

  async signOutEverywhere(): Promise<void> {
    if (!this.session) throw new Error("Please sign in.");
    const { error } = await this.client.auth.signOut({ scope: "global" });
    if (error) throw this.toError(error);
    this.pendingMfa = false;
    this.publish(null);
  }

  async signUp(
    email: string,
    password: string,
  ): Promise<{ session: Session | null; verificationRequired: boolean }> {
    const { data, error } = await this.client.auth.signUp({
      email: email.trim(),
      password,
      options: this.redirectTo
        ? { emailRedirectTo: this.redirectTo }
        : undefined,
    });
    if (error) {
      if (
        error.code === "user_already_exists" ||
        /already registered/i.test(error.message)
      ) {
        throw new BackendError(
          "An account with this email already exists. Sign in instead.",
          error.status ?? 400,
          { email: { code: "validation_not_unique" } },
        );
      }
      throw this.toError(error);
    }
    // GoTrue returns an empty identities array when signing up with an existing email under enumeration protection.
    if (
      data.user &&
      Array.isArray(data.user.identities) &&
      data.user.identities.length === 0
    ) {
      throw new BackendError(
        "An account with this email already exists. Sign in instead.",
        400,
        { email: { code: "validation_not_unique" } },
      );
    }
    if (data.session) {
      return {
        session: await this.resolveSession(data.session),
        verificationRequired: false,
      };
    }
    return { session: null, verificationRequired: true };
  }

  private async rows<T>(table: Table): Promise<T[]> {
    const items: T[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error, status } = await this.client
        .from(`fuloos_${table}`)
        .select("*")
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw this.toError(error, status, { table });
      const page = (data ?? []) as T[];
      items.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return items;
  }

  private async optionalRows<T>(table: Table): Promise<T[]> {
    try {
      return await this.rows<T>(table);
    } catch (e) {
      if (e instanceof MissingCollectionError) return [];
      throw e;
    }
  }

  private async rpc<T>(
    fn: string,
    params?: Record<string, unknown>,
    batch = false,
  ): Promise<T> {
    if (!this.session) throw new Error("Please sign in.");
    const { data, error, status } = await this.client.rpc(fn, params);
    if (error) throw this.toError(error, status, { fn, batch });
    return data as T;
  }

  private async invokeFunction<T>(
    name: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const session = this.session;
    if (!session) throw new Error("Please sign in.");
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}/functions/v1/${name}`, {
        method: "POST",
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : "{}",
      });
    } catch {
      throw new Error(
        "Could not reach Supabase. Check the connection and try again.",
      );
    }
    const data =
      response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 404) {
        throw new MissingCollectionError(
          `Supabase Edge Function "${name}" is not deployed yet.`,
          404,
        );
      }
      if (response.status === 401 && session.token === this.session?.token) {
        this.publish(null);
      }
      const msg =
        (data && typeof data === "object" && "message" in data
          ? String((data as { message?: unknown }).message)
          : data && typeof data === "object" && "error" in data
            ? String((data as { error?: unknown }).error)
            : "") || `Supabase function "${name}" failed (${response.status}).`;
      throw new BackendError(msg, response.status);
    }
    return data as T;
  }

  async list<K extends "ml_settings" | "ml_examples">(
    table: K,
  ): Promise<RecordTypes[K][]> {
    if (!this.session) throw new Error("Please sign in.");
    const rows = await this.rows<RecordTypes[K]>(table);
    return rows.map((r) => normalizeRecord(table, r));
  }

  async listCsvPresets(): Promise<CsvPresetRecord[]> {
    if (!this.session) throw new Error("Please sign in.");
    return this.rows<CsvPresetRecord>("csv_presets");
  }

  async probeCollection(table: Table): Promise<boolean> {
    if (!this.session) throw new Error("Please sign in.");
    const { error, status } = await this.client
      .from(`fuloos_${table}`)
      .select("id")
      .limit(1);
    if (!error) return true;
    const mapped = this.toError(error, status, { table });
    if (mapped instanceof MissingCollectionError) return false;
    throw mapped;
  }

  async load(): Promise<Ledger> {
    if (!this.session) throw new Error("Please sign in.");
    const [
      accounts,
      categories,
      records,
      recurring,
      recurringOccurrences,
      recurringPrefs,
      budgets,
      goals,
      goalContributions,
      rules,
      netWorthItems,
      netWorthSnapshots,
    ] = await Promise.all([
      this.rows<Account>("accounts"),
      this.rows<Category>("categories"),
      this.rows<Transaction>("transactions"),
      this.optionalRows<RecurringSchedule>("recurring"),
      this.optionalRows<RecurringOccurrenceRecord>("recurring_occurrences"),
      this.optionalRows<SavedRecurringPreferences>("recurring_prefs"),
      this.optionalRows<Budget>("budgets"),
      this.optionalRows<SavingsGoal>("goals"),
      this.optionalRows<GoalContribution>("goal_contributions"),
      this.optionalRows<TransactionRule>("rules"),
      this.optionalRows<NetWorthItem>("net_worth_items"),
      this.optionalRows<NetWorthSnapshot>("net_worth_snapshots"),
    ]);
    return {
      accounts: accounts.map((a) => normalizeRecord("accounts", a)),
      categories: categories.map((c) => normalizeRecord("categories", c)),
      transactions: records.map((t) => normalizeRecord("transactions", t)),
      recurring: recurring.map((r) => normalizeRecord("recurring", r)),
      recurring_occurrences: recurringOccurrences.map((o) =>
        normalizeRecord("recurring_occurrences", o),
      ),
      recurring_prefs: recurringPrefs[0]
        ? normalizeRecord("recurring_prefs", recurringPrefs[0])
        : { ...defaultRecurringPreferences },
      budgets: budgets.map((b) => normalizeRecord("budgets", b)),
      goals: goals.map((g) => normalizeRecord("goals", g)),
      goal_contributions: goalContributions.map((c) =>
        normalizeRecord("goal_contributions", c),
      ),
      rules: rules.map((r) => normalizeRecord("rules", r)),
      net_worth_items: netWorthItems.map((i) =>
        normalizeRecord("net_worth_items", i),
      ),
      net_worth_snapshots: netWorthSnapshots.map((s) =>
        normalizeRecord("net_worth_snapshots", s),
      ),
    };
  }

  /**
   * Translates Fuloos payloads to Postgres column conventions:
   * - converts empty strings on nullable FK/date/enum/text columns to `null`
   * - enforces current `user_id` on insert
   * - clears foreign currency fields when currency is empty or AED
   */
  private prepareBody<K extends Table>(
    table: K,
    value: Record<string, unknown>,
    userId: string,
    isUpdate = false,
  ): Record<string, unknown> {
    const raw: Record<string, unknown> = isUpdate
      ? { ...value }
      : { ...value, user_id: userId };
    if (isUpdate) {
      delete raw.user_id;
    }
    const body: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (val === undefined) continue;
      if (NULLABLE_TEXT_FIELDS.has(key) && val === "") {
        body[key] = null;
      } else if (NULLABLE_NUMERIC_FIELDS.has(key) && val === "") {
        body[key] = null;
      } else {
        body[key] = val;
      }
    }
    if (
      table === "transactions" &&
      "original_currency" in body &&
      (!body.original_currency || body.original_currency === "AED")
    ) {
      body.original_currency = null;
      body.original_amount = null;
      body.fx_rate = null;
    }
    if (table === "recurring_prefs" && "dismissed_keys" in body) {
      body.dismissed_keys = serializeDismissedKeys(body.dismissed_keys);
    }
    return body;
  }

  async save<K extends Table>(
    table: K,
    value: Record<string, unknown>,
    id?: string,
  ): Promise<RecordTypes[K]> {
    if (!this.session) throw new Error("Please sign in.");
    const session = this.session;
    const body = this.prepareBody(table, value, session.user.id, Boolean(id));
    const query = id
      ? this.client
          .from(`fuloos_${table}`)
          .update(body)
          .eq("id", id)
          .select("*")
          .single()
      : this.client.from(`fuloos_${table}`).insert(body).select("*").single();
    const { data, error, status } = await query;
    if (error) throw this.toError(error, status, { table });
    if (this.session?.user.id !== session.user.id) {
      throw new Error("Session changed. Please sign in again.");
    }
    return normalizeRecord(table, data as RecordTypes[K]);
  }

  async contributeGoal(
    goalId: string,
    body: Record<string, unknown>,
  ): Promise<{
    goal: SavingsGoal;
    contribution: GoalContribution;
    transaction: Transaction | null;
  }> {
    const res = await this.rpc<{
      goal: SavingsGoal;
      contribution: GoalContribution;
      transaction: Transaction | null;
    }>("fuloos_contribute_goal", {
      goal_id: goalId,
      payload: body,
    });
    return {
      goal: normalizeRecord("goals", res.goal),
      contribution: normalizeRecord("goal_contributions", res.contribution),
      transaction: res.transaction
        ? normalizeRecord("transactions", res.transaction)
        : null,
    };
  }

  async removeGoalContribution(id: string): Promise<SavingsGoal> {
    const goal = await this.rpc<SavingsGoal>(
      "fuloos_remove_goal_contribution",
      { contribution_id: id },
    );
    return normalizeRecord("goals", goal);
  }

  async importCapturedAlert(
    id: string,
    transaction: Record<string, unknown>,
  ): Promise<Transaction> {
    const tx = await this.rpc<Transaction>("fuloos_import_captured_alert", {
      alert_id: id,
      transaction,
    });
    return normalizeRecord("transactions", tx);
  }

  async saveNetWorthItemAtomic(
    draft: Record<string, unknown>,
    id: string | undefined,
    operationKey: string,
  ): Promise<{ item: NetWorthItem; snapshots: NetWorthSnapshot[] }> {
    const res = await this.rpc<{
      item: NetWorthItem;
      snapshots: NetWorthSnapshot[];
    }>("fuloos_save_net_worth_item", {
      draft,
      item_id: id ?? null,
      operation_key: operationKey,
    });
    return {
      item: normalizeRecord("net_worth_items", res.item),
      snapshots: (res.snapshots ?? []).map((s) =>
        normalizeRecord("net_worth_snapshots", s),
      ),
    };
  }

  async saveNetWorthValuationAtomic(
    itemId: string,
    value: number,
    date: string,
    notes: string,
    operationKey: string,
  ): Promise<{ item: NetWorthItem; snapshots: NetWorthSnapshot[] }> {
    const res = await this.rpc<{
      item: NetWorthItem;
      snapshots: NetWorthSnapshot[];
    }>("fuloos_save_net_worth_valuation", {
      item_id: itemId,
      value,
      date,
      notes,
      operation_key: operationKey,
    });
    return {
      item: normalizeRecord("net_worth_items", res.item),
      snapshots: (res.snapshots ?? []).map((s) =>
        normalizeRecord("net_worth_snapshots", s),
      ),
    };
  }

  async deleteNetWorthSnapshotAtomic(
    id: string,
  ): Promise<{ item: NetWorthItem; snapshots: NetWorthSnapshot[] }> {
    const res = await this.rpc<{
      item: NetWorthItem;
      snapshots: NetWorthSnapshot[];
    }>("fuloos_delete_net_worth_snapshot", {
      snapshot_id: id,
    });
    return {
      item: normalizeRecord("net_worth_items", res.item),
      snapshots: (res.snapshots ?? []).map((s) =>
        normalizeRecord("net_worth_snapshots", s),
      ),
    };
  }

  async saveTransactionWithReceipt(
    value: Record<string, unknown>,
    id?: string,
    receiptFile?: File | null,
    removeReceipt = false,
  ): Promise<Transaction> {
    if (!this.session) throw new Error("Please sign in.");
    if (!receiptFile) {
      if (removeReceipt && id) {
        const listed = await this.client.storage
          .from(RECEIPTS_BUCKET)
          .list(id)
          .catch(() => ({ data: null }));
        const paths = (listed.data ?? [])
          .filter((f) => f.name)
          .map((f) => `${id}/${f.name}`);
        if (paths.length) {
          await this.client.storage
            .from(RECEIPTS_BUCKET)
            .remove(paths)
            .catch(() => {});
        }
      }
      const nextValue = removeReceipt ? { ...value, receipt: null } : value;
      return this.save("transactions", nextValue, id);
    }

    const session = this.session;
    const safeName = sanitizeFilename(receiptFile.name);
    if (id) {
      const { error: uploadErr } = await this.client.storage
        .from(RECEIPTS_BUCKET)
        .upload(`${id}/${safeName}`, receiptFile, {
          upsert: true,
          contentType: receiptFile.type || undefined,
        });
      if (uploadErr) throw this.toError(uploadErr);
      return this.save("transactions", { ...value, receipt: safeName }, id);
    }

    const created = await this.save("transactions", {
      ...value,
      receipt: null,
    });
    const { error: uploadErr } = await this.client.storage
      .from(RECEIPTS_BUCKET)
      .upload(`${created.id}/${safeName}`, receiptFile, {
        upsert: true,
        contentType: receiptFile.type || undefined,
      });
    if (uploadErr) throw this.toError(uploadErr);
    if (this.session?.user.id !== session.user.id) {
      throw new Error("Session changed. Please sign in again.");
    }
    return this.save("transactions", { receipt: safeName }, created.id);
  }

  async getReceiptBlob(txId: string, filename: string): Promise<Blob> {
    if (!this.session) throw new Error("Please sign in.");
    const { data, error } = await this.client.storage
      .from(RECEIPTS_BUCKET)
      .createSignedUrl(`${txId}/${filename}`, 300);
    if (error || !data?.signedUrl) {
      throw this.toError(
        error ?? { message: "Could not create receipt download link." },
      );
    }
    const response = await this.fetcher(data.signedUrl);
    if (!response.ok) {
      throw new BackendError(
        `Could not load receipt (${response.status}).`,
        response.status,
      );
    }
    return response.blob();
  }

  async getReceiptBlobUrl(txId: string, filename: string): Promise<string> {
    return URL.createObjectURL(await this.getReceiptBlob(txId, filename));
  }

  async updateTransactions(
    values: Transaction[],
    progress: (saved: number, records: Transaction[]) => void,
    shouldContinue: () => boolean = () => true,
  ): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("Please sign in.");
    for (let offset = 0; offset < values.length; offset += IMPORT_BATCH_SIZE) {
      if (this.session?.user.id !== session.user.id || !shouldContinue()) {
        throw new Error("Session changed. Reload the ledger before retrying.");
      }
      const chunk = values.slice(offset, offset + IMPORT_BATCH_SIZE);
      const result = await this.rpc<Transaction[]>(
        "fuloos_update_transactions",
        {
          rows: chunk.map((t) => ({
            id: t.id,
            type: t.type,
            amount: t.amount,
            account_id: t.account_id,
            to_account_id: t.to_account_id || null,
            category_id: t.category_id || null,
            date: t.date,
            payee: t.payee,
            notes: t.notes,
            tags: t.tags ?? [],
            splits: t.splits ?? [],
          })),
        },
        true,
      );
      if (
        !Array.isArray(result) ||
        result.length !== chunk.length ||
        result.some((r, i) => r?.id !== chunk[i].id)
      ) {
        throw new Error(
          "The server returned an unexpected batch result. Reload the ledger before retrying.",
        );
      }
      if (this.session?.user.id !== session.user.id || !shouldContinue()) {
        throw new Error("Session changed. Reload the ledger before retrying.");
      }
      progress(
        offset + chunk.length,
        result.map((r) => normalizeRecord("transactions", r)),
      );
    }
  }

  async createMany<K extends Table>(
    table: K,
    values: Omit<RecordTypes[K], "id">[],
    progress: (saved: number, records: RecordTypes[K][]) => void,
    shouldContinue: () => boolean = () => true,
  ): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("Please sign in.");
    for (let offset = 0; offset < values.length; offset += IMPORT_BATCH_SIZE) {
      if (this.session?.user.id !== session.user.id || !shouldContinue()) {
        throw new Error("Session changed. Please sign in again.");
      }
      const chunk = values.slice(offset, offset + IMPORT_BATCH_SIZE);
      const prepared = chunk.map((value) =>
        this.prepareBody(
          table,
          value as Record<string, unknown>,
          session.user.id,
        ),
      );
      const { data, error, status } = await this.client
        .from(`fuloos_${table}`)
        .insert(prepared)
        .select("*");
      if (error) {
        throw this.toError(error, status, { table, batch: true });
      }
      const rows = data as RecordTypes[K][] | null;
      if (
        !Array.isArray(rows) ||
        rows.length !== chunk.length ||
        rows.some((r) => !r?.id)
      ) {
        throw new Error(
          "The server returned an unexpected batch result. Reload the ledger before retrying.",
        );
      }
      if (this.session?.user.id !== session.user.id || !shouldContinue()) {
        throw new Error("Session changed. Reload the ledger before retrying.");
      }
      progress(
        offset + chunk.length,
        rows.map((r) => normalizeRecord(table, r)),
      );
    }
  }

  async deleteAccount(
    progress: (step: string) => void = () => {},
  ): Promise<void> {
    if (!this.session) throw new Error("Please sign in.");
    progress("Deleting your account…");
    try {
      await this.rpc<void>("fuloos_delete_account");
    } catch (e) {
      if (e instanceof MissingCollectionError) {
        throw new Error(
          "Account deletion isn't enabled on the server yet. Apply the latest Supabase migration and try again. Nothing was deleted.",
        );
      }
      throw e;
    }
    this.signOut();
  }

  async removeMany(
    table: Table,
    ids: string[],
    progress: (deleted: string[]) => void = () => {},
  ): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("Please sign in.");
    for (let offset = 0; offset < ids.length; offset += IMPORT_BATCH_SIZE) {
      if (this.session?.user.id !== session.user.id) {
        throw new Error("Session changed. Reload the ledger before retrying.");
      }
      const chunk = ids.slice(offset, offset + IMPORT_BATCH_SIZE);
      const { error, status } = await this.client
        .from(`fuloos_${table}`)
        .delete()
        .in("id", chunk);
      if (error) {
        throw this.toError(error, status, { table, batch: true });
      }
      progress(chunk);
    }
  }

  async remove(table: Table, id: string): Promise<void> {
    if (!this.session) throw new Error("Please sign in.");
    const { error, status } = await this.client
      .from(`fuloos_${table}`)
      .delete()
      .eq("id", id);
    if (error) throw this.toError(error, status, { table });
  }

  async loadNotificationPrefs(): Promise<{
    prefs: NotificationPreferences;
    supported: boolean;
  }> {
    if (!this.session) throw new Error("Please sign in.");
    try {
      const rows =
        await this.rows<SavedNotificationPreferences>("notification_prefs");
      return {
        prefs: rows[0]
          ? normalizeRecord("notification_prefs", rows[0])
          : { ...defaultNotificationPreferences },
        supported: true,
      };
    } catch (e) {
      if (e instanceof MissingCollectionError) {
        return {
          prefs: { ...defaultNotificationPreferences },
          supported: false,
        };
      }
      throw e;
    }
  }

  async saveNotificationPrefs(
    prefs: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    if (!this.session) throw new Error("Please sign in.");
    const days = Math.max(
      1,
      Math.min(30, Math.round(Number(prefs.upcoming_bill_days) || 3)),
    );
    const body = {
      email_enabled: Boolean(prefs.email_enabled),
      upcoming_bill_enabled: Boolean(prefs.upcoming_bill_enabled),
      upcoming_bill_days: days,
      overdue_enabled: Boolean(prefs.overdue_enabled),
      budget_80_enabled: Boolean(prefs.budget_80_enabled),
      budget_100_enabled: Boolean(prefs.budget_100_enabled),
      weekly_digest_enabled: Boolean(prefs.weekly_digest_enabled),
      digest_day: prefs.digest_day || "sun",
      timezone: prefs.timezone.trim() || "Asia/Dubai",
      channels: {
        ...(prefs.channels ?? {}),
        email: Boolean(prefs.email_enabled),
      },
    };
    return this.save("notification_prefs", body, prefs.id || undefined);
  }

  async sendTestNotificationEmail(): Promise<{ ok: boolean; message: string }> {
    return this.invokeFunction<{ ok: boolean; message: string }>("notify-test");
  }

  async loadPushSubscriptions(): Promise<{
    subscriptions: PushSubscriptionRecord[];
    supported: boolean;
  }> {
    if (!this.session) throw new Error("Please sign in.");
    try {
      const rows =
        await this.rows<PushSubscriptionRecord>("push_subscriptions");
      return {
        subscriptions: rows.map((r) =>
          normalizeRecord("push_subscriptions", r),
        ),
        supported: true,
      };
    } catch (e) {
      if (e instanceof MissingCollectionError) {
        return { subscriptions: [], supported: false };
      }
      throw e;
    }
  }

  async savePushSubscription(
    sub: Omit<PushSubscriptionRecord, "id">,
  ): Promise<PushSubscriptionRecord> {
    if (!this.session) throw new Error("Please sign in.");
    const existing =
      await this.rows<PushSubscriptionRecord>("push_subscriptions");
    const match = existing.find((r) => r.endpoint === sub.endpoint);
    return this.save(
      "push_subscriptions",
      {
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        user_agent: (sub.user_agent ?? "").slice(0, 300),
        created_at_iso: sub.created_at_iso || new Date().toISOString(),
      },
      match?.id,
    );
  }

  async deletePushSubscription(id: string): Promise<void> {
    if (!this.session) throw new Error("Please sign in.");
    return this.remove("push_subscriptions", id);
  }

  async sendTestPushNotification(): Promise<{ ok: boolean; message: string }> {
    return this.invokeFunction<{ ok: boolean; message: string }>("push-test");
  }

  async loadCaptureToken(): Promise<{
    token: CaptureTokenInfo | null;
    supported: boolean;
  }> {
    if (!this.session) throw new Error("Please sign in.");
    try {
      const rows = await this.rows<CaptureTokenInfo>("capture_tokens");
      return {
        token: rows[0] ? normalizeRecord("capture_tokens", rows[0]) : null,
        supported: true,
      };
    } catch (e) {
      if (e instanceof MissingCollectionError) {
        return { token: null, supported: false };
      }
      throw e;
    }
  }

  async rotateCaptureToken(): Promise<{
    id: string;
    token: string;
    token_preview: string;
    enabled: boolean;
    default_account_id: string | null;
  }> {
    return this.rpc("fuloos_rotate_capture_token");
  }

  async updateCaptureTokenSettings(
    id: string,
    patch: { enabled?: boolean; default_account_id?: string | null },
  ): Promise<CaptureTokenInfo> {
    if (!this.session) throw new Error("Please sign in.");
    return this.save("capture_tokens", patch, id);
  }

  async loadCapturedAlerts(): Promise<{
    alerts: CapturedAlert[];
    supported: boolean;
  }> {
    if (!this.session) throw new Error("Please sign in.");
    try {
      const rows = await this.rows<CapturedAlert>("captured_alerts");
      return {
        alerts: rows.map((a) => normalizeRecord("captured_alerts", a)),
        supported: true,
      };
    } catch (e) {
      if (e instanceof MissingCollectionError) {
        return { alerts: [], supported: false };
      }
      throw e;
    }
  }

  async createCapturedAlert(
    alert: Omit<CapturedAlert, "id">,
  ): Promise<CapturedAlert> {
    if (!this.session) throw new Error("Please sign in.");
    return this.save("captured_alerts", alert);
  }

  async updateCapturedAlertStatus(
    id: string,
    status: CaptureAlertStatus,
  ): Promise<CapturedAlert> {
    if (!this.session) throw new Error("Please sign in.");
    return this.save("captured_alerts", { status }, id);
  }

  async deleteCapturedAlert(id: string): Promise<void> {
    if (!this.session) throw new Error("Please sign in.");
    return this.remove("captured_alerts", id);
  }

  async loadHouseholds(): Promise<{
    households: Household[];
    members: HouseholdMember[];
    supported: boolean;
  }> {
    if (!this.session) throw new Error("Please sign in.");
    try {
      const [households, members] = await Promise.all([
        this.rows<Household>("households"),
        this.rows<HouseholdMember>("household_members"),
      ]);
      return {
        households,
        members: members.map((m) => normalizeRecord("household_members", m)),
        supported: true,
      };
    } catch (e) {
      if (e instanceof MissingCollectionError) {
        return { households: [], members: [], supported: false };
      }
      throw e;
    }
  }

  async createHousehold(name: string): Promise<{
    household: Household;
    member: HouseholdMember;
  }> {
    if (!this.session) throw new Error("Please sign in.");
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Enter a household name.");
    const {
      data: householdData,
      error: hhErr,
      status: hhStatus,
    } = await this.client
      .from("fuloos_households")
      .insert({
        name: trimmed,
        owner_id: this.session.user.id,
      })
      .select("*")
      .single();
    if (hhErr) throw this.toError(hhErr, hhStatus, { table: "households" });
    const household = householdData as Household;

    const members = await this.rows<HouseholdMember>("household_members");
    const existing = members
      .map((m) => normalizeRecord("household_members", m))
      .find(
        (m) =>
          m.household_id === household.id &&
          m.user_id === this.session?.user.id,
      );
    if (existing) {
      return { household, member: existing };
    }
    const {
      data: created,
      error: memErr,
      status: memStatus,
    } = await this.client
      .from("fuloos_household_members")
      .insert({
        household_id: household.id,
        user_id: this.session.user.id,
        role: "owner",
        status: "active",
        invite_code: null,
        member_email: this.session.user.email,
      })
      .select("*")
      .single();
    if (memErr) {
      throw this.toError(memErr, memStatus, { table: "household_members" });
    }
    return {
      household,
      member: normalizeRecord("household_members", created as HouseholdMember),
    };
  }

  async createHouseholdInvite(
    householdId: string,
    role: "editor" | "viewer" = "editor",
  ): Promise<HouseholdMember> {
    const member = await this.rpc<HouseholdMember>("fuloos_household_invite", {
      household_id: householdId,
      role,
    });
    return normalizeRecord("household_members", member);
  }

  async joinHouseholdByCode(inviteCode: string): Promise<{
    household: Household;
    member: HouseholdMember;
  }> {
    const code = inviteCode.trim().toUpperCase();
    if (!code) throw new Error("Enter an invite code.");
    const result = await this.rpc<{
      household: Household;
      member: HouseholdMember;
    }>("fuloos_household_join", { code });
    return {
      household: result.household,
      member: normalizeRecord("household_members", result.member),
    };
  }

  async leaveHousehold(householdId: string): Promise<void> {
    if (!this.session) throw new Error("Please sign in.");
    const { households, members, supported } = await this.loadHouseholds();
    if (!supported) return;
    const household = households.find((h) => h.id === householdId);
    if (household && household.owner_id === this.session.user.id) {
      await this.remove("households", householdId);
      return;
    }
    const member = members.find(
      (m) =>
        m.household_id === householdId && m.user_id === this.session?.user.id,
    );
    if (member) {
      await this.remove("household_members", member.id);
    }
  }

  async removeHouseholdMember(memberId: string): Promise<void> {
    if (!this.session) throw new Error("Please sign in.");
    return this.remove("household_members", memberId);
  }

  async shareAccountWithHousehold(
    accountId: string,
    householdId: string | null,
  ): Promise<Account> {
    const account = await this.rpc<Account>("fuloos_share_account", {
      account_id: accountId,
      household_id: householdId,
    });
    return normalizeRecord("accounts", account);
  }

  async shareBudgetWithHousehold(
    budgetId: string,
    householdId: string | null,
  ): Promise<Budget> {
    const budget = await this.rpc<Budget>("fuloos_share_budget", {
      budget_id: budgetId,
      household_id: householdId,
    });
    return normalizeRecord("budgets", budget);
  }
}
