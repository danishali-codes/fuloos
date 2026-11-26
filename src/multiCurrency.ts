import {
  computeImpliedRate,
  convertMinor,
  DEFAULT_CURRENCY,
  getCurrencyDecimals,
  getPeggedFallbackRate,
  normalizeCurrencyCode,
} from "./currency.ts";
import {
  accountCurrency,
  balance,
  today,
  type Account,
  type Ledger,
  type Transaction,
} from "./domain.ts";
import { transactionCategoryAmounts } from "./enrichment.ts";
import { fxRateService } from "./fxRates.ts";
import type { ImportTransaction } from "./csv.ts";

export interface ReportingRateResult {
  rate: number | null;
  estimated: boolean;
}

export type RateLookupFn = (
  from: string,
  to: string,
  date: string,
) => ReportingRateResult;

export function defaultRateLookup(
  from: string,
  to: string,
  date: string,
): ReportingRateResult {
  const f = normalizeCurrencyCode(from);
  const t = normalizeCurrencyCode(to);
  if (f === t) return { rate: 1, estimated: false };
  const resolved = fxRateService.getCachedRateSync(f, t, date);
  return {
    rate: resolved.rate,
    estimated: resolved.status === "estimated",
  };
}

export interface ConvertedAmount {
  amount: number;
  estimated: boolean;
  unavailable: boolean;
}

export function convertAmountToReporting(
  amountMinor: number,
  fromCurrency: string,
  reportingCurrency: string,
  date: string,
  rateLookup: RateLookupFn = defaultRateLookup,
): ConvertedAmount {
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(reportingCurrency);
  if (from === to) {
    return { amount: amountMinor, estimated: false, unavailable: false };
  }
  const { rate, estimated } = rateLookup(from, to, date);
  if (rate === null || !Number.isFinite(rate) || rate <= 0) {
    return { amount: 0, estimated: true, unavailable: true };
  }
  return {
    amount: convertMinor(amountMinor, from, to, rate),
    estimated,
    unavailable: false,
  };
}

export function convertTransactionToReporting(
  tx: Transaction,
  accCurrency: string,
  reportingCurrency: string,
  rateLookup: RateLookupFn = defaultRateLookup,
): ConvertedAmount {
  const base = convertAmountToReporting(
    tx.amount,
    accCurrency,
    reportingCurrency,
    tx.date,
    rateLookup,
  );
  return {
    amount: base.amount,
    estimated: base.estimated || tx.fx_status === "estimated",
    unavailable: base.unavailable,
  };
}

export function transactionCategoryAmountsInReporting(
  tx: Transaction,
  accCurrency: string,
  reportingCurrency: string,
  rateLookup: RateLookupFn = defaultRateLookup,
): { parts: Array<{ category_id: string | null; amount: number }>; estimated: boolean } {
  const rawParts = transactionCategoryAmounts(tx);
  const from = normalizeCurrencyCode(accCurrency);
  const to = normalizeCurrencyCode(reportingCurrency);
  if (from === to) {
    return { parts: rawParts, estimated: tx.fx_status === "estimated" };
  }
  const { rate, estimated } = rateLookup(from, to, tx.date);
  if (rate === null || !Number.isFinite(rate) || rate <= 0) {
    return {
      parts: rawParts.map((p) => ({ category_id: p.category_id, amount: 0 })),
      estimated: true,
    };
  }
  return {
    parts: rawParts.map((p) => ({
      category_id: p.category_id,
      amount: convertMinor(p.amount, from, to, rate),
    })),
    estimated: estimated || tx.fx_status === "estimated",
  };
}

export function accountCurrencyMap(
  accounts: readonly Account[],
): Map<string, string> {
  return new Map(accounts.map((a) => [a.id, accountCurrency(a)]));
}

export function reportingTotals(
  transactions: readonly Transaction[],
  accounts: readonly Account[],
  reportingCurr: string = DEFAULT_CURRENCY,
  rateLookup: RateLookupFn = defaultRateLookup,
): {
  income: number;
  expense: number;
  estimatedCount: number;
  currency: string;
} {
  const accCurr = accountCurrencyMap(accounts);
  const target = normalizeCurrencyCode(reportingCurr);
  let income = 0;
  let expense = 0;
  let estimatedCount = 0;

  for (const t of transactions) {
    if (t.type !== "income" && t.type !== "expense") continue;
    const from = accCurr.get(t.account_id) ?? DEFAULT_CURRENCY;
    const conv = convertTransactionToReporting(t, from, target, rateLookup);
    if (conv.estimated) estimatedCount++;
    if (t.type === "income") income += conv.amount;
    else expense += conv.amount;
  }

  return { income, expense, estimatedCount, currency: target };
}

export function totalNetBalanceInReporting(
  accounts: readonly Account[],
  transactions: Transaction[],
  reportingCurr: string = DEFAULT_CURRENCY,
  asOfDate: string = today(),
  rateLookup: RateLookupFn = defaultRateLookup,
): { total: number; estimatedCount: number; currency: string } {
  const target = normalizeCurrencyCode(reportingCurr);
  let total = 0;
  let estimatedCount = 0;
  for (const acc of accounts) {
    const accBal = balance(acc, transactions);
    const from = accountCurrency(acc);
    const conv = convertAmountToReporting(accBal, from, target, asOfDate, rateLookup);
    total += conv.amount;
    if (conv.estimated) estimatedCount++;
  }
  return { total, estimatedCount, currency: target };
}

/** Returns all transactions whose account-currency amount is still estimated, newest first. */
export function estimatedTransactions(
  transactions: readonly Transaction[],
): Transaction[] {
  return transactions
    .filter((t) => t.fx_status === "estimated")
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

/**
 * Builds the updated transaction fields when the user confirms the real charged amount
 * in the account's currency (in minor units).
 */
export function buildConfirmedForeignPatch(
  tx: Pick<Transaction, "original_amount" | "original_currency" | "amount">,
  confirmedAccountMinor: number,
  accCurrency: string,
): Pick<Transaction, "amount" | "fx_rate" | "fx_source" | "fx_status"> {
  const origCurr = normalizeCurrencyCode(tx.original_currency ?? accCurrency);
  const origMinor = tx.original_amount ?? tx.amount;
  const fxRate =
    origCurr === normalizeCurrencyCode(accCurrency)
      ? 1
      : computeImpliedRate(origMinor, origCurr, confirmedAccountMinor, accCurrency);
  return {
    amount: confirmedAccountMinor,
    fx_rate: fxRate > 0 ? fxRate : 1,
    fx_source: "user_confirmed",
    fx_status: "exact",
  };
}

/**
 * Converts a transaction's amount to AED major units for ML category learning
 * (`src/ledger/learning.ts` and `categoriser.ts`), using the transaction's own rate
 * or rate cache so the model's `log1p(amountAed)` feature keeps its trained meaning.
 */
export function transactionAmountInAedMajor(
  tx: Pick<
    Transaction,
    "amount" | "original_amount" | "original_currency" | "fx_rate" | "date"
  >,
  accCurrency: string = DEFAULT_CURRENCY,
  rateLookup: RateLookupFn = defaultRateLookup,
): number {
  const accCode = normalizeCurrencyCode(accCurrency);
  if (accCode === DEFAULT_CURRENCY && tx.amount > 0) {
    return tx.amount / 100;
  }
  const origCode = normalizeCurrencyCode(tx.original_currency ?? accCode);
  if (origCode === DEFAULT_CURRENCY && (tx.original_amount ?? 0) > 0) {
    return (tx.original_amount ?? 0) / 100;
  }
  if (accCode !== DEFAULT_CURRENCY && tx.amount > 0) {
    const { rate } = rateLookup(accCode, DEFAULT_CURRENCY, tx.date);
    const effective = rate ?? getPeggedFallbackRate(accCode, DEFAULT_CURRENCY);
    if (effective && effective > 0) {
      return (tx.amount / 10 ** getCurrencyDecimals(accCode)) * effective;
    }
  }
  if (tx.original_amount && tx.original_amount > 0) {
    if (accCode === DEFAULT_CURRENCY && tx.fx_rate && tx.fx_rate > 0) {
      return (
        (tx.original_amount / 10 ** getCurrencyDecimals(origCode)) * tx.fx_rate
      );
    }
    const { rate } = rateLookup(origCode, DEFAULT_CURRENCY, tx.date);
    const effective = rate ?? getPeggedFallbackRate(origCode, DEFAULT_CURRENCY);
    if (effective && effective > 0) {
      return (
        (tx.original_amount / 10 ** getCurrencyDecimals(origCode)) * effective
      );
    }
    return tx.original_amount / 10 ** getCurrencyDecimals(origCode);
  }
  return tx.amount / 10 ** getCurrencyDecimals(accCode);
}

export interface EstimatedStatementMatch {
  rowIndex: number;
  existingTx: Transaction;
  statementAmount: number;
  recomputedFxRate: number;
}

function daysDiff(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T12:00:00Z`);
  const b = Date.parse(`${bIso}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.abs(Math.round((a - b) / 86_400_000));
}

function merchantsSimilar(a: string, b: string): boolean {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const na = clean(a);
  const nb = clean(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const tokA = new Set(na.split(" ").filter((w) => w.length >= 3));
  const tokB = new Set(nb.split(" ").filter((w) => w.length >= 3));
  if (!tokA.size || !tokB.size) return false;
  let overlap = 0;
  for (const t of tokA) if (tokB.has(t)) overlap++;
  return overlap > 0 && overlap / Math.min(tokA.size, tokB.size) >= 0.5;
}

/**
 * Matches imported CSV/statement rows against existing `fx_status === "estimated"`
 * transactions on the same account (date within ±3 days, merchant similar,
 * amount within ±5% of estimate — or any positive amount when the estimate was 0/pending).
 */
export function findEstimatedStatementMatches(
  rows: ReadonlyArray<{ index: number; transaction: ImportTransaction | null; duplicate?: boolean }>,
  ledger: Ledger,
): EstimatedStatementMatch[] {
  const accCurr = accountCurrencyMap(ledger.accounts);
  const estimated = ledger.transactions.filter((t) => t.fx_status === "estimated");
  if (!estimated.length) return [];

  const usedExisting = new Set<string>();
  const matches: EstimatedStatementMatch[] = [];

  for (const row of rows) {
    if (row.duplicate || !row.transaction) continue;
    const incoming = row.transaction;
    if (incoming.type === "transfer" || incoming.amount <= 0) continue;

    let best: { tx: Transaction; score: number } | null = null;
    for (const existing of estimated) {
      if (usedExisting.has(existing.id)) continue;
      if (existing.account_id !== incoming.account_id) continue;
      if (existing.type !== incoming.type) continue;
      const d = daysDiff(existing.date, incoming.date);
      if (d > 3) continue;
      if (!merchantsSimilar(existing.payee, incoming.payee)) continue;

      if (existing.amount > 0) {
        const diffRatio = Math.abs(incoming.amount - existing.amount) / existing.amount;
        if (diffRatio > 0.05) continue;
      }

      const score = d;
      if (!best || score < best.score) {
        best = { tx: existing, score };
      }
    }

    if (best) {
      usedExisting.add(best.tx.id);
      const acctCode = accCurr.get(best.tx.account_id) ?? DEFAULT_CURRENCY;
      const origCode = normalizeCurrencyCode(best.tx.original_currency ?? acctCode);
      const origMinor = best.tx.original_amount ?? incoming.amount;
      const recomputedFxRate =
        origCode === acctCode
          ? 1
          : computeImpliedRate(origMinor, origCode, incoming.amount, acctCode);
      matches.push({
        rowIndex: row.index,
        existingTx: best.tx,
        statementAmount: incoming.amount,
        recomputedFxRate: recomputedFxRate > 0 ? recomputedFxRate : 1,
      });
    }
  }

  return matches;
}
