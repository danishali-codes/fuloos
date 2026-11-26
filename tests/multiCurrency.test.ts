import test from "node:test";
import assert from "node:assert/strict";
import { balance, type Account, type Ledger, type Transaction } from "../src/domain.ts";
import {
  buildConfirmedForeignPatch,
  convertAmountToReporting,
  estimatedTransactions,
  findEstimatedStatementMatches,
  reportingTotals,
  totalNetBalanceInReporting,
  transactionAmountInAedMajor,
  type RateLookupFn,
} from "../src/multiCurrency.ts";
import { budgetReport } from "../src/budgets.ts";
import {
  computeCategoryTrends,
  computePayeeBreakdown,
  computeYoYComparison,
} from "../src/reportsAnalytics.ts";
import { computeNetWorthSummary } from "../src/netWorth.ts";
import { buildRegister } from "../src/register.ts";
import { buildIntelligentForecast } from "../src/recurringForecast.ts";
import { csvAmount, previewCsv, type CsvOptions } from "../src/csv.ts";
import { reportToCsv, transactionsToCsv } from "../src/export.ts";
import {
  createBackup,
  executeRestore,
  parseAndValidateBackup,
  serializeBackup,
} from "../src/backup.ts";
import { makeExample } from "../src/ledger/learning.ts";

const mockRates: RateLookupFn = (from, to) => {
  if (from === to) return { rate: 1, estimated: false };
  const toUsd: Record<string, number> = {
    USD: 1,
    AED: 1 / 3.6725,
    GBP: 1.27,
    EUR: 1.08,
    JPY: 1 / 150,
    KWD: 3.25,
  };
  const f = toUsd[from];
  const t = toUsd[to];
  if (!f || !t) return { rate: null, estimated: true };
  return { rate: f / t, estimated: false };
};

const sampleAccounts: Account[] = [
  {
    id: "acc_aed",
    name: "Sample Bank AED",
    type: "current",
    currency: "AED",
    opening_balance: 100000, // AED 1,000.00
    opening_date: "2026-01-01",
    color: "#2d6a4f",
  },
  {
    id: "acc_usd",
    name: "Sample Bank USD",
    type: "savings",
    currency: "USD",
    opening_balance: 50000, // USD 500.00
    opening_date: "2026-01-01",
    color: "#1b4332",
  },
];

const sampleCategories = [
  { id: "cat_dining", name: "Dining", description: "", color: "#b55233" },
  { id: "cat_shop", name: "Shopping", description: "", color: "#2d6a4f" },
];

test("account balances stay in native currency while dashboard reporting total converts into reporting currency", () => {
  const transactions: Transaction[] = [
    {
      id: "tx1",
      type: "expense",
      amount: 10000, // AED 100.00
      original_amount: 10000,
      original_currency: "AED",
      fx_rate: 1,
      fx_rate_date: "2026-03-10",
      fx_source: "same_currency",
      fx_status: "exact",
      account_id: "acc_aed",
      to_account_id: null,
      category_id: "cat_dining",
      date: "2026-03-10",
      payee: "Sample Bistro",
      notes: "",
    },
    {
      id: "tx2",
      type: "expense",
      amount: 5000, // USD 50.00
      original_amount: 5000,
      original_currency: "USD",
      fx_rate: 1,
      fx_rate_date: "2026-03-11",
      fx_source: "same_currency",
      fx_status: "exact",
      account_id: "acc_usd",
      to_account_id: null,
      category_id: "cat_shop",
      date: "2026-03-11",
      payee: "Sample Store",
      notes: "",
    },
  ];

  // Native account balances
  assert.equal(balance(sampleAccounts[0], transactions), 90000); // AED 900.00
  assert.equal(balance(sampleAccounts[1], transactions), 45000); // USD 450.00

  // Dashboard total in AED: 900.00 + 450.00 * 3.6725 = 900.00 + 1652.625 -> 2552.63 AED
  const netAed = totalNetBalanceInReporting(
    sampleAccounts,
    transactions,
    "AED",
    "2026-03-15",
    mockRates,
  );
  assert.equal(netAed.currency, "AED");
  assert.equal(netAed.total, 90000 + 165263);

  // Dashboard total in USD: 450.00 + 900.00 / 3.6725 = 450.00 + 245.06 = 695.06 USD
  const netUsd = totalNetBalanceInReporting(
    sampleAccounts,
    transactions,
    "USD",
    "2026-03-15",
    mockRates,
  );
  assert.equal(netUsd.currency, "USD");
  assert.equal(netUsd.total, 45000 + 24506);
});

test("cross-currency transfer updates source by amount and destination by to_amount", () => {
  const transfer: Transaction = {
    id: "tx_xfer",
    type: "transfer",
    amount: 36725, // AED 367.25 out of AED account
    to_amount: 10000, // USD 100.00 into USD account
    original_amount: 36725,
    original_currency: "AED",
    fx_rate: 1 / 3.6725,
    fx_rate_date: "2026-03-12",
    fx_source: "user_confirmed",
    fx_status: "exact",
    account_id: "acc_aed",
    to_account_id: "acc_usd",
    category_id: null,
    date: "2026-03-12",
    payee: "FX Transfer",
    notes: "",
  };

  assert.equal(balance(sampleAccounts[0], [transfer]), 100000 - 36725);
  assert.equal(balance(sampleAccounts[1], [transfer]), 50000 + 10000);

  // Register for destination account reflects to_amount (+10000 USD cents)
  const usdReg = buildRegister(
    { accounts: sampleAccounts, categories: sampleCategories, transactions: [transfer] },
    "acc_usd",
    { reportingCurrency: "AED", rateLookup: mockRates },
  );
  assert.equal(usdReg[0].currency, "USD");
  assert.equal(usdReg[0].balanceCurrency, "USD");
  assert.equal(usdReg[0].deposit, 10000);
  assert.equal(usdReg[0].balance, 60000);
});

test("budgets, analytics, net worth, and recurring forecast convert to reporting currency and flag estimates", () => {
  const estTx: Transaction = {
    id: "tx_est",
    type: "expense",
    amount: 5580, // Estimated AED 55.80 for GBP 12.00
    original_amount: 1200,
    original_currency: "GBP",
    fx_rate: 4.65,
    fx_rate_date: "2026-03-15",
    fx_source: "api_estimate",
    fx_status: "estimated",
    account_id: "acc_aed",
    to_account_id: null,
    category_id: "cat_shop",
    date: "2026-03-15",
    payee: "Sample Store London",
    notes: "",
  };
  const usdTx: Transaction = {
    id: "tx_usd",
    type: "expense",
    amount: 2000, // USD 20.00 = AED 73.45
    original_amount: 2000,
    original_currency: "USD",
    fx_rate: 1,
    fx_rate_date: "2026-03-16",
    fx_source: "same_currency",
    fx_status: "exact",
    account_id: "acc_usd",
    to_account_id: null,
    category_id: "cat_shop",
    date: "2026-03-16",
    payee: "Sample Merchant US",
    notes: "",
  };

  const totals = reportingTotals(
    [estTx, usdTx],
    sampleAccounts,
    "AED",
    mockRates,
  );
  assert.equal(totals.expense, 5580 + 7345);
  assert.equal(totals.estimatedCount, 1);

  const bRep = budgetReport(
    {
      accounts: sampleAccounts,
      categories: sampleCategories,
      transactions: [estTx, usdTx],
      budgets: [
        {
          id: "b1",
          category_id: "cat_shop",
          amount: 20000, // AED 200.00
          start_month: "2026-03",
          end_month: null,
        },
      ],
    },
    "2026-03",
    "2026-03",
    { reportingCurrency: "AED", rateLookup: mockRates },
  );
  assert.equal(bRep.currency, "AED");
  assert.equal(bRep.totalActual, 5580 + 7345);
  assert.equal(bRep.estimatedCount, 1);

  const range = { firstMonth: "2026-03", lastMonth: "2026-03" };
  const payees = computePayeeBreakdown([estTx, usdTx], range, {
    accounts: sampleAccounts,
    reportingCurrency: "AED",
    rateLookup: mockRates,
  });
  assert.equal(payees.totalFils, 5580 + 7345);
  assert.equal(payees.estimatedCount, 1);

  const yoy = computeYoYComparison([estTx, usdTx], range, {
    accounts: sampleAccounts,
    reportingCurrency: "AED",
    rateLookup: mockRates,
  });
  assert.equal(yoy.current.expenses, 5580 + 7345);
  assert.equal(yoy.current.estimatedCount, 1);

  const trends = computeCategoryTrends([estTx, usdTx], sampleCategories, "2026-03", {
    monthsCount: 1,
    accounts: sampleAccounts,
    reportingCurrency: "AED",
    rateLookup: mockRates,
  });
  assert.equal(trends.estimatedCount, 1);
  assert.equal(trends.categories[0].totalFils, 5580 + 7345);

  const nw = computeNetWorthSummary(
    sampleAccounts,
    [estTx, usdTx],
    [],
    "2026-03-20",
    "AED",
    mockRates,
  );
  assert.equal(nw.currency, "AED");
  assert.equal(
    nw.cashAssets,
    (100000 - 5580) + convertAmountToReporting(50000 - 2000, "USD", "AED", "2026-03-20", mockRates).amount,
  );

  // Recurring forecast with foreign currency schedule (GBP 10.00 on AED account)
  const forecast = buildIntelligentForecast(
    {
      accounts: sampleAccounts,
      categories: sampleCategories,
      transactions: [],
      recurring: [
        {
          id: "rec1",
          name: "Sample Cloud GBP",
          type: "expense",
          amount: 1000, // GBP 10.00
          currency: "GBP",
          amount_type: "fixed",
          account_id: "acc_aed",
          category_id: "cat_shop",
          frequency: "monthly",
          start_date: "2026-03-25",
          end_date: null,
          status: "active",
          notes: "",
        },
      ],
      recurring_occurrences: [],
    },
    "2026-03-20",
    { reportingCurrency: "AED", rateLookup: mockRates },
  );
  assert.equal(forecast.reportingCurrency, "AED");
  assert.ok((forecast.horizons[30].estimatedFxCount ?? 0) >= 1);
  assert.ok(forecast.horizons[30].expense.expected > 4000); // ~AED 46.64
});

test("confirming real charged amount recomputes implied rate and updates status to exact", () => {
  const estTx: Transaction = {
    id: "tx_gbp",
    type: "expense",
    amount: 5580,
    original_amount: 1200, // GBP 12.00
    original_currency: "GBP",
    fx_rate: 4.65,
    fx_rate_date: "2026-03-15",
    fx_source: "api_estimate",
    fx_status: "estimated",
    account_id: "acc_aed",
    to_account_id: null,
    category_id: "cat_shop",
    date: "2026-03-15",
    payee: "SAMPLE STORE LONDON",
    notes: "",
  };

  assert.equal(estimatedTransactions([estTx]).length, 1);

  const patch = buildConfirmedForeignPatch(estTx, 5610, "AED");
  assert.equal(patch.amount, 5610);
  assert.equal(patch.fx_source, "user_confirmed");
  assert.equal(patch.fx_status, "exact");
  assert.ok(Math.abs((patch.fx_rate ?? 0) - 4.675) < 1e-6);

  // KWD (3 decimals) -> AED (2 decimals): KWD 2.500 (2500) billed AED 30.00 (3000) -> rate 12.0
  const kwdPatch = buildConfirmedForeignPatch(
    { original_amount: 2500, original_currency: "KWD", amount: 2990 },
    3000,
    "AED",
  );
  assert.ok(Math.abs((kwdPatch.fx_rate ?? 0) - 12) < 1e-6);

  // JPY (0 decimals) -> AED (2 decimals): JPY 1500 (1500) billed AED 37.50 (3750) -> rate 0.025
  const jpyPatch = buildConfirmedForeignPatch(
    { original_amount: 1500, original_currency: "JPY", amount: 3670 },
    3750,
    "AED",
  );
  assert.ok(Math.abs((jpyPatch.fx_rate ?? 0) - 0.025) < 1e-6);
});

test("CSV import supports 0/2/3 decimal currencies, optional currency column, and statement matching", () => {
  assert.equal(csvAmount("1,500", ".", "JPY"), 1500);
  assert.equal(csvAmount("2.500", ".", "KWD"), 2500);
  assert.equal(csvAmount("12.34", ".", "USD"), 1234);

  const ledger: Ledger = {
    accounts: sampleAccounts,
    categories: sampleCategories,
    transactions: [
      {
        id: "tx_est_1",
        type: "expense",
        amount: 5580, // estimated AED 55.80
        original_amount: 1200,
        original_currency: "GBP",
        fx_rate: 4.65,
        fx_rate_date: "2026-03-15",
        fx_source: "api_estimate",
        fx_status: "estimated",
        account_id: "acc_aed",
        to_account_id: null,
        category_id: "cat_shop",
        date: "2026-03-15",
        payee: "SAMPLE STORE LONDON",
        notes: "",
      },
    ],
  };

  const opts: CsvOptions = {
    date: 0,
    payee: 1,
    amount: 2,
    currency: 3,
    notes: -1,
    category: -1,
    debit: -1,
    credit: -1,
    split: false,
    flip: false,
    decimal: ".",
    dateFormat: "YMD",
    account: "acc_aed",
  };

  const rows = [
    ["2026-03-17", "Sample Store London UK", "-56.10", "AED"],
    ["2026-03-18", "Sample Tokyo Cafe", "-1500", "JPY"],
    ["2026-03-18", "Sample Kuwait Shop", "-2.500", "KWD"],
  ];

  const preview = previewCsv(rows, opts, ledger, (from, to, date) => {
    const r = mockRates(from, to, date);
    return { rate: r.rate, source: "api_estimate", rateDate: date, estimated: true };
  });

  assert.equal(preview[0].error, "");
  assert.equal(preview[0].transaction?.amount, 5610);
  assert.equal(preview[0].transaction?.original_currency, "AED");

  assert.equal(preview[1].error, "");
  assert.equal(preview[1].transaction?.original_currency, "JPY");
  assert.equal(preview[1].transaction?.original_amount, 1500);
  assert.equal(preview[1].transaction?.fx_status, "estimated");

  assert.equal(preview[2].error, "");
  assert.equal(preview[2].transaction?.original_currency, "KWD");
  assert.equal(preview[2].transaction?.original_amount, 2500);
  assert.equal(preview[2].transaction?.fx_status, "estimated");

  // Statement matching finds the AED 56.10 row within ±3 days & ±5% of AED 55.80 estimate
  const matches = findEstimatedStatementMatches(preview, ledger);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].existingTx.id, "tx_est_1");
  assert.equal(matches[0].statementAmount, 5610);
  assert.ok(Math.abs(matches[0].recomputedFxRate - 4.675) < 1e-6);
});

test("export and backup/restore preserve non-AED reporting currency, FX metadata, and legacy AED backups", async () => {
  const ledger: Ledger = {
    accounts: sampleAccounts,
    categories: sampleCategories,
    user_settings: {
      reporting_currency: "USD",
      confirm_foreign_mode: "above_threshold",
      confirm_foreign_threshold: 5000,
    },
    transactions: [
      {
        id: "tx1",
        type: "expense",
        amount: 5610,
        original_amount: 1200,
        original_currency: "GBP",
        fx_rate: 4.675,
        fx_rate_date: "2026-03-15",
        fx_source: "user_confirmed",
        fx_status: "exact",
        account_id: "acc_aed",
        to_account_id: null,
        category_id: "cat_shop",
        date: "2026-03-15",
        payee: "Sample Store",
        notes: "",
      },
      {
        id: "tx2",
        type: "transfer",
        amount: 36725,
        to_amount: 10000,
        original_amount: 36725,
        original_currency: "AED",
        fx_rate: 1 / 3.6725,
        fx_rate_date: "2026-03-16",
        fx_source: "user_confirmed",
        fx_status: "exact",
        account_id: "acc_aed",
        to_account_id: "acc_usd",
        category_id: null,
        date: "2026-03-16",
        payee: "Transfer",
        notes: "",
      },
    ],
    recurring: [
      {
        id: "rec1",
        name: "Sample SaaS",
        type: "expense",
        amount: 1500,
        currency: "EUR",
        amount_type: "fixed",
        account_id: "acc_usd",
        category_id: "cat_shop",
        frequency: "monthly",
        start_date: "2026-03-01",
        end_date: null,
        status: "active",
        notes: "",
      },
    ],
  };

  const txCsv = transactionsToCsv(ledger.transactions, ledger);
  assert.ok(txCsv.includes("FX Rate Date,FX Source,FX Status"));
  assert.ok(txCsv.includes("12.00,GBP,4.675,2026-03-15,user_confirmed,exact"));

  const repCsv = reportToCsv({
    rangeLabel: "March 2026",
    summary: { income: 100000, expense: 25000 },
    spending: [{ name: "Shopping", total: 25000 }],
    currency: "USD",
    estimatedCount: 2,
  });
  assert.ok(repCsv.includes("Amount (USD)"));
  assert.ok(repCsv.includes("Includes 2 estimated amounts"));

  const rawBackup = serializeBackup(createBackup(ledger));
  const { backup } = parseAndValidateBackup(rawBackup);
  assert.equal(backup.currency, "USD");
  assert.equal(backup.data.user_settings?.reporting_currency, "USD");
  assert.equal(backup.data.user_settings?.confirm_foreign_mode, "above_threshold");
  assert.equal(backup.data.transactions[0].fx_source, "user_confirmed");
  assert.equal(backup.data.transactions[1].to_amount, 10000);
  assert.equal(backup.data.recurring[0].currency, "EUR");

  let seq = 1;
  const restored = await executeRestore({
    backup,
    mode: "empty",
    existingLedger: { accounts: [], categories: [], transactions: [] },
    existingPresets: [],
    presetStore: { save: async () => ({ presets: [], replaced: false }) },
    demo: true,
    demoId: () => `id_${seq++}`,
  });
  assert.equal(restored.ledger.user_settings?.reporting_currency, "USD");
  assert.equal(restored.ledger.transactions[0].fx_status, "exact");
  assert.equal(restored.ledger.transactions[1].to_amount, 10000);
  assert.equal(restored.ledger.recurring?.[0].currency, "EUR");
});

test("ML learning helpers normalise non-AED amounts to AED equivalent", () => {
  const major = transactionAmountInAedMajor(
    {
      amount: 10000, // USD 100.00
      original_amount: 10000,
      original_currency: "USD",
      fx_rate: 1,
      date: "2026-03-15",
    },
    "USD",
    mockRates,
  );
  assert.ok(Math.abs(major - 367.25) < 0.01);

  const ex = makeExample({
    merchant: "SAMPLE STORE LONDON",
    payee: "Sample Store",
    amount: 10000, // USD 100.00
    currency: "USD",
    category_id: "cat_shop",
    suggested_category_id: "cat_shop",
    source: "sms",
    model_version: "v1",
  });
  assert.ok(ex);
  assert.equal(ex.amount, 36725); // AED 367.25 in fils
});
