import type { ImportTransaction } from "../csv.ts";
import { transactionKey } from "../csv.ts";
import {
  computeImpliedRate,
  convertMinor,
  DEFAULT_CURRENCY,
  formatCurrencyInput,
  getCurrencyDecimals,
  getPeggedFallbackRate,
  isSupportedCurrency,
  normalizeCurrencyCode,
  type FxSource,
  type FxStatus,
} from "../currency.ts";
import {
  uaeToday,
  type Account,
  type CaptureCategorySuggestion,
  type CapturedAlert,
  type Category,
  type TransactionRule,
  type UserSettings,
} from "../domain.ts";
import {
  CANONICAL,
  DEFAULT_REVIEW_THRESHOLD,
  categorise,
  makeText,
} from "../ledger/categoriser.ts";
import {
  buildPersonalModel,
  suggestCategory,
  type LearningExample,
  type LearningSettings,
  type PersonalModel,
} from "../ledger/learning.ts";
import type { CategoryMap } from "../ledger/mapping.ts";
import type { LoadedModel } from "../ledger/model.ts";
import {
  cleanName,
  dateInText,
  extractBalanceAfter,
  extractBilledAmount,
  extractCurrencyAmount,
  maskForDisplay,
  normalizeSmsDigits,
  stripBalanceAndLimitClauses,
  type ParsedSms,
  type SmsType,
} from "../ledger/sms.ts";
import { displayPayee } from "../ledger/smsImport.ts";
import { applyRules } from "../rules.ts";
import { sha256Hex } from "../sms/hash.ts";
import { parseSmsV1 } from "../sms/parse.ts";
import {
  mapV1ToLegacySmsType,
  type LearnedTemplate,
  type ParsedSmsV1,
} from "../sms/types.ts";
export { sha256Hex };
import {
  extractCardLast4,
  matchSmsToLink,
  normalizeSender,
  type SmsAccountLink,
} from "./smsLinks.ts";

export interface RawNativeSms {
  id?: string;
  sender: string;
  body: string;
  /** Received timestamp in epoch milliseconds. */
  timestampMs: number;
}

export interface CachedRateSnapshotEntry {
  rate: number;
  rateDate: string;
  provider?: string;
}

export interface SmsEngineContext {
  links: SmsAccountLink[];
  accounts: Pick<Account, "id" | "name" | "type" | "opening_date" | "currency">[];
  categories: Pick<Category, "id" | "name" | "color" | "emoji">[];
  rules: TransactionRule[];
  learningSettings: LearningSettings | null;
  learningExamples: LearningExample[];
  categoryMap: CategoryMap;
  baseModel: LoadedModel | null;
  /** Optional non-SMS (manual/CSV) ledger transaction keys for possible_duplicate review flagging. */
  existingKeys?: string[];
  /** Optional previously processed SMS identity hashes (sender + body + minute). */
  processedSmsHashes?: string[];
  /** Optional cached FX rates keyed by `"BASE|QUOTE|YYYY-MM-DD"`. */
  fxRates?: Record<string, CachedRateSnapshotEntry>;
  /** Optional user currency & confirmation settings. */
  userSettings?: UserSettings;
  /** Optional on-device learned SMS templates (Phase 3). */
  learnedTemplates?: LearnedTemplate[];
}

export type SmsDecisionAction = "auto_add" | "needs_review" | "unparsed" | "skip";

export interface SmsDecision {
  action: SmsDecisionAction;
  skipReason?: string;
  smsHash: string;
  androidSmsId?: string;
  timestampMs: number;
  sender: string;
  linkId?: string;
  accountId?: string;
  accountCurrency?: string;
  bank?: string | null;
  cardLast4?: string | null;
  merchantClean?: string | null;
  /** On-device display preview only — NEVER synced to Supabase. */
  maskedPreview: string;
  transaction?: ImportTransaction;
  duplicate: boolean;
  confidence: number;
  decidedBy: string;
  topSuggestions: CaptureCategorySuggestion[];
  balanceAfter?: number | null;
  warnings?: string[];
  /** Present when the headless engine lacked a cached FX rate and native Kotlin should resolve it. */
  needsFxRate?: { from: string; to: string; date: string };
  /** Canonical fuloos.sms/1 structured parse result (never contains SMS body text). */
  parsedV1?: ParsedSmsV1;
  /** Parser layer tag (e.g. "template:ADCB/debit_purchase", "universal@1", "learned:tpl_1"). */
  parsedBy?: string;
}

export interface BackfillMerchantGroup {
  key: string;
  merchantDisplay: string;
  count: number;
  totalFils: number;
  sampleDate: string;
  topSuggestions: CaptureCategorySuggestion[];
  suggestedCategoryId: string | null;
  decisions: SmsDecision[];
}

export interface BackfillSummary {
  totalScanned: number;
  readyToImport: SmsDecision[];
  merchantGroups: BackfillMerchantGroup[];
  lowConfidenceItems: SmsDecision[];
  skippedCount: number;
  duplicateCount: number;
  oldestDate: string | null;
  newestDate: string | null;
  earliestBalanceAfter: number | null;
  latestBalanceAfter: number | null;
}

const SKIP_TYPES: Partial<Record<SmsType, string>> = {
  otp: "One-time password, not a transaction.",
  declined: "Declined or failed transaction.",
  notice: "Not a recognised transaction message.",
  internal_out: "Internal move between accounts at the same bank.",
  internal_in: "Internal move between accounts at the same bank.",
  card_repayment: "Credit card repayment (record as a transfer).",
  card_payment_received: "Credit card repayment (record as a transfer).",
};

const PAYEE_FOR_TYPE: Partial<Record<SmsType, string>> = {
  cash_withdrawal: "Cash withdrawal",
  bank_fee: "Bank fee",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
  income: "Salary / income",
  loan_repayment: "Loan instalment",
  other_debit: "Bank debit",
  refund: "Refund",
};

/** Deterministic one-way fingerprint for deduplication (sender + body + timestamp to the minute). */
export function computeSmsHash(raw: RawNativeSms): string {
  const minuteBucket =
    Number.isFinite(raw.timestampMs) && raw.timestampMs > 0
      ? String(Math.floor(raw.timestampMs / 60_000))
      : "";
  const normBody = String(raw.body ?? "").replace(/\s+/g, " ").trim();
  return sha256Hex(
    `${normalizeSender(raw.sender)}\u0001${minuteBucket}\u0001${normBody}`,
  );
}

/**
 * Looks up a cached FX rate (`1 from = X to`) from the engine context snapshot.
 * Checks exact `(from, to, date)` first, then latest on or before `date`,
 * then latest overall (plus inverse pair).
 */
export function lookupCachedFxRate(
  fxRates: Record<string, CachedRateSnapshotEntry> | undefined,
  from: string,
  to: string,
  date: string,
): { rate: number; rateDate: string; provider: string } | null {
  if (!fxRates) return null;
  const fromCode = normalizeCurrencyCode(from);
  const toCode = normalizeCurrencyCode(to);
  if (fromCode === toCode) return { rate: 1, rateDate: date, provider: "identity" };

  const exact = fxRates[`${fromCode}|${toCode}|${date}`];
  if (exact && Number.isFinite(exact.rate) && exact.rate > 0) {
    return {
      rate: exact.rate,
      rateDate: exact.rateDate || date,
      provider: exact.provider || "cache",
    };
  }

  let bestDirectBefore: CachedRateSnapshotEntry | null = null;
  let bestDirectAny: CachedRateSnapshotEntry | null = null;
  let bestInvBefore: CachedRateSnapshotEntry | null = null;
  let bestInvAny: CachedRateSnapshotEntry | null = null;

  for (const [key, entry] of Object.entries(fxRates)) {
    if (!entry || !Number.isFinite(entry.rate) || entry.rate <= 0) continue;
    const parts = key.split("|");
    if (parts.length < 3) continue;
    const [base, quote, keyDate] = parts;
    const effDate = entry.rateDate || keyDate;
    if (base === fromCode && quote === toCode) {
      if (!bestDirectAny || effDate > bestDirectAny.rateDate) {
        bestDirectAny = { ...entry, rateDate: effDate };
      }
      if (effDate <= date && (!bestDirectBefore || effDate > bestDirectBefore.rateDate)) {
        bestDirectBefore = { ...entry, rateDate: effDate };
      }
    } else if (base === toCode && quote === fromCode) {
      if (!bestInvAny || effDate > bestInvAny.rateDate) {
        bestInvAny = { ...entry, rateDate: effDate };
      }
      if (effDate <= date && (!bestInvBefore || effDate > bestInvBefore.rateDate)) {
        bestInvBefore = { ...entry, rateDate: effDate };
      }
    }
  }

  const direct = bestDirectBefore ?? bestDirectAny;
  if (direct) {
    return {
      rate: direct.rate,
      rateDate: direct.rateDate,
      provider: direct.provider || "cache",
    };
  }
  const inv = bestInvBefore ?? bestInvAny;
  if (inv && inv.rate > 0) {
    return {
      rate: 1 / inv.rate,
      rateDate: inv.rateDate,
      provider: inv.provider || "cache",
    };
  }
  return null;
}

/**
 * Fallback parser for bank SMS templates not in rules.generated.ts (e.g. ENBD / generic debit/credit alerts).
 * Preserves any currency code/symbol in minor units and strictly ignores balance / credit-limit clauses.
 */
function parseGenericUaeFallback(
  body: string,
  bank: string | null,
): ParsedSms | null {
  const flat = normalizeSmsDigits(body).replace(/\n+/g, " ").trim();
  if (
    /\bOTP\b|one[- ]time[- ]password|verification\s+code|authentication\s+code|security\s+code/i.test(
      flat,
    )
  ) {
    return null;
  }
  if (
    /\bdeclined\b|could\s+not\s+be\s+(?:completed|processed)|insufficient\s+(?:funds|balance|limit)|has\s+been\s+rejected/i.test(
      flat,
    )
  ) {
    return null;
  }

  // Strip balance / credit limit clauses before extracting ANY transaction amount
  const nonBalance = stripBalanceAndLimitClauses(flat);

  let direction: "debit" | "credit" | "none" = "none";
  let txnType: SmsType = "notice";
  let merchantRaw: string | null = null;

  const extracted = extractCurrencyAmount(nonBalance);
  if (!extracted) return null;

  const currency = extracted.currency;
  const amount = extracted.amount;
  const amountMinor = extracted.amountMinor;

  let m: RegExpExecArray | null = null;
  if (
    (m =
      /(?:Credit|Debit)\s+Card(?:\s+ending(?:\s+with)?\s+\d+|\s+no\.?\s*\S+)?\s+(?:was\s+used\s+for|has\s+been\s+charged(?:\s+for)?|transaction\s+of)\s+.+?\s+(?:at|to)\s+(.+?)(?:\s+on\s+\d|\s*\.\s*(?:Avl|Avail|Bal|Billed)|\s*\.|$)/i.exec(
        nonBalance,
      ))
  ) {
    direction = "debit";
    txnType = "purchase";
    merchantRaw = m[1].trim();
  } else if (
    /\bhas\s+been\s+(?:credited|deposited|transferred\s+to\s+your)\b/i.test(
      nonBalance,
    )
  ) {
    direction = "credit";
    txnType = /salary/i.test(nonBalance)
      ? "income"
      : /refund/i.test(nonBalance)
        ? "refund"
        : "transfer_in";
  } else if (/\bhas\s+been\s+(?:debited|deducted)\b/i.test(nonBalance)) {
    direction = "debit";
    txnType = "other_debit";
    const atM = /\bat\s+([^.\n]+)/i.exec(nonBalance);
    if (atM) merchantRaw = atM[1].trim();
  } else {
    if (/\b(?:credited|deposited|salary|refund|received)\b/i.test(nonBalance)) {
      direction = "credit";
      txnType = /salary/i.test(nonBalance)
        ? "income"
        : /refund/i.test(nonBalance)
          ? "refund"
          : "transfer_in";
    } else if (
      /\b(?:debited|deducted|purchase|spent|charged|paid|withdrawal|pos|used\s+for)\b/i.test(
        nonBalance,
      )
    ) {
      direction = "debit";
      txnType = "purchase";
    } else {
      return null;
    }
    const atM =
      /\bat\s+([A-Za-z0-9][A-Za-z0-9\s&*.'/-]{1,60}?)(?:,\s*[A-Za-z\s-]+|\s+on\s+\d|\s*\.\s*(?:Avl|Avail|Bal|Billed)|\s*\.|$)/i.exec(
        nonBalance,
      );
    if (atM) merchantRaw = atM[1].trim();
  }

  const billed = extractBilledAmount(flat, currency);
  const balanceAfter = extractBalanceAfter(flat);
  const cardLast4 = extractCardLast4(flat, null);
  const clean = cleanName(merchantRaw);
  const warnings = extracted.unknownCode ? ["unknown_currency_code"] : [];

  return {
    bank,
    txn_type: txnType,
    direction,
    amount,
    amount_minor: amountMinor,
    currency,
    billed_amount: billed?.amount ?? null,
    billed_amount_minor: billed?.amountMinor ?? null,
    billed_currency: billed?.currency ?? null,
    card_last4: cardLast4,
    merchant_raw: merchantRaw,
    merchant: merchantRaw,
    merchant_clean: clean,
    location: null,
    country: null,
    balance_after: balanceAfter,
    is_bnpl: false,
    is_foreign: Boolean(currency && currency !== DEFAULT_CURRENCY),
    date_in_text: dateInText(flat),
    warnings,
  };
}

function buildTopSuggestions(
  merchantClean: string | null,
  amountAed: number,
  topCategoryId: string | null,
  topConfidence: number,
  ctx: SmsEngineContext,
  categoryById: Map<string, Pick<Category, "id" | "name">>,
): CaptureCategorySuggestion[] {
  const candidates = new Map<string, number>();

  if (topCategoryId && categoryById.has(topCategoryId)) {
    candidates.set(topCategoryId, Math.max(0, Math.min(1, topConfidence)));
  }

  // Pull ranked canonical probabilities from categorise() and map to user's own categories.
  const cat = categorise(ctx.baseModel, merchantClean, amountAed);
  if (cat.scores) {
    const ranked = cat.scores
      .map((score, idx) => ({ canonical: CANONICAL[idx], score }))
      .sort((a, b) => b.score - a.score);
    for (const item of ranked) {
      const mappedId = ctx.categoryMap[item.canonical];
      if (!mappedId || !categoryById.has(mappedId)) continue;
      const prev = candidates.get(mappedId) ?? 0;
      if (item.score > prev) candidates.set(mappedId, item.score);
      if (candidates.size >= 3) break;
    }
  } else if (cat.category) {
    const mappedId = ctx.categoryMap[cat.category];
    if (mappedId && categoryById.has(mappedId) && !candidates.has(mappedId)) {
      candidates.set(mappedId, cat.confidence);
    }
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([category_id, confidence]) => ({
      category_id,
      name: categoryById.get(category_id)!.name,
      confidence: Math.round(confidence * 1000) / 1000,
    }));
}

export interface PreparedEngineState {
  categoryIds: Set<string>;
  categoryById: Map<string, Pick<Category, "id" | "name">>;
  personal: PersonalModel | null;
  /** Non-SMS (manual/CSV) transaction keys used to flag possible_duplicate for review. */
  existingKeys: Set<string>;
  /** Processed SMS identity hashes (sender + body + minute). */
  seenSmsHashes: Set<string>;
}

function isSmsSourcedNotes(notes: string | undefined): boolean {
  return /^From\s+.+?\s+SMS\b/i.test(String(notes || "").trim());
}

/**
 * Builds the non-SMS (manual/CSV) transaction key set used to flag `possible_duplicate`
 * for review. SMS-sourced transactions are deduplicated primarily by `smsHash` on-device,
 * so two identical SMS purchases at different times never collapse into one.
 */
export function collectExistingDedupeKeys(
  transactions: Pick<
    ImportTransaction,
    "account_id" | "date" | "type" | "to_account_id" | "amount" | "payee" | "notes"
  >[],
  capturedAlerts: CapturedAlert[] = [],
  fallbackAccountId?: string,
  maxTransactions = Number.POSITIVE_INFINITY,
): string[] {
  const keys = new Set<string>();
  const txSlice =
    Number.isFinite(maxTransactions) && transactions.length > maxTransactions
      ? [...transactions]
          .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
          .slice(0, maxTransactions)
      : transactions;
  for (const tx of txSlice) {
    if (isSmsSourcedNotes(tx.notes)) continue;
    keys.add(transactionKey(tx as ImportTransaction));
  }
  for (const alert of capturedAlerts) {
    if (alert.status !== "pending") continue;
    if (alert.source === "sms_native") continue;
    const accountId = alert.account_id || fallbackAccountId;
    if (!accountId || !alert.parsed_date || !alert.parsed_amount) continue;
    const type = alert.parsed_type === "income" ? "income" : "expense";
    keys.add(
      transactionKey({
        date: alert.parsed_date,
        account_id: accountId,
        to_account_id: null,
        category_id: alert.suggested_category_id ?? null,
        type,
        amount: alert.parsed_amount,
        payee: alert.parsed_payee || "",
        notes: alert.parsed_notes || "",
      }),
    );
  }
  return [...keys];
}

export function prepareEngineState(ctx: SmsEngineContext): PreparedEngineState {
  const categoryIds = new Set(ctx.categories.map((c) => c.id));
  const categoryById = new Map(ctx.categories.map((c) => [c.id, c]));
  const personal =
    ctx.learningSettings?.learn_consent && ctx.learningExamples.length
      ? buildPersonalModel(
          ctx.learningExamples,
          ctx.baseModel,
          ctx.categoryMap,
          categoryIds,
        )
      : null;
  const existingKeys = new Set(ctx.existingKeys ?? []);
  const seenSmsHashes = new Set(ctx.processedSmsHashes ?? []);
  return { categoryIds, categoryById, personal, existingKeys, seenSmsHashes };
}

/**
 * Evaluate one raw native SMS against the user's linked accounts, fuloos.sms/1 parser
 * cascade, rules, and ML categoriser.
 * Pure, deterministic, and privacy-preserving (never mutates inputs or leaks raw SMS text).
 */
export function processSingleSms(
  raw: RawNativeSms,
  ctx: SmsEngineContext,
  prepared: PreparedEngineState = prepareEngineState(ctx),
): SmsDecision {
  const smsHash = computeSmsHash(raw);
  const maskedPreview = maskForDisplay(raw.body);
  const cardInBody = extractCardLast4(raw.body, null);

  // Fast-path: check if sender matches ANY enabled link before doing heavy work.
  const preliminaryLink = matchSmsToLink(raw.sender, cardInBody, ctx.links);
  if (!preliminaryLink) {
    return {
      action: "skip",
      skipReason: "Sender/card is not linked to any enabled account.",
      smsHash,
      androidSmsId: raw.id,
      timestampMs: raw.timestampMs,
      sender: raw.sender,
      cardLast4: cardInBody,
      maskedPreview,
      duplicate: false,
      confidence: 0,
      decidedBy: "none",
      topSuggestions: [],
    };
  }

  // Primary de-duplication by SMS identity hash (sender + body + timestamp to the minute).
  if (prepared.seenSmsHashes.has(smsHash)) {
    return {
      action: "skip",
      skipReason: "Already processed this SMS.",
      smsHash,
      androidSmsId: raw.id,
      timestampMs: raw.timestampMs,
      sender: raw.sender,
      linkId: preliminaryLink.id,
      accountId: preliminaryLink.account_id,
      cardLast4: cardInBody,
      maskedPreview,
      duplicate: true,
      confidence: 0,
      decidedBy: "none",
      topSuggestions: [],
    };
  }
  prepared.seenSmsHashes.add(smsHash);

  const prelimAccount = ctx.accounts.find((a) => a.id === preliminaryLink.account_id);
  const prelimAccCurrency = normalizeCurrencyCode(prelimAccount?.currency);
  const receivedAtIso =
    Number.isFinite(raw.timestampMs) && raw.timestampMs > 0
      ? new Date(raw.timestampMs).toISOString()
      : new Date().toISOString();
  const receivedDate =
    Number.isFinite(raw.timestampMs) && raw.timestampMs > 0
      ? uaeToday(new Date(raw.timestampMs))
      : uaeToday();

  const parsedV1 = parseSmsV1(raw.body, {
    sender: raw.sender,
    received_at: receivedAtIso,
    sms_hash: smsHash,
    link_bank_template: preliminaryLink.bank_template,
    learned_templates: ctx.learnedTemplates,
    account_currency: prelimAccCurrency,
  });

  const bank = parsedV1.bank.id;
  const finalCard = extractCardLast4(raw.body, parsedV1.instrument.last4);
  const link =
    matchSmsToLink(raw.sender, finalCard, ctx.links) ?? preliminaryLink;
  const linkedAccount = ctx.accounts.find((a) => a.id === link.account_id);
  const accCurrency = normalizeCurrencyCode(linkedAccount?.currency);

  // Only otp, declined, and promo may skip silently.
  if (
    parsedV1.kind === "otp" ||
    parsedV1.kind === "declined" ||
    parsedV1.kind === "promo"
  ) {
    const reason =
      parsedV1.kind === "otp"
        ? "One-time password, not a transaction."
        : parsedV1.kind === "declined"
          ? "Declined or failed transaction."
          : "Promotional message, not a transaction.";
    return {
      action: "skip",
      skipReason: reason,
      smsHash,
      androidSmsId: raw.id,
      timestampMs: raw.timestampMs,
      sender: raw.sender,
      linkId: link.id,
      accountId: link.account_id,
      accountCurrency: accCurrency,
      bank,
      cardLast4: finalCard,
      maskedPreview,
      duplicate: false,
      confidence: 0,
      decidedBy: "none",
      topSuggestions: [],
      parsedV1,
      parsedBy: parsedV1.parsed_by,
    };
  }

  // Non-transaction or unvalidated messages from a linked sender are NEVER silently skipped:
  // - If it contains a money figure + debit/credit verb -> needs_review with low_confidence_parse
  // - Otherwise -> unparsed (saved locally in FuloosLocalDb.unparsed_sms "Couldn't read" list)
  if (parsedV1.kind !== "transaction" || !parsedV1.amount || !parsedV1.direction) {
    if (parsedV1.warnings.includes("low_confidence_parse")) {
      const cardNote = finalCard ? ` · Card ••${finalCard}` : "";
      const notes = `From ${bank ?? normalizeSender(raw.sender)} SMS${cardNote} · needs review`;
      const stubTx: ImportTransaction = {
        date: parsedV1.date ?? receivedDate,
        account_id: link.account_id,
        to_account_id: null,
        category_id: null,
        type: "expense",
        amount: 0,
        payee: displayPayee(parsedV1.counterparty.clean) || "",
        notes,
        original_amount: 0,
        original_currency: accCurrency,
        fx_rate: 1,
        fx_rate_date: parsedV1.date ?? receivedDate,
        fx_source: "same_currency",
        fx_status: "estimated",
      };
      return {
        action: "needs_review",
        smsHash,
        androidSmsId: raw.id,
        timestampMs: raw.timestampMs,
        sender: raw.sender,
        linkId: link.id,
        accountId: link.account_id,
        accountCurrency: accCurrency,
        bank,
        cardLast4: finalCard,
        merchantClean: parsedV1.counterparty.clean,
        maskedPreview,
        transaction: stubTx,
        duplicate: false,
        confidence: 0,
        decidedBy: "none",
        topSuggestions: [],
        balanceAfter: parsedV1.balance_after?.minor ?? null,
        warnings: [...parsedV1.warnings],
        parsedV1,
        parsedBy: parsedV1.parsed_by,
      };
    }

    return {
      action: "unparsed",
      skipReason:
        parsedV1.kind === "balance_notice"
          ? "Balance notice without transaction details."
          : "Message format not recognised.",
      smsHash,
      androidSmsId: raw.id,
      timestampMs: raw.timestampMs,
      sender: raw.sender,
      linkId: link.id,
      accountId: link.account_id,
      accountCurrency: accCurrency,
      bank,
      cardLast4: finalCard,
      maskedPreview,
      duplicate: false,
      confidence: 0,
      decidedBy: "none",
      topSuggestions: [],
      balanceAfter: parsedV1.balance_after?.minor ?? null,
      ...(parsedV1.warnings.length ? { warnings: [...parsedV1.warnings] } : {}),
      parsedV1,
      parsedBy: parsedV1.parsed_by,
    };
  }

  const origCurrency = normalizeCurrencyCode(parsedV1.amount.currency);
  const origMinor = parsedV1.amount.minor;
  const legacyType = mapV1ToLegacySmsType(
    parsedV1.kind,
    parsedV1.txn_type,
    parsedV1.direction,
  );
  const date = parsedV1.date ?? receivedDate;
  const type: "expense" | "income" =
    parsedV1.direction === "debit" ? "expense" : "income";

  const warnings: string[] = [...parsedV1.warnings];
  const isKnownCurrency = isSupportedCurrency(origCurrency);
  if (!isKnownCurrency && !warnings.includes("unknown_currency_code")) {
    warnings.push("unknown_currency_code");
  }

  let accountAmountMinor = 0;
  let fxRate: number | undefined;
  let fxRateDate: string = date;
  let fxSource: FxSource | undefined;
  let fxStatus: FxStatus = "exact";
  let needsFxRate: { from: string; to: string; date: string } | undefined;

  if (origCurrency === accCurrency) {
    accountAmountMinor = origMinor;
    fxRate = 1;
    fxRateDate = date;
    fxSource = "same_currency";
    fxStatus = "exact";
  } else if (
    parsedV1.billed_amount &&
    parsedV1.billed_amount.currency === accCurrency &&
    parsedV1.billed_amount.minor > 0
  ) {
    accountAmountMinor = parsedV1.billed_amount.minor;
    fxRate = computeImpliedRate(
      origMinor,
      origCurrency,
      accountAmountMinor,
      accCurrency,
    );
    fxRateDate = date;
    fxSource = "bank_sms";
    fxStatus = "exact";
  } else {
    const cached = isKnownCurrency
      ? lookupCachedFxRate(ctx.fxRates, origCurrency, accCurrency, date)
      : null;
    if (cached) {
      accountAmountMinor = convertMinor(
        origMinor,
        origCurrency,
        accCurrency,
        cached.rate,
      );
      fxRate = cached.rate;
      fxRateDate = cached.rateDate;
      fxSource = "api_estimate";
      fxStatus = "estimated";
      if (cached.rateDate !== date) {
        needsFxRate = { from: origCurrency, to: accCurrency, date };
      }
    } else {
      const pegged = isKnownCurrency
        ? getPeggedFallbackRate(origCurrency, accCurrency)
        : null;
      if (pegged !== null) {
        accountAmountMinor = convertMinor(
          origMinor,
          origCurrency,
          accCurrency,
          pegged,
        );
        fxRate = pegged;
        fxRateDate = date;
        fxSource = "manual_rate";
        fxStatus = "estimated";
        needsFxRate = { from: origCurrency, to: accCurrency, date };
      } else {
        accountAmountMinor = 0;
        fxRate = undefined;
        fxRateDate = date;
        fxSource = undefined;
        fxStatus = "estimated";
        warnings.push("rate_unavailable");
        if (isKnownCurrency) {
          needsFxRate = { from: origCurrency, to: accCurrency, date };
        }
      }
    }
  }

  // Compute AED-equivalent major units for the categoriser model so ML features keep their meaning
  let amountForMlAed: number;
  if (accCurrency === DEFAULT_CURRENCY && accountAmountMinor > 0) {
    amountForMlAed = accountAmountMinor / 100;
  } else if (origCurrency === DEFAULT_CURRENCY) {
    amountForMlAed = origMinor / 100;
  } else {
    const aedRate =
      lookupCachedFxRate(ctx.fxRates, origCurrency, DEFAULT_CURRENCY, date)?.rate ??
      getPeggedFallbackRate(origCurrency, DEFAULT_CURRENCY);
    if (aedRate !== null && aedRate > 0) {
      amountForMlAed =
        (origMinor / 10 ** getCurrencyDecimals(origCurrency)) * aedRate;
    } else {
      amountForMlAed = origMinor / 10 ** getCurrencyDecimals(origCurrency);
    }
  }

  const origFormatted = formatCurrencyInput(origMinor, origCurrency);
  const foreignNote =
    origCurrency !== accCurrency
      ? fxSource === "bank_sms"
        ? ` · ${origCurrency} ${origFormatted} (bank billed)`
        : warnings.includes("rate_unavailable")
          ? ` · ${origCurrency} ${origFormatted} (rate pending)`
          : ` · ${origCurrency} ${origFormatted} (estimated)`
      : "";
  const cardNote = finalCard ? ` · Card ••${finalCard}` : "";
  const notes = `From ${bank ?? normalizeSender(raw.sender)} SMS${cardNote}${foreignNote}`;

  const merchantClean = parsedV1.counterparty.clean;
  let payee =
    displayPayee(merchantClean) ||
    PAYEE_FOR_TYPE[legacyType] ||
    "";
  let categoryId: string | null = null;
  let tags: string[] = [];
  let confidence = type === "income" ? 0.95 : 0;
  let decidedBy = type === "income" ? "income" : "none";
  let topSuggestions: CaptureCategorySuggestion[] = [];

  if (type === "expense") {
    // Tier 1: User's explicit TransactionRules (highest priority, 100% confidence)
    if (ctx.rules.length) {
      const ruleRes = applyRules(
        ctx.rules,
        {
          type,
          amount: accountAmountMinor,
          category_id: null,
          payee,
          notes,
        },
        { overwriteCategory: true, overwritePayee: true },
      );
      if (ruleRes.matchedRules.length) {
        if (ruleRes.category_id && prepared.categoryIds.has(ruleRes.category_id)) {
          categoryId = ruleRes.category_id;
          confidence = 1;
          decidedBy = "user rule";
        }
        if (ruleRes.payee) payee = ruleRes.payee;
        if (ruleRes.tags.length) tags = ruleRes.tags;
      }
    }

    // Tiers 2–5: Corrections -> Personal ML -> UAE Brands/Keywords -> Base ML
    const mlSuggestion = suggestCategory(
      prepared.personal,
      ctx.baseModel,
      ctx.categoryMap,
      merchantClean,
      amountForMlAed,
    );
    if (!categoryId) {
      categoryId =
        mlSuggestion.category_id && prepared.categoryIds.has(mlSuggestion.category_id)
          ? mlSuggestion.category_id
          : null;
      confidence = categoryId ? mlSuggestion.confidence : 0;
      decidedBy = mlSuggestion.decidedBy;
    }
    if (mlSuggestion.payee && decidedBy !== "user rule") {
      payee = mlSuggestion.payee;
    }
    topSuggestions = buildTopSuggestions(
      merchantClean,
      amountForMlAed,
      categoryId,
      confidence,
      ctx,
      prepared.categoryById,
    );
  }

  const transaction: ImportTransaction = {
    date,
    account_id: link.account_id,
    to_account_id: null,
    category_id: categoryId,
    type,
    amount: accountAmountMinor,
    payee,
    notes,
    original_amount: origMinor,
    original_currency: origCurrency,
    ...(fxRate !== undefined ? { fx_rate: fxRate } : {}),
    fx_rate_date: fxRateDate,
    ...(fxSource ? { fx_source: fxSource } : {}),
    fx_status: fxStatus,
    ...(tags.length ? { tags } : {}),
  };

  // Match against existing non-SMS (manual/CSV) ledger transactions only.
  // Never silently skip: flag as `possible_duplicate` and route to review.
  const baseTxKey = transactionKey(transaction);
  const txKey =
    accountAmountMinor === 0 && origMinor > 0
      ? `${baseTxKey}|${origCurrency}|${origMinor}`
      : baseTxKey;
  const possibleDuplicate = prepared.existingKeys.has(txKey);
  if (possibleDuplicate && !warnings.includes("possible_duplicate")) {
    warnings.push("possible_duplicate");
  }

  const threshold = link.confidence_threshold ?? DEFAULT_REVIEW_THRESHOLD;
  const isHighConfidence =
    type === "income" || (Boolean(categoryId) && confidence >= threshold);
  const cannotFullyPrice =
    warnings.includes("unknown_currency_code") ||
    warnings.includes("rate_unavailable");
  const isTransferLikeReview =
    parsedV1.txn_type === "internal_move" ||
    parsedV1.txn_type === "card_repayment";

  let action: SmsDecisionAction = "needs_review";
  if (
    !possibleDuplicate &&
    !cannotFullyPrice &&
    !isTransferLikeReview &&
    link.auto_add_mode === "auto_high_confidence" &&
    isHighConfidence
  ) {
    action = "auto_add";
  }

  return {
    action,
    smsHash,
    androidSmsId: raw.id,
    timestampMs: raw.timestampMs,
    sender: raw.sender,
    linkId: link.id,
    accountId: link.account_id,
    accountCurrency: accCurrency,
    bank,
    cardLast4: finalCard,
    merchantClean,
    maskedPreview,
    transaction,
    duplicate: possibleDuplicate,
    confidence: Math.round(confidence * 1000) / 1000,
    decidedBy,
    topSuggestions,
    balanceAfter: parsedV1.balance_after?.minor ?? null,
    ...(warnings.length ? { warnings } : {}),
    ...(needsFxRate ? { needsFxRate } : {}),
    parsedV1,
    parsedBy: parsedV1.parsed_by,
  };
}

/**
 * Group a historical backfill scan into:
 *  - readyToImport: high-confidence transactions ready for 1-click batch import
 *  - merchantGroups: low-confidence transactions grouped by cleaned merchant so the user only categorizes each merchant once
 */
export function groupBackfillForReview(
  decisions: ReadonlyArray<SmsDecision>,
): BackfillSummary {
  const readyToImport: SmsDecision[] = [];
  const lowConfidenceItems: SmsDecision[] = [];
  let skippedCount = 0;
  let duplicateCount = 0;
  let oldestDate: string | null = null;
  let newestDate: string | null = null;
  let earliestBalanceAfter: number | null = null;
  let latestBalanceAfter: number | null = null;
  let earliestTs = Infinity;
  let latestTs = -Infinity;

  for (const d of decisions) {
    if (d.duplicate && d.action === "skip") {
      duplicateCount++;
      continue;
    }
    if (d.action === "skip" || d.action === "unparsed" || !d.transaction) {
      skippedCount++;
      continue;
    }
    const txDate = d.transaction.date;
    if (!oldestDate || txDate < oldestDate) oldestDate = txDate;
    if (!newestDate || txDate > newestDate) newestDate = txDate;
    if (d.balanceAfter != null) {
      if (d.timestampMs < earliestTs) {
        earliestTs = d.timestampMs;
        earliestBalanceAfter = d.balanceAfter;
      }
      if (d.timestampMs > latestTs) {
        latestTs = d.timestampMs;
        latestBalanceAfter = d.balanceAfter;
      }
    }
    if (d.action === "auto_add") {
      readyToImport.push(d);
    } else {
      lowConfidenceItems.push(d);
    }
  }

  const groupMap = new Map<string, BackfillMerchantGroup>();
  for (const item of lowConfidenceItems) {
    const rawKey =
      makeText(item.merchantClean || item.transaction?.payee || "") ||
      "UNKNOWN MERCHANT";
    const existing = groupMap.get(rawKey);
    if (existing) {
      existing.count++;
      existing.totalFils += item.transaction?.amount ?? 0;
      existing.decisions.push(item);
      if (
        item.transaction?.date &&
        item.transaction.date > existing.sampleDate
      ) {
        existing.sampleDate = item.transaction.date;
      }
      if (!existing.topSuggestions.length && item.topSuggestions.length) {
        existing.topSuggestions = item.topSuggestions;
      }
    } else {
      groupMap.set(rawKey, {
        key: rawKey,
        merchantDisplay:
          item.transaction?.payee ||
          displayPayee(item.merchantClean ?? null) ||
          "Unknown merchant",
        count: 1,
        totalFils: item.transaction?.amount ?? 0,
        sampleDate: item.transaction?.date ?? "",
        topSuggestions: item.topSuggestions,
        suggestedCategoryId: item.topSuggestions[0]?.category_id ?? null,
        decisions: [item],
      });
    }
  }

  const merchantGroups = [...groupMap.values()].sort(
    (a, b) => b.count - a.count || b.totalFils - a.totalFils,
  );

  return {
    totalScanned: decisions.length,
    readyToImport,
    merchantGroups,
    lowConfidenceItems,
    skippedCount,
    duplicateCount,
    oldestDate,
    newestDate,
    earliestBalanceAfter,
    latestBalanceAfter,
  };
}

/**
 * Build a privacy-safe CapturedAlert draft for Supabase review sync.
 * Privacy invariant: for `source = "sms_native"`, raw SMS body text NEVER leaves
 * the phone — `raw_text` is always empty (`""`) and only structured parsed fields sync.
 */
export function buildCapturedAlertDraft(
  decision: SmsDecision,
): Omit<CapturedAlert, "id"> {
  const tx = decision.transaction;
  const bankLabel = decision.bank || "Bank";
  const accountHint = [
    decision.bank || normalizeSender(decision.sender),
    decision.cardLast4 ? `Card ${decision.cardLast4}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    source: "sms_native",
    subject: `${bankLabel} SMS`,
    raw_text: "",
    parsed_type: tx?.type === "income" ? "income" : "expense",
    parsed_amount: tx?.amount ?? 0,
    parsed_date: tx?.date || uaeToday(),
    parsed_payee: (tx?.payee ?? "").slice(0, 120),
    parsed_notes: (tx?.notes ?? "").slice(0, 500),
    account_hint: accountHint.slice(0, 64),
    status: "pending",
    created_at_iso: new Date(
      decision.timestampMs > 0 ? decision.timestampMs : Date.now(),
    ).toISOString(),
    account_id: decision.accountId ?? null,
    suggested_category_id:
      decision.topSuggestions[0]?.category_id ?? tx?.category_id ?? null,
    confidence: decision.confidence,
    top_suggestions: decision.topSuggestions,
    sms_sender: normalizeSender(decision.sender).slice(0, 64),
    card_last4: decision.cardLast4 ?? "",
    ...(tx?.original_currency ? { parsed_currency: tx.original_currency } : {}),
    ...(tx?.original_amount !== undefined
      ? { parsed_original_amount: tx.original_amount }
      : {}),
    ...(tx?.fx_rate !== undefined ? { parsed_fx_rate: tx.fx_rate } : {}),
    ...(tx?.fx_rate_date ? { parsed_fx_rate_date: tx.fx_rate_date } : {}),
    ...(tx?.fx_source ? { parsed_fx_source: tx.fx_source } : {}),
    ...(tx?.fx_status ? { parsed_fx_status: tx.fx_status } : {}),
    ...(decision.warnings?.length ? { warnings: decision.warnings } : {}),
  };
}
