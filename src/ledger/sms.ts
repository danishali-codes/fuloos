/* Bank SMS parser and merchant cleaner.
   Pure functions: SMS text is parsed on-device and never sent anywhere.
   Parsing preserves the exact currency and minor-unit amount printed in the SMS
   and never performs exchange-rate conversion. */
import {
  getCurrencyDecimals,
  isSupportedCurrency,
  isThreeLetterCurrencyCode,
  parseCurrencyMinor,
  roundHalfAwayFromZero,
} from "../currency.ts";
import { uaeToday } from "../domain.ts";
import { LEDGER_RULES as T } from "./rules.generated.ts";

export type SmsType =
  | "purchase"
  | "bill_payment"
  | "cash_withdrawal"
  | "bank_fee"
  | "transfer_out"
  | "card_repayment"
  | "loan_repayment"
  | "internal_out"
  | "other_debit"
  | "refund"
  | "transfer_in"
  | "income"
  | "internal_in"
  | "card_payment_received"
  | "otp"
  | "declined"
  | "notice";

export interface ParsedSms {
  bank: string | null;
  txn_type: SmsType;
  direction: "debit" | "credit" | "none";
  /** Major-unit numeric amount in `currency` (NaN when not a transaction). */
  amount: number;
  /** Exact integer minor units in `currency` (null when not a transaction). */
  amount_minor: number | null;
  /** Uppercase 3-letter currency code as printed in the SMS. */
  currency: string | null;
  /** Optional billed amount in account currency when the SMS prints both. */
  billed_amount: number | null;
  billed_amount_minor: number | null;
  billed_currency: string | null;
  card_last4: string | null;
  merchant_raw: string | null;
  merchant: string | null;
  merchant_clean: string | null;
  location: string | null;
  country: string | null;
  balance_after: number;
  is_bnpl: boolean;
  is_foreign: boolean;
  date_in_text: string | null;
  warnings: string[];
}

const rx = (src: string, flags = "") => new RegExp(src, flags);
type Rule = [SmsType, RegExp];
const COMMON: Rule[] = T.COMMON_RULES.map(([t, s, f]) => [
  t as SmsType,
  rx(s, f),
]);
const BANKS: Record<string, Rule[]> = Object.fromEntries(
  Object.entries(T.BANK_RULES).map(([b, list]) => [
    b,
    (list as readonly (readonly string[])[]).map(
      ([t, s, f]): Rule => [t as SmsType, rx(s, f)],
    ),
  ]),
);
const BALANCE = rx(T.BALANCE_RX[0], T.BALANCE_RX[1]);
export const BANK_NAMES = Object.keys(BANKS);

/** Non-currency 3-letter abbreviations commonly seen next to numbers in bank SMS. */
const NON_CURRENCY_WORDS = new Set([
  "ACC",
  "AND",
  "APP",
  "ARE",
  "ATM",
  "AUH",
  "AVL",
  "BAL",
  "CAR",
  "COM",
  "CRD",
  "CVV",
  "DAY",
  "DXB",
  "END",
  "EST",
  "EXP",
  "EXT",
  "FOR",
  "GMT",
  "HAS",
  "HRS",
  "INC",
  "ITS",
  "LLC",
  "LTD",
  "MAX",
  "MIN",
  "NET",
  "NEW",
  "NOT",
  "NOW",
  "NUM",
  "OTP",
  "PAY",
  "PER",
  "PIN",
  "POS",
  "PVT",
  "REF",
  "SEC",
  "SHJ",
  "SMS",
  "TAX",
  "THE",
  "TRD",
  "TRX",
  "TXN",
  "UAE",
  "USA",
  "UTC",
  "VAT",
  "VIA",
  "WAS",
  "WEB",
  "YOU",
]);

/**
 * Normalizes Arabic-Indic (`٠-٩`) and Extended Arabic-Indic (`۰-۹`) digits
 * and Arabic decimal/thousands punctuation into ASCII equivalents.
 */
export function normalizeSmsDigits(input: string): string {
  return String(input ?? "")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066B/g, ".")
    .replace(/\u066C/g, ",");
}

/**
 * Matches balance or credit-limit clauses whose numbers must NEVER be mistaken
 * for transaction amounts.
 */
const BALANCE_LIMIT_CLAUSE_RE =
  /(?:(?:Avl\.?|Avail\.?|Available|Remaining|Curr(?:ent)?\.?|Account|Card)\s+(?:(?:Cr(?:edit)?\.?\s*)?(?:Bal(?:ance)?|Limit))|Credit\s+Limit|Avl\.?\s*Cr\.?\s*Limit|\bBal(?:ance)?\s*(?:is|:|after|remaining|now))\s*(?:is|:)?\s*(?:[A-Z]{3}\s*)?-?[\d,]+(?:\.\d+)?(?:\s*[A-Z]{3})?/gi;

const BALANCE_LIMIT_START_RE =
  /\b(?:Avl\.?\s*(?:Cr\.?\s*)?(?:Bal(?:ance)?|Limit)|Avail(?:able)?\.?\s*(?:Cr(?:edit)?\.?\s*)?(?:Bal(?:ance)?|Limit)|Credit\s+Limit|Remaining\s+(?:Cr(?:edit)?\.?\s*)?(?:Bal(?:ance)?|Limit)|(?:Account|Card|Curr(?:ent)?\.?)\s+Bal(?:ance)?|Bal(?:ance)?\s*(?:is|:|after|remaining|now))\b/i;

/** Removes balance and credit-limit clauses from SMS text before extracting amounts. */
export function stripBalanceAndLimitClauses(text: string): string {
  return text.replace(BALANCE_LIMIT_CLAUSE_RE, " ");
}

/** Extracts an available balance or credit limit figure if present. */
export function extractBalanceAfter(text: string): number {
  const b = BALANCE.exec(text);
  if (b) {
    const val = num(b.groups?.balance);
    if (Number.isFinite(val)) return val;
  }
  const fallback =
    /(?:Avl\.?\s*(?:Cr\.?\s*)?(?:Bal(?:ance)?|Limit)|Available\s+(?:Cr(?:edit)?\.?\s*)?(?:Bal(?:ance)?|Limit)|Credit\s+Limit|\bBalance)\s*(?:is|:)?\s*(?:[A-Z]{3}\s*)?(-?[\d,]+(?:\.\d+)?)/i.exec(
      text,
    );
  return fallback ? num(fallback[1]) : NaN;
}

function num(s: string | undefined | null): number {
  if (s == null) return NaN;
  const cleaned = normalizeSmsDigits(String(s))
    .replace(/,/g, "")
    .trim()
    .replace(/\.+$/, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return NaN;
  return parseFloat(cleaned);
}

/**
 * Converts a parsed SMS amount string (or numeric value) into exact integer minor units
 * for `currency`. Unknown 3-letter codes assume exponent 2 without throwing.
 */
export function smsAmountToMinor(
  rawAmount: string | number | null | undefined,
  currency: string | null | undefined,
): number | null {
  if (rawAmount === null || rawAmount === undefined) return null;
  const code = (currency ?? "").trim().toUpperCase();
  if (!isThreeLetterCurrencyCode(code)) return null;
  const decimals = getCurrencyDecimals(code);

  if (typeof rawAmount === "string") {
    const cleaned = normalizeSmsDigits(rawAmount)
      .replace(/,/g, "")
      .trim()
      .replace(/\.+$/, "");
    if (!cleaned) return null;
    try {
      return parseCurrencyMinor(cleaned, code, { allowUnknownCode: true });
    } catch {
      const parsed = parseFloat(cleaned);
      if (!Number.isFinite(parsed) || parsed < 0) return null;
      return roundHalfAwayFromZero(parsed * 10 ** decimals);
    }
  }

  if (!Number.isFinite(rawAmount) || rawAmount < 0) return null;
  return roundHalfAwayFromZero(rawAmount * 10 ** decimals);
}

export interface ExtractedAmount {
  currency: string;
  amount: number;
  amountRaw: string;
  amountMinor: number;
  index: number;
  endIndex: number;
  unknownCode: boolean;
}

const AMOUNT_NUM_SRC = "\\d[\\d,]*(?:\\.\\d{1,3})?";

/**
 * Extracts a `(currency, amount)` pair from text that has already had balance/limit
 * clauses removed. Supports:
 * - Code before number: `GBP 12.00`, `GBP12`, `JPY 1,500`, `KWD 2.500`
 * - Number before code: `12.00 GBP`, `1,500 JPY`, `2.500 KWD`
 * - Symbols: `€`, `£`, `₹`, `﷼`, and `$` (only as USD when no other ISO code is present)
 */
export function extractCurrencyAmount(
  text: string,
  options?: { excludeRange?: [number, number] },
): ExtractedAmount | null {
  const normalized = normalizeSmsDigits(text);
  const nonBalance = stripBalanceAndLimitClauses(normalized);
  const overlapsExcluded = (start: number, end: number) => {
    if (!options?.excludeRange) return false;
    const [es, ee] = options.excludeRange;
    return start < ee && end > es;
  };

  // Detect any explicit 3-letter ISO currency codes in the non-balance text
  // so `$` is only mapped to USD when no other code (e.g. CAD, AUD, SGD) is present.
  const presentIsoCodes = new Set<string>();
  for (const m of nonBalance.matchAll(/\b([A-Z]{3})\b/g)) {
    const code = m[1];
    if (isSupportedCurrency(code)) presentIsoCodes.add(code);
  }

  const candidates: Array<ExtractedAmount & { priority: number }> = [];

  const pushCandidate = (
    code: string,
    amountRaw: string,
    index: number,
    endIndex: number,
    priority: number,
  ) => {
    if (overlapsExcluded(index, endIndex)) return;
    const upper = code.toUpperCase();
    if (!isThreeLetterCurrencyCode(upper) || NON_CURRENCY_WORDS.has(upper)) {
      return;
    }
    const val = num(amountRaw);
    if (!Number.isFinite(val) || val <= 0) return;
    const minor = smsAmountToMinor(amountRaw, upper);
    if (minor === null || minor <= 0) return;
    const supported = isSupportedCurrency(upper);
    candidates.push({
      currency: upper,
      amount: val,
      amountRaw,
      amountMinor: minor,
      index,
      endIndex,
      unknownCode: !supported,
      priority: supported ? priority : priority + 10,
    });
  };

  // 1. Code before amount: `GBP 12.00`, `GBP12`, `CAD $15.00`, `KWD 2.500`, `JPY 1,500`
  const codeBeforeRe = new RegExp(
    `\\b([A-Z]{3})\\s*[$€£₹﷼]?\\s*(${AMOUNT_NUM_SRC})(?![\\d.])`,
    "g",
  );
  for (const m of nonBalance.matchAll(codeBeforeRe)) {
    const idx = m.index ?? 0;
    pushCandidate(m[1], m[2], idx, idx + m[0].length, 1);
  }

  // 2. Amount before code: `12.00 GBP`, `1,500 JPY`, `2.500 KWD`
  const codeAfterRe = new RegExp(
    `(?<![\\d.])(${AMOUNT_NUM_SRC})\\s*([A-Z]{3})\\b`,
    "g",
  );
  for (const m of nonBalance.matchAll(codeAfterRe)) {
    const idx = m.index ?? 0;
    pushCandidate(m[2], m[1], idx, idx + m[0].length, 2);
  }

  // 3. Explicit dollar-prefixed codes: US$, CA$, A$, S$, HK$, NZ$
  const prefixedDollarRe = new RegExp(
    `\\b(US|CA|AU|SG|HK|NZ)\\$\\s*(${AMOUNT_NUM_SRC})(?![\\d.])`,
    "gi",
  );
  const dollarPrefixMap: Record<string, string> = {
    US: "USD",
    CA: "CAD",
    AU: "AUD",
    SG: "SGD",
    HK: "HKD",
    NZ: "NZD",
  };
  for (const m of nonBalance.matchAll(prefixedDollarRe)) {
    const idx = m.index ?? 0;
    const mapped = dollarPrefixMap[m[1].toUpperCase()];
    if (mapped) pushCandidate(mapped, m[2], idx, idx + m[0].length, 1);
  }

  // 4. Unambiguous currency symbols (before or after amount)
  const symbolBeforeRe = new RegExp(
    `([€£₹﷼$])\\s*(${AMOUNT_NUM_SRC})(?![\\d.])`,
    "g",
  );
  const symbolAfterRe = new RegExp(
    `(?<![\\d.])(${AMOUNT_NUM_SRC})\\s*([€£₹﷼])`,
    "g",
  );
  const mapSymbol = (sym: string): string | null => {
    if (sym === "€") return "EUR";
    if (sym === "£") return "GBP";
    if (sym === "₹") return "INR";
    if (sym === "﷼") {
      // Map ﷼ carefully: if another riyal/rial code is explicitly present, defer to it
      for (const other of ["OMR", "QAR", "IRR", "YER"]) {
        if (presentIsoCodes.has(other)) return other;
      }
      return "SAR";
    }
    if (sym === "$") {
      // Map bare `$` to USD only when no other ISO code is present
      const nonUsdCodes = [...presentIsoCodes].filter((c) => c !== "USD");
      return nonUsdCodes.length === 0 ? "USD" : null;
    }
    return null;
  };
  for (const m of nonBalance.matchAll(symbolBeforeRe)) {
    const mapped = mapSymbol(m[1]);
    if (mapped) {
      const idx = m.index ?? 0;
      pushCandidate(mapped, m[2], idx, idx + m[0].length, 3);
    }
  }
  for (const m of nonBalance.matchAll(symbolAfterRe)) {
    const mapped = mapSymbol(m[2]);
    if (mapped) {
      const idx = m.index ?? 0;
      pushCandidate(mapped, m[1], idx, idx + m[0].length, 3);
    }
  }

  if (!candidates.length) return null;
  // Prefer known ISO codes over unknown codes, then earliest position in the SMS
  candidates.sort((a, b) => a.priority - b.priority || a.index - b.index);
  const best = candidates[0];
  return {
    currency: best.currency,
    amount: best.amount,
    amountRaw: best.amountRaw,
    amountMinor: best.amountMinor,
    index: best.index,
    endIndex: best.endIndex,
    unknownCode: best.unknownCode,
  };
}

/**
 * Extracts a secondary account-currency billed amount when a bank SMS prints both
 * the merchant's foreign amount and the billed amount (e.g. "GBP 12.00 (AED 56.10 billed)"
 * or "billed AED 56.10" or "equivalent to AED 56.10").
 * Never inspects balance or credit-limit clauses.
 */
export function extractBilledAmount(
  text: string,
  primaryCurrency: string | null,
): { amount: number; amountMinor: number; currency: string } | null {
  if (!primaryCurrency) return null;
  const normalized = normalizeSmsDigits(text);
  const nonBalance = stripBalanceAndLimitClauses(normalized);

  const patterns: RegExp[] = [
    // "AED 56.10 billed" / "AED 56.10 charged" / "AED 56.10 debited"
    new RegExp(
      `\\b([A-Z]{3})\\s*(${AMOUNT_NUM_SRC})\\s*(?:billed|charged|debited|settled|deducted)\\b`,
      "i",
    ),
    // "billed AED 56.10" / "billed amount: AED 56.10" / "equivalent to AED 56.10" / "charged AED 56.10"
    new RegExp(
      `\\b(?:billed(?:\\s+amount)?|equiv(?:alent)?(?:\\s+to)?|settled(?:\\s+at)?|approx\\.?|total\\s+billed)\\s*(?:is|:|=|of)?\\s*([A-Z]{3})\\s*(${AMOUNT_NUM_SRC})\\b`,
      "i",
    ),
    // Parenthesized equivalent: "(AED 56.10)" or "(56.10 AED)" or "(billed AED 56.10)"
    new RegExp(
      `\\(\\s*(?:(?:billed|approx\\.?|equiv\\.?|~|≈)\\s*)?([A-Z]{3})\\s*(${AMOUNT_NUM_SRC})(?:\\s*billed)?\\s*\\)`,
      "i",
    ),
    new RegExp(
      `\\(\\s*(?:(?:billed|approx\\.?|equiv\\.?|~|≈)\\s*)?(${AMOUNT_NUM_SRC})\\s*([A-Z]{3})(?:\\s*billed)?\\s*\\)`,
      "i",
    ),
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = patterns[i].exec(nonBalance);
    if (!m) continue;
    const isCodeSecond = i === 3;
    const code = (isCodeSecond ? m[2] : m[1]).toUpperCase();
    const rawAmt = isCodeSecond ? m[1] : m[2];
    if (code === primaryCurrency.toUpperCase()) continue;
    if (!isSupportedCurrency(code)) continue;
    const val = num(rawAmt);
    const minor = smsAmountToMinor(rawAmt, code);
    if (Number.isFinite(val) && val > 0 && minor !== null && minor > 0) {
      return { amount: val, amountMinor: minor, currency: code };
    }
  }
  return null;
}

const PARENTHETICAL_BILLED_RE =
  /\s*\(\s*(?:(?:billed|approx\.?|equiv\.?|~|≈)\s*)?(?:[A-Z]{3}\s*\d[\d,]*(?:\.\d{1,3})?|\d[\d,]*(?:\.\d{1,3})?\s*[A-Z]{3})(?:\s*billed)?\s*\)/gi;

interface RawParsedSms {
  txn_type: SmsType;
  amount: number;
  amount_raw: string | null;
  currency: string | null;
  card_last4: string | null;
  merchant_raw: string | null;
  balance_after: number;
  normalized_text: string;
}

function parseRaw(msg: string, bank: string | null): RawParsedSms {
  const text = normalizeSmsDigits(String(msg)).replace(/\n/g, " ").trim();
  const bankRules = bank ? (BANKS[bank] ?? []) : [];
  const matchAgainst = (candidate: string, ruleList: Rule[]) => {
    for (const [type, re] of ruleList) {
      const m = re.exec(candidate);
      if (!m) continue;
      const g = m.groups || {};
      let balance = num(g.balance);
      if (
        Number.isNaN(balance) &&
        !["otp", "declined", "notice"].includes(type)
      ) {
        balance = extractBalanceAfter(text);
      }
      let currency = (g.currency || "").toUpperCase() || null;
      let amountRaw = g.amount ?? null;
      let amount = num(g.amount);
      const merchant = (g.merchant_raw || "").trim();

      if (
        !["otp", "declined", "notice"].includes(type) &&
        (!currency || Number.isNaN(amount))
      ) {
        const extracted = extractCurrencyAmount(text);
        if (extracted) {
          currency = extracted.currency;
          amountRaw = extracted.amountRaw;
          amount = extracted.amount;
        }
      }

      return {
        txn_type: type,
        amount,
        amount_raw: amountRaw,
        currency,
        card_last4: g.card || null,
        merchant_raw: merchant || null,
        balance_after: balance,
        normalized_text: text,
      };
    }
    return null;
  };

  const direct = matchAgainst(text, [...COMMON, ...bankRules]);
  if (direct) return direct;

  // Retry bank templates after stripping inline parenthetical billed-amount notes
  // (e.g. "Purchase of GBP 12.00 (AED 56.10 billed) with Credit Card...")
  const strippedParen = text.replace(PARENTHETICAL_BILLED_RE, "").replace(/\s+/g, " ").trim();
  if (strippedParen !== text && bankRules.length) {
    const retry = matchAgainst(strippedParen, bankRules);
    if (retry) return retry;
  }

  return {
    txn_type: "notice" as SmsType,
    amount: NaN,
    amount_raw: null,
    currency: null,
    card_last4: null,
    merchant_raw: null,
    balance_after: NaN,
    normalized_text: text,
  };
}

const stripChars = (s: string, chars: string) => {
  let a = 0,
    b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
};

export function splitMerchant(
  raw: string | null,
  bank: string | null,
): [string | null, string | null, string | null] {
  if (typeof raw !== "string" || !raw.trim()) return [null, null, null];
  const s = raw.replace(/\s+/g, " ").trim();
  let m: RegExpExecArray | null;
  if (bank === "ADCB") {
    if ((m = /^(.*),\s*(.*?)-\s*([A-Z]{2})$/.exec(s)))
      return [m[1].trim(), m[2].trim() || null, m[3]];
    return [s, null, null];
  }
  if (bank === "Liv") {
    const k = s.lastIndexOf(", ");
    if (k >= 0) return [s.slice(0, k).trim(), s.slice(k + 2).trim(), null];
    return [s, null, null];
  }
  if (bank === "FAB") {
    m = /^(.*?)\s+([A-Z]{2})$/.exec(s);
    const [name, cc] = m ? [m[1].trim(), m[2]] : [s, null];
    const loc =
      /\s+((?:ABU ?DHABI|DUBAI|SHARJAH|AJMAN|AL AIN|RAS AL KHAIMAH|FUJAIRAH|RIYADH|JEDDAH|KARACHI|LAHORE|LONDON|CAIRO|[A-Z][a-z]+))$/i.exec(
        name,
      );
    if (loc && loc.index > 2)
      return [name.slice(0, loc.index).trim(), loc[1], cc];
    return [name, null, cc];
  }
  if (bank === "ADIB") {
    const UAE = T.UAE_CITIES;
    if ((m = /^(.*?) in (.*?), ?(UNITED ARAB EMI|UNITED STATES|.*)$/.exec(s)))
      return [
        m[1].trim(),
        m[2].trim() || null,
        m[3].includes("ARAB") ? "AE" : null,
      ];
    if ((m = /^(.*), ?(UAE|UNITED STATES|IRELAND|.*)$/.exec(s)))
      return [m[1].trim(), null, m[2] === "UAE" ? "AE" : null];
    if ((m = new RegExp(`^(.*?)\\s+${UAE}?\\s*([A-Z]{2})$`).exec(s))) {
      const loc = new RegExp(`${UAE}\\s*[A-Z]{2}$`).exec(s);
      return [m[1].trim(), loc ? loc[0].slice(0, -2).trim() : null, m[2]];
    }
    return [s, null, null];
  }
  return [s, null, null]; // Mashreq: no location
}

const BRANDS: [RegExp, string][] = T.BRANDS.map(([s, n]) => [rx(s, "i"), n]);
const FUEL = new Set<string>(T.FUEL_BRANDS);
const FOOD_AT_STATION = rx(T.FOOD_AT_STATION, "i");
const TRANSFER_MERCHANTS = rx(T.TRANSFER_MERCHANTS, "i");
const BNPL_MERCHANTS = rx(T.BNPL_MERCHANTS, "i");

/** Canonical brand name ("Talabat") or a cleaned upper-case merchant string. */
export function cleanName(name: string | null): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  for (const [re, canon] of BRANDS) {
    if (re.test(name)) {
      if (FUEL.has(canon) && FOOD_AT_STATION.test(name)) continue;
      return canon;
    }
  }
  let s = name.replace(/^(?:SP|FAT|WL|TAP|MYF|SQ|SUMUP|NOMOD)\s*\*\s*/i, "");
  s = s.replace(/\+?\d[\d -]{5,}/g, " ");
  s = s.replace(/\b\d+\b/g, " ");
  s = s.replace(/[*#/]+/g, " ");
  s = stripChars(s.replace(/\s+/g, " "), " -,.");
  return s.toUpperCase() || null;
}

const DEBIT = new Set<SmsType>([
  "purchase",
  "bill_payment",
  "cash_withdrawal",
  "bank_fee",
  "transfer_out",
  "card_repayment",
  "loan_repayment",
  "internal_out",
  "other_debit",
]);
const CREDIT = new Set<SmsType>([
  "refund",
  "transfer_in",
  "income",
  "internal_in",
  "card_payment_received",
]);

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
/** Transaction date written inside some templates (Mashreq 05-MAY-2025, ADCB 05/05/2025, FAB 05/05/25). */
export function dateInText(message: string): string | null {
  const norm = normalizeSmsDigits(message);
  const p = (n: number | string) => String(n).padStart(2, "0");
  const valid = (y: number, m: number, d: number) => {
    const iso = `${y}-${p(m)}-${p(d)}`;
    return m >= 1 &&
      m <= 12 &&
      d >= 1 &&
      new Date(iso + "T00:00:00Z").toISOString().slice(0, 10) === iso
      ? iso
      : null;
  };
  let m = /\b(\d{1,2})-([A-Z]{3})-(\d{4})\b/i.exec(norm);
  if (m) {
    const month = MONTHS.indexOf(m[2].toUpperCase()) + 1;
    if (month) return valid(+m[3], month, +m[1]);
  }
  for (const match of norm.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) {
    const iso = valid(
      match[3].length === 2 ? 2000 + +match[3] : +match[3],
      +match[2],
      +match[1],
    );
    if (iso) return iso;
  }
  return null;
}

/**
 * Parse one SMS without performing any FX conversion.
 * Preserves the exact transaction currency and integer minor units from the SMS,
 * plus any billed amount printed alongside it.
 */
export function parseSms(message: string, bank: string | null): ParsedSms {
  const p = parseRaw(message, bank);
  const [merchant, location, country] = splitMerchant(p.merchant_raw, bank);
  let merchant_clean = cleanName(merchant);
  let txn_type = p.txn_type;
  if (
    (txn_type === "purchase" || txn_type === "bill_payment") &&
    merchant_clean == null
  )
    merchant_clean = "UNKNOWN MERCHANT";
  if (txn_type === "purchase" && TRANSFER_MERCHANTS.test(p.merchant_raw || ""))
    txn_type = "transfer_out";

  const warnings: string[] = [];
  if (p.currency && !isSupportedCurrency(p.currency)) {
    warnings.push("unknown_currency_code");
  }

  const amountMinor =
    p.currency && typeof p.amount === "number" && Number.isFinite(p.amount)
      ? smsAmountToMinor(p.amount_raw ?? p.amount, p.currency)
      : null;

  const billed =
    !["otp", "declined", "notice"].includes(txn_type) && p.currency
      ? extractBilledAmount(p.normalized_text, p.currency)
      : null;

  return {
    bank,
    txn_type,
    amount: p.amount,
    amount_minor: amountMinor,
    currency: p.currency,
    billed_amount: billed?.amount ?? null,
    billed_amount_minor: billed?.amountMinor ?? null,
    billed_currency: billed?.currency ?? null,
    card_last4: p.card_last4,
    merchant_raw: p.merchant_raw,
    merchant,
    location,
    country,
    merchant_clean,
    balance_after: p.balance_after,
    direction: DEBIT.has(txn_type)
      ? "debit"
      : CREDIT.has(txn_type)
        ? "credit"
        : "none",
    is_bnpl:
      txn_type === "purchase" && BNPL_MERCHANTS.test(p.merchant_raw || ""),
    is_foreign:
      p.currency != null &&
      (p.currency !== "AED" || (country != null && country !== "AE")),
    date_in_text: dateInText(p.normalized_text),
    warnings,
  };
}

/** True when text contains a balance/limit clause (used by fallback parsers). */
export function hasBalanceOrLimitClause(text: string): boolean {
  return BALANCE_LIMIT_START_RE.test(normalizeSmsDigits(text));
}

/** The bank whose own templates match the most messages (first 400). */
export function detectBank(messages: string[]): string | null {
  let best: string | null = null,
    bestScore = 0;
  for (const b of BANK_NAMES) {
    let score = 0;
    for (const m of messages.slice(0, 400)) {
      const text = normalizeSmsDigits(String(m)).replace(/\n/g, " ").trim();
      if (BANKS[b].some(([t, re]) => t !== "notice" && re.test(text))) score++;
    }
    if (score > bestScore) [best, bestScore] = [b, score];
  }
  return best;
}
/** Best bank for a single message (its own templates first, then the batch guess). */
export function bankForMessage(
  message: string,
  fallback: string | null,
): string | null {
  const text = normalizeSmsDigits(message).replace(/\n/g, " ").trim();
  const own = (b: string | null) =>
    !!b && BANKS[b]?.some(([t, re]) => t !== "notice" && re.test(text));
  if (own(fallback)) return fallback;
  return BANK_NAMES.find((b) => own(b)) ?? fallback;
}

const SENDER_BANK: [RegExp, string][] = [
  [/adcb/i, "ADCB"],
  [/^liv\b|liv\.?$|\bliv\b/i, "Liv"],
  [/mashreq|neo/i, "Mashreq"],
  [/\bfab\b|fabbank|first ?abu/i, "FAB"],
  [/adib/i, "ADIB"],
];
export function bankFromSender(
  address: string | null | undefined,
): string | null {
  for (const [re, b] of SENDER_BANK)
    if (re.test(String(address || ""))) return b;
  return null;
}

export interface RawSms {
  message: string;
  date: string | null;
  sender: string | null;
}

/** Pasted text: messages separated by blank lines (or one message per line when there are no blank lines). */
export function splitPastedSms(text: string): RawSms[] {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (!t) return [];
  const blocks = /\n\s*\n/.test(t) ? t.split(/\n\s*\n/) : t.split("\n");
  return blocks
    .map((m) => m.trim())
    .filter(Boolean)
    .map((message) => ({ message, date: null, sender: null }));
}

/** "SMS Backup & Restore" XML: received messages only (type 2 = sent). */
export function smsFromBackupXml(
  xml: string,
  parser: DOMParser = new DOMParser(),
): RawSms[] {
  const doc = parser.parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length)
    throw new Error("This is not a valid SMS backup XML file.");
  return [...doc.getElementsByTagName("sms")]
    .filter((n) => n.getAttribute("type") !== "2")
    .map((n) => {
      const ms = Number(n.getAttribute("date"));
      const d = Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
      return {
        message: (n.getAttribute("body") || "").trim(),
        date: d && !Number.isNaN(d.getTime()) ? uaeToday(d) : null,
        sender: n.getAttribute("address"),
      };
    })
    .filter((r) => r.message);
}

/** Mask long digit runs and emails for display. Parsing always runs on the original text. */
export function maskForDisplay(message: string): string {
  return message
    .replace(/\b(\d{2})\d{4,}(\d{2})\b/g, "$1••••$2")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "•••@•••");
}
