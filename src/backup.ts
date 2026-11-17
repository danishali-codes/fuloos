import type { PocketBaseBackend } from "./backend.ts";
import { validateSavingsGoal, validateGoalContribution } from "./goals.ts";
import { validateNetWorthItem, validateNetWorthSnapshot, type NetWorthItem, type NetWorthSnapshot } from "./netWorth.ts";
import { validateRule } from "./rules.ts";
import type { SavingsGoal, GoalContribution, TransactionRule, CapturedAlert, NotificationPreferences, Household } from "./domain.ts";
import { budgetsOverlap, isMonth, MAX_BUDGET_AMOUNT } from "./budgets.ts";
import {
  isSupportedCurrency,
  normalizeCurrencyCode,
  validateForeignCurrencyFields,
} from "./currency.ts";
import { normalizeSplits, normalizeTags } from "./enrichment.ts";
import {
  parsePresetEntry,
  presetKey,
  type CsvPreset,
  type PresetStore,
} from "./csvPresets.ts";
import {
  defaultRecurringPreferences,
  isIsoCalendarDate,
  type Account,
  type AccountType,
  type Budget,
  type Category,
  type Kind,
  type Ledger,
  type RecurringAmountType,
  type RecurringFrequency,
  type RecurringKind,
  type RecurringOccurrenceRecord,
  type RecurringPreferences,
  type RecurringSchedule,
  type RecurringStatus,
  type Transaction,
} from "./domain.ts";

export const BACKUP_FORMAT_VERSION = 2;
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
export const MAX_MONETARY_FILS = 100_000_000_000;

export const BACKUP_LIMITS = {
  accounts: 1000,
  categories: 1000,
  transactions: 50_000,
  recurring: 2000,
  recurringOccurrences: 50_000,
  budgets: 2000,
  csvPresets: 200,
} as const;

const ACCOUNT_TYPES = new Set<AccountType>([
  "current",
  "savings",
  "credit_card",
  "cash",
  "other",
]);
const TX_KINDS = new Set<Kind>(["expense", "income", "transfer"]);
const RECURRING_KINDS = new Set<RecurringKind>(["expense", "income"]);
const RECURRING_FREQUENCIES = new Set<RecurringFrequency>([
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
]);
const RECURRING_AMOUNT_TYPES = new Set<RecurringAmountType>([
  "fixed",
  "variable",
]);
const RECURRING_STATUSES = new Set<RecurringStatus>(["active", "paused"]);
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Full-account portable JSON backup.
 *
 * Privacy & portability note: `ml_examples` and `ml_settings` are intentionally
 * excluded. `ml_examples` contains raw `merchant_text` and correction logs tied
 * to a user's consent state, and `ml_settings` contains `category_map` tied to
 * original account category IDs and consent timestamps.
 */
export interface FuloosBackup {
  format_version: 1 | 2;
  app: "fuloos";
  exported_at: string;
  currency: "AED";
  excluded: ["ml_examples", "ml_settings"];
  data: {
    accounts: Account[];
    categories: Category[];
    transactions: Transaction[];
    recurring: RecurringSchedule[];
    recurring_occurrences: RecurringOccurrenceRecord[];
    recurring_prefs: RecurringPreferences;
    budgets: Budget[];
    csv_presets: CsvPreset[];
    goals?: SavingsGoal[];
    goal_contributions?: GoalContribution[];
    rules?: TransactionRule[];
    captured_alerts?: CapturedAlert[];
    net_worth_items?: NetWorthItem[];
    net_worth_snapshots?: NetWorthSnapshot[];
    notification_prefs?: NotificationPreferences;
    households?: Household[];
    attachments?: BackupAttachment[];
  };
}

export interface BackupAttachment {
  transaction_id: string;
  filename: string;
  mime: string;
  base64: string;
}
export interface BackupPreview {
  formatVersion: number;
  exportedAt: string;
  counts: {
    accounts: number;
    categories: number;
    transactions: number;
    recurring: number;
    recurringOccurrences: number;
    budgets: number;
    csvPresets: number;
  };
}

export type RestoreMode = "empty" | "merge";

export class BackupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new BackupValidationError(message);
}

function requireId(value: unknown, label: string, seen: Set<string>): string {
  if (typeof value !== "string" || !value.trim() || value.length > 64) {
    fail(`${label} has an invalid id.`);
  }
  const id = value.trim();
  if (seen.has(id)) {
    fail(`Duplicate ${label.toLowerCase()} id "${id}" in backup.`);
  }
  seen.add(id);
  return id;
}

function requireString(
  value: unknown,
  label: string,
  opts: { min?: number; max: number },
): string {
  if (typeof value !== "string") fail(`${label} must be a string.`);
  const trimmed = value.trim();
  if (opts.min && trimmed.length < opts.min) {
    fail(`${label} cannot be empty.`);
  }
  if (value.length > opts.max) {
    fail(`${label} exceeds maximum length of ${opts.max} characters.`);
  }
  return value;
}

function requireIntFils(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(`${label} must be an integer in fils between ${min} and ${max}.`);
  }
  return value;
}

function requireDateInBounds(value: unknown, label: string): string {
  if (typeof value !== "string" || !isIsoCalendarDate(value)) {
    fail(`${label} must be a valid YYYY-MM-DD date.`);
  }
  if (value < "1970-01-01" || value > "2100-12-31") {
    fail(`${label} must be between 1970-01-01 and 2100-12-31.`);
  }
  return value;
}

function requireColor(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX_COLOR_RE.test(value)) {
    fail(`${label} must be a #RRGGBB hex color.`);
  }
  return value;
}

function optionalEmoji(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 32) {
    fail(`${label} emoji is invalid.`);
  }
  return value;
}

export function createBackup(
  ledger: Ledger,
  csvPresets: CsvPreset[] = [],
  exportedAt = new Date().toISOString(),
): FuloosBackup {
  return {
    format_version: BACKUP_FORMAT_VERSION,
    app: "fuloos",
    exported_at: exportedAt,
    currency: "AED",
    excluded: ["ml_examples", "ml_settings"],
    data: {
      accounts: ledger.accounts.map((a) => ({ ...a })),
      categories: ledger.categories.map((c) => ({ ...c })),
      transactions: ledger.transactions.map((t) => ({ ...t })),
      recurring: (ledger.recurring ?? []).map((r) => ({ ...r })),
      recurring_occurrences: (ledger.recurring_occurrences ?? []).map((o) => ({
        ...o,
      })),
      recurring_prefs: {
        auto_detect:
          ledger.recurring_prefs?.auto_detect === "off" ? "off" : "on",
        auto_match:
          ledger.recurring_prefs?.auto_match === "review" ||
          ledger.recurring_prefs?.auto_match === "off"
            ? ledger.recurring_prefs.auto_match
            : "auto",
        dismissed_keys: [
          ...(ledger.recurring_prefs?.dismissed_keys ??
            defaultRecurringPreferences.dismissed_keys),
        ],
      },
      budgets: (ledger.budgets ?? []).map((b) => ({ ...b })),
      goals: structuredClone(ledger.goals ?? []),
      goal_contributions: structuredClone(ledger.goal_contributions ?? []),
      rules: structuredClone(ledger.rules ?? []),
      captured_alerts: structuredClone(ledger.captured_alerts ?? []),
      net_worth_items: structuredClone(ledger.net_worth_items ?? []),
      net_worth_snapshots: structuredClone(ledger.net_worth_snapshots ?? []),
      attachments: [],
      csv_presets: csvPresets.map((p) => ({
        ...p,
        headers: [...p.headers],
        columns: { ...p.columns },
      })),
    },
  };
}

export function serializeBackup(backup: FuloosBackup): string {
  return JSON.stringify(backup, null, 2);
}

export function parseAndValidateBackup(rawText: string): {
  backup: FuloosBackup;
  preview: BackupPreview;
} {
  if (typeof rawText !== "string" || !rawText.trim()) {
    fail("Backup file is empty.");
  }
  const byteLength = new TextEncoder().encode(rawText).byteLength;
  if (byteLength > MAX_BACKUP_BYTES) {
    fail("Backup file exceeds the 100 MB size limit.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    fail("Backup file is not valid JSON.");
  }

  if (!isPlainObject(parsed)) {
    fail("Backup root must be a JSON object.");
  }
  if (parsed.format_version !== 1 && parsed.format_version !== BACKUP_FORMAT_VERSION) {
    fail(
      `Unsupported backup format_version: ${String(parsed.format_version ?? "missing")}.`,
    );
  }
  if (parsed.app !== undefined && parsed.app !== "fuloos") {
    fail("Backup file is not a Fuloos backup.");
  }
  if (parsed.currency !== undefined && parsed.currency !== "AED") {
    fail(`Unsupported currency "${String(parsed.currency)}". Only AED is supported.`);
  }
  const exportedAt =
    typeof parsed.exported_at === "string" && parsed.exported_at.trim()
      ? parsed.exported_at
      : new Date().toISOString();

  if (!isPlainObject(parsed.data)) {
    fail("Backup is missing its data object.");
  }
  const d = parsed.data;

  for (const [key, limit, label] of [
    ["accounts", BACKUP_LIMITS.accounts, "accounts"],
    ["categories", BACKUP_LIMITS.categories, "categories"],
    ["transactions", BACKUP_LIMITS.transactions, "transactions"],
    ["recurring", BACKUP_LIMITS.recurring, "recurring schedules"],
    [
      "recurring_occurrences",
      BACKUP_LIMITS.recurringOccurrences,
      "recurring occurrences",
    ],
    ["budgets", BACKUP_LIMITS.budgets, "budgets"],
    ["csv_presets", BACKUP_LIMITS.csvPresets, "CSV presets"],
  ] as const) {
    if (!Array.isArray(d[key])) {
      fail(`Backup data.${key} must be an array.`);
    }
    if ((d[key] as unknown[]).length > limit) {
      fail(`Backup exceeds the limit of ${limit} ${label}.`);
    }
  }

  const accountIds = new Set<string>();
  const accounts: Account[] = (d.accounts as unknown[]).map((raw, i) => {
    if (!isPlainObject(raw)) fail(`Account #${i + 1} must be an object.`);
    const id = requireId(raw.id, `Account #${i + 1}`, accountIds);
    const name = requireString(raw.name, `Account #${i + 1} name`, {
      min: 1,
      max: 80,
    }).trim();
    if (
      typeof raw.type !== "string" ||
      !ACCOUNT_TYPES.has(raw.type as AccountType)
    ) {
      fail(`Account "${name}" has an invalid type.`);
    }
    const opening_balance = requireIntFils(
      raw.opening_balance,
      `Account "${name}" opening_balance`,
      -MAX_MONETARY_FILS,
      MAX_MONETARY_FILS,
    );
    const opening_date = requireDateInBounds(
      raw.opening_date,
      `Account "${name}" opening_date`,
    );
    const color = requireColor(raw.color, `Account "${name}" color`);
    const emoji = optionalEmoji(raw.emoji, `Account "${name}"`);
    let currency: string | undefined;
    if (
      raw.currency !== undefined &&
      raw.currency !== null &&
      raw.currency !== ""
    ) {
      if (typeof raw.currency !== "string" || !isSupportedCurrency(raw.currency)) {
        fail(`Account "${name}" has an unsupported currency.`);
      }
      currency = normalizeCurrencyCode(raw.currency);
    }
    return {
      id,
      name,
      type: raw.type as AccountType,
      opening_balance,
      opening_date,
      color,
      ...(emoji ? { emoji } : {}),
      ...(currency ? { currency } : {}),
      ...Object.fromEntries(["credit_limit","statement_day","payment_due_day","apr_bps","minimum_payment"].filter((key) => raw[key] !== undefined).map((key) => [key, requireIntFils(raw[key], key, 0, key === "statement_day" || key === "payment_due_day" ? 31 : MAX_MONETARY_FILS)])),
      ...(typeof raw.household_id === "string" && raw.household_id ? {household_id: raw.household_id} : {}),
    };
  });

  const categoryIds = new Set<string>();
  const categories: Category[] = (d.categories as unknown[]).map((raw, i) => {
    if (!isPlainObject(raw)) fail(`Category #${i + 1} must be an object.`);
    const id = requireId(raw.id, `Category #${i + 1}`, categoryIds);
    const name = requireString(raw.name, `Category #${i + 1} name`, {
      min: 1,
      max: 80,
    }).trim();
    const description =
      raw.description === undefined
        ? ""
        : requireString(raw.description, `Category "${name}" description`, {
            max: 500,
          });
    const color = requireColor(raw.color, `Category "${name}" color`);
    const emoji = optionalEmoji(raw.emoji, `Category "${name}"`);
    return {
      id,
      name,
      description,
      color,
      ...(emoji ? { emoji } : {}),
    };
  });

  const transactionIds = new Set<string>();
  const txById = new Map<string, Transaction>();
  const transactions: Transaction[] = (d.transactions as unknown[]).map(
    (raw, i) => {
      if (!isPlainObject(raw)) {
        fail(`Transaction #${i + 1} must be an object.`);
      }
      const id = requireId(raw.id, `Transaction #${i + 1}`, transactionIds);
      if (typeof raw.type !== "string" || !TX_KINDS.has(raw.type as Kind)) {
        fail(`Transaction #${i + 1} has an invalid type.`);
      }
      const type = raw.type as Kind;
      const amount = requireIntFils(
        raw.amount,
        `Transaction #${i + 1} amount`,
        0,
        MAX_MONETARY_FILS,
      );
      if (typeof raw.account_id !== "string" || !accountIds.has(raw.account_id)) {
        fail(`Transaction #${i + 1} references missing account.`);
      }
      const toAccountId =
        raw.to_account_id === "" || raw.to_account_id === undefined
          ? null
          : raw.to_account_id;
      const categoryId =
        raw.category_id === "" || raw.category_id === undefined
          ? null
          : raw.category_id;

      if (type === "transfer") {
        if (
          typeof toAccountId !== "string" ||
          !accountIds.has(toAccountId) ||
          toAccountId === raw.account_id
        ) {
          fail(
            `Transfer transaction #${i + 1} must reference a different receiving account.`,
          );
        }
        if (categoryId !== null) {
          fail(`Transfer transaction #${i + 1} cannot have a category.`);
        }
      } else {
        if (toAccountId !== null) {
          fail(`Transaction #${i + 1} cannot have to_account_id unless it is a transfer.`);
        }
        if (
          categoryId !== null &&
          (typeof categoryId !== "string" || !categoryIds.has(categoryId))
        ) {
          fail(`Transaction #${i + 1} references missing category.`);
        }
      }

      const date = requireDateInBounds(raw.date, `Transaction #${i + 1} date`);
      const payee =
        raw.payee === undefined
          ? ""
          : requireString(raw.payee, `Transaction #${i + 1} payee`, {
              max: 160,
            });
      const notes =
        raw.notes === undefined
          ? ""
          : requireString(raw.notes, `Transaction #${i + 1} notes`, {
              max: 1000,
            });

      const tags = raw.tags !== undefined ? normalizeTags(raw.tags) : undefined;
      const splits =
        raw.splits !== undefined ? normalizeSplits(raw.splits) : undefined;
      if (splits && splits.length > 0) {
        if (type === "transfer") {
          fail(`Transfer transaction #${i + 1} cannot have splits.`);
        }
        let splitSum = 0;
        for (const s of splits) {
          if (!Number.isSafeInteger(s.amount) || s.amount <= 0) {
            fail(`Transaction #${i + 1} has an invalid split amount.`);
          }
          if (s.category_id && !categoryIds.has(s.category_id)) {
            fail(`Transaction #${i + 1} split references missing category.`);
          }
          splitSum += s.amount;
        }
        if (splitSum !== amount) {
          fail(`Transaction #${i + 1} split amounts do not sum to total.`);
        }
      }

      let foreignFields:
        | { original_currency: string; original_amount: number; fx_rate: number }
        | undefined;
      if (
        raw.original_currency !== undefined &&
        raw.original_currency !== null &&
        raw.original_currency !== ""
      ) {
        if (typeof raw.original_currency !== "string") {
          fail(`Transaction #${i + 1} has an invalid original_currency.`);
        }
        const oc = normalizeCurrencyCode(raw.original_currency);
        if (oc !== "AED") {
          try {
            validateForeignCurrencyFields({
              original_currency: oc,
              original_amount: raw.original_amount as number,
              fx_rate: raw.fx_rate as number,
            });
          } catch (err) {
            fail(
              `Transaction #${i + 1}: ${err instanceof Error ? err.message : "Invalid foreign currency fields."}`,
            );
          }
          foreignFields = {
            original_currency: oc,
            original_amount: raw.original_amount as number,
            fx_rate: raw.fx_rate as number,
          };
        }
      }

      const tx: Transaction = {
        id,
        type,
        amount,
        account_id: raw.account_id,
        to_account_id: toAccountId,
        category_id: categoryId,
        date,
        payee,
        notes,
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(splits && splits.length > 0 ? { splits } : {}),
        ...(foreignFields ?? {}),
      };
      txById.set(id, tx);
      return tx;
    },
  );

  const recurringIds = new Set<string>();
  const recurringById = new Map<string, RecurringSchedule>();
  const recurring: RecurringSchedule[] = (d.recurring as unknown[]).map(
    (raw, i) => {
      if (!isPlainObject(raw)) {
        fail(`Recurring schedule #${i + 1} must be an object.`);
      }
      const id = requireId(
        raw.id,
        `Recurring schedule #${i + 1}`,
        recurringIds,
      );
      const name = requireString(raw.name, `Recurring schedule #${i + 1} name`, {
        min: 1,
        max: 80,
      }).trim();
      if (
        typeof raw.type !== "string" ||
        !RECURRING_KINDS.has(raw.type as RecurringKind)
      ) {
        fail(`Recurring schedule "${name}" has an invalid type.`);
      }
      const amount = requireIntFils(
        raw.amount,
        `Recurring schedule "${name}" amount`,
        0,
        MAX_MONETARY_FILS,
      );
      if (
        typeof raw.amount_type !== "string" ||
        !RECURRING_AMOUNT_TYPES.has(raw.amount_type as RecurringAmountType)
      ) {
        fail(`Recurring schedule "${name}" has an invalid amount_type.`);
      }
      if (typeof raw.account_id !== "string" || !accountIds.has(raw.account_id)) {
        fail(`Recurring schedule "${name}" references missing account.`);
      }
      const categoryId =
        raw.category_id === "" || raw.category_id === undefined
          ? null
          : raw.category_id;
      if (
        categoryId !== null &&
        (typeof categoryId !== "string" || !categoryIds.has(categoryId))
      ) {
        fail(`Recurring schedule "${name}" references missing category.`);
      }
      if (
        typeof raw.frequency !== "string" ||
        !RECURRING_FREQUENCIES.has(raw.frequency as RecurringFrequency)
      ) {
        fail(`Recurring schedule "${name}" has an invalid frequency.`);
      }
      const start_date = requireDateInBounds(
        raw.start_date,
        `Recurring schedule "${name}" start_date`,
      );
      const endDateRaw =
        raw.end_date === "" || raw.end_date === undefined ? null : raw.end_date;
      let end_date: string | null = null;
      if (endDateRaw !== null) {
        end_date = requireDateInBounds(
          endDateRaw,
          `Recurring schedule "${name}" end_date`,
        );
        if (end_date < start_date) {
          fail(
            `Recurring schedule "${name}" end_date cannot be before start_date.`,
          );
        }
      }
      if (
        typeof raw.status !== "string" ||
        !RECURRING_STATUSES.has(raw.status as RecurringStatus)
      ) {
        fail(`Recurring schedule "${name}" has an invalid status.`);
      }
      const notes =
        raw.notes === undefined
          ? ""
          : requireString(raw.notes, `Recurring schedule "${name}" notes`, {
              max: 1000,
            });
      const schedule: RecurringSchedule = {
        id,
        name,
        type: raw.type as RecurringKind,
        amount,
        amount_type: raw.amount_type as RecurringAmountType,
        account_id: raw.account_id,
        category_id: categoryId,
        frequency: raw.frequency as RecurringFrequency,
        start_date,
        end_date,
        status: raw.status as RecurringStatus,
        notes,
      };
      recurringById.set(id, schedule);
      return schedule;
    },
  );

  const occurrenceIds = new Set<string>();
  const seenScheduleDate = new Set<string>();
  const seenOccurrenceTx = new Set<string>();
  const recurring_occurrences: RecurringOccurrenceRecord[] = (
    d.recurring_occurrences as unknown[]
  ).map((raw, i) => {
    if (!isPlainObject(raw)) {
      fail(`Recurring occurrence #${i + 1} must be an object.`);
    }
    const id = requireId(
      raw.id,
      `Recurring occurrence #${i + 1}`,
      occurrenceIds,
    );
    if (
      typeof raw.recurring_id !== "string" ||
      !recurringById.has(raw.recurring_id)
    ) {
      fail(`Recurring occurrence #${i + 1} references missing schedule.`);
    }
    const occurrence_date = requireDateInBounds(
      raw.occurrence_date,
      `Recurring occurrence #${i + 1} date`,
    );
    if (
      typeof raw.transaction_id !== "string" ||
      !txById.has(raw.transaction_id)
    ) {
      fail(`Recurring occurrence #${i + 1} references missing transaction.`);
    }
    const schedule = recurringById.get(raw.recurring_id)!;
    const tx = txById.get(raw.transaction_id)!;
    if (tx.type !== schedule.type) {
      fail(
        `Recurring occurrence #${i + 1} links a ${tx.type} transaction to a ${schedule.type} schedule.`,
      );
    }
    const schedDateKey = `${raw.recurring_id}|${occurrence_date}`;
    if (seenScheduleDate.has(schedDateKey)) {
      fail(
        `Duplicate recurring occurrence for schedule "${schedule.name}" on ${occurrence_date}.`,
      );
    }
    seenScheduleDate.add(schedDateKey);
    if (seenOccurrenceTx.has(raw.transaction_id)) {
      fail(
        `Transaction "${raw.transaction_id}" is linked to multiple recurring occurrences.`,
      );
    }
    seenOccurrenceTx.add(raw.transaction_id);

    const match_source =
      raw.match_source === "auto" || raw.match_source === "manual"
        ? raw.match_source
        : undefined;
    const match_reason =
      typeof raw.match_reason === "string" && raw.match_reason
        ? raw.match_reason.slice(0, 240)
        : undefined;

    return {
      id,
      recurring_id: raw.recurring_id,
      occurrence_date,
      transaction_id: raw.transaction_id,
      ...(match_source ? { match_source } : {}),
      ...(match_reason ? { match_reason } : {}),
    };
  });

  const budgetIds = new Set<string>();
  const budgetsByCategory = new Map<string, Budget[]>();
  const budgets: Budget[] = (d.budgets as unknown[]).map((raw, i) => {
    if (!isPlainObject(raw)) fail(`Budget #${i + 1} must be an object.`);
    const id = requireId(raw.id, `Budget #${i + 1}`, budgetIds);
    if (
      typeof raw.category_id !== "string" ||
      !categoryIds.has(raw.category_id)
    ) {
      fail(`Budget #${i + 1} references missing category.`);
    }
    const amount = requireIntFils(
      raw.amount,
      `Budget #${i + 1} amount`,
      0,
      MAX_BUDGET_AMOUNT,
    );
    if (typeof raw.start_month !== "string" || !isMonth(raw.start_month)) {
      fail(`Budget #${i + 1} has an invalid start_month.`);
    }
    const endMonthRaw =
      raw.end_month === "" || raw.end_month === undefined
        ? null
        : raw.end_month;
    let end_month: string | null = null;
    if (endMonthRaw !== null) {
      if (typeof endMonthRaw !== "string" || !isMonth(endMonthRaw)) {
        fail(`Budget #${i + 1} has an invalid end_month.`);
      }
      if (endMonthRaw < raw.start_month) {
        fail(`Budget #${i + 1} end_month cannot be before start_month.`);
      }
      end_month = endMonthRaw;
    }
    const budget: Budget = {
      id,
      category_id: raw.category_id,
      amount,
      start_month: raw.start_month,
      end_month,
    };
    const existingForCat = budgetsByCategory.get(budget.category_id) ?? [];
    if (existingForCat.some((b) => budgetsOverlap(b, budget))) {
      fail(`Backup contains overlapping budgets for the same category.`);
    }
    existingForCat.push(budget);
    budgetsByCategory.set(budget.category_id, existingForCat);
    return budget;
  });

  let recurring_prefs: RecurringPreferences = {
    ...defaultRecurringPreferences,
    dismissed_keys: [],
  };
  if (d.recurring_prefs !== undefined) {
    if (!isPlainObject(d.recurring_prefs)) {
      fail("Backup data.recurring_prefs must be an object.");
    }
    const rp = d.recurring_prefs;
    const auto_detect = rp.auto_detect === "off" ? "off" : "on";
    const auto_match =
      rp.auto_match === "review" || rp.auto_match === "off"
        ? rp.auto_match
        : "auto";
    if (
      rp.dismissed_keys !== undefined &&
      (!Array.isArray(rp.dismissed_keys) ||
        !rp.dismissed_keys.every((k) => typeof k === "string"))
    ) {
      fail("Backup recurring_prefs.dismissed_keys must be an array of strings.");
    }
    const dismissed_keys = [
      ...new Set(
        ((rp.dismissed_keys as string[] | undefined) ?? []).filter(Boolean),
      ),
    ].slice(-400);
    recurring_prefs = { auto_detect, auto_match, dismissed_keys };
  }

  const csv_presets: CsvPreset[] = [];
  const seenPresetKeys = new Set<string>();
  for (let i = 0; i < (d.csv_presets as unknown[]).length; i++) {
    const parsedPreset = parsePresetEntry((d.csv_presets as unknown[])[i]);
    if (!parsedPreset) {
      fail(`CSV preset #${i + 1} is invalid.`);
    }
    const key = presetKey(parsedPreset.name);
    if (seenPresetKeys.has(key)) {
      fail(`Duplicate CSV preset "${parsedPreset.name}" in backup.`);
    }
    seenPresetKeys.add(key);
    csv_presets.push(parsedPreset);
  }

  const backup: FuloosBackup = {
    format_version: parsed.format_version as 1 | 2,
    app: "fuloos",
    exported_at: exportedAt,
    currency: "AED",
    excluded: ["ml_examples", "ml_settings"],
    data: {
      accounts,
      categories,
      transactions,
      recurring,
      recurring_occurrences,
      recurring_prefs,
      budgets,
      csv_presets,
      ...validateBackupExtensions(d, {accounts, categories, transactions}),
    },
  };

  return {
    backup,
    preview: {
      formatVersion: parsed.format_version as number,
      exportedAt,
      counts: {
        accounts: accounts.length,
        categories: categories.length,
        transactions: transactions.length,
        recurring: recurring.length,
        recurringOccurrences: recurring_occurrences.length,
        budgets: budgets.length,
        csvPresets: csv_presets.length,
      },
    },
  };
}

export function isLedgerEmpty(ledger: Ledger): boolean {
  return (
    ledger.accounts.length === 0 &&
    ledger.categories.length === 0 &&
    ledger.transactions.length === 0 &&
    (ledger.recurring?.length ?? 0) === 0 &&
    (ledger.recurring_occurrences?.length ?? 0) === 0 &&
    (ledger.budgets?.length ?? 0) === 0 &&
    (ledger.goals?.length ?? 0) === 0 &&
    (ledger.goal_contributions?.length ?? 0) === 0 &&
    (ledger.rules?.length ?? 0) === 0 &&
    (ledger.captured_alerts?.length ?? 0) === 0 &&
    (ledger.net_worth_items?.length ?? 0) === 0 &&
    (ledger.net_worth_snapshots?.length ?? 0) === 0
  );
}

function accountMatchKey(a: Pick<Account, "name" | "type" | "currency">): string {
  return `${a.name.trim().toLowerCase()}|${a.type}|${a.currency || "AED"}`;
}

function categoryMatchKey(c: Pick<Category, "name">): string {
  return c.name.trim().toLowerCase();
}

function recurringMatchKey(
  r: Pick<
    RecurringSchedule,
    "name" | "type" | "account_id" | "frequency" | "start_date"
  >,
): string {
  return JSON.stringify([
    r.name.trim().toLowerCase(),
    r.type,
    r.account_id,
    r.frequency,
    r.start_date,
  ]);
}

function transactionFingerprint(t: Omit<Transaction, "id">): string {
  return JSON.stringify([
    t.date,
    t.type,
    t.amount,
    t.account_id,
    t.to_account_id ?? null,
    t.category_id ?? null,
    t.payee,
    t.notes,
    t.original_currency ?? null,
    t.original_amount ?? null,
    t.fx_rate ?? null,
  ]);
}

export type RestoreBackend = Pick<PocketBaseBackend, "save" | "createMany"> & Partial<Pick<PocketBaseBackend, "saveTransactionWithReceipt" | "createHousehold" | "shareAccountWithHousehold" | "shareBudgetWithHousehold" | "saveNotificationPrefs" | "loadNotificationPrefs">>;

export interface RestoreResult {
  accountsCreated: number;
  categoriesCreated: number;
  transactionsCreated: number;
  recurringCreated: number;
  occurrencesCreated: number;
  budgetsCreated: number;
  presetsSaved: number;
  skipped: {
    accounts: number;
    categories: number;
    transactions: number;
    recurring: number;
    occurrences: number;
    budgets: number;
    presets: number;
  };
}

export async function executeRestore(params: {
  backup: FuloosBackup;
  mode: RestoreMode;
  existingLedger: Ledger;
  existingPresets: CsvPreset[];
  presetStore: Pick<PresetStore, "save">;
  backend?: RestoreBackend;
  demo: boolean;
  demoId: () => string;
  shouldContinue?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ ledger: Ledger; result: RestoreResult }> {
  const {
    backup,
    mode,
    existingLedger,
    existingPresets,
    presetStore,
    backend,
    demo,
    demoId,
    shouldContinue = () => true,
    onProgress,
  } = params;

  if (mode === "empty" && !isLedgerEmpty(existingLedger)) {
    throw new BackupValidationError(
      "Your workspace is not empty. Choose 'Merge with existing data' or clear your workspace first.",
    );
  }
  if (!demo && !backend) {
    throw new Error("Please sign in.");
  }

  const totalSteps =
    backup.data.accounts.length +
    backup.data.categories.length +
    backup.data.transactions.length +
    backup.data.recurring.length +
    backup.data.recurring_occurrences.length +
    backup.data.budgets.length +
    backup.data.csv_presets.length +
    1;
  let completed = 0;
  const advance = (delta: number) => {
    completed += delta;
    onProgress?.(Math.min(completed, totalSteps), totalSteps);
  };

  const check = () => {
    if (!shouldContinue()) {
      throw new Error(
        "Session changed before restore finished. Reload your workspace to see what was saved.",
      );
    }
  };

  const accountIdMap = new Map<string, string>();
  const existingAccountsByKey = new Map(
    existingLedger.accounts.map((a) => [accountMatchKey(a), a.id]),
  );
  const accountsToCreate: { oldId: string; value: Omit<Account, "id"> }[] = [];
  let accountsSkipped = 0;

  for (const a of backup.data.accounts) {
    const existingId =
      mode === "merge" ? existingAccountsByKey.get(accountMatchKey(a)) : undefined;
    if (existingId) {
      accountIdMap.set(a.id, existingId);
      accountsSkipped++;
    } else {
      const { id: oldId, ...value } = a;
      delete value.household_id;
      accountsToCreate.push({ oldId, value });
    }
  }

  const categoryIdMap = new Map<string, string>();
  const existingCategoriesByKey = new Map(
    existingLedger.categories.map((c) => [categoryMatchKey(c), c.id]),
  );
  const categoriesToCreate: { oldId: string; value: Omit<Category, "id"> }[] =
    [];
  let categoriesSkipped = 0;

  for (const c of backup.data.categories) {
    const existingId =
      mode === "merge"
        ? existingCategoriesByKey.get(categoryMatchKey(c))
        : undefined;
    if (existingId) {
      categoryIdMap.set(c.id, existingId);
      categoriesSkipped++;
    } else {
      const { id: oldId, ...value } = c;
      categoriesToCreate.push({ oldId, value });
    }
  }

  const createdAccounts: Account[] = [];
  if (accountsToCreate.length) {
    check();
    if (demo) {
      for (const item of accountsToCreate) {
        const created: Account = { ...item.value, id: demoId() };
        accountIdMap.set(item.oldId, created.id);
        createdAccounts.push(created);
      }
      advance(accountsToCreate.length);
    } else {
      let idx = 0;
      await backend!.createMany(
        "accounts",
        accountsToCreate.map((x) => ({ ...x.value })),
        (_saved, records) => {
          for (const rec of records) {
            const item = accountsToCreate[idx++];
            if (item) accountIdMap.set(item.oldId, rec.id);
            createdAccounts.push(rec as Account);
          }
          advance(records.length);
        },
        shouldContinue,
      );
    }
  }
  if (accountsSkipped) advance(accountsSkipped);

  const createdCategories: Category[] = [];
  if (categoriesToCreate.length) {
    check();
    if (demo) {
      for (const item of categoriesToCreate) {
        const created: Category = { ...item.value, id: demoId() };
        categoryIdMap.set(item.oldId, created.id);
        createdCategories.push(created);
      }
      advance(categoriesToCreate.length);
    } else {
      let idx = 0;
      await backend!.createMany(
        "categories",
        categoriesToCreate.map((x) => ({ ...x.value })),
        (_saved, records) => {
          for (const rec of records) {
            const item = categoriesToCreate[idx++];
            if (item) categoryIdMap.set(item.oldId, rec.id);
            createdCategories.push(rec as Category);
          }
          advance(records.length);
        },
        shouldContinue,
      );
    }
  }
  if (categoriesSkipped) advance(categoriesSkipped);

  // Transactions (multiset deduplication in merge mode for resumability)
  const existingTxCounts = new Map<string, number>();
  if (mode === "merge") {
    for (const t of existingLedger.transactions) {
      const { id: _id, ...rest } = t;
      const fp = transactionFingerprint(rest);
      existingTxCounts.set(fp, (existingTxCounts.get(fp) ?? 0) + 1);
    }
  }

  const txIdMap = new Map<string, string>();
  const txToCreate: { oldId: string; value: Omit<Transaction, "id"> }[] = [];
  let txSkipped = 0;

  for (const t of backup.data.transactions) {
    const remapped: Omit<Transaction, "id"> = {
      type: t.type,
      amount: t.amount,
      account_id: accountIdMap.get(t.account_id) ?? t.account_id,
      to_account_id: t.to_account_id
        ? (accountIdMap.get(t.to_account_id) ?? t.to_account_id)
        : null,
      category_id: t.category_id
        ? (categoryIdMap.get(t.category_id) ?? t.category_id)
        : null,
      date: t.date,
      payee: t.payee,
      notes: t.notes,
      ...(t.tags && t.tags.length > 0 ? { tags: [...t.tags] } : {}),
      ...(t.splits && t.splits.length > 0
        ? {
            splits: t.splits.map((s) => ({
              ...s,
              category_id: s.category_id
                ? (categoryIdMap.get(s.category_id) ?? s.category_id)
                : null,
            })),
          }
        : {}),
      ...(t.original_currency && t.original_currency !== "AED"
        ? {
            original_currency: t.original_currency,
            original_amount: t.original_amount,
            fx_rate: t.fx_rate,
          }
        : {}),
    };
    if (mode === "merge") {
      const fp = transactionFingerprint(remapped);
      const remaining = existingTxCounts.get(fp) ?? 0;
      if (remaining > 0) {
        existingTxCounts.set(fp, remaining - 1);
        const used = new Set(txIdMap.values());
        const existing = existingLedger.transactions.find((candidate) => !used.has(candidate.id) && transactionFingerprint(candidate) === fp);
        if (existing) txIdMap.set(t.id, existing.id);
        txSkipped++;
        continue;
      }
    }
    txToCreate.push({ oldId: t.id, value: remapped });
  }

  const createdTransactions: Transaction[] = [];
  if (txToCreate.length) {
    check();
    if (demo) {
      for (const item of txToCreate) {
        const created: Transaction = { ...item.value, id: demoId() };
        txIdMap.set(item.oldId, created.id);
        createdTransactions.push(created);
      }
      advance(txToCreate.length);
    } else {
      let idx = 0;
      await backend!.createMany(
        "transactions",
        txToCreate.map((x) => ({ ...x.value })),
        (_saved, records) => {
          for (const rec of records) {
            const item = txToCreate[idx++];
            if (item) txIdMap.set(item.oldId, rec.id);
            createdTransactions.push(rec as Transaction);
          }
          advance(records.length);
        },
        shouldContinue,
      );
    }
  }
  if (txSkipped) advance(txSkipped);

  // Recurring schedules
  const existingRecurringByKey = new Map(
    (existingLedger.recurring ?? []).map((r) => [recurringMatchKey(r), r.id]),
  );
  const recurringIdMap = new Map<string, string>();
  const recurringToCreate: {
    oldId: string;
    value: Omit<RecurringSchedule, "id">;
  }[] = [];
  let recurringSkipped = 0;

  for (const r of backup.data.recurring) {
    const remapped: Omit<RecurringSchedule, "id"> = {
      name: r.name,
      type: r.type,
      amount: r.amount,
      amount_type: r.amount_type,
      account_id: accountIdMap.get(r.account_id) ?? r.account_id,
      category_id: r.category_id
        ? (categoryIdMap.get(r.category_id) ?? r.category_id)
        : null,
      frequency: r.frequency,
      start_date: r.start_date,
      end_date: r.end_date,
      status: r.status,
      notes: r.notes,
    };
    const existingId =
      mode === "merge"
        ? existingRecurringByKey.get(recurringMatchKey(remapped))
        : undefined;
    if (existingId) {
      recurringIdMap.set(r.id, existingId);
      recurringSkipped++;
    } else {
      recurringToCreate.push({ oldId: r.id, value: remapped });
    }
  }

  const createdRecurring: RecurringSchedule[] = [];
  if (recurringToCreate.length) {
    check();
    if (demo) {
      for (const item of recurringToCreate) {
        const created: RecurringSchedule = { ...item.value, id: demoId() };
        recurringIdMap.set(item.oldId, created.id);
        createdRecurring.push(created);
      }
      advance(recurringToCreate.length);
    } else {
      let idx = 0;
      await backend!.createMany(
        "recurring",
        recurringToCreate.map((x) => ({ ...x.value })),
        (_saved, records) => {
          for (const rec of records) {
            const item = recurringToCreate[idx++];
            if (item) recurringIdMap.set(item.oldId, rec.id);
            createdRecurring.push(rec as RecurringSchedule);
          }
          advance(records.length);
        },
        shouldContinue,
      );
    }
  }
  if (recurringSkipped) advance(recurringSkipped);

  // Recurring occurrences (only when both schedule & transaction were mapped)
  const existingOccKeys = new Set(
    (existingLedger.recurring_occurrences ?? []).map(
      (o) => `${o.recurring_id}|${o.occurrence_date}`,
    ),
  );
  const existingOccTxIds = new Set(
    (existingLedger.recurring_occurrences ?? []).map((o) => o.transaction_id),
  );
  const occToCreate: Omit<RecurringOccurrenceRecord, "id">[] = [];
  let occSkipped = 0;

  for (const occ of backup.data.recurring_occurrences) {
    const newRecurringId = recurringIdMap.get(occ.recurring_id);
    const newTxId = txIdMap.get(occ.transaction_id);
    if (!newRecurringId || !newTxId) {
      occSkipped++;
      continue;
    }
    const key = `${newRecurringId}|${occ.occurrence_date}`;
    if (existingOccKeys.has(key) || existingOccTxIds.has(newTxId)) {
      occSkipped++;
      continue;
    }
    existingOccKeys.add(key);
    existingOccTxIds.add(newTxId);
    occToCreate.push({
      recurring_id: newRecurringId,
      occurrence_date: occ.occurrence_date,
      transaction_id: newTxId,
      ...(occ.match_source ? { match_source: occ.match_source } : {}),
      ...(occ.match_reason ? { match_reason: occ.match_reason } : {}),
    });
  }

  const createdOccurrences: RecurringOccurrenceRecord[] = [];
  if (occToCreate.length) {
    check();
    if (demo) {
      for (const item of occToCreate) {
        createdOccurrences.push({ ...item, id: demoId() });
      }
      advance(occToCreate.length);
    } else {
      await backend!.createMany(
        "recurring_occurrences",
        occToCreate.map((x) => ({ ...x })),
        (_saved, records) => {
          createdOccurrences.push(...(records as RecurringOccurrenceRecord[]));
          advance(records.length);
        },
        shouldContinue,
      );
    }
  }
  if (occSkipped) advance(occSkipped);

  // Budgets
  const existingBudgets = [...(existingLedger.budgets ?? [])];
  const budgetsToCreate: Omit<Budget, "id">[] = [];
  let budgetsSkipped = 0;

  for (const b of backup.data.budgets) {
    const category_id = categoryIdMap.get(b.category_id) ?? b.category_id;
    const candidate: Omit<Budget, "id"> = {
      category_id,
      amount: b.amount,
      start_month: b.start_month,
      end_month: b.end_month,
    };
    const overlaps = existingBudgets.some(
      (eb) => eb.category_id === category_id && budgetsOverlap(eb, candidate),
    );
    if (overlaps) {
      budgetsSkipped++;
      continue;
    }
    existingBudgets.push({ ...candidate, id: "pending" });
    budgetsToCreate.push(candidate);
  }

  const createdBudgets: Budget[] = [];
  if (budgetsToCreate.length) {
    check();
    if (demo) {
      for (const item of budgetsToCreate) {
        createdBudgets.push({ ...item, id: demoId() });
      }
      advance(budgetsToCreate.length);
    } else {
      await backend!.createMany(
        "budgets",
        budgetsToCreate.map((x) => ({ ...x })),
        (_saved, records) => {
          createdBudgets.push(...(records as Budget[]));
          advance(records.length);
        },
        shouldContinue,
      );
    }
  }
  if (budgetsSkipped) advance(budgetsSkipped);

  // Recurring prefs
  check();
  const existingPrefs =
    existingLedger.recurring_prefs ?? defaultRecurringPreferences;
  const mergedDismissed = [
    ...new Set([
      ...(existingPrefs.dismissed_keys ?? []),
      ...(backup.data.recurring_prefs.dismissed_keys ?? []),
    ]),
  ].slice(-400);
  let nextPrefs: RecurringPreferences =
    mode === "empty"
      ? {
          ...backup.data.recurring_prefs,
          dismissed_keys: mergedDismissed,
        }
      : {
          ...existingPrefs,
          dismissed_keys: mergedDismissed,
        };
  if (!demo) {
    const savedPrefs = (await backend!.save(
      "recurring_prefs",
      {
        auto_detect: nextPrefs.auto_detect,
        auto_match: nextPrefs.auto_match,
        dismissed_keys: nextPrefs.dismissed_keys,
      },
      existingPrefs.id,
    )) as RecurringPreferences;
    nextPrefs = savedPrefs;
  }
  advance(1);

  // CSV presets
  const existingPresetKeys = new Set(
    existingPresets.map((p) => presetKey(p.name)),
  );
  let presetsSaved = 0;
  let presetsSkipped = 0;
  for (const preset of backup.data.csv_presets) {
    check();
    const key = presetKey(preset.name);
    if (mode === "merge" && existingPresetKeys.has(key)) {
      presetsSkipped++;
      advance(1);
      continue;
    }
    await presetStore.save(preset);
    existingPresetKeys.add(key);
    presetsSaved++;
    advance(1);
  }

  const {householdMap, receipts, ...extensions} = await restoreBackupExtensions(backup, existingLedger, {accountIdMap, categoryIdMap, txIdMap}, backend, demo, demoId, check);
  const nextLedger: Ledger = {
    ...existingLedger,
    ...extensions,
    accounts: [...existingLedger.accounts, ...createdAccounts].map(a => {
      const original = backup.data.accounts.find(old => accountIdMap.get(old.id) === a.id);
      const household_id = original?.household_id ? householdMap.get(original.household_id) : undefined;
      return household_id ? {...a,household_id} : a;
    }),
    categories: [...existingLedger.categories, ...createdCategories],
    transactions: [...existingLedger.transactions, ...createdTransactions].map(t => receipts.has(t.id) ? {...t,receipt:receipts.get(t.id)} : t),
    recurring: [...(existingLedger.recurring ?? []), ...createdRecurring],
    recurring_occurrences: [
      ...(existingLedger.recurring_occurrences ?? []),
      ...createdOccurrences,
    ],
    recurring_prefs: nextPrefs,
    budgets: [...(existingLedger.budgets ?? []), ...createdBudgets],
  };

  return {
    ledger: nextLedger,
    result: {
      accountsCreated: createdAccounts.length,
      categoriesCreated: createdCategories.length,
      transactionsCreated: createdTransactions.length,
      recurringCreated: createdRecurring.length,
      occurrencesCreated: createdOccurrences.length,
      budgetsCreated: createdBudgets.length,
      presetsSaved,
      skipped: {
        accounts: accountsSkipped,
        categories: categoriesSkipped,
        transactions: txSkipped,
        recurring: recurringSkipped,
        occurrences: occSkipped,
        budgets: budgetsSkipped,
        presets: presetsSkipped,
      },
    },
  };
}

function validateBackupExtensions(d: Record<string, unknown>, ledger: Pick<Ledger, "accounts" | "categories" | "transactions">): Partial<FuloosBackup["data"]> {
  const read = <T extends {id: string}>(key: string, fields: string[], validate: (v: T) => void): T[] => {
    const values = d[key] ?? [];
    if (!Array.isArray(values) || values.length > 10000) fail("Invalid backup " + key + ".");
    const ids = new Set<string>();
    return values.map((raw, i) => {
      if (!isPlainObject(raw)) fail("Invalid backup " + key + ".");
      const id = requireId(raw.id, key + " #" + (i + 1), ids);
      const item = Object.fromEntries(["id", ...fields].filter(k => raw[k] !== undefined).map(k => [k, raw[k]])) as T;
      item.id = id;
      try { validate(item); } catch (err) { fail("Invalid " + key + ": " + (err instanceof Error ? err.message : "invalid data")); }
      return item;
    });
  };
  const goals = read<SavingsGoal>("goals", ["name","target_amount","current_amount","target_date","account_id","color","emoji","kind","status","notes"], (g) => validateSavingsGoal(g, ledger));
  const goal_contributions = read<GoalContribution>("goal_contributions", ["goal_id","amount","date","transaction_id","notes"], (c) => validateGoalContribution(c, {...ledger,goals}));
  const rules = read<TransactionRule>("rules", ["name","enabled","priority","match_field","match_type","pattern","min_amount","max_amount","set_category_id","add_tags","set_payee"], (r) => validateRule(r, ledger.categories));
  const net_worth_items = read<NetWorthItem>("net_worth_items", ["name","kind","category","current_value","as_of_date","color","emoji","notes"], validateNetWorthItem);
  const net_worth_snapshots = read<NetWorthSnapshot>("net_worth_snapshots", ["item_id","value","date","notes"], (s) => {
    validateNetWorthSnapshot(s);
    if (!net_worth_items.some(i => i.id === s.item_id)) fail("Missing net worth item.");
  });
  const captured_alerts = read<CapturedAlert>("captured_alerts", ["source","subject","raw_text","parsed_type","parsed_amount","parsed_date","parsed_payee","parsed_notes","account_hint","status","created_at_iso"], (a) => {
    if (!["email","shortcut"].includes(a.source) || !["expense","income","unknown"].includes(a.parsed_type) || !["pending","imported","dismissed"].includes(a.status)) fail("Invalid captured alert.");
    requireIntFils(a.parsed_amount, "Alert amount", 0, MAX_MONETARY_FILS);
    for (const key of ["subject","raw_text","parsed_date","parsed_payee","parsed_notes","account_hint","created_at_iso"] as const) requireString(a[key],key,{max:key === "raw_text" ? 64000 : 1000});
  });
  const households = read<Household>("households", ["name","owner_id"], (h) => {requireString(h.name,"Household name",{min:1,max:80});});
  const attachments = d.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 200) fail("Too many receipt attachments.");
  let attachmentBytes = 0;
  const seenAttachments = new Set<string>();
  for (const a of attachments) {
    if (!isPlainObject(a) || typeof a.transaction_id !== "string" || !ledger.transactions.some(t => t.id === a.transaction_id) || seenAttachments.has(a.transaction_id)) fail("Invalid receipt transaction.");
    seenAttachments.add(a.transaction_id);
    requireString(a.filename,"Receipt filename",{min:1,max:255});
    if (!["image/jpeg","image/png","image/webp","application/pdf"].includes(String(a.mime)) || typeof a.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.base64)) fail("Invalid receipt encoding.");
    const bytes = a.base64.length * 3 / 4 - (a.base64.endsWith("==") ? 2 : a.base64.endsWith("=") ? 1 : 0);
    if (bytes <= 0 || bytes > 5 * 1024 * 1024) fail("Receipt exceeds 5 MB.");
    attachmentBytes += bytes;
  }
  if (attachmentBytes > 50 * 1024 * 1024) fail("Receipts exceed the 50 MB total limit.");
  let notification_prefs: NotificationPreferences | undefined;
  if (d.notification_prefs !== undefined) {
    const n = d.notification_prefs;
    if (!isPlainObject(n)) fail("Invalid notification preferences.");
    const flags = ["email_enabled","upcoming_bill_enabled","overdue_enabled","budget_80_enabled","budget_100_enabled","weekly_digest_enabled"];
    if (!flags.every(k => typeof n[k] === "boolean") || !Number.isInteger(n.upcoming_bill_days) || Number(n.upcoming_bill_days) < 1 || Number(n.upcoming_bill_days) > 30 || !["sun","mon","tue","wed","thu","fri","sat"].includes(String(n.digest_day))) fail("Invalid notification preferences.");
    const timezone = requireString(n.timezone,"Timezone",{min:1,max:100});
    try { new Intl.DateTimeFormat("en",{timeZone:timezone}); } catch { fail("Invalid notification timezone."); }
    notification_prefs = {...Object.fromEntries(flags.map(k => [k,n[k]])), upcoming_bill_days:n.upcoming_bill_days, digest_day:n.digest_day, timezone, channels:{email:!!n.email_enabled,push:false}} as unknown as NotificationPreferences;
  }
  return {goals,goal_contributions,rules,net_worth_items,net_worth_snapshots,captured_alerts,households,attachments:attachments as BackupAttachment[], ...(notification_prefs ? {notification_prefs} : {})};
}

async function restoreBackupExtensions(
  backup: FuloosBackup, existing: Ledger,
  maps: {accountIdMap: Map<string,string>; categoryIdMap: Map<string,string>; txIdMap: Map<string,string>},
  backend: RestoreBackend | undefined, demo: boolean, demoId: () => string, check: () => void,
): Promise<Partial<Ledger> & {householdMap: Map<string,string>; receipts: Map<string,string>}> {
  const {accountIdMap:accounts,categoryIdMap:categories,txIdMap:transactions} = maps;
  const remap = (map: Map<string,string>, id: string | null | undefined) => id ? map.get(id) ?? id : null;
  const clean = <T extends {id:string}>(row:T) => {const {id,...rest}=row; return rest;};
  async function rows<T extends {id:string}>(table: "goals"|"goal_contributions"|"rules"|"net_worth_items"|"net_worth_snapshots"|"captured_alerts", values:T[], previous:T[], rewrite:(row:T)=>Record<string,unknown>) {
    const result = [...previous], map = new Map<string,string>();
    const fingerprint = (v:Record<string,unknown>) => JSON.stringify(Object.fromEntries(Object.keys(v).filter(k => k !== "id" && k !== "user_id" && k !== "created" && k !== "updated").sort().map(k=>[k,v[k]])));
    const used = new Set<string>();
    for (const original of values) {
      check();
      const value = rewrite(original);
      const match = result.find(r => !used.has(r.id) && fingerprint(clean(r)) === fingerprint(value));
      const saved = match ?? (demo ? {...value,id:demoId()} : await backend!.save(table,value));
      used.add(saved.id);
      if (!match) result.push(saved as T);
      map.set(original.id,saved.id);
    }
    return {records:result,map};
  }
  const goals = await rows("goals",backup.data.goals ?? [],existing.goals ?? [],g=>({...clean(g),account_id:remap(accounts,g.account_id)}));
  const contributions = await rows("goal_contributions",backup.data.goal_contributions ?? [],existing.goal_contributions ?? [],c=>({...clean(c),goal_id:remap(goals.map,c.goal_id),transaction_id:remap(transactions,c.transaction_id)}));
  const rules = await rows("rules",backup.data.rules ?? [],existing.rules ?? [],r=>({...clean(r),set_category_id:remap(categories,r.set_category_id)}));
  const items = await rows("net_worth_items",backup.data.net_worth_items ?? [],existing.net_worth_items ?? [],i=>({...clean(i)}));
  const snapshots = await rows("net_worth_snapshots",backup.data.net_worth_snapshots ?? [],existing.net_worth_snapshots ?? [],s=>({...clean(s),item_id:remap(items.map,s.item_id)}));
  const alerts = await rows("captured_alerts",backup.data.captured_alerts ?? [],existing.captured_alerts ?? [],a=>({...clean(a)}));
  const householdMap = new Map<string,string>();
  for (const h of backup.data.households ?? []) {
    check();
    if (demo) householdMap.set(h.id,demoId());
    else {
      if (!backend?.createHousehold) throw new Error("Household restore is unavailable.");
      const created = await backend.createHousehold(h.name);
      householdMap.set(h.id,created.household.id);
    }
  }
  for (const a of backup.data.accounts) {
    const hid = a.household_id ? householdMap.get(a.household_id) : undefined;
    const id = accounts.get(a.id);
    if (hid && id && !demo) {
      if (!backend?.shareAccountWithHousehold) throw new Error("Household sharing restore is unavailable.");
      await backend.shareAccountWithHousehold(id,hid);
    }
  }
  if (backup.data.notification_prefs && !demo) {
    if (!backend?.saveNotificationPrefs) throw new Error("Notification settings restore is unavailable.");
    const current = await backend.loadNotificationPrefs?.();
    await backend.saveNotificationPrefs({...backup.data.notification_prefs,id:current?.prefs.id});
  }
  const receipts = new Map<string,string>();
  for (const a of backup.data.attachments ?? []) {
    check();
    const id = transactions.get(a.transaction_id);
    if (!id) throw new Error("Receipt transaction was not restored.");
    const bytes = Uint8Array.from(atob(a.base64), c=>c.charCodeAt(0));
    if (demo) { receipts.set(id,URL.createObjectURL(new Blob([bytes],{type:a.mime}))); continue; }
    if (!backend?.saveTransactionWithReceipt) throw new Error("Receipt restore is unavailable.");
    const saved = await backend.saveTransactionWithReceipt({},id,new File([bytes],a.filename,{type:a.mime}));
    if (saved.receipt) receipts.set(id,saved.receipt);
  }
  return {householdMap,receipts,goals:goals.records,goal_contributions:contributions.records,rules:rules.records,net_worth_items:items.records,net_worth_snapshots:snapshots.records,captured_alerts:alerts.records};
}
