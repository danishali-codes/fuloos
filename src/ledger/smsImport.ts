/* Turns bank SMS into reviewable Fuloos transactions. Everything here runs in the browser; only the transactions the
   user confirms are saved, and the SMS text itself is never stored. */
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
import { validateTransaction, type Ledger } from "../domain.ts";
import { transactionKey, type ImportTransaction } from "../csv.ts";
import type { UserSuggestion } from "./learning.ts";
import {
  bankForMessage,
  bankFromSender,
  detectBank,
  maskForDisplay,
  parseSms,
  type ParsedSms,
  type RawSms,
  type SmsType,
} from "./sms.ts";

export interface SmsImportRateEntry {
  rate: number;
  rateDate: string;
  provider?: string;
}

export interface SmsImportOptions {
  account: string;
  /** Used when neither the SMS text nor the backup file has a date. */
  fallbackDate: string;
  /** Force a bank for every message (otherwise sender, then templates, decide). */
  bank?: string | null;
  /** Optional cached FX rates keyed by `"BASE|QUOTE|YYYY-MM-DD"`. */
  fxRates?: Record<string, SmsImportRateEntry>;
}

export interface SmsPreviewRow {
  index: number;
  display: string;
  parsed: ParsedSms | null;
  transaction: ImportTransaction | null;
  dateSource: "sms" | "backup" | "fallback" | null;
  suggestion: UserSuggestion | null;
  duplicate: boolean;
  /** The same SMS (same bank, text and received date) appeared earlier in this batch. */
  repeated: boolean;
  /** Rows the user would normally not import (OTPs, internal moves, card repayments). */
  skipped: string;
  error: string;
  warnings?: string[];
}

const SKIP: Partial<Record<SmsType, string>> = {
  otp: "One-time password, not a transaction.",
  declined: "Declined or failed transaction.",
  notice: "Not a recognised transaction message.",
  internal_out: "Move between your own accounts at the same bank.",
  internal_in: "Move between your own accounts at the same bank.",
  card_repayment: "Credit card repayment: record it as a transfer.",
  card_payment_received: "Credit card repayment: record it as a transfer.",
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

/** Title-case shouty merchant strings ("AL MAYA SUPERMARKET" -> "Al Maya Supermarket"); brand names stay as they are. */
export function displayPayee(merchant: string | null): string {
  if (!merchant || merchant === "UNKNOWN MERCHANT") return "";
  if (merchant !== merchant.toUpperCase()) return merchant;
  return merchant
    .toLowerCase()
    .replace(
      /(^|[\s&(\-/.])([a-z])/g,
      (_, p: string, c: string) => p + c.toUpperCase(),
    );
}

function findCachedRate(
  fxRates: Record<string, SmsImportRateEntry> | undefined,
  from: string,
  to: string,
  date: string,
): { rate: number; rateDate: string } | null {
  if (!fxRates) return null;
  const exact = fxRates[`${from}|${to}|${date}`];
  if (exact && exact.rate > 0) return { rate: exact.rate, rateDate: exact.rateDate || date };
  let bestBefore: SmsImportRateEntry | null = null;
  let bestAny: SmsImportRateEntry | null = null;
  for (const [k, v] of Object.entries(fxRates)) {
    if (!v || !(v.rate > 0)) continue;
    const [b, q, kd] = k.split("|");
    if (b === from && q === to) {
      const ed = v.rateDate || kd;
      if (!bestAny || ed > bestAny.rateDate) bestAny = { ...v, rateDate: ed };
      if (ed <= date && (!bestBefore || ed > bestBefore.rateDate)) {
        bestBefore = { ...v, rateDate: ed };
      }
    }
  }
  const hit = bestBefore ?? bestAny;
  return hit ? { rate: hit.rate, rateDate: hit.rateDate } : null;
}

export function previewSms(
  messages: RawSms[],
  options: SmsImportOptions,
  ledger: Ledger,
  /** Category (and learned payee) suggestion for an expense: see suggestCategory() in learning.ts. */
  suggest: (merchant: string | null, amountAed: number) => UserSuggestion,
): SmsPreviewRow[] {
  const seenText = new Set<string>();
  const targetAccount = ledger.accounts.find((a) => a.id === options.account);
  const accCurrency = normalizeCurrencyCode(targetAccount?.currency);
  const batchBank =
    options.bank ??
    detectBank(
      messages.filter((m) => !bankFromSender(m.sender)).map((m) => m.message),
    );
  const rows = messages.map((raw, index) => {
    const row: SmsPreviewRow = {
      index,
      display: maskForDisplay(raw.message),
      parsed: null,
      transaction: null,
      dateSource: null,
      suggestion: null,
      duplicate: false,
      repeated: false,
      skipped: "",
      error: "",
    };
    try {
      const bank =
        options.bank ??
        bankFromSender(raw.sender) ??
        bankForMessage(raw.message, batchBank);
      const parsed = parseSms(raw.message, bank);
      row.parsed = parsed;
      const textKey = `${bank}\u0001${raw.date ?? ""}\u0001${raw.message.trim()}`;
      row.repeated = seenText.has(textKey);
      seenText.add(textKey);
      if (SKIP[parsed.txn_type]) {
        row.skipped = SKIP[parsed.txn_type]!;
        if (parsed.txn_type === "notice" && !bank)
          row.skipped = "Bank not recognised. Choose the bank above.";
        return row;
      }
      if (parsed.direction === "none")
        throw new Error("Not a debit or credit.");
      if (parsed.amount_minor === null || !parsed.currency) {
        throw new Error("Amount not found in this SMS.");
      }

      const date = parsed.date_in_text ?? raw.date ?? options.fallbackDate;
      row.dateSource = parsed.date_in_text
        ? "sms"
        : raw.date
          ? "backup"
          : "fallback";
      const type = parsed.direction === "debit" ? "expense" : "income";

      const origCurrency = normalizeCurrencyCode(parsed.currency);
      const origMinor = parsed.amount_minor;
      const warnings = [...parsed.warnings];
      const known = isSupportedCurrency(origCurrency);
      if (!known && !warnings.includes("unknown_currency_code")) {
        warnings.push("unknown_currency_code");
      }

      let amountMinor = 0;
      let fxRate: number | undefined;
      let fxRateDate = date;
      let fxSource: FxSource | undefined;
      let fxStatus: FxStatus = "exact";

      if (origCurrency === accCurrency) {
        amountMinor = origMinor;
        fxRate = 1;
        fxSource = "same_currency";
        fxStatus = "exact";
      } else if (
        parsed.billed_currency === accCurrency &&
        parsed.billed_amount_minor !== null &&
        parsed.billed_amount_minor > 0
      ) {
        amountMinor = parsed.billed_amount_minor;
        fxRate = computeImpliedRate(origMinor, origCurrency, amountMinor, accCurrency);
        fxSource = "bank_sms";
        fxStatus = "exact";
      } else {
        const cached = known
          ? findCachedRate(options.fxRates, origCurrency, accCurrency, date)
          : null;
        if (cached) {
          amountMinor = convertMinor(origMinor, origCurrency, accCurrency, cached.rate);
          fxRate = cached.rate;
          fxRateDate = cached.rateDate;
          fxSource = "api_estimate";
          fxStatus = "estimated";
        } else {
          const pegged = known
            ? getPeggedFallbackRate(origCurrency, accCurrency)
            : null;
          if (pegged !== null) {
            amountMinor = convertMinor(origMinor, origCurrency, accCurrency, pegged);
            fxRate = pegged;
            fxSource = "manual_rate";
            fxStatus = "estimated";
          } else {
            amountMinor = 0;
            fxRate = undefined;
            fxSource = undefined;
            fxStatus = "estimated";
            warnings.push("rate_unavailable");
          }
        }
      }

      const amountForMlAed =
        accCurrency === DEFAULT_CURRENCY && amountMinor > 0
          ? amountMinor / 100
          : origMinor / 10 ** getCurrencyDecimals(origCurrency);

      let category_id: string | null = null;
      if (type === "expense") {
        row.suggestion = suggest(parsed.merchant_clean, amountForMlAed);
        category_id = row.suggestion.category_id;
      }

      const origStr = formatCurrencyInput(origMinor, origCurrency);
      const foreign =
        origCurrency !== accCurrency
          ? fxSource === "bank_sms"
            ? ` · ${origCurrency} ${origStr} (bank billed)`
            : warnings.includes("rate_unavailable")
              ? ` · ${origCurrency} ${origStr} (rate pending)`
              : ` · ${origCurrency} ${origStr} (estimated)`
          : "";
      const transaction: ImportTransaction = {
        date,
        account_id: options.account,
        to_account_id: null,
        category_id,
        type,
        amount: amountMinor,
        payee:
          row.suggestion?.payee ||
          displayPayee(parsed.merchant_clean) ||
          PAYEE_FOR_TYPE[parsed.txn_type] ||
          "",
        notes: `From ${bank ?? "bank"} SMS${foreign}`,
        original_amount: origMinor,
        original_currency: origCurrency,
        ...(fxRate !== undefined ? { fx_rate: fxRate } : {}),
        fx_rate_date: fxRateDate,
        ...(fxSource ? { fx_source: fxSource } : {}),
        fx_status: fxStatus,
      };
      validateTransaction(transaction, ledger);
      row.transaction = transaction;
      if (warnings.length) row.warnings = warnings;
    } catch (e) {
      row.error = e instanceof Error ? e.message : "Could not read this SMS.";
    }
    return row;
  });
  return markDuplicates(rows, ledger);
}

/** Flag rows that match the ledger or an earlier row (account, date, type, amount, payee). Run again after edits. */
export function markDuplicates(
  rows: SmsPreviewRow[],
  ledger: Ledger,
): SmsPreviewRow[] {
  const seen = new Set(ledger.transactions.map(transactionKey));
  return rows.map((row) => {
    if (!row.transaction) return { ...row, duplicate: false };
    const key = transactionKey(row.transaction);
    const duplicate = row.repeated || seen.has(key);
    seen.add(key);
    return { ...row, duplicate };
  });
}
