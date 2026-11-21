import type { ImportTransaction } from "../csv.ts";
import { transactionKey } from "../csv.ts";
import {
  uaeToday,
  type Account,
  type CaptureCategorySuggestion,
  type CapturedAlert,
  type Category,
  type TransactionRule,
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
  bankForMessage,
  bankFromSender,
  cleanName,
  dateInText,
  maskForDisplay,
  parseSms,
  type ParsedSms,
  type SmsType,
} from "../ledger/sms.ts";
import { displayPayee } from "../ledger/smsImport.ts";
import { applyRules } from "../rules.ts";
import {
  detectBankForSenderOrText,
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

export interface SmsEngineContext {
  links: SmsAccountLink[];
  accounts: Pick<Account, "id" | "name" | "type" | "opening_date">[];
  categories: Pick<Category, "id" | "name" | "color" | "emoji">[];
  rules: TransactionRule[];
  learningSettings: LearningSettings | null;
  learningExamples: LearningExample[];
  categoryMap: CategoryMap;
  baseModel: LoadedModel | null;
  /** Optional existing ledger transaction keys (from transactionKey()) for duplicate detection. */
  existingKeys?: string[];
}

export type SmsDecisionAction = "auto_add" | "needs_review" | "skip";

export interface SmsDecision {
  action: SmsDecisionAction;
  skipReason?: string;
  smsHash: string;
  androidSmsId?: string;
  timestampMs: number;
  sender: string;
  linkId?: string;
  accountId?: string;
  bank?: string | null;
  cardLast4?: string | null;
  merchantClean?: string | null;
  maskedPreview: string;
  transaction?: ImportTransaction;
  duplicate: boolean;
  confidence: number;
  decidedBy: string;
  topSuggestions: CaptureCategorySuggestion[];
  balanceAfter?: number | null;
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

const EXTRA_AED_RATES: Record<string, number> = {
  AED: 1,
  USD: 3.6725,
  SAR: 0.9793333333333333,
  QAR: 1.0089285714285714,
  BHD: 9.767287234042552,
  OMR: 9.551365409622885,
};

/** Pure JS SHA-256 hex digest (zero Node/WebCrypto dependency so it runs in Android Jetpack JavaScriptEngine). */
export function sha256Hex(input: string): string {
  const str = String(input || "");
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0xd800 || code >= 0xe000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      i++;
      const cp =
        0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push(
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  );
  const rotr = (n: number, x: number) => (x >>> n) | (x << (32 - n));
  const W = new Array<number>(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let t = 0; t < 16; t++) {
      const j = offset + t * 4;
      W[t] =
        ((bytes[j] << 24) |
          (bytes[j + 1] << 16) |
          (bytes[j + 2] << 8) |
          bytes[j + 3]) >>>
        0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(7, W[t - 15]) ^ rotr(18, W[t - 15]) ^ (W[t - 15] >>> 3);
      const s1 = rotr(17, W[t - 2]) ^ rotr(19, W[t - 2]) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let r = 0; r < 64; r++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[r] + W[r]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  return H.map((v) => v.toString(16).padStart(8, "0")).join("");
}

/** Deterministic one-way fingerprint for deduplication without storing raw SMS text. */
export function computeSmsHash(raw: RawNativeSms): string {
  const dateKey = Number.isFinite(raw.timestampMs) && raw.timestampMs > 0
    ? uaeToday(new Date(raw.timestampMs))
    : "";
  const normBody = String(raw.body ?? "").replace(/\s+/g, " ").trim();
  return sha256Hex(
    `${normalizeSender(raw.sender)}\u0001${dateKey}\u0001${normBody}`,
  );
}

/** Fallback parser for UAE banks not in rules.generated.ts (e.g. ENBD / generic debit/credit alerts). */
function parseGenericUaeFallback(
  body: string,
  bank: string | null,
): ParsedSms | null {
  const flat = body.replace(/\n+/g, " ").trim();
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

  let direction: "debit" | "credit" | "none" = "none";
  let txnType: SmsType = "notice";
  let currency: string | null = null;
  let amount = NaN;
  let merchantRaw: string | null = null;

  let m: RegExpExecArray | null = null;
  if (
    (m =
      /(?:Credit|Debit)\s+Card(?:\s+ending(?:\s+with)?\s+\d+|\s+no\.?\s*\S+)?\s+(?:was\s+used\s+for|has\s+been\s+charged(?:\s+for)?|transaction\s+of)\s+([A-Z]{3})\s+([\d,]+(?:\.\d+)?)\s+(?:at|to)\s+(.+?)(?:\s+on\s+\d|\s*\.\s*Avl|\s*\.|$)/i.exec(
        flat,
      ))
  ) {
    direction = "debit";
    txnType = "purchase";
    currency = m[1].toUpperCase();
    amount = parseFloat(m[2].replace(/,/g, ""));
    merchantRaw = m[3].trim();
  } else if (
    (m =
      /([A-Z]{3})\s+([\d,]+(?:\.\d+)?)\s+has\s+been\s+(?:credited|deposited|transferred\s+to\s+your)/i.exec(
        flat,
      ))
  ) {
    direction = "credit";
    txnType = /salary/i.test(flat)
      ? "income"
      : /refund/i.test(flat)
        ? "refund"
        : "transfer_in";
    currency = m[1].toUpperCase();
    amount = parseFloat(m[2].replace(/,/g, ""));
  } else if (
    (m =
      /([A-Z]{3})\s+([\d,]+(?:\.\d+)?)\s+has\s+been\s+(?:debited|deducted)/i.exec(
        flat,
      ))
  ) {
    direction = "debit";
    txnType = "other_debit";
    currency = m[1].toUpperCase();
    amount = parseFloat(m[2].replace(/,/g, ""));
    const atM = /\bat\s+([^.\n]+)/i.exec(flat);
    if (atM) merchantRaw = atM[1].trim();
  } else {
    const amtM = /\b(AED|USD|SAR|QAR|BHD|OMR)\s*([\d,]+(?:\.\d{1,2})?)\b/i.exec(
      flat,
    );
    if (!amtM) return null;
    currency = amtM[1].toUpperCase();
    amount = parseFloat(amtM[2].replace(/,/g, ""));
    if (/\b(?:credited|deposited|salary|refund|received)\b/i.test(flat)) {
      direction = "credit";
      txnType = /salary/i.test(flat) ? "income" : "transfer_in";
    } else if (
      /\b(?:debited|deducted|purchase|spent|charged|paid|withdrawal|pos)\b/i.test(
        flat,
      )
    ) {
      direction = "debit";
      txnType = "purchase";
    } else {
      return null;
    }
    const atM =
      /\bat\s+([A-Za-z0-9][A-Za-z0-9\s&*.'/-]{1,60}?)(?:,\s*[A-Za-z\s-]+|\s+on\s+\d|\s*\.\s*(?:Avl|Avail|Bal)|\s*\.|$)/i.exec(
        flat,
      );
    if (atM) merchantRaw = atM[1].trim();
  }

  const rate = currency ? EXTRA_AED_RATES[currency] : undefined;
  const amountAed =
    rate != null && Number.isFinite(amount) ? amount * rate : NaN;
  if (!Number.isFinite(amountAed)) return null;

  const balM =
    /(?:Avl\.?\s*Bal(?:ance)?|Available\s+Bal(?:ance)?|Balance)\s*(?:is\s*)?(?:AED\s*)?([\d,]+(?:\.\d{1,2})?)/i.exec(
      flat,
    );
  const balanceAfter = balM ? parseFloat(balM[1].replace(/,/g, "")) : NaN;
  const cardLast4 = extractCardLast4(flat, null);
  const clean = cleanName(merchantRaw);

  return {
    bank,
    txn_type: txnType,
    direction,
    amount,
    currency,
    amount_aed: amountAed,
    card_last4: cardLast4,
    merchant_raw: merchantRaw,
    merchant: merchantRaw,
    merchant_clean: clean,
    location: null,
    country: null,
    balance_after: balanceAfter,
    is_bnpl: false,
    is_foreign: Boolean(currency && currency !== "AED"),
    date_in_text: dateInText(flat),
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
  existingKeys: Set<string>;
}

/**
 * Builds the deduplication key set covering both existing ledger transactions and
 * pending captured alerts so neither historical backfill nor background SMS catch-up
 * creates duplicates of already-imported or pending-review transactions.
 */
export function collectExistingDedupeKeys(
  transactions: Pick<
    ImportTransaction,
    "account_id" | "date" | "type" | "to_account_id" | "amount" | "payee"
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
    keys.add(transactionKey(tx as ImportTransaction));
  }
  for (const alert of capturedAlerts) {
    if (alert.status !== "pending") continue;
    const accountId =
      alert.account_id ||
      (alert.source === "sms_native" ? fallbackAccountId : undefined);
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
  return { categoryIds, categoryById, personal, existingKeys };
}

/**
 * Evaluate one raw native SMS against the user's linked accounts, rules, and ML categoriser.
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

  const bank =
    preliminaryLink.bank_template ||
    bankFromSender(raw.sender) ||
    bankForMessage(raw.body, null) ||
    detectBankForSenderOrText(raw.sender, raw.body);

  let parsed = parseSms(raw.body, bank);
  if (parsed.txn_type === "notice" || !Number.isFinite(parsed.amount_aed)) {
    const fallback = parseGenericUaeFallback(raw.body, bank);
    if (fallback) parsed = fallback;
  }

  const finalCard = extractCardLast4(raw.body, parsed.card_last4);
  const link =
    matchSmsToLink(raw.sender, finalCard, ctx.links) ?? preliminaryLink;

  if (SKIP_TYPES[parsed.txn_type]) {
    return {
      action: "skip",
      skipReason: SKIP_TYPES[parsed.txn_type],
      smsHash,
      androidSmsId: raw.id,
      timestampMs: raw.timestampMs,
      sender: raw.sender,
      linkId: link.id,
      accountId: link.account_id,
      bank,
      cardLast4: finalCard,
      maskedPreview,
      duplicate: false,
      confidence: 0,
      decidedBy: "none",
      topSuggestions: [],
    };
  }

  if (parsed.direction === "none" || !Number.isFinite(parsed.amount_aed)) {
    return {
      action: "skip",
      skipReason: "Not a valid debit or credit transaction.",
      smsHash,
      androidSmsId: raw.id,
      timestampMs: raw.timestampMs,
      sender: raw.sender,
      linkId: link.id,
      accountId: link.account_id,
      bank,
      cardLast4: finalCard,
      maskedPreview,
      duplicate: false,
      confidence: 0,
      decidedBy: "none",
      topSuggestions: [],
    };
  }

  const amountFils = Math.round(parsed.amount_aed * 100);
  if (amountFils <= 0) {
    return {
      action: "skip",
      skipReason: "Zero-amount message skipped.",
      smsHash,
      androidSmsId: raw.id,
      timestampMs: raw.timestampMs,
      sender: raw.sender,
      linkId: link.id,
      accountId: link.account_id,
      bank,
      cardLast4: finalCard,
      maskedPreview,
      duplicate: false,
      confidence: 0,
      decidedBy: "none",
      topSuggestions: [],
    };
  }

  const receivedDate =
    Number.isFinite(raw.timestampMs) && raw.timestampMs > 0
      ? uaeToday(new Date(raw.timestampMs))
      : uaeToday();
  const date = parsed.date_in_text ?? receivedDate;
  const type: "expense" | "income" =
    parsed.direction === "debit" ? "expense" : "income";

  const foreignNote =
    parsed.currency && parsed.currency !== "AED"
      ? ` · ${parsed.amount.toFixed(2)} ${parsed.currency} at fixed reference rate`
      : "";
  const cardNote = finalCard ? ` · Card ••${finalCard}` : "";
  const notes = `From ${bank ?? normalizeSender(raw.sender)} SMS${cardNote}${foreignNote}`;

  let payee =
    displayPayee(parsed.merchant_clean) ||
    PAYEE_FOR_TYPE[parsed.txn_type] ||
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
          amount: amountFils,
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
      parsed.merchant_clean,
      parsed.amount_aed,
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
      parsed.merchant_clean,
      parsed.amount_aed,
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
    amount: amountFils,
    payee,
    notes,
    ...(tags.length ? { tags } : {}),
  };

  const txKey = transactionKey(transaction);
  const duplicate = prepared.existingKeys.has(txKey);
  if (!duplicate) {
    prepared.existingKeys.add(txKey);
  }

  const threshold = link.confidence_threshold ?? DEFAULT_REVIEW_THRESHOLD;
  const isHighConfidence =
    type === "income" || (Boolean(categoryId) && confidence >= threshold);

  let action: SmsDecisionAction = "needs_review";
  if (duplicate) {
    action = "skip";
  } else if (link.auto_add_mode === "auto_high_confidence" && isHighConfidence) {
    action = "auto_add";
  }

  return {
    action,
    skipReason: duplicate ? "Already in your Fuloos ledger." : undefined,
    smsHash,
    androidSmsId: raw.id,
    timestampMs: raw.timestampMs,
    sender: raw.sender,
    linkId: link.id,
    accountId: link.account_id,
    bank,
    cardLast4: finalCard,
    merchantClean: parsed.merchant_clean,
    maskedPreview,
    transaction,
    duplicate,
    confidence: Math.round(confidence * 1000) / 1000,
    decidedBy,
    topSuggestions,
    balanceAfter: Number.isFinite(parsed.balance_after)
      ? Math.round(parsed.balance_after * 100)
      : null,
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
    if (d.duplicate) {
      duplicateCount++;
      continue;
    }
    if (d.action === "skip" || !d.transaction) {
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
 * Build a privacy-safe CapturedAlert draft (raw_text is masked!) to sync a low-confidence
 * native SMS decision to the server so it can be reviewed on both mobile and desktop web.
 */
export function buildCapturedAlertDraft(
  decision: SmsDecision,
): Omit<CapturedAlert, "id"> {
  const tx = decision.transaction;
  const accountHint = [
    decision.bank || normalizeSender(decision.sender),
    decision.cardLast4 ? `Card ${decision.cardLast4}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    source: "sms_native",
    subject: `${decision.bank || decision.sender} SMS`,
    raw_text: decision.maskedPreview.slice(0, 8000),
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
  };
}
