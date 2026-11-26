import assert from "node:assert/strict";
import test from "node:test";
import {
  computeImpliedRate,
  convertMinor,
  convertToAedFils,
  formatCurrency,
  formatCurrencyInput,
  formatOriginalCurrencyPill,
  getCurrencyDecimals,
  getPeggedFallbackRate,
  ISO_4217_CURRENCIES,
  isSupportedCurrency,
  normalizeCurrencyCode,
  parseCurrencyMinor,
  roundHalfAwayFromZero,
  SUPPORTED_CURRENCIES,
  validateForeignCurrencyFields,
} from "../src/currency.ts";
import { validateTransaction, type Ledger } from "../src/domain.ts";
import { transactionsToCsv } from "../src/export.ts";
import {
  createBackup,
  executeRestore,
  parseAndValidateBackup,
  serializeBackup,
} from "../src/backup.ts";

test("ISO 4217 table covers global currencies and minor-unit exponents 0, 2, 3", () => {
  assert.ok(ISO_4217_CURRENCIES.length >= 150);
  assert.equal(SUPPORTED_CURRENCIES.length, ISO_4217_CURRENCIES.length);

  // Spot check major, regional, and previously-unsupported currencies
  for (const code of [
    "AED",
    "USD",
    "EUR",
    "GBP",
    "JPY",
    "KRW",
    "VND",
    "KWD",
    "BHD",
    "OMR",
    "JOD",
    "TND",
    "THB",
    "TRY",
    "MXN",
    "BRL",
    "ZAR",
    "NZD",
    "PLN",
    "SEK",
    "NOK",
    "DKK",
    "HKD",
    "TWD",
    "MYR",
    "IDR",
    "CLF",
  ]) {
    assert.equal(isSupportedCurrency(code), true, `Expected ${code} supported`);
  }
  assert.equal(isSupportedCurrency("XYZ"), false);
  assert.equal(isSupportedCurrency("ZZZ"), false);
  assert.equal(isSupportedCurrency("12"), false);

  assert.equal(getCurrencyDecimals("AED"), 2);
  assert.equal(getCurrencyDecimals("USD"), 2);
  assert.equal(getCurrencyDecimals("GBP"), 2);
  assert.equal(getCurrencyDecimals("PKR"), 2);
  assert.equal(getCurrencyDecimals("INR"), 2);
  assert.equal(getCurrencyDecimals("KWD"), 3);
  assert.equal(getCurrencyDecimals("BHD"), 3);
  assert.equal(getCurrencyDecimals("OMR"), 3);
  assert.equal(getCurrencyDecimals("JOD"), 3);
  assert.equal(getCurrencyDecimals("TND"), 3);
  assert.equal(getCurrencyDecimals("JPY"), 0);
  assert.equal(getCurrencyDecimals("KRW"), 0);
  assert.equal(getCurrencyDecimals("VND"), 0);
  // Unknown 3-letter code defaults safely to 2 decimals without crashing
  assert.equal(getCurrencyDecimals("ZZZ"), 2);

  // Pegged fallback exists only for GCC/USD pegged pairs
  assert.equal(getPeggedFallbackRate("USD", "AED"), 3.6725);
  assert.equal(getPeggedFallbackRate("AED", "AED"), 1);
  assert.ok(Math.abs((getPeggedFallbackRate("SAR", "AED") ?? 0) - 3.6725 / 3.75) < 1e-9);
  assert.equal(getPeggedFallbackRate("GBP", "AED"), null);
  assert.equal(getPeggedFallbackRate("EUR", "USD"), null);

  assert.equal(normalizeCurrencyCode(undefined), "AED");
  assert.equal(normalizeCurrencyCode(" thb "), "THB");
});

test("roundHalfAwayFromZero rounds positive and negative halves away from zero", () => {
  assert.equal(roundHalfAwayFromZero(0), 0);
  assert.equal(roundHalfAwayFromZero(0.5), 1);
  assert.equal(roundHalfAwayFromZero(1.5), 2);
  assert.equal(roundHalfAwayFromZero(2.5), 3);
  assert.equal(roundHalfAwayFromZero(-0.5), -1);
  assert.equal(roundHalfAwayFromZero(-1.5), -2);
  assert.equal(roundHalfAwayFromZero(-2.5), -3);
  assert.equal(roundHalfAwayFromZero(1.4999), 1);
  assert.equal(roundHalfAwayFromZero(-1.4999), -1);
  // IEEE-754 artifact check: 1.005 * 100 = 100.49999999999999
  assert.equal(roundHalfAwayFromZero(1.005 * 100), 101);
});

test("parseCurrencyMinor and formatCurrencyInput handle 0, 2, and 3 decimals without float drift", () => {
  assert.equal(parseCurrencyMinor("100.00", "USD"), 10000);
  assert.equal(parseCurrencyMinor("1,234.56", "THB"), 123456);
  assert.equal(parseCurrencyMinor("12.345", "KWD"), 12345);
  assert.equal(parseCurrencyMinor("2.500", "KWD"), 2500);
  assert.equal(parseCurrencyMinor("1500", "JPY"), 1500);
  assert.equal(parseCurrencyMinor("1,500", "JPY"), 1500);

  assert.equal(formatCurrencyInput(10000, "USD"), "100.00");
  assert.equal(formatCurrencyInput(12345, "KWD"), "12.345");
  assert.equal(formatCurrencyInput(2500, "KWD"), "2.500");
  assert.equal(formatCurrencyInput(1500, "JPY"), "1500");

  assert.throws(() => parseCurrencyMinor("12.345", "USD"), /2 decimal/);
  assert.throws(() => parseCurrencyMinor("12.5", "JPY"), /whole number/);
  assert.throws(() => parseCurrencyMinor("10", "XYZ"), /Unsupported currency/);

  // Unknown 3-letter code with allowUnknownCode assumes 2 decimals
  assert.equal(
    parseCurrencyMinor("42.50", "XYZ", { allowUnknownCode: true }),
    4250,
  );
});

test("property-style round-trip: parse -> format -> parse across exponents 0, 2, and 3", () => {
  const cases: Array<{ code: string; decimals: 0 | 2 | 3 }> = [
    { code: "JPY", decimals: 0 },
    { code: "KRW", decimals: 0 },
    { code: "VND", decimals: 0 },
    { code: "AED", decimals: 2 },
    { code: "GBP", decimals: 2 },
    { code: "INR", decimals: 2 },
    { code: "THB", decimals: 2 },
    { code: "KWD", decimals: 3 },
    { code: "BHD", decimals: 3 },
    { code: "OMR", decimals: 3 },
    { code: "JOD", decimals: 3 },
    { code: "TND", decimals: 3 },
  ];

  // Deterministic pseudo-random integers covering 0, small, large, negative, and boundary values
  const seeds = [
    0, 1, 5, 9, 10, 42, 99, 100, 101, 250, 999, 1000, 1234, 1500, 2500, 9999,
    12345, 56100, 999999, 12345678, 987654321, -1, -50, -12345, -1000000,
  ];

  for (const { code, decimals } of cases) {
    for (const minor of seeds) {
      const formatted = formatCurrencyInput(minor, code);
      const reparsed = parseCurrencyMinor(formatted, code);
      assert.equal(
        reparsed,
        minor,
        `Round-trip failed for ${code} (exp ${decimals}): ${minor} -> "${formatted}" -> ${reparsed}`,
      );
      const reformatted = formatCurrencyInput(reparsed, code);
      assert.equal(reformatted, formatted);
    }
  }
});

test("convertMinor converts across arbitrary pairs and exponents with half-away-from-zero rounding", () => {
  // 100.00 USD * 3.6725 = 367.25 AED -> 36725 fils
  assert.equal(convertMinor(10000, "USD", "AED", 3.6725), 36725);
  // 1.000 KWD * 11.95 = 11.95 AED -> 1195 fils
  assert.equal(convertMinor(1000, "KWD", "AED", 11.95), 1195);
  // 1500 JPY * 0.024 = 36.00 AED -> 3600 fils
  assert.equal(convertMinor(1500, "JPY", "AED", 0.024), 3600);
  // AED -> JPY (2 decimals -> 0 decimals): 36.00 AED * 41.666667 = 1500 JPY
  assert.equal(convertMinor(3600, "AED", "JPY", 1 / 0.024), 1500);
  // AED -> KWD (2 decimals -> 3 decimals): 11.95 AED -> 1.000 KWD = 1000 fils
  assert.equal(convertMinor(1195, "AED", "KWD", 1 / 11.95), 1000);
  // GBP 12.00 @ 4.675 = AED 56.10 -> 5610 fils
  assert.equal(convertMinor(1200, "GBP", "AED", 4.675), 5610);
  // Implied rate check: GBP 12.00 -> AED 56.10 = 4.675
  assert.equal(computeImpliedRate(1200, "GBP", 5610, "AED"), 4.675);
  // Signed balance conversion: -100.00 USD -> -367.25 AED
  assert.equal(convertMinor(-10000, "USD", "AED", 3.6725), -36725);
  // Half away from zero on tie: 1 minor unit * 0.5 -> 1; -1 * 0.5 -> -1
  assert.equal(convertMinor(1, "JPY", "JPY", 0.5), 1);
  assert.equal(convertMinor(-1, "JPY", "JPY", 0.5), -1);

  // Compatibility wrapper convertToAedFils
  assert.equal(convertToAedFils(10000, "USD", 3.6725), 36725);
  assert.equal(convertToAedFils(5000, "AED", 1), 5000);
  assert.throws(() => convertToAedFils(-100, "USD", 3.6725), /zero or greater/);
  assert.throws(() => convertToAedFils(100, "USD", 0), /greater than zero/);
  assert.throws(() => convertToAedFils(100, "USD", -1), /greater than zero/);
  assert.throws(() => convertToAedFils(100, "XYZ", 1), /Unsupported currency/);
});

test("formatCurrency uses Intl.NumberFormat and falls back to CODE 1,234.50 for unknown codes", () => {
  const formatted = formatCurrency(36725, "AED");
  assert.ok(formatted.includes("367.25"));
  const jpy = formatCurrency(1500, "JPY");
  assert.ok(jpy.includes("1,500"));
  assert.ok(!jpy.includes(".00"));
  const kwd = formatCurrency(2500, "KWD");
  assert.ok(kwd.includes("2.500"));

  // Unknown 3-letter code falls back cleanly to "CODE 1,234.50"
  assert.equal(formatCurrency(123450, "XYZ"), "XYZ 1,234.50");
  assert.equal(formatCurrency(-123450, "XYZ"), "-XYZ 1,234.50");

  assert.equal(
    formatOriginalCurrencyPill(10000, "USD", 3.6725),
    "USD 100.00 @ 3.6725",
  );
  assert.equal(
    formatOriginalCurrencyPill(12345, "KWD", 11.95),
    "KWD 12.345 @ 11.95",
  );
  assert.equal(
    formatOriginalCurrencyPill(1500, "JPY", 0.024),
    "JPY 1500 @ 0.024",
  );
});

test("validateForeignCurrencyFields and validateTransaction enforce explicit FX invariants", () => {
  const ledger: Ledger = {
    accounts: [
      {
        id: "acc1",
        name: "USD Card",
        type: "credit_card",
        currency: "USD",
        opening_balance: 0,
        opening_date: "2026-01-01",
        color: "#1d5b48",
      },
    ],
    categories: [
      {
        id: "cat1",
        name: "Travel",
        description: "",
        color: "#696198",
      },
    ],
    transactions: [],
  };

  assert.doesNotThrow(() =>
    validateTransaction(
      {
        type: "expense",
        amount: 36725,
        account_id: "acc1",
        to_account_id: null,
        category_id: "cat1",
        date: "2026-03-10",
        payee: "SAMPLE CLOUD",
        notes: "",
        original_currency: "USD",
        original_amount: 10000,
        fx_rate: 3.6725,
      },
      ledger,
    ),
  );

  // Any ISO 4217 currency is accepted (e.g. THB)
  assert.doesNotThrow(() =>
    validateForeignCurrencyFields({
      original_currency: "THB",
      original_amount: 50000,
      fx_rate: 0.105,
      fx_rate_date: "2026-03-10",
      fx_source: "api_estimate",
      fx_status: "estimated",
    }),
  );

  // Unknown 3-letter code rejected strictly, accepted with allowUnknownCode
  assert.throws(
    () =>
      validateForeignCurrencyFields({
        original_currency: "ZZZ",
        original_amount: 10000,
        fx_rate: 1,
      }),
    /Unsupported currency/,
  );
  assert.doesNotThrow(() =>
    validateForeignCurrencyFields(
      {
        original_currency: "ZZZ",
        original_amount: 10000,
        fx_status: "estimated",
      },
      { allowUnknownCode: true },
    ),
  );

  assert.throws(
    () =>
      validateForeignCurrencyFields({
        original_currency: "USD",
        original_amount: -5,
        fx_rate: 3.6725,
      }),
    /zero or greater/,
  );

  assert.throws(
    () =>
      validateForeignCurrencyFields({
        original_currency: "USD",
        original_amount: 10000,
        fx_rate: 0,
      }),
    /greater than zero/,
  );
});

test("transactionsToCsv and backup/restore round-trip preserve multi-currency fields", async () => {
  const ledger: Ledger = {
    accounts: [
      {
        id: "acc1",
        name: "USD Travel Card",
        type: "credit_card",
        currency: "USD",
        opening_balance: 0,
        opening_date: "2026-01-01",
        color: "#1d5b48",
      },
    ],
    categories: [
      {
        id: "cat1",
        name: "Software",
        description: "",
        color: "#696198",
      },
    ],
    transactions: [
      {
        id: "tx1",
        type: "expense",
        amount: 36725,
        account_id: "acc1",
        to_account_id: null,
        category_id: "cat1",
        date: "2026-03-15",
        payee: "Sample Hosting",
        notes: "",
        original_currency: "USD",
        original_amount: 10000,
        fx_rate: 3.6725,
      },
    ],
  };

  const csv = transactionsToCsv(ledger.transactions, ledger);
  const lines = csv.trim().split("\r\n");
  assert.ok(lines[0].includes("Original Amount"));
  assert.ok(lines[1].includes("Sample Hosting"));
  assert.ok(lines[1].includes("100.00"));

  const rawBackup = serializeBackup(createBackup(ledger));
  const { backup } = parseAndValidateBackup(rawBackup);
  assert.equal(backup.data.accounts[0].currency, "USD");
  assert.equal(backup.data.transactions[0].original_currency, "USD");
  assert.equal(backup.data.transactions[0].original_amount, 10000);
  assert.equal(backup.data.transactions[0].fx_rate, 3.6725);

  let nextId = 1;
  const restored = await executeRestore({
    backup,
    mode: "empty",
    existingLedger: { accounts: [], categories: [], transactions: [] },
    existingPresets: [],
    presetStore: { save: async () => {} },
    demo: true,
    demoId: () => `id_${nextId++}`,
  });
  assert.equal(restored.ledger.accounts[0].currency, "USD");
  assert.equal(restored.ledger.transactions[0].original_currency, "USD");
  assert.equal(restored.ledger.transactions[0].original_amount, 10000);
  assert.equal(restored.ledger.transactions[0].fx_rate, 3.6725);
});
