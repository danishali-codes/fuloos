import {
  defaultUserSettings,
  type Account,
  type Budget,
  type CaptureAlertStatus,
  type CaptureTokenInfo,
  type CapturedAlert,
  type Category,
  type ConfirmForeignMode,
  type DigestDay,
  type GoalContribution,
  type Household,
  type HouseholdMember,
  type Ledger,
  type NotificationPreferences,
  type RecurringOccurrenceRecord,
  type RecurringPreferences,
  type RecurringSchedule,
  type SavingsGoal,
  type Transaction,
  type TransactionRule,
  type UserSettings,
} from "./domain.ts";
import {
  DEFAULT_CURRENCY,
  isValidFxSource,
  isValidFxStatus,
  normalizeCurrencyCode,
} from "./currency.ts";
import { normalizeSplits, normalizeTags } from "./enrichment.ts";
import type { NetWorthItem, NetWorthSnapshot } from "./netWorth.ts";

export type BackendKind = "pocketbase" | "supabase";
export type MfaMethod = "email_otp" | "totp";

export interface Session {
  token: string;
  refreshToken?: string;
  user: {
    id: string;
    email: string;
    verified?: boolean;
    mfaEnabled?: boolean;
  };
}

export interface TotpEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
}

export type Table =
  | "accounts"
  | "categories"
  | "transactions"
  | "recurring"
  | "recurring_occurrences"
  | "recurring_prefs"
  | "user_settings"
  | "csv_presets"
  | "budgets"
  | "goals"
  | "goal_contributions"
  | "ml_settings"
  | "ml_examples"
  | "rules"
  | "notification_prefs"
  | "notification_log"
  | "capture_tokens"
  | "captured_alerts"
  | "net_worth_items"
  | "net_worth_snapshots"
  | "push_subscriptions"
  | "households"
  | "household_members";

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string;
  created_at_iso?: string;
}

export interface CsvPresetRecord {
  id: string;
  name: string;
  name_key: string;
  config: unknown;
}

export type SavedRecurringPreferences = RecurringPreferences & { id: string };
export type SavedNotificationPreferences = NotificationPreferences & {
  id: string;
};
export type SavedUserSettings = UserSettings & { id: string };

export interface NotificationLogRecord {
  id: string;
  dedup_key: string;
  channel: string;
  event_type: string;
  period_key: string;
  subject?: string;
  sent_at?: string;
}

/** AI suggestion settings and correction log (see src/ledger/learning.ts). */
export interface MlSettingsRecord {
  id: string;
  learn_consent: boolean;
  share_consent?: boolean;
  consent_version: string;
  consent_at: string;
  category_map: unknown;
}

export interface MlExampleRecord {
  id: string;
  merchant_text: string;
  payee: string;
  amount: number;
  category_id: string | null;
  source: "sms" | "csv" | "manual";
  model_version: string;
  suggested_category: string;
  accepted: boolean;
  created?: string;
}

export type RecordTypes = {
  accounts: Account;
  categories: Category;
  transactions: Transaction;
  recurring: RecurringSchedule;
  recurring_occurrences: RecurringOccurrenceRecord;
  recurring_prefs: SavedRecurringPreferences;
  user_settings: SavedUserSettings;
  csv_presets: CsvPresetRecord;
  budgets: Budget;
  goals: SavingsGoal;
  goal_contributions: GoalContribution;
  ml_settings: MlSettingsRecord;
  ml_examples: MlExampleRecord;
  rules: TransactionRule;
  notification_prefs: SavedNotificationPreferences;
  notification_log: NotificationLogRecord;
  capture_tokens: CaptureTokenInfo;
  captured_alerts: CapturedAlert;
  net_worth_items: NetWorthItem;
  net_worth_snapshots: NetWorthSnapshot;
  push_subscriptions: PushSubscriptionRecord;
  households: Household;
  household_members: HouseholdMember;
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const IMPORT_BATCH_SIZE = 100;

/** A backend error response, keeping the status and field codes for callers. */
export class BackendError extends Error {
  readonly status: number;
  readonly fields: Record<string, { code?: string; message?: string }>;
  constructor(
    message: string,
    status: number,
    fields: Record<string, { code?: string; message?: string }> = {},
  ) {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.fields = fields;
  }
}

export class MissingCollectionError extends BackendError {}

export class MfaRequiredError extends BackendError {
  readonly mfaId: string;
  readonly method: MfaMethod;
  readonly factorId?: string;
  readonly challengeId?: string;
  readonly email?: string;
  constructor(
    mfaId: string,
    message = "Multi-factor authentication required.",
    options?: {
      method?: MfaMethod;
      factorId?: string;
      challengeId?: string;
      email?: string;
    },
  ) {
    super(message, 401);
    this.name = "MfaRequiredError";
    this.mfaId = mfaId;
    this.method = options?.method ?? "email_otp";
    this.factorId = options?.factorId;
    this.challengeId = options?.challengeId;
    this.email = options?.email;
  }
}

/** Public contract implemented by both PocketBaseBackend and SupabaseBackend. */
export interface FuloosBackend {
  readonly kind: BackendKind;
  readonly mfaMethod: MfaMethod;
  readonly url: string;
  subscribe(listener: (session: Session | null) => void): () => void;
  signOut(): void;
  getSession(): Promise<Session | null>;
  googleEnabled(): Promise<boolean>;
  signInWithGoogle(): Promise<Session | null>;
  signIn(email: string, password: string): Promise<Session>;
  requestOtp(email: string): Promise<{ otpId: string }>;
  verifyMfaOtp(mfaId: string, otpId: string, code: string): Promise<Session>;
  enrollTotpMfa?(): Promise<TotpEnrollment>;
  verifyTotpEnrollment?(factorId: string, code: string): Promise<Session>;
  verifyMfaTotp?(
    factorId: string,
    challengeId: string,
    code: string,
  ): Promise<Session>;
  disableTotpMfa?(): Promise<Session>;
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(
    token: string,
    password: string,
    passwordConfirm: string,
  ): Promise<void>;
  requestVerification(email: string): Promise<void>;
  confirmVerification(token: string): Promise<void>;
  changePassword(
    oldPassword: string,
    password: string,
    passwordConfirm: string,
  ): Promise<void>;
  requestEmailChange(newEmail: string): Promise<void>;
  confirmEmailChange(token: string, password: string): Promise<void>;
  setMfaEnabled(enabled: boolean): Promise<Session>;
  signOutEverywhere(): Promise<void>;
  signUp(
    email: string,
    password: string,
  ): Promise<{ session: Session | null; verificationRequired: boolean }>;
  list<K extends "ml_settings" | "ml_examples">(
    table: K,
  ): Promise<RecordTypes[K][]>;
  listCsvPresets(): Promise<CsvPresetRecord[]>;
  probeCollection(table: Table): Promise<boolean>;
  load(): Promise<Ledger>;
  save<K extends Table>(
    table: K,
    value: Record<string, unknown>,
    id?: string,
  ): Promise<RecordTypes[K]>;
  contributeGoal(
    goalId: string,
    body: Record<string, unknown>,
  ): Promise<{
    goal: SavingsGoal;
    contribution: GoalContribution;
    transaction: Transaction | null;
  }>;
  removeGoalContribution(id: string): Promise<SavingsGoal>;
  importCapturedAlert(
    id: string,
    transaction: Record<string, unknown>,
  ): Promise<Transaction>;
  saveNetWorthItemAtomic(
    draft: Record<string, unknown>,
    id: string | undefined,
    operationKey: string,
  ): Promise<{ item: NetWorthItem; snapshots: NetWorthSnapshot[] }>;
  saveNetWorthValuationAtomic(
    itemId: string,
    value: number,
    date: string,
    notes: string,
    operationKey: string,
  ): Promise<{ item: NetWorthItem; snapshots: NetWorthSnapshot[] }>;
  deleteNetWorthSnapshotAtomic(
    id: string,
  ): Promise<{ item: NetWorthItem; snapshots: NetWorthSnapshot[] }>;
  saveTransactionWithReceipt(
    value: Record<string, unknown>,
    id?: string,
    receiptFile?: File | null,
    removeReceipt?: boolean,
  ): Promise<Transaction>;
  getReceiptBlob(txId: string, filename: string): Promise<Blob>;
  getReceiptBlobUrl(txId: string, filename: string): Promise<string>;
  updateTransactions(
    values: Transaction[],
    progress: (saved: number, records: Transaction[]) => void,
    shouldContinue?: () => boolean,
  ): Promise<void>;
  createMany<K extends Table>(
    table: K,
    values: Omit<RecordTypes[K], "id">[],
    progress: (saved: number, records: RecordTypes[K][]) => void,
    shouldContinue?: () => boolean,
  ): Promise<void>;
  deleteAccount(progress?: (step: string) => void): Promise<void>;
  removeMany(
    table: Table,
    ids: string[],
    progress?: (deleted: string[]) => void,
  ): Promise<void>;
  remove(table: Table, id: string): Promise<void>;
  loadNotificationPrefs(): Promise<{
    prefs: NotificationPreferences;
    supported: boolean;
  }>;
  saveNotificationPrefs(
    prefs: NotificationPreferences,
  ): Promise<NotificationPreferences>;
  sendTestNotificationEmail(): Promise<{ ok: boolean; message: string }>;
  loadPushSubscriptions(): Promise<{
    subscriptions: PushSubscriptionRecord[];
    supported: boolean;
  }>;
  savePushSubscription(
    sub: Omit<PushSubscriptionRecord, "id">,
  ): Promise<PushSubscriptionRecord>;
  deletePushSubscription(id: string): Promise<void>;
  sendTestPushNotification(): Promise<{ ok: boolean; message: string }>;
  loadCaptureToken(): Promise<{
    token: CaptureTokenInfo | null;
    supported: boolean;
  }>;
  rotateCaptureToken(): Promise<{
    id: string;
    token: string;
    token_preview: string;
    enabled: boolean;
    default_account_id: string | null;
  }>;
  updateCaptureTokenSettings(
    id: string,
    patch: { enabled?: boolean; default_account_id?: string | null },
  ): Promise<CaptureTokenInfo>;
  loadCapturedAlerts(): Promise<{
    alerts: CapturedAlert[];
    supported: boolean;
  }>;
  createCapturedAlert(
    alert: Omit<CapturedAlert, "id">,
  ): Promise<CapturedAlert>;
  updateCapturedAlertStatus(
    id: string,
    status: CaptureAlertStatus,
  ): Promise<CapturedAlert>;
  deleteCapturedAlert(id: string): Promise<void>;
  loadHouseholds(): Promise<{
    households: Household[];
    members: HouseholdMember[];
    supported: boolean;
  }>;
  createHousehold(name: string): Promise<{
    household: Household;
    member: HouseholdMember;
  }>;
  createHouseholdInvite(
    householdId: string,
    role?: "editor" | "viewer",
  ): Promise<HouseholdMember>;
  joinHouseholdByCode(inviteCode: string): Promise<{
    household: Household;
    member: HouseholdMember;
  }>;
  leaveHousehold(householdId: string): Promise<void>;
  removeHouseholdMember(memberId: string): Promise<void>;
  shareAccountWithHousehold(
    accountId: string,
    householdId: string | null,
  ): Promise<Account>;
  shareBudgetWithHousehold(
    budgetId: string,
    householdId: string | null,
  ): Promise<Budget>;
  loadUserSettings?(): Promise<{
    settings: UserSettings;
    supported: boolean;
  }>;
  saveUserSettings?(settings: UserSettings): Promise<UserSettings>;
  fetchFxRate?(
    from: string,
    to: string,
    date: string,
  ): Promise<{ rate: number; rate_date: string; provider: string } | null>;
}

const MAX_DISMISSED_KEYS = 400;

export function parseDismissedKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return [
      ...new Set(raw.filter((v): v is string => typeof v === "string" && !!v)),
    ].slice(-MAX_DISMISSED_KEYS);
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return [
          ...new Set(
            parsed.filter((v): v is string => typeof v === "string" && !!v),
          ),
        ].slice(-MAX_DISMISSED_KEYS);
      }
    } catch {
      return [];
    }
  }
  return [];
}

export function serializeDismissedKeys(raw: unknown): string {
  const list = parseDismissedKeys(raw);
  let encoded = JSON.stringify(list);
  while (encoded.length > 19500 && list.length > 0) {
    list.shift();
    encoded = JSON.stringify(list);
  }
  return encoded;
}

export function validateBackendOrigin(url: string, label: string): string {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(parsed.hostname)
    )
  ) {
    throw new Error(`${label} must use HTTPS.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `Use the public ${label} origin without credentials or query parameters.`,
    );
  }
  return parsed.href.replace(/\/$/, "");
}

export type ResolvedBackendConfig =
  | { kind: "pocketbase"; url: string }
  | { kind: "supabase"; url: string; anonKey: string }
  | null;

export interface BackendEnv {
  VITE_BACKEND?: string;
  VITE_POCKETBASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

/**
 * Resolves which backend implementation to instantiate from Vite env vars.
 * Defaults to `pocketbase` unless `VITE_BACKEND=supabase` is set.
 */
export function resolveBackendConfig(env: BackendEnv): ResolvedBackendConfig {
  const requested = (env.VITE_BACKEND ?? "pocketbase").trim().toLowerCase();
  if (requested === "supabase") {
    const url = env.VITE_SUPABASE_URL?.trim();
    const anonKey =
      env.VITE_SUPABASE_ANON_KEY?.trim() ||
      env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
    if (!url || !anonKey) return null;
    return { kind: "supabase", url, anonKey };
  }
  const url = env.VITE_POCKETBASE_URL?.trim();
  if (!url) return null;
  return { kind: "pocketbase", url };
}

/**
 * Normalizes a raw row from PocketBase (empty strings for missing fields)
 * or Postgres/Supabase (NULL for missing fields) into Fuloos domain types.
 */
export function normalizeRecord<K extends Table>(
  table: K,
  record: RecordTypes[K],
): RecordTypes[K] {
  if (table === "accounts") {
    const acc = { ...(record as Account) };
    if (acc.opening_balance != null) {
      acc.opening_balance = Math.trunc(Number(acc.opening_balance));
    }
    if (acc.emoji == null) {
      delete acc.emoji;
    }
    if (acc.currency && acc.currency.trim()) {
      acc.currency = acc.currency.trim().toUpperCase();
    } else {
      delete acc.currency;
    }
    for (const key of [
      "credit_limit",
      "statement_day",
      "payment_due_day",
      "apr_bps",
      "minimum_payment",
    ] as const) {
      const val = acc[key];
      if (val != null && Number.isFinite(Number(val)) && Number(val) > 0) {
        acc[key] = Math.trunc(Number(val));
      } else {
        delete acc[key];
      }
    }
    if (acc.household_id && String(acc.household_id).trim()) {
      acc.household_id = String(acc.household_id).trim();
    } else {
      delete acc.household_id;
    }
    return acc as RecordTypes[K];
  }
  if (table === "categories") {
    const cat = { ...(record as Category) };
    cat.description = cat.description ?? "";
    if (cat.emoji == null) {
      delete cat.emoji;
    }
    if (cat.household_id && String(cat.household_id).trim()) {
      cat.household_id = String(cat.household_id).trim();
    } else {
      delete cat.household_id;
    }
    return cat as RecordTypes[K];
  }
  if (table === "transactions") {
    const tx = { ...(record as Transaction) };
    const tags = normalizeTags(tx.tags);
    const splits = normalizeSplits(tx.splits);
    const rawOrigCurr =
      typeof tx.original_currency === "string"
        ? tx.original_currency.trim().toUpperCase()
        : "";
    if (!rawOrigCurr) {
      delete tx.original_currency;
      delete tx.original_amount;
      delete tx.fx_rate;
    } else {
      tx.original_currency = rawOrigCurr;
      if (tx.original_amount != null && Number.isFinite(Number(tx.original_amount))) {
        tx.original_amount = Math.trunc(Number(tx.original_amount));
      } else {
        delete tx.original_amount;
      }
      if (tx.fx_rate != null && Number.isFinite(Number(tx.fx_rate)) && Number(tx.fx_rate) > 0) {
        tx.fx_rate = Number(tx.fx_rate);
      } else {
        delete tx.fx_rate;
      }
    }
    if (typeof tx.fx_rate_date === "string" && tx.fx_rate_date.trim()) {
      tx.fx_rate_date = tx.fx_rate_date.trim().slice(0, 10);
    } else {
      delete tx.fx_rate_date;
    }
    if (!isValidFxSource(tx.fx_source)) {
      delete tx.fx_source;
    }
    if (!isValidFxStatus(tx.fx_status)) {
      delete tx.fx_status;
    }
    if (
      tx.to_amount != null &&
      Number.isFinite(Number(tx.to_amount)) &&
      Number(tx.to_amount) >= 0
    ) {
      tx.to_amount = Math.trunc(Number(tx.to_amount));
    } else {
      delete tx.to_amount;
    }
    const receipt = tx.receipt ? String(tx.receipt) : undefined;
    delete tx.receipt;
    return {
      ...tx,
      amount: Math.trunc(Number(tx.amount ?? 0)),
      payee: tx.payee ?? "",
      notes: tx.notes ?? "",
      to_account_id: tx.to_account_id || null,
      category_id: tx.category_id || null,
      ...(tags.length ? { tags } : { tags: [] }),
      ...(splits.length ? { splits } : { splits: [] }),
      ...(receipt ? { receipt } : {}),
    } as RecordTypes[K];
  }
  if (table === "rules") {
    const r = record as TransactionRule;
    const tags = normalizeTags(r.add_tags);
    return {
      id: r.id,
      name: String(r.name ?? ""),
      enabled: Boolean(r.enabled),
      priority: Number.isFinite(Number(r.priority))
        ? Math.trunc(Number(r.priority))
        : 100,
      match_field:
        r.match_field === "payee" || r.match_field === "notes"
          ? r.match_field
          : "either",
      match_type:
        r.match_type === "starts_with" ||
        r.match_type === "exact" ||
        r.match_type === "regex"
          ? r.match_type
          : "contains",
      pattern: String(r.pattern ?? ""),
      min_amount:
        r.min_amount != null && Number(r.min_amount) > 0
          ? Math.trunc(Number(r.min_amount))
          : null,
      max_amount:
        r.max_amount != null && Number(r.max_amount) > 0
          ? Math.trunc(Number(r.max_amount))
          : null,
      set_category_id: r.set_category_id || null,
      add_tags: tags,
      set_payee: r.set_payee ? String(r.set_payee) : "",
    } as RecordTypes[K];
  }
  if (table === "recurring") {
    const r = record as RecurringSchedule;
    const currency =
      typeof r.currency === "string" && r.currency.trim()
        ? normalizeCurrencyCode(r.currency)
        : undefined;
    return {
      ...r,
      amount: Math.trunc(Number(r.amount ?? 0)),
      ...(currency ? { currency } : {}),
      notes: r.notes ?? "",
      category_id: r.category_id || null,
      end_date: r.end_date || null,
    } as RecordTypes[K];
  }
  if (table === "recurring_occurrences") {
    const occ = record as RecurringOccurrenceRecord & {
      match_source?: string | null;
      match_reason?: string | null;
    };
    const normalized: RecurringOccurrenceRecord = {
      id: occ.id,
      recurring_id: occ.recurring_id,
      occurrence_date: occ.occurrence_date,
      transaction_id: occ.transaction_id,
    };
    if (occ.match_source === "auto" || occ.match_source === "manual") {
      normalized.match_source = occ.match_source;
    }
    if (occ.match_reason) {
      normalized.match_reason = String(occ.match_reason);
    }
    return normalized as RecordTypes[K];
  }
  if (table === "ml_settings") {
    const s = record as MlSettingsRecord;
    return {
      ...s,
      learn_consent: Boolean(s.learn_consent),
      consent_version: s.consent_version ?? "",
      consent_at: s.consent_at ?? "",
    } as RecordTypes[K];
  }
  if (table === "ml_examples") {
    const e = record as MlExampleRecord;
    return {
      ...e,
      amount: Math.trunc(Number(e.amount ?? 0)),
      payee: e.payee ?? "",
      model_version: e.model_version ?? "",
      suggested_category: e.suggested_category ?? "",
      category_id: e.category_id || null,
    } as RecordTypes[K];
  }
  if (table === "budgets") {
    const b = record as Budget;
    return {
      id: b.id,
      category_id: b.category_id,
      amount: Math.trunc(Number(b.amount ?? 0)),
      start_month: b.start_month,
      end_month: b.end_month || null,
      ...(b.household_id ? { household_id: b.household_id } : {}),
    } as RecordTypes[K];
  }
  if (table === "household_members") {
    const m = record as HouseholdMember;
    return {
      id: m.id,
      household_id: m.household_id,
      user_id: m.user_id || null,
      role: m.role === "owner" || m.role === "viewer" ? m.role : "editor",
      status: m.status === "pending" ? "pending" : "active",
      invite_code: m.invite_code || undefined,
      member_email: m.member_email || undefined,
    } as RecordTypes[K];
  }
  if (table === "goals") {
    const g = record as SavingsGoal;
    return {
      id: g.id,
      name: g.name,
      target_amount: Math.trunc(Number(g.target_amount ?? 0)),
      current_amount: Math.trunc(Number(g.current_amount ?? 0)),
      target_date: g.target_date || null,
      account_id: g.account_id || null,
      color: g.color || "#1d5b48",
      emoji: g.emoji || undefined,
      kind: g.kind === "sinking_fund" ? "sinking_fund" : "savings",
      status:
        g.status === "completed" || g.status === "paused" ? g.status : "active",
      notes: g.notes ?? "",
    } as RecordTypes[K];
  }
  if (table === "goal_contributions") {
    const c = record as GoalContribution;
    return {
      id: c.id,
      goal_id: c.goal_id,
      amount: Math.trunc(Number(c.amount ?? 0)),
      date: c.date,
      transaction_id: c.transaction_id || null,
      notes: c.notes ?? "",
    } as RecordTypes[K];
  }
  if (table === "recurring_prefs") {
    const pref = record as {
      id: string;
      auto_detect?: string;
      auto_match?: string;
      dismissed_keys?: unknown;
    };
    return {
      id: pref.id,
      auto_detect: pref.auto_detect === "off" ? "off" : "on",
      auto_match:
        pref.auto_match === "review" || pref.auto_match === "off"
          ? pref.auto_match
          : "auto",
      dismissed_keys: parseDismissedKeys(pref.dismissed_keys),
    } as RecordTypes[K];
  }
  if (table === "notification_prefs") {
    const p = record as Partial<SavedNotificationPreferences>;
    const validDays: readonly DigestDay[] = [
      "sun",
      "mon",
      "tue",
      "wed",
      "thu",
      "fri",
      "sat",
    ];
    const days = Number(p.upcoming_bill_days);
    return {
      id: String(p.id ?? ""),
      email_enabled: Boolean(p.email_enabled),
      upcoming_bill_enabled: Boolean(p.upcoming_bill_enabled),
      upcoming_bill_days:
        Number.isInteger(days) && days >= 1 && days <= 30 ? days : 3,
      overdue_enabled: Boolean(p.overdue_enabled),
      budget_80_enabled: Boolean(p.budget_80_enabled),
      budget_100_enabled: Boolean(p.budget_100_enabled),
      weekly_digest_enabled: Boolean(p.weekly_digest_enabled),
      digest_day: validDays.includes(p.digest_day as DigestDay)
        ? (p.digest_day as DigestDay)
        : "sun",
      timezone:
        typeof p.timezone === "string" && p.timezone.trim()
          ? p.timezone.trim()
          : "Asia/Dubai",
      channels:
        p.channels && typeof p.channels === "object"
          ? (p.channels as Record<string, boolean>)
          : { email: Boolean(p.email_enabled) },
    } as RecordTypes[K];
  }
  if (table === "push_subscriptions") {
    const s = record as Partial<PushSubscriptionRecord>;
    return {
      id: String(s.id ?? ""),
      endpoint: String(s.endpoint ?? ""),
      p256dh: String(s.p256dh ?? ""),
      auth: String(s.auth ?? ""),
      user_agent: String(s.user_agent ?? ""),
      created_at_iso: String(s.created_at_iso ?? ""),
    } as RecordTypes[K];
  }
  if (table === "capture_tokens") {
    const t = record as Partial<CaptureTokenInfo>;
    return {
      id: String(t.id ?? ""),
      token_preview: String(t.token_preview ?? ""),
      enabled: Boolean(t.enabled),
      default_account_id: t.default_account_id || null,
    } as RecordTypes[K];
  }
  if (table === "captured_alerts") {
    const a = record as Partial<CapturedAlert>;
    const source =
      a.source === "sms_native"
        ? "sms_native"
        : a.source === "shortcut"
          ? "shortcut"
          : "email";
    let topSuggestions: CapturedAlert["top_suggestions"] = undefined;
    if (Array.isArray(a.top_suggestions)) {
      topSuggestions = a.top_suggestions
        .filter(
          (s): s is NonNullable<CapturedAlert["top_suggestions"]>[number] =>
            !!s &&
            typeof s === "object" &&
            typeof s.category_id === "string" &&
            typeof s.name === "string",
        )
        .map((s) => ({
          category_id: s.category_id,
          name: s.name,
          confidence: Number(s.confidence ?? 0),
        }));
    }
    return {
      id: String(a.id ?? ""),
      source,
      subject: String(a.subject ?? ""),
      raw_text: String(a.raw_text ?? ""),
      parsed_type:
        a.parsed_type === "expense" || a.parsed_type === "income"
          ? a.parsed_type
          : "unknown",
      parsed_amount: Math.trunc(Number(a.parsed_amount ?? 0)),
      parsed_date: String(a.parsed_date ?? ""),
      parsed_payee: String(a.parsed_payee ?? ""),
      parsed_notes: String(a.parsed_notes ?? ""),
      account_hint: String(a.account_hint ?? ""),
      status:
        a.status === "imported" || a.status === "dismissed"
          ? a.status
          : "pending",
      created_at_iso: String(a.created_at_iso ?? ""),
      ...(a.account_id ? { account_id: String(a.account_id) } : {}),
      ...(a.suggested_category_id
        ? { suggested_category_id: String(a.suggested_category_id) }
        : {}),
      ...(typeof a.confidence === "number" && Number.isFinite(a.confidence)
        ? { confidence: a.confidence }
        : {}),
      ...(topSuggestions?.length ? { top_suggestions: topSuggestions } : {}),
      ...(a.sms_sender ? { sms_sender: String(a.sms_sender) } : {}),
      ...(a.card_last4 ? { card_last4: String(a.card_last4) } : {}),
      ...(typeof a.parsed_currency === "string" && a.parsed_currency.trim()
        ? { parsed_currency: a.parsed_currency.trim().toUpperCase() }
        : {}),
      ...(a.parsed_original_amount != null &&
      Number.isFinite(Number(a.parsed_original_amount))
        ? { parsed_original_amount: Math.trunc(Number(a.parsed_original_amount)) }
        : {}),
      ...(a.parsed_fx_rate != null &&
      Number.isFinite(Number(a.parsed_fx_rate)) &&
      Number(a.parsed_fx_rate) > 0
        ? { parsed_fx_rate: Number(a.parsed_fx_rate) }
        : {}),
      ...(typeof a.parsed_fx_rate_date === "string" && a.parsed_fx_rate_date.trim()
        ? { parsed_fx_rate_date: a.parsed_fx_rate_date.trim().slice(0, 10) }
        : {}),
      ...(isValidFxSource(a.parsed_fx_source)
        ? { parsed_fx_source: a.parsed_fx_source }
        : {}),
      ...(isValidFxStatus(a.parsed_fx_status)
        ? { parsed_fx_status: a.parsed_fx_status }
        : {}),
      ...(Array.isArray(a.warnings) && a.warnings.length
        ? { warnings: a.warnings.map((w) => String(w)) }
        : {}),
    } as RecordTypes[K];
  }
  if (table === "user_settings") {
    const s = record as Partial<SavedUserSettings>;
    const mode: ConfirmForeignMode =
      s.confirm_foreign_mode === "above_threshold" ||
      s.confirm_foreign_mode === "never"
        ? s.confirm_foreign_mode
        : "always";
    const threshold = Number(s.confirm_foreign_threshold);
    return {
      id: String(s.id ?? ""),
      reporting_currency: normalizeCurrencyCode(
        s.reporting_currency ?? DEFAULT_CURRENCY,
      ),
      confirm_foreign_mode: mode,
      confirm_foreign_threshold:
        Number.isFinite(threshold) && threshold >= 0
          ? Math.trunc(threshold)
          : defaultUserSettings.confirm_foreign_threshold,
    } as RecordTypes[K];
  }
  if (table === "net_worth_items") {
    const i = record as NetWorthItem;
    return {
      id: i.id,
      name: String(i.name ?? ""),
      kind: i.kind === "liability" ? "liability" : "asset",
      category: i.category,
      current_value: Math.trunc(Number(i.current_value ?? 0)),
      as_of_date: String(i.as_of_date ?? ""),
      notes: i.notes ?? "",
      color: i.color || "#1d5b48",
      emoji: i.emoji || undefined,
    } as RecordTypes[K];
  }
  if (table === "net_worth_snapshots") {
    const s = record as NetWorthSnapshot;
    return {
      id: s.id,
      item_id: s.item_id,
      value: Math.trunc(Number(s.value ?? 0)),
      date: String(s.date ?? ""),
      notes: s.notes ?? "",
      ...(s.revision !== undefined ? { revision: Number(s.revision) } : {}),
    } as RecordTypes[K];
  }
  return record;
}
