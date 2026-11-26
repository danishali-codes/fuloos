import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanName,
  dateInText,
  detectBank,
  smsFromBackupXml,
  splitMerchant,
} from "../src/ledger/sms.ts";

function makeMockParser(
  nodes: { attrs: Record<string, string | null> }[],
  hasError = false,
): DOMParser {
  const makeNode = (attrs: Record<string, string | null>) => ({
    getAttribute: (name: string) =>
      Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null,
  });
  return {
    parseFromString: () =>
      ({
        getElementsByTagName: (tag: string) => {
          if (tag === "parsererror") return hasError ? [{}] : [];
          if (tag === "sms") return nodes.map((n) => makeNode(n.attrs));
          return [];
        },
      }) as unknown as Document,
  } as unknown as DOMParser;
}

test("smsFromBackupXml parses received messages in Asia/Dubai and guards invalid dates", () => {
  // 2025-05-05T22:00:00Z is 2025-05-06T02:00:00+04:00 in Asia/Dubai
  const dubaiNextDayMs = String(Date.UTC(2025, 4, 5, 22, 0, 0));
  const parser = makeMockParser([
    {
      attrs: {
        type: "1",
        date: dubaiNextDayMs,
        body: "  Purchase of AED 10.00  ",
        address: "Liv",
      },
    },
    {
      attrs: {
        type: "2",
        date: dubaiNextDayMs,
        body: "Sent message should be ignored",
        address: "Me",
      },
    },
    {
      attrs: {
        type: "1",
        date: "9000000000000000000", // > max JS Date (~8.64e15) -> Invalid Date
        body: "Huge timestamp",
        address: "ADCB",
      },
    },
    {
      attrs: {
        type: "1",
        date: "not-a-number",
        body: "Bad timestamp",
        address: "FAB",
      },
    },
    {
      attrs: {
        type: "1",
        date: dubaiNextDayMs,
        body: "   ",
        address: "Liv",
      },
    },
  ]);

  const rows = smsFromBackupXml("<smses/>", parser);
  assert.deepEqual(rows, [
    { message: "Purchase of AED 10.00", date: "2025-05-06", sender: "Liv" },
    { message: "Huge timestamp", date: null, sender: "ADCB" },
    { message: "Bad timestamp", date: null, sender: "FAB" },
  ]);

  assert.throws(
    () => smsFromBackupXml("<bad>", makeMockParser([], true)),
    /not a valid SMS backup XML/,
  );
});

test("splitMerchant extracts merchant, location, and country per bank", () => {
  assert.deepEqual(splitMerchant(null, "ADCB"), [null, null, null]);
  assert.deepEqual(splitMerchant("   ", "Liv"), [null, null, null]);
  assert.deepEqual(splitMerchant("ADNOC 123, DUBAI - AE", "ADCB"), [
    "ADNOC 123",
    "DUBAI",
    "AE",
  ]);
  assert.deepEqual(splitMerchant("TALABAT, DUBAI", "Liv"), [
    "TALABAT",
    "DUBAI",
    null,
  ]);
  assert.deepEqual(splitMerchant("NETFLIX.COM Amsterdam NL", "FAB"), [
    "NETFLIX.COM",
    "Amsterdam",
    "NL",
  ]);
  assert.deepEqual(
    splitMerchant("ASTER PHARMACY in DUBAI, UNITED ARAB EMI", "ADIB"),
    ["ASTER PHARMACY", "DUBAI", "AE"],
  );
  assert.deepEqual(splitMerchant("CARREFOUR MOE", "Mashreq"), [
    "CARREFOUR MOE",
    null,
    null,
  ]);
});

test("cleanName normalizes canonical brands and strips payment prefixes and noise", () => {
  assert.equal(cleanName(null), null);
  assert.equal(cleanName("  "), null);
  assert.equal(cleanName("TALABAT.COM DUBAI"), "Talabat");
  assert.equal(cleanName("SP * MY COFFEE SHOP 1234"), "MY COFFEE SHOP");
  assert.equal(cleanName("TAP* BAKERY #45"), "BAKERY");
});

test("detectBank selects the bank matching the most messages", () => {
  assert.equal(detectBank(["hello world"]), null);
  assert.equal(
    detectBank([
      "Purchase of AED 45.00 with Debit Card ending 1234 at TALABAT, DUBAI. Avl Bal is AED 1,000.00",
      "Purchase of AED 20.00 with Debit Card ending 1234 at CAREEM, DUBAI. Avl Bal is AED 980.00",
      "Cr.Card ***9876 used for AED 120.00 on 03/05/2025 12:30 at ADNOC 123,DUBAI-AE. Avl. Cr.limit is AED 5000.00",
    ]),
    "Liv",
  );
});

test("dateInText skips invalid slash dates and finds subsequent valid dates", () => {
  assert.equal(dateInText("ref 31/02/2025 posted 05/05/2025"), "2025-05-05");
  assert.equal(dateInText("on 04/05/25 10:11"), "2025-05-04");
  assert.equal(dateInText("on 05-MAY-2025"), "2025-05-05");
  assert.equal(dateInText("on 31-FEB-2025"), null);
});

test("multi-currency SMS parsing extracts GBP, EUR, INR, JPY, KWD, symbols, Arabic-Indic digits, billed amounts, and never mistakes credit limits for amounts", async () => {
  const {
    extractBilledAmount,
    extractCurrencyAmount,
    normalizeSmsDigits,
    parseSms,
  } = await import("../src/ledger/sms.ts");

  // 1. Acceptance check: GBP 12.00 + Avl Cr. Limit AED 7,000.00 -> GBP 1200, NOT AED 7000
  const gbp = parseSms(
    "Purchase of GBP 12.00 with Credit Card ending 0000 at SAMPLE STORE LONDON. Avl Cr. Limit is AED 7,000.00",
    "Liv",
  );
  assert.equal(gbp.currency, "GBP");
  assert.equal(gbp.amount_minor, 1200);
  assert.equal(gbp.billed_amount_minor, null);
  assert.equal(gbp.balance_after, 7000);

  // 2. JPY 0 decimals
  const jpy = parseSms(
    "Purchase of JPY 1,500 with Credit Card ending 0000 at SAMPLE RAMEN TOKYO. Avl Bal is AED 5,000.00",
    "Liv",
  );
  assert.equal(jpy.currency, "JPY");
  assert.equal(jpy.amount_minor, 1500);

  // 3. KWD 3 decimals
  const kwd = parseSms(
    "Purchase of KWD 2.500 with Credit Card ending 0000 at SAMPLE BAKERY KUWAIT. Avl Bal is AED 5,000.00",
    "Liv",
  );
  assert.equal(kwd.currency, "KWD");
  assert.equal(kwd.amount_minor, 2500);

  // 4. Unknown 3-letter currency code: does not crash, assumes exponent 2, warns unknown_currency_code
  const unknown = parseSms(
    "Purchase of ZZZ 42.50 with Credit Card ending 0000 at SAMPLE VENDOR. Avl Bal is AED 1,000.00",
    "Liv",
  );
  assert.equal(unknown.currency, "ZZZ");
  assert.equal(unknown.amount_minor, 4250);
  assert.deepEqual(unknown.warnings, ["unknown_currency_code"]);

  // 5. Dual amount: foreign + billed AED amount
  const dual = parseSms(
    "Purchase of GBP 12.00 (AED 56.10 billed) with Credit Card ending 0000 at SAMPLE STORE LONDON. Avl Cr. Limit is AED 7,000.00",
    "Liv",
  );
  assert.equal(dual.currency, "GBP");
  assert.equal(dual.amount_minor, 1200);
  assert.equal(dual.billed_currency, "AED");
  assert.equal(dual.billed_amount_minor, 5610);

  // 6. Code before, code after, no space, and currency symbols
  assert.equal(extractCurrencyAmount("Spent 24.50 EUR at SAMPLE CAFE")?.currency, "EUR");
  assert.equal(extractCurrencyAmount("Spent 24.50 EUR at SAMPLE CAFE")?.amountMinor, 2450);
  assert.equal(extractCurrencyAmount("Paid GBP12 at SAMPLE SHOP")?.amountMinor, 1200);
  assert.equal(extractCurrencyAmount("Charged €19.99 at SAMPLE STREAM")?.currency, "EUR");
  assert.equal(extractCurrencyAmount("Charged £12.00 at SAMPLE STORE")?.currency, "GBP");
  assert.equal(extractCurrencyAmount("Charged ₹1,250.00 at SAMPLE MART")?.currency, "INR");
  assert.equal(extractCurrencyAmount("Charged ₹1,250.00 at SAMPLE MART")?.amountMinor, 125000);
  assert.equal(extractCurrencyAmount("Paid $15.00 at SAMPLE CLOUD")?.currency, "USD");
  // `$` must NOT become USD when another ISO currency code is present
  assert.equal(extractCurrencyAmount("Paid CAD $15.00 at SAMPLE STORE")?.currency, "CAD");

  // 7. Arabic-Indic digits
  assert.equal(normalizeSmsDigits("GBP ١٢٫٠٠"), "GBP 12.00");
  const arabic = parseSms(
    "Purchase of GBP ١٢٫٠٠ with Credit Card ending ٠٠٠٠ at SAMPLE STORE. Avl Bal is AED ٧٬٠٠٠٫٠٠",
    "Liv",
  );
  assert.equal(arabic.currency, "GBP");
  assert.equal(arabic.amount_minor, 1200);

  // 8. Balance / credit limit only SMS yields NO extracted amount
  assert.equal(
    extractCurrencyAmount("Your Avl Cr. Limit is AED 7,000.00. Available Balance is AED 3,500.00."),
    null,
  );
  assert.equal(
    extractBilledAmount("Purchase of GBP 12.00 at SAMPLE STORE. Avl Cr. Limit is AED 7,000.00", "GBP"),
    null,
  );
});

