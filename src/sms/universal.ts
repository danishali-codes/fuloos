/* Universal bank-agnostic SMS field extractor (Phase 2).
   Extracts money, direction, txn_type, date, time, instrument, balance_after,
   billed_amount, and counterparty independently — works on any bank's English or
   Arabic SMS without requiring bank-specific regex templates.

   Pure TypeScript, sandbox-safe (no DOM, React, Node, or i18n imports). */
import { isSupportedCurrency } from "../currency.ts";
import { LEDGER_RULES as T } from "../ledger/rules.generated.ts";
import {
  cleanName,
  normalizeSmsDigits,
  smsAmountToMinor,
  splitMerchant,
} from "../ledger/sms.ts";
import { extractCardLast4 } from "../mobile/smsLinks.ts";
import {
  extractCounterpartyFromText,
  isBalanceOnlyNotice,
  isPromoSms,
} from "./bankTemplates.ts";
import {
  makeMoney,
  moneyExponent,
  type BalanceLabel,
  type BalanceMoney,
  type BankInfo,
  type CounterpartyInfo,
  type InstrumentInfo,
  type Money,
  type ParseContext,
  type ParsedSmsV1,
  type SmsTxnType,
} from "./types.ts";
import {
  BALANCE_OR_LIMIT_CLAUSE_RE,
  parseStrictIsoDateUtc,
  validateParsedSmsV1,
} from "./validate.ts";

const COMMON_OTP_RE = new RegExp(T.COMMON_RULES[0][1], T.COMMON_RULES[0][2]);
const COMMON_DECLINED_RE = new RegExp(T.COMMON_RULES[1][1], T.COMMON_RULES[1][2]);
const ARABIC_OTP_RE = /(?:رمز\s+التحقق|كلمة\s+المرور\s+لمرة\s+واحدة|رمز\s+التفعيل)/;
const ARABIC_DECLINED_RE = /(?:تم\s+رفض|مرفوضة|رصيد\s+غير\s+كاف)/;

export type MoneyCandidateLabel = "amount" | "billed" | "balance" | "limit";

export interface MoneyCandidate {
  raw: string;
  currency: string;
  amountStr: string;
  amountMinor: number;
  start: number;
  end: number;
  label: MoneyCandidateLabel;
  balanceLabel?: BalanceLabel;
  unknownCode: boolean;
  inParens: boolean;
  fromSymbol: boolean;
}

/** Normalise digits, dashes, NBSP, and newlines while keeping predictable spacing. */
export function normalizeUniversalText(raw: string): string {
  return normalizeSmsDigits(String(raw ?? ""))
    .replace(/\u00A0/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SYMBOL_TO_CURRENCY: Record<string, string> = {
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  "$": "USD",
};

const ARABIC_CURRENCY_MAP: Array<[RegExp, string]> = [
  [/^(?:درهم|دراهم|د\.?\s*إ\.?|د\.?\s*ا\.?)$/, "AED"],
  [/^(?:ريال|ر\.?\s*س\.?)$/, "SAR"],
  [/^(?:دولار)$/, "USD"],
  [/^(?:يورو)$/, "EUR"],
  [/^(?:جنيه)$/, "GBP"],
];

function mapArabicCurrency(token: string): string | null {
  const cleaned = token.trim();
  for (const [re, code] of ARABIC_CURRENCY_MAP) {
    if (re.test(cleaned)) return code;
  }
  return null;
}

const LIMIT_CTX_RE =
  /(?:\b(?:avl\.?\s*cr\.?\s*limit|avail(?:able)?\s*cr(?:edit)?\.?\s*limit|cr(?:edit)?\.?\s*limit|avl\.?\s*limit|available\s+limit|remaining\s+limit|limit\s*(?:is|:))\b|(?:ال)?حد(?:\s+الائتماني)?)/i;

const BALANCE_CTX_RE =
  /(?:\b(?:avl\.?\s*bal(?:ance)?|avail(?:able)?\s*bal(?:ance)?|new\s+bal(?:ance)?|current\s+bal(?:ance)?|remaining\s+bal(?:ance)?|account\s+bal(?:ance)?|a\/c\s+bal(?:ance)?|bal(?:ance)?\s*(?:is|:|now|after)?|bal\.)\b|(?:ال)?رصيد(?:\s+(?:المتاح|الحالي|المتبقي))?)/i;

const BILLED_CTX_RE =
  /(?:\b(?:billed|equiv(?:alent)?\.?|approx\.?|converted|charged\s+as)\b|[~≈]|مقابل)/i;

const TX_VERB_BEFORE_RE =
  /(?:\b(?:debited|deducted|credited|deposited|purchase|purchased|spent|used\s+for|charged|paid|payment|withdrawn|withdrawal|refund|refunded|reversed|reversal|salary|received|transferred|transfer|bill|fee|charges|installment|emi)\b|(?:خصم|شراء|إيداع|ايداع|سحب|استرداد|راتب|دفع|سداد|تحويل|رسوم))/i;

const NON_CURRENCY_3LETTER = new Set([
  "THE", "AND", "FOR", "WAS", "HAS", "ARE", "NOT", "YOU", "OUR", "VIA",
  "REF", "TXN", "POS", "ATM", "OTP", "PIN", "SMS", "UAE", "VAT", "EMI",
  "END", "NO.", "AVL", "BAL", "LMT", "MAX", "MIN", "DAY", "NOW", "NEW",
  "DUE", "PAY", "APP", "URL", "WWW", "COM", "NET", "ORG", "ACC", "CRD",
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN",
]);

function isInsideParens(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 20), start);
  const after = text.slice(end, Math.min(text.length, end + 20));
  const openIdx = before.lastIndexOf("(");
  const closeBeforeIdx = before.lastIndexOf(")");
  const closeAfterIdx = after.indexOf(")");
  return openIdx >= 0 && openIdx > closeBeforeIdx && closeAfterIdx >= 0;
}

function classifyMoneyContext(
  text: string,
  start: number,
  end: number,
  inParens: boolean,
): { label: MoneyCandidateLabel; balanceLabel?: BalanceLabel } {
  // Look back up to 42 chars, stopping at sentence break (period+space or semicolon)
  const rawPrev = text.slice(Math.max(0, start - 42), start);
  const breakMatch = /(?:[.!?;]\s+)([^.!?;]*)$/.exec(rawPrev);
  const prev = breakMatch ? breakMatch[1] : rawPrev;
  const next = text.slice(end, Math.min(text.length, end + 16));

  if (LIMIT_CTX_RE.test(prev)) {
    return { label: "limit", balanceLabel: "available_limit" };
  }
  if (BALANCE_CTX_RE.test(prev)) {
    const isAvl =
      /(?:\b(?:avl\.?\s*bal|avail(?:able)?\s*bal)\b|الرصيد\s+المتاح)/i.test(prev);
    return {
      label: "balance",
      balanceLabel: isAvl ? "available_balance" : "balance",
    };
  }
  if (BILLED_CTX_RE.test(prev) || /^\s*billed\b/i.test(next)) {
    return { label: "billed" };
  }
  if (inParens) {
    return { label: "billed" };
  }
  return { label: "amount" };
}

/** Extract all money candidates from normalised SMS text with context labels. */
export function extractMoneyCandidates(normText: string): MoneyCandidate[] {
  const rawMatches: Array<{
    raw: string;
    currency: string;
    amountStr: string;
    start: number;
    end: number;
    unknownCode: boolean;
    fromSymbol: boolean;
  }> = [];

  const overlaps = (start: number, end: number) =>
    rawMatches.some((m) => start < m.end && end > m.start);

  // Pass 1: Known ISO 4217 code before amount ("AED 45.00", "AED45.00", "GBP 12.00")
  const codeBeforeRe =
    /(?<![A-Za-z])([A-Z]{3})\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)(?![A-Za-z0-9_])/g;
  let m: RegExpExecArray | null;
  while ((m = codeBeforeRe.exec(normText)) !== null) {
    const code = m[1].toUpperCase();
    if (!isSupportedCurrency(code)) continue;
    rawMatches.push({
      raw: m[0],
      currency: code,
      amountStr: m[2],
      start: m.index,
      end: m.index + m[0].length,
      unknownCode: false,
      fromSymbol: false,
    });
  }

  // Pass 2: Amount before known ISO 4217 code ("245.50 AED", "12.00 GBP")
  const codeAfterRe =
    /(?<![A-Za-z0-9_.])(\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)\s*([A-Z]{3})(?![A-Za-z])/g;
  while ((m = codeAfterRe.exec(normText)) !== null) {
    const code = m[2].toUpperCase();
    if (!isSupportedCurrency(code)) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    if (overlaps(start, end)) continue;
    rawMatches.push({
      raw: m[0],
      currency: code,
      amountStr: m[1],
      start,
      end,
      unknownCode: false,
      fromSymbol: false,
    });
  }

  // Pass 3: Arabic currency words after or before amount ("150.00 درهم", "درهم 150.00", "250 ريال")
  const arabicAfterRe =
    /(?<![0-9.])(\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)\s*(درهم|دراهم|د\.?\s*إ\.?|د\.?\s*ا\.?|ريال|ر\.?\s*س\.?|دولار|يورو|جنيه)(?![\u0600-\u06FF])/g;
  while ((m = arabicAfterRe.exec(normText)) !== null) {
    const code = mapArabicCurrency(m[2]);
    if (!code) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    if (overlaps(start, end)) continue;
    rawMatches.push({
      raw: m[0],
      currency: code,
      amountStr: m[1],
      start,
      end,
      unknownCode: false,
      fromSymbol: false,
    });
  }

  const arabicBeforeRe =
    /(?<![\u0600-\u06FF])(درهم|دراهم|د\.?\s*إ\.?|د\.?\s*ا\.?|ريال|ر\.?\s*س\.?|دولار|يورو|جنيه)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)(?![0-9])/g;
  while ((m = arabicBeforeRe.exec(normText)) !== null) {
    const code = mapArabicCurrency(m[1]);
    if (!code) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    if (overlaps(start, end)) continue;
    rawMatches.push({
      raw: m[0],
      currency: code,
      amountStr: m[2],
      start,
      end,
      unknownCode: false,
      fromSymbol: false,
    });
  }

  // Pass 4: Currency symbols (€, £, ₹ always; $ only when no ISO code appeared)
  const hasIsoCode = rawMatches.some((x) => !x.fromSymbol);
  const symbolRe =
    /([€£₹$])\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)(?![A-Za-z0-9_])/g;
  while ((m = symbolRe.exec(normText)) !== null) {
    const sym = m[1];
    if (sym === "$" && hasIsoCode) continue;
    const code = SYMBOL_TO_CURRENCY[sym];
    if (!code) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    if (overlaps(start, end)) continue;
    rawMatches.push({
      raw: m[0],
      currency: code,
      amountStr: m[2],
      start,
      end,
      unknownCode: false,
      fromSymbol: true,
    });
  }

  // Pass 5: Unknown 3-letter currency code (only if nothing else matched outside balance clauses)
  const hasKnownNonBalance = rawMatches.some((rm) => {
    const cls = classifyMoneyContext(
      normText,
      rm.start,
      rm.end,
      isInsideParens(normText, rm.start, rm.end),
    );
    return cls.label === "amount";
  });
  if (!hasKnownNonBalance) {
    const unkBeforeRe =
      /(?<![A-Za-z])([A-Z]{3})\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)(?![A-Za-z0-9_])/g;
    while ((m = unkBeforeRe.exec(normText)) !== null) {
      const code = m[1].toUpperCase();
      if (isSupportedCurrency(code) || NON_CURRENCY_3LETTER.has(code)) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      if (overlaps(start, end)) continue;
      rawMatches.push({
        raw: m[0],
        currency: code,
        amountStr: m[2],
        start,
        end,
        unknownCode: true,
        fromSymbol: false,
      });
    }
    const unkAfterRe =
      /(?<![A-Za-z0-9_.])(\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)\s*([A-Z]{3})(?![A-Za-z])/g;
    while ((m = unkAfterRe.exec(normText)) !== null) {
      const code = m[2].toUpperCase();
      if (isSupportedCurrency(code) || NON_CURRENCY_3LETTER.has(code)) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      if (overlaps(start, end)) continue;
      rawMatches.push({
        raw: m[0],
        currency: code,
        amountStr: m[1],
        start,
        end,
        unknownCode: true,
        fromSymbol: false,
      });
    }
  }

  rawMatches.sort((a, b) => a.start - b.start);

  const out: MoneyCandidate[] = [];
  for (const rm of rawMatches) {
    const minor = smsAmountToMinor(rm.amountStr, rm.currency);
    if (minor === null || minor <= 0) continue;
    const inParens = isInsideParens(normText, rm.start, rm.end);
    const { label, balanceLabel } = classifyMoneyContext(
      normText,
      rm.start,
      rm.end,
      inParens,
    );
    out.push({
      raw: rm.raw,
      currency: rm.currency,
      amountStr: rm.amountStr,
      amountMinor: minor,
      start: rm.start,
      end: rm.end,
      label,
      balanceLabel,
      unknownCode: rm.unknownCode,
      inParens,
      fromSymbol: rm.fromSymbol,
    });
  }
  return out;
}

/** Strip balance and credit-limit clauses using the validator's canonical regex. */
function stripBalanceClausesForClassification(normText: string): string {
  const re = new RegExp(BALANCE_OR_LIMIT_CLAUSE_RE.source, "gi");
  const spans: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(normText)) !== null) {
    const start = m.index;
    const rest = normText.slice(start);
    const boundary = /(?:\.(?:\s|$)|[;\n|])/.exec(rest.slice(m[0].length));
    const len = boundary
      ? m[0].length + boundary.index + 1
      : Math.min(rest.length, 90);
    spans.push({ start, end: start + len });
  }
  if (spans.length === 0) return normText;
  let out = "";
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start > cursor) out += normText.slice(cursor, sp.start) + " ";
    cursor = Math.max(cursor, sp.end);
  }
  if (cursor < normText.length) out += normText.slice(cursor);
  return out.replace(/\s+/g, " ").trim();
}

interface DirectionClassification {
  direction: "debit" | "credit" | null;
  txnType: SmsTxnType;
  confidence: number;
  warnings: string[];
}

/** Classify direction and txn_type from English + Arabic lexicons. */
export function classifyDirectionAndType(
  normText: string,
  amountPos: number,
): DirectionClassification {
  const nonBal = stripBalanceClausesForClassification(normText);
  // Mask out "credit card" and "debit card" so those noun phrases never act as direction verbs.
  const masked = nonBal
    .replace(/\b(?:credit|debit)\s+card\b/gi, "CARD")
    .replace(/\b(?:cr\.?\s*card|cr\.?\s*limit)\b/gi, "CARD");

  const warnings: string[] = [];

  // Specific high-priority transaction types first
  const isRefund =
    /(?:\b(?:refund|refunded|reversal|reversed|cashback|chargeback|credited\s+back)\b|(?:استرداد|مرتجع|عكس\s+عملية))/i.test(
      nonBal,
    );
  const isSalary =
    /(?:\b(?:salary|payroll|wages)\b|(?:تحويل\s+راتب|راتب))/i.test(nonBal);
  const isAtm =
    /(?:\b(?:cash\s+withdrawal|atm\s+withdrawal|atm\s+cash|withdrawn|withdrawal\s+at\s+atm|cash\s+advance)\b|(?:سحب\s*(?:نقدي|صراف|آلي)?))/i.test(
      nonBal,
    );
  const isLoan =
    /(?:\b(?:loan\s+(?:repayment|installment|emi)|installment\s+payment\s+plan|auto\s+finance|personal\s+finance|finance\s+(?:installment|payment|repayment)|murabaha|ijara|mortgage\s+(?:payment|installment)|\bemi\b)\b|(?:قسط\s+(?:تمويل|قرض)))/i.test(
      nonBal,
    );
  const isCardPayment =
    /(?:\b(?:credit\s+card\s+payment|card\s+payment|payment\s+towards\s+(?:your\s+)?(?:[\w]+\s+)?credit\s+card|payment\s+of\s+.*(?:received|processed)\s+(?:against|towards|on)\s+(?:your\s+)?(?:[\w]+\s+)?credit\s+card|auto[- ]?pay\s+.*card)\b)/i.test(
      nonBal,
    );
  const isFee =
    /(?:\b(?:annual\s+fee|service\s+fee|late\s+fee|maintenance\s+fees?|sms\s+fee|finance\s+charge|foreign\s+currency\s+fee|bank\s+fee|account\s+charges?|charges?\s+and\s+vat|fee\s+and\s+vat|vat\s+charge)\b|(?:رسوم|عمولة))/i.test(
      nonBal,
    );
  const isBill =
    /(?:\b(?:bill\s+payment|utility\s+bill|telecom\s+bill|dewa|etisalat|sewa|addc|salik|nol\s+top[- ]?up|empower|du\s+bill|paid\s+for\s+.*bill)\b|(?:سداد\s+فاتورة|دفع\s+فاتورة))/i.test(
      nonBal,
    );
  const isTransferOut =
    /(?:\b(?:transferred\s+(?:from\s+.*?\s+)?to|transfer\s+(?:request\s+of\s+.*?\s+)?to|local\s+transfer\s+to|funds?\s+transfer\s+(?:request\s+of\s+.*?\s+)?to|sent\s+to|remitted\s+to|remittance\s+to|wire\s+transfer\s+to|quick\s*remit)\b|(?:تحويل\s+(?:إلى|الى|صادر)))/i.test(
      nonBal,
    );
  const isTransferIn =
    /(?:\b(?:inward\s+remittance|incoming\s+transfer|transfer\s+from|received\s+from)\b|(?:تحويل\s+وارد))/i.test(
      nonBal,
    );
  const isPurchase =
    /(?:\b(?:purchase|purchased|spent|used\s+for|pos\s+txn|pos\s+purchase|charged\s+at|card\s+transaction|payment\s+at)\b|(?:تم\s+)?(?:شراء|عملية\s+شراء))/i.test(
      nonBal,
    );

  // General debit and credit verb matches on masked text (so "Credit Card" / "Debit Card" don't fire)
  const debitVerbRe =
    /(?:\b(?:debited|deducted|spent|used\s+for|purchase|purchased|charged|withdrawn|withdrawal|paid|transferred|remitted|sent\s+to|auto[- ]?debit|debit\s+alert)\b|(?:خصم|شراء|سحب|دفع|سداد|تحويل\s+(?:إلى|الى|صادر)))/gi;
  const creditVerbRe =
    /(?:\b(?:credited|deposited|deposit\s+of|received|refund|refunded|reversed|reversal|salary|cashback|inward\s+remittance|incoming\s+transfer|credit\s+alert)\b|(?:إيداع|ايداع|استرداد|راتب|تحويل\s+وارد|استلام|قيد\s+دائن))/gi;

  const debitMatches: number[] = [];
  const creditMatches: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = debitVerbRe.exec(masked)) !== null) debitMatches.push(m.index);
  while ((m = creditVerbRe.exec(masked)) !== null) creditMatches.push(m.index);

  // Special disambiguations before generic conflict resolution:
  // 1. Refund ("Purchase amount of AED 120.00 ... has been refunded") is ALWAYS credit + refund.
  if (isRefund) {
    return { direction: "credit", txnType: "refund", confidence: 0.95, warnings };
  }
  // 2. Salary ("Salary of AED ... has been credited") is ALWAYS credit + salary.
  if (isSalary && !/\bdebited\b/i.test(masked)) {
    return { direction: "credit", txnType: "salary", confidence: 0.95, warnings };
  }
  // 3. Card repayment: if debited from A/C -> debit; if payment received against Credit Card -> credit.
  if (isCardPayment) {
    const isDebited = /\b(?:debited|deducted)\b/i.test(masked);
    const isReceivedOnCard = /\b(?:received|credited)\b/i.test(masked) && !isDebited;
    return {
      direction: isReceivedOnCard ? "credit" : "debit",
      txnType: "card_repayment",
      confidence: 0.92,
      warnings,
    };
  }
  // 4. Loan / finance installment
  if (isLoan) {
    return { direction: "debit", txnType: "loan_repayment", confidence: 0.92, warnings };
  }
  // 5. ATM / cash withdrawal
  if (isAtm) {
    return { direction: "debit", txnType: "cash_withdrawal", confidence: 0.95, warnings };
  }
  // 6. Fee / bank charge
  if (isFee && !/\bcredited\b/i.test(masked)) {
    return { direction: "debit", txnType: "fee", confidence: 0.92, warnings };
  }
  // 7. Utility / bill payment
  if (isBill && !/\bcredited\b/i.test(masked)) {
    return { direction: "debit", txnType: "bill_payment", confidence: 0.92, warnings };
  }

  // Resolve direction from debit vs credit verb sets
  let direction: "debit" | "credit" | null = null;
  let confidence = 0.95;

  if (debitMatches.length > 0 && creditMatches.length === 0) {
    direction = "debit";
  } else if (creditMatches.length > 0 && debitMatches.length === 0) {
    direction = "credit";
  } else if (debitMatches.length > 0 && creditMatches.length > 0) {
    // Both matched: prefer whichever verb sits closest to the transaction amount
    const nearestDebit = Math.min(...debitMatches.map((pos) => Math.abs(pos - amountPos)));
    const nearestCredit = Math.min(...creditMatches.map((pos) => Math.abs(pos - amountPos)));
    direction = nearestDebit <= nearestCredit ? "debit" : "credit";
    confidence = 0.6;
    warnings.push("conflicting_direction_signals");
  } else if (isTransferOut) {
    direction = "debit";
    confidence = 0.85;
  } else if (isTransferIn) {
    direction = "credit";
    confidence = 0.85;
  } else if (/\bpayment\s+(?:of|for)\b/i.test(masked)) {
    direction = "debit";
    confidence = 0.8;
  }

  if (!direction) {
    return { direction: null, txnType: "other", confidence: 0, warnings };
  }

  let txnType: SmsTxnType = "other";
  if (direction === "credit") {
    if (isSalary) txnType = "salary";
    else if (isRefund) txnType = "refund";
    else if (isTransferIn || /\b(?:credited|deposited|received)\b/i.test(masked)) {
      txnType = "transfer_in";
    }
  } else {
    if (isAtm) txnType = "cash_withdrawal";
    else if (isFee) txnType = "fee";
    else if (isBill) txnType = "bill_payment";
    else if (isTransferOut) txnType = "transfer_out";
    else if (isPurchase) txnType = "purchase";
    else if (/\b(?:transfer|remittance)\b/i.test(nonBal)) txnType = "transfer_out";
    else if (/\bcard\b/i.test(nonBal)) txnType = "purchase";
    else txnType = "other";
  }

  return { direction, txnType, confidence, warnings };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function formatIsoDate(y: number, m: number, d: number): string | null {
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return parseStrictIsoDateUtc(iso) !== null ? iso : null;
}

/** Extract the best transaction date and optional 24h HH:mm time from SMS text. */
export function extractUniversalDateAndTime(
  normText: string,
  amountPos: number,
): { date: string | null; time: string | null } {
  const candidates: Array<{ iso: string; pos: number; afterOn: boolean }> = [];

  const pushCandidate = (iso: string | null, pos: number) => {
    if (!iso) return;
    const prev = normText.slice(Math.max(0, pos - 12), pos);
    const afterOn = /\b(?:on|dated|date:?)\s*$/i.test(prev);
    candidates.push({ iso, pos, afterOn });
  };

  let m: RegExpExecArray | null;

  // YYYY-MM-DD or YYYY/MM/DD
  const isoRe = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g;
  while ((m = isoRe.exec(normText)) !== null) {
    pushCandidate(formatIsoDate(Number(m[1]), Number(m[2]), Number(m[3])), m.index);
  }

  // DD-MMM-YYYY / DD MMM YYYY / DD-MMM-YY / DD MMM YY
  const dmyWordRe = /\b(\d{1,2})[-\s]+([A-Za-z]{3})[a-z]*[-\s,]+(\d{2,4})\b/g;
  while ((m = dmyWordRe.exec(normText)) !== null) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) continue;
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    pushCandidate(formatIsoDate(y, mon, Number(m[1])), m.index);
  }

  // MMM DD, YYYY
  const mdyWordRe = /\b([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(20\d{2})\b/g;
  while ((m = mdyWordRe.exec(normText)) !== null) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (!mon) continue;
    pushCandidate(formatIsoDate(Number(m[3]), mon, Number(m[2])), m.index);
  }

  // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, DD/MM/YY (day-first UAE convention)
  const dmyNumRe = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g;
  while ((m = dmyNumRe.exec(normText)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    if (y < 2000 || y > 2100) continue;
    let day = a;
    let month = b;
    if (month > 12 && day <= 12) {
      day = b;
      month = a;
    }
    pushCandidate(formatIsoDate(y, month, day), m.index);
  }

  let bestDate: string | null = null;
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (a.afterOn !== b.afterOn) return a.afterOn ? -1 : 1;
      return Math.abs(a.pos - amountPos) - Math.abs(b.pos - amountPos);
    });
    bestDate = candidates[0].iso;
  }

  // Extract 24h or 12h AM/PM time
  let bestTime: string | null = null;
  const timeRe = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?:\s*(AM|PM))?\b/i;
  const tm = timeRe.exec(normText);
  if (tm) {
    let hh = Number(tm[1]);
    const mm = tm[2];
    const ampm = tm[3]?.toUpperCase();
    if (ampm === "PM" && hh < 12) hh += 12;
    if (ampm === "AM" && hh === 12) hh = 0;
    bestTime = `${String(hh).padStart(2, "0")}:${mm}`;
  }

  return { date: bestDate, time: bestTime };
}

/** Extract instrument info including English and Arabic card/account wording. */
function extractUniversalInstrument(normText: string): InstrumentInfo {
  const last4 =
    extractCardLast4(normText, null) ??
    /(?:تنتهي\s+بـ?\s*|بطاقة\s+رقم\s*)[X*\u2022•-]*(\d{4})\b/.exec(normText)?.[1] ??
    null;

  if (/(?:\b(?:credit\s*card|cr\.?\s*card|cr\.?\s*limit)\b|بطاقة\s+(?:ال)?ائتمان)/i.test(normText)) {
    return { kind: "credit_card", last4 };
  }
  if (/(?:\bdebit\s*card\b|بطاقة\s+(?:ال)?خصم|بطاقة\s+صراف)/i.test(normText)) {
    return { kind: "debit_card", last4 };
  }
  if (last4) {
    return { kind: "debit_card", last4 };
  }
  if (/(?:\b(?:a\/c|acct|account)\b|حساب)/i.test(normText)) {
    return { kind: "account", last4: null };
  }
  return { kind: null, last4: null };
}

const PARENTHETICAL_BILLED_RE =
  /\s*\(\s*(?:(?:billed|approx\.?|equiv\.?|~|≈)\s*)?(?:[A-Z]{3}\s*\d[\d,]*(?:\.\d{1,3})?|\d[\d,]*(?:\.\d{1,3})?\s*[A-Z]{3})(?:\s*billed)?\s*\)/gi;

const ARABIC_CP_RE =
  /(?:لدى|في|عند|من|إلى|الى)\s+([^\n.,;|]{2,60}?)(?=\s+(?:بتاريخ|في\s+\d|بمبلغ|الرصيد|رصيد|على\s+بطاقة|من\s+حساب)|[.,;|]|$)/u;

const KNOWN_BILLER_RE =
  /\b(DEWA|SEWA|ADDC|Etisalat|Salik|Empower|FEWA|Taqa)\b/i;

const POST_AMOUNT_NON_MERCHANT_RE =
  /^(?:has\b|was\b|is\b|were\b|on\b|at\b|from\b|to\b|for\b|by\b|via\b|with\b|towards\b|against\b|using\b|your\b|card\b|a\/c\b|account\b|debited\b|credited\b|spent\b|paid\b|received\b|refunded\b|reversed\b|withdrawn\b|transferred\b|processed\b|recorded\b|completed\b|successful)/i;

function buildCounterparty(raw: string, bankId: string | null): CounterpartyInfo {
  const [merchant, city, country] = splitMerchant(raw, bankId ?? "");
  const name = (merchant ?? raw).trim() || null;
  const clean = name ? cleanName(name) || name : null;
  return { raw, name, clean, city, country };
}

/** Extract counterparty from structured labels, English/Arabic prepositions, billers, or post-amount spans. */
export function extractUniversalCounterparty(
  normText: string,
  bankId: string | null,
  amountEnd?: number,
): CounterpartyInfo {
  const cleanBody = stripBalanceClausesForClassification(
    normText.replace(PARENTHETICAL_BILLED_RE, " "),
  );

  // 1. Explicit structured label ("Merchant: ...", "Beneficiary: ...", "Payee: ...", "Ref: ...")
  const labeled =
    /\b(?:merchant|beneficiary|payee|vendor|biller|ref)\s*[:|-]\s*([^|.;\n]{2,60}?)(?=\s*(?:\||\.|\bon\s+\d|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\b(?:AED|USD|EUR|GBP|SAR)\b|$))/i.exec(
      cleanBody,
    );
  if (labeled) {
    const raw = labeled[1].trim();
    if (raw && !/^\d[\d\s-]*$/.test(raw)) {
      const cp = buildCounterparty(raw, bankId);
      if (cp.clean) return cp;
    }
  }

  // 2. Shared preposition extractor (handles at/@/towards/to/from/by/for cleanly)
  const eng = extractCounterpartyFromText(cleanBody, bankId);
  if (eng.clean) return eng;

  // 3. Arabic preposition extractor (لدى / في / عند / من / إلى)
  const ar = ARABIC_CP_RE.exec(cleanBody);
  if (ar) {
    const raw = ar[1].trim();
    if (raw && !/^(?:حسابك|حساب|بطاقتك|بطاقة|البطاقة)/.test(raw)) {
      const cp = buildCounterparty(raw, bankId);
      if (cp.clean) return cp;
    }
  }

  // 4. Known utility/telecom biller name appearing without a preposition (e.g. "... DEWA NO. 9988...")
  const biller = KNOWN_BILLER_RE.exec(cleanBody);
  if (biller) {
    const raw = biller[1].trim();
    const clean = cleanName(raw) || raw;
    return { raw, name: raw, clean, city: null, country: null };
  }

  // 5. Post-amount unprefixed merchant span (e.g. "Card No XXX2468 AED 135.00 SAMPLE SUPERMARKET DUBAI AE 03/11/26")
  if (typeof amountEnd === "number" && amountEnd > 0 && amountEnd < normText.length) {
    const afterAmt = stripBalanceClausesForClassification(
      normText.slice(amountEnd).replace(PARENTHETICAL_BILLED_RE, " "),
    ).replace(/^[\s,:-]+/, "");
    if (afterAmt && !POST_AMOUNT_NON_MERCHANT_RE.test(afterAmt)) {
      const span =
        /^([A-Za-z][A-Za-z0-9&'.,/ -]{1,55}?)(?=\s+(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\bon\b|\bavl\b|\bavailable\b|\bbal\b)|[.;|]|$)/i.exec(
          afterAmt,
        );
      if (span) {
        const raw = span[1].trim();
        if (raw.length >= 2 && !POST_AMOUNT_NON_MERCHANT_RE.test(raw)) {
          const cp = buildCounterparty(raw, bankId);
          if (cp.clean) return cp;
        }
      }
    }
  }

  return { raw: null, name: null, clean: null, city: null, country: null };
}

/**
 * Layer 3 universal bank-agnostic field extractor.
 * Returns a validated `ParsedSmsV1` object, or `null` if the SMS does not carry
 * a recognisable transaction or non-transaction kind.
 */
export function parseSmsUniversal(
  rawText: string,
  ctx: ParseContext,
  bank: BankInfo,
  receivedDate: string,
): ParsedSmsV1 | null {
  const norm = normalizeUniversalText(rawText);
  if (!norm) return null;

  const accCurr = String(ctx.account_currency || "AED").trim().toUpperCase();

  // 1. Non-transaction fast checks (English + Arabic OTP, declined, promo)
  if (COMMON_OTP_RE.test(norm) || ARABIC_OTP_RE.test(norm)) {
    return buildNonTxUniversal("otp", rawText, norm, ctx, bank, receivedDate, 0.95);
  }
  if (COMMON_DECLINED_RE.test(norm) || ARABIC_DECLINED_RE.test(norm)) {
    return buildNonTxUniversal("declined", rawText, norm, ctx, bank, receivedDate, 0.95);
  }
  if (isPromoSms(norm)) {
    return buildNonTxUniversal("promo", rawText, norm, ctx, bank, receivedDate, 0.9);
  }

  // 2. Extract money candidates and separate transaction amount, billed_amount, and balance_after
  const candidates = extractMoneyCandidates(norm);
  const amountCandidates = candidates.filter((c) => c.label === "amount");
  const billedCandidates = candidates.filter((c) => c.label === "billed");
  const balanceCandidates = candidates.filter(
    (c) => c.label === "balance" || c.label === "limit",
  );

  // Choose primary transaction amount: prefer first unlabelled candidate appearing after a transaction verb
  let chosenAmount: MoneyCandidate | null = null;
  if (amountCandidates.length === 1) {
    chosenAmount = amountCandidates[0];
  } else if (amountCandidates.length > 1) {
    const afterVerb = amountCandidates.find((c) =>
      TX_VERB_BEFORE_RE.test(norm.slice(0, c.start)),
    );
    chosenAmount = afterVerb ?? amountCandidates[0];
  }

  if (!chosenAmount) {
    if (isBalanceOnlyNotice(norm) || (balanceCandidates.length > 0 && amountCandidates.length === 0)) {
      const balCand = balanceCandidates[0] ?? null;
      return buildNonTxUniversal(
        "balance_notice",
        rawText,
        norm,
        ctx,
        bank,
        receivedDate,
        0.85,
        balCand
          ? {
              minor: balCand.amountMinor,
              currency: balCand.currency,
              exponent: moneyExponent(balCand.currency),
              label: balCand.balanceLabel ?? "balance",
            }
          : null,
      );
    }
    return null;
  }

  // 3. Classify direction and txn_type
  const cls = classifyDirectionAndType(norm, chosenAmount.start);
  if (!cls.direction) {
    return null;
  }

  // 4. Pick billed_amount (different currency from chosenAmount)
  let billedMoney: Money | null = null;
  const billedCand =
    billedCandidates.find((c) => c.currency !== chosenAmount!.currency) ??
    amountCandidates.find(
      (c) => c !== chosenAmount && c.currency !== chosenAmount!.currency && c.inParens,
    ) ??
    null;
  if (billedCand && billedCand.amountMinor > 0) {
    billedMoney = makeMoney(billedCand.amountMinor, billedCand.currency);
  }

  // 5. Pick balance_after (prefer balance over limit if both present)
  const balCand =
    balanceCandidates.find((c) => c.label === "balance") ??
    balanceCandidates[0] ??
    null;
  const balanceAfter: BalanceMoney | null = balCand
    ? {
        minor: balCand.amountMinor,
        currency: balCand.currency || accCurr,
        exponent: moneyExponent(balCand.currency || accCurr),
        label: balCand.balanceLabel ?? "balance",
      }
    : null;

  // 6. Date & time
  const { date: dateInSms, time: timeInSms } = extractUniversalDateAndTime(
    norm,
    chosenAmount.start,
  );

  // 7. Instrument & counterparty
  const instrument = extractUniversalInstrument(norm);
  const counterparty = extractUniversalCounterparty(norm, bank.id, chosenAmount.end);

  // 8. Per-field confidence scores & warnings
  const warnings = [...cls.warnings];
  if (chosenAmount.unknownCode) warnings.push("unknown_currency_code");

  const amountConf = chosenAmount.unknownCode
    ? 0.75
    : amountCandidates.length === 1
      ? 0.95
      : 0.85;
  const dateConf = dateInSms ? 1.0 : 0.8;
  const noCounterpartyExpected =
    cls.txnType === "cash_withdrawal" ||
    cls.txnType === "fee" ||
    cls.txnType === "card_repayment" ||
    cls.txnType === "loan_repayment" ||
    cls.txnType === "salary";
  const counterpartyConf = counterparty.clean
    ? 0.9
    : noCounterpartyExpected
      ? 0.75
      : 0.65;

  const candidate: ParsedSmsV1 = {
    schema: "fuloos.sms/1",
    kind: "transaction",
    direction: cls.direction,
    txn_type: cls.txnType,
    amount: makeMoney(chosenAmount.amountMinor, chosenAmount.currency),
    billed_amount: billedMoney,
    balance_after: balanceAfter,
    date: dateInSms ?? receivedDate,
    time: timeInSms,
    date_source: dateInSms ? "text" : "received",
    counterparty,
    instrument,
    bank,
    sms: {
      sender: ctx.sender,
      received_at: ctx.received_at,
      hash: ctx.sms_hash ?? "",
    },
    parsed_by: "universal@1",
    confidence: {
      overall: 0,
      amount: amountConf,
      direction: cls.confidence,
      date: dateConf,
      counterparty: counterpartyConf,
    },
    warnings,
  };

  const checked = validateParsedSmsV1(rawText, candidate);
  return checked.valid ? checked.parsed : null;
}

function buildNonTxUniversal(
  kind: ParsedSmsV1["kind"],
  rawText: string,
  norm: string,
  ctx: ParseContext,
  bank: BankInfo,
  receivedDate: string,
  overallConf: number,
  balanceAfter: BalanceMoney | null = null,
): ParsedSmsV1 {
  const { date, time } = extractUniversalDateAndTime(norm, 0);
  const candidate: ParsedSmsV1 = {
    schema: "fuloos.sms/1",
    kind,
    direction: null,
    txn_type: null,
    amount: null,
    billed_amount: null,
    balance_after: balanceAfter,
    date: date ?? receivedDate,
    time,
    date_source: date ? "text" : "received",
    counterparty: { raw: null, name: null, clean: null, city: null, country: null },
    instrument: extractUniversalInstrument(norm),
    bank,
    sms: {
      sender: ctx.sender,
      received_at: ctx.received_at,
      hash: ctx.sms_hash ?? "",
    },
    parsed_by: "universal@1",
    confidence: {
      overall: overallConf,
      amount: 0,
      direction: 0,
      date: date ? 1 : 0.8,
      counterparty: 0,
    },
    warnings: [],
  };
  const checked = validateParsedSmsV1(rawText, candidate);
  return checked.valid ? checked.parsed : candidate;
}
