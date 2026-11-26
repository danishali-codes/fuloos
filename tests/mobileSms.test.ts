import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { transactionKey } from "../src/csv.ts";
import { demoLedger } from "../src/demo.ts";
import type { CapturedAlert, TransactionRule } from "../src/domain.ts";
import {
  createDefaultSmsLink,
  extractCardLast4,
  matchSmsToLink,
  normalizeCardLast4,
  normalizeSender,
  validateSmsLink,
  type SmsAccountLink,
} from "../src/mobile/smsLinks.ts";
import {
  buildCapturedAlertDraft,
  collectExistingDedupeKeys,
  groupBackfillForReview,
  processSingleSms,
  sha256Hex,
  type RawNativeSms,
  type SmsEngineContext,
} from "../src/mobile/smsPipeline.ts";

function makeLink(
  id: string,
  accountId: string,
  senders: string[],
  overrides: Partial<SmsAccountLink> = {},
): SmsAccountLink {
  return {
    id,
    created_at: "2026-11-01T00:00:00.000Z",
    ...createDefaultSmsLink(
      accountId,
      senders,
      overrides.bank_template ?? null,
      overrides.card_last4 ?? null,
    ),
    ...overrides,
  };
}

function buildTestContext(
  links: SmsAccountLink[],
  overrides: Partial<SmsEngineContext> = {},
): SmsEngineContext {
  const ledger = demoLedger();
  const catByName = (needle: string) =>
    ledger.categories.find((c) => c.name.toLowerCase().includes(needle))?.id ??
    "";

  const categoryMap: Record<string, string> = {
    Food_Dining: catByName("dining") || catByName("food"),
    Groceries: catByName("grocer"),
    Transport_Auto: catByName("transport"),
    Shopping_Retail: catByName("shop"),
    Utilities_Telecom: catByName("bill") || catByName("utilit"),
  };

  return {
    links,
    accounts: ledger.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      opening_date: a.opening_date,
    })),
    categories: ledger.categories.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      emoji: c.emoji,
    })),
    rules: [],
    learningSettings: null,
    learningExamples: [],
    categoryMap,
    baseModel: null,
    existingKeys: [],
    ...overrides,
  };
}

test("smsLinks: normalizes sender IDs and extracts 4-digit card suffixes", () => {
  assert.equal(normalizeSender("  adcb  "), "ADCB");
  assert.equal(normalizeSender("AD-ADCB"), "ADCB");
  assert.equal(normalizeSender("Emirates  NBD"), "EMIRATES NBD");
  assert.equal(normalizeCardLast4("xx4512"), "4512");
  assert.equal(normalizeCardLast4("123"), null);

  assert.equal(
    extractCardLast4(
      "AED 48.50 spent on your ADCB Card XX4512 at TALABAT, DUBAI.",
      null,
    ),
    "4512",
  );
  assert.equal(
    extractCardLast4(
      "Purchase of AED 142.00 with Debit Card ending 3319 at ENOC 1042.",
      null,
    ),
    "3319",
  );
  assert.equal(
    extractCardLast4("Card ****8891 used for AED 19.00 at ZOOM.", null),
    "8891",
  );
  assert.equal(
    extractCardLast4("Your OTP is 482910. Do not share.", null),
    null,
  );
});

test("smsLinks: card_last4 routing takes priority over catch-all link on the same bank sender", () => {
  const debitLink = makeLink("link-debit", "acc-debit", ["ADCB"], {
    card_last4: "4512",
  });
  const creditLink = makeLink("link-credit", "acc-credit", ["ADCB"], {
    card_last4: "8891",
  });
  const catchAllLink = makeLink("link-catchall", "acc-fallback", ["ADCB"], {
    card_last4: null,
  });
  const disabledLink = makeLink("link-disabled", "acc-disabled", ["Liv"], {
    enabled: false,
  });

  const links = [catchAllLink, debitLink, creditLink, disabledLink];

  assert.equal(matchSmsToLink("ADCB", "4512", links)?.account_id, "acc-debit");
  assert.equal(matchSmsToLink("AD-ADCB", "8891", links)?.account_id, "acc-credit");
  assert.equal(matchSmsToLink("ADCB", "9999", links)?.account_id, "acc-fallback");
  assert.equal(matchSmsToLink("ADCB", null, links)?.account_id, "acc-fallback");
  assert.equal(matchSmsToLink("Liv", "3319", links), null);

  // Without catch-all, an unlinked card on the same sender returns null.
  assert.equal(matchSmsToLink("ADCB", "9999", [debitLink, creditLink]), null);
});

test("smsLinks: validateSmsLink allows distinct cards on same sender but rejects duplicates", () => {
  const accounts = [
    { id: "acc-debit" },
    { id: "acc-credit" },
    { id: "acc-other" },
  ];
  const debitLink = makeLink("link-debit", "acc-debit", ["ADCB"], {
    card_last4: "4512",
  });
  const creditLink = makeLink("link-credit", "acc-credit", ["ADCB"], {
    card_last4: "8891",
  });
  const duplicateDebit = makeLink("link-dup", "acc-other", ["ADCB"], {
    card_last4: "4512",
  });

  assert.doesNotThrow(() => validateSmsLink(creditLink, accounts, [debitLink]));
  assert.throws(
    () => validateSmsLink(duplicateDebit, accounts, [debitLink]),
    /already linked/i,
  );
});

test("smsPipeline: pure JS sha256Hex matches Node crypto including Unicode", () => {
  for (const sample of ["", "ADCB|1700000000|AED 50", "فلوس · Talabat 48.50"]) {
    const expected = crypto
      .createHash("sha256")
      .update(sample, "utf8")
      .digest("hex");
    assert.equal(sha256Hex(sample), expected);
  }
});

test("smsPipeline: routes multi-card bank SMSes, auto-adds high-confidence brands, applies rules, and flags low-confidence merchants", () => {
  const ledger = demoLedger();
  const checking = ledger.accounts[0]!;
  const cardAcc = ledger.accounts[1] ?? ledger.accounts[0]!;
  const coffeeCat = ledger.categories[0]!;

  const debitLink = makeLink("link-debit", checking.id, ["ADCB"], {
    card_last4: "4512",
    bank_template: "ADCB",
    confidence_threshold: 0.6,
  });
  const creditLink = makeLink("link-credit", cardAcc.id, ["ADCB"], {
    card_last4: "8891",
    bank_template: "ADCB",
    confidence_threshold: 0.6,
  });

  const customRule: TransactionRule = {
    id: "rule-1",
    name: "Specialty Coffee",
    enabled: true,
    priority: 10,
    match_field: "either",
    match_type: "contains",
    pattern: "boon specialty",
    min_amount: null,
    max_amount: null,
    set_category_id: coffeeCat.id,
    add_tags: ["coffee"],
    set_payee: "Boon Coffee",
  };

  const ctx = buildTestContext([debitLink, creditLink], {
    rules: [customRule],
  });

  // 1) High-confidence brand on debit card XX4512
  const talabatDecision = processSingleSms(
    {
      id: "101",
      sender: "ADCB",
      timestampMs: Date.UTC(2026, 10, 7, 10, 0, 0),
      body: "AED 48.50 spent on your ADCB Card XX4512 at TALABAT, DUBAI-AE on 07/11/2026. Avl Bal is AED 4,210.50.",
    },
    ctx,
  );
  assert.equal(talabatDecision.action, "auto_add");
  assert.equal(talabatDecision.accountId, checking.id);
  assert.equal(talabatDecision.cardLast4, "4512");
  assert.equal(talabatDecision.transaction?.amount, 4850);
  assert.equal(talabatDecision.transaction?.type, "expense");
  assert.equal(talabatDecision.transaction?.category_id, "food");
  assert.equal(talabatDecision.balanceAfter, 421050);

  // 2) Different card XX8891 on same sender routes to credit card account
  const carrefourDecision = processSingleSms(
    {
      id: "102",
      sender: "ADCB",
      timestampMs: Date.UTC(2026, 10, 13, 12, 0, 0),
      body: "AED 184.25 spent on your ADCB Card XX8891 at CARREFOUR, DUBAI-AE on 13/11/2026. Avl Bal is AED 12,400.00.",
    },
    ctx,
  );
  assert.equal(carrefourDecision.action, "auto_add");
  assert.equal(carrefourDecision.accountId, cardAcc.id);
  assert.equal(carrefourDecision.cardLast4, "8891");
  assert.equal(carrefourDecision.transaction?.amount, 18425);
  assert.equal(carrefourDecision.transaction?.category_id, "groceries");

  // 3) User rule override wins with confidence 1.0 and sets payee + tags
  const ruleDecision = processSingleSms(
    {
      id: "103",
      sender: "ADCB",
      timestampMs: Date.UTC(2026, 10, 9, 8, 30, 0),
      body: "AED 32.00 spent on your ADCB Card XX4512 at BOON SPECIALTY COFFEE, DUBAI-AE on 09/11/2026.",
    },
    ctx,
  );
  assert.equal(ruleDecision.action, "auto_add");
  assert.equal(ruleDecision.decidedBy, "user rule");
  assert.equal(ruleDecision.confidence, 1);
  assert.equal(ruleDecision.transaction?.category_id, coffeeCat.id);
  assert.equal(ruleDecision.transaction?.payee, "Boon Coffee");
  assert.deepEqual(ruleDecision.transaction?.tags, ["coffee"]);

  // 4) Unfamiliar merchant → needs_review + masked PocketBase draft
  const unknownDecision = processSingleSms(
    {
      id: "104",
      sender: "ADCB",
      timestampMs: Date.UTC(2026, 10, 14, 15, 0, 0),
      body: "AED 76.00 spent on your ADCB Card XX4512 at AL MARWA VENTURES 9876543210, SHARJAH on 14/11/2026.",
    },
    ctx,
  );
  assert.equal(unknownDecision.action, "needs_review");
  assert.equal(unknownDecision.accountId, checking.id);
  assert.equal(unknownDecision.transaction?.amount, 7600);

  const draft = buildCapturedAlertDraft(unknownDecision);
  assert.equal(draft.source, "sms_native");
  assert.equal(draft.account_id, checking.id);
  assert.equal(draft.card_last4, "4512");
  assert.equal(draft.sms_sender, "ADCB");
  assert.equal(draft.parsed_amount, 7600);
  // Privacy: long digit strings must be masked before syncing to PocketBase.
  assert.ok(!draft.raw_text.includes("9876543210"));

  // 5) OTP is skipped
  const otpDecision = processSingleSms(
    {
      id: "105",
      sender: "ADCB",
      timestampMs: Date.UTC(2026, 10, 14, 15, 5, 0),
      body: "Your OTP for ADCB online payment is 482910. Do not share it with anyone.",
    },
    ctx,
  );
  assert.equal(otpDecision.action, "skip");

  // 6) Existing duplicate key is skipped
  const dupCtx = buildTestContext([debitLink], {
    existingKeys: [transactionKey(talabatDecision.transaction!)],
  });
  const dupDecision = processSingleSms(
    {
      id: "106",
      sender: "ADCB",
      timestampMs: Date.UTC(2026, 10, 7, 10, 0, 0),
      body: "AED 48.50 spent on your ADCB Card XX4512 at TALABAT, DUBAI-AE on 07/11/2026.",
    },
    dupCtx,
  );
  assert.equal(dupDecision.action, "skip");
  assert.equal(dupDecision.duplicate, true);
});

test("smsPipeline: groupBackfillForReview groups repeated unfamiliar merchants together", () => {
  const ledger = demoLedger();
  const checking = ledger.accounts[0]!;
  const link = makeLink("link-1", checking.id, ["ADCB"], {
    bank_template: "ADCB",
  });
  const ctx = buildTestContext([link]);

  const rawBatch: RawNativeSms[] = [
    {
      id: "b1",
      sender: "ADCB",
      timestampMs: Date.UTC(2026, 10, 1, 9, 0, 0),
      body: "AED 48.50 spent on your ADCB Card XX4512 at TALABAT, DUBAI-AE on 01/11/2026. Avl Bal is AED 5,000.00.",
    },
    {
      id: "b2",
      sender: "ADCB",
      timestampMs: Date.UTC(2026, 10, 5, 9, 0, 0),
      body: "AED 32.00 spent on your ADCB Card XX4512 at ZYLO STUDIO LLC, DUBAI on 05/11/2026. Avl Bal is AED 4,968.00.",
    },
    {
      id: "b3",
      sender: "ADCB",
      timestampMs: Date.UTC(2026, 10, 9, 9, 0, 0),
      body: "AED 28.00 spent on your ADCB Card XX4512 at ZYLO STUDIO LLC, DUBAI on 09/11/2026. Avl Bal is AED 4,940.00.",
    },
  ];

  const decisions = rawBatch.map((m) => processSingleSms(m, ctx));
  const summary = groupBackfillForReview(decisions);

  assert.equal(summary.totalScanned, 3);
  assert.equal(summary.readyToImport.length, 1);
  assert.equal(summary.lowConfidenceItems.length, 2);
  assert.equal(summary.merchantGroups.length, 1);
  assert.equal(summary.merchantGroups[0]!.count, 2);
  assert.equal(summary.merchantGroups[0]!.totalFils, 6000);
  assert.equal(summary.oldestDate, "2026-11-01");
  assert.equal(summary.newestDate, "2026-11-09");
  assert.equal(summary.earliestBalanceAfter, 500000);
  assert.equal(summary.latestBalanceAfter, 494000);
});

test("headless bundle android/app/src/main/assets/fuloos-sms-engine.js runs inside a bare JS isolate", async () => {
  const bundleCode = await readFile(
    new URL(
      "../android/app/src/main/assets/fuloos-sms-engine.js",
      import.meta.url,
    ),
    "utf8",
  );

  // Simulate Android Jetpack JavaScriptSandbox: no window, document, fetch, or Node globals.
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  runInNewContext(bundleCode, sandbox);

  const engine = sandbox.FuloosSmsEngine as {
    version: string;
    processSmsJson: (raw: string, ctx: string) => string;
    processBatchJson: (rawList: string, ctx: string) => string;
    matchSenderJson: (sender: string, body: string, links: string) => string;
  };

  assert.ok(engine);
  assert.equal(typeof engine.processSmsJson, "function");
  assert.equal(typeof engine.processBatchJson, "function");

  const ledger = demoLedger();
  const link = makeLink("link-headless", ledger.accounts[0]!.id, ["ADCB"], {
    card_last4: "4512",
  });
  const ctx = buildTestContext([link]);

  const singleOut = JSON.parse(
    engine.processSmsJson(
      JSON.stringify({
        id: "h1",
        sender: "ADCB",
        timestampMs: Date.UTC(2026, 10, 15, 11, 0, 0),
        body: "AED 65.00 spent on your ADCB Card XX4512 at ZYLO STUDIO LLC, DUBAI on 15/11/2026.",
      }),
      JSON.stringify(ctx),
    ),
  ) as {
    action: string;
    capturedAlertDraft?: {
      source: string;
      account_id: string;
      parsed_amount: number;
    };
  };

  assert.equal(singleOut.action, "needs_review");
  assert.equal(singleOut.capturedAlertDraft?.source, "sms_native");
  assert.equal(singleOut.capturedAlertDraft?.account_id, ledger.accounts[0]!.id);
  assert.equal(singleOut.capturedAlertDraft?.parsed_amount, 6500);
});

test("migration 1794860000_native_sms_capture extends fuloos_captured_alerts and triggers cleanly", async () => {
  const sourceField = {
    name: "source",
    type: "select",
    values: ["email", "shortcut"],
  };
  const fields: Array<Record<string, unknown>> = [sourceField];
  const executedSql: string[] = [];

  const col = {
    name: "fuloos_captured_alerts",
    fields: {
      getByName: (name: string) => fields.find((f) => f.name === name) ?? null,
      add: (f: Record<string, unknown>) => fields.push(f),
      removeByName: (name: string) => {
        const idx = fields.findIndex((f) => f.name === name);
        if (idx >= 0) fields.splice(idx, 1);
      },
    },
  };

  let savedCount = 0;
  let upFn!: (app: unknown) => void;
  let downFn!: (app: unknown) => void;

  const app = {
    findCollectionByNameOrId: (name: string) => {
      assert.equal(name, "fuloos_captured_alerts");
      return col;
    },
    save: () => {
      savedCount++;
    },
    db: () => ({
      newQuery: (sql: string) => ({
        execute: () => {
          executedSql.push(sql);
        },
      }),
    }),
  };

  runInNewContext(
    await readFile(
      new URL(
        "../pocketbase/pb_migrations/1794860000_native_sms_capture.js",
        import.meta.url,
      ),
      "utf8",
    ),
    {
      migrate: (up: (app: unknown) => void, down: (app: unknown) => void) => {
        upFn = up;
        downFn = down;
      },
      TextField: function (spec: Record<string, unknown>) {
        return spec;
      },
      NumberField: function (spec: Record<string, unknown>) {
        return spec;
      },
      JSONField: function (spec: Record<string, unknown>) {
        return spec;
      },
    },
  );

  upFn(app);
  assert.equal(savedCount, 1);
  assert.deepEqual(sourceField.values, ["email", "shortcut", "sms_native"]);
  for (const fieldName of [
    "account_id",
    "suggested_category_id",
    "confidence",
    "top_suggestions",
    "sms_sender",
    "card_last4",
  ]) {
    assert.ok(
      fields.some((f) => f.name === fieldName),
      `expected field ${fieldName}`,
    );
  }

  const createTriggers = executedSql.filter((s) =>
    s.startsWith("CREATE TRIGGER"),
  );
  assert.equal(createTriggers.length, 2);
  for (const sql of createTriggers) {
    assert.match(sql, /'sms_native'/);
    assert.match(sql, /fuloos_accounts/);
    assert.match(sql, /NEW\.confidence < 0 OR NEW\.confidence > 1/);
  }

  // Rollback restores original schema and triggers cleanly.
  downFn(app);
  assert.deepEqual(sourceField.values, ["email", "shortcut"]);
  assert.equal(fields.length, 1);
});

test("collectExistingDedupeKeys: deduplicates existing ledger transactions and pending native captured alerts", () => {
  const ledger = demoLedger();
  const checking = ledger.accounts[0]!;
  const link = makeLink("link-dedupe", checking.id, ["ADCB"], {
    bank_template: "ADCB",
    confidence_threshold: 0.6,
  });

  const rawSms: RawNativeSms = {
    id: "501",
    sender: "ADCB",
    timestampMs: Date.UTC(2026, 10, 14, 9, 0, 0),
    body: "AED 64.00 spent on your ADCB Card XX4512 at AL MARWA VENTURES, SHARJAH on 14/11/2026.",
  };

  // First evaluation produces a needs_review decision & pending captured alert draft.
  const initialCtx = buildTestContext([link]);
  const initialDecision = processSingleSms(rawSms, initialCtx);
  assert.equal(initialDecision.action, "needs_review");
  const draft = buildCapturedAlertDraft(initialDecision);

  const pendingAlert: CapturedAlert = {
    id: "alert0000000001",
    ...draft,
    status: "pending",
  };
  const dismissedAlert: CapturedAlert = {
    id: "alert0000000002",
    ...draft,
    parsed_amount: 9900,
    status: "dismissed",
  };

  const existingKeys = collectExistingDedupeKeys(
    ledger.transactions,
    [pendingAlert, dismissedAlert],
    checking.id,
  );

  // Subsequent scan (backfill or catch-up) recognizes the pending alert as already captured.
  const dedupedCtx = buildTestContext([link], { existingKeys });
  const secondDecision = processSingleSms(rawSms, dedupedCtx);
  assert.equal(secondDecision.duplicate, true);
  assert.equal(secondDecision.action, "skip");

  // Dismissed alerts are not treated as duplicates.
  const dismissedSms: RawNativeSms = {
    ...rawSms,
    id: "502",
    body: "AED 99.00 spent on your ADCB Card XX4512 at AL MARWA VENTURES, SHARJAH on 14/11/2026.",
  };
  const dismissedDecision = processSingleSms(dismissedSms, dedupedCtx);
  assert.equal(dismissedDecision.duplicate, false);
  assert.equal(dismissedDecision.action, "needs_review");

  // Existing ledger transactions are included in the dedupe key set.
  assert.ok(existingKeys.includes(transactionKey(ledger.transactions[0]!)));

  // Large ledgers (>5,000 rows) are never truncated by default during historical backfill.
  const largeLedger = Array.from({ length: 5050 }, (_, idx) => ({
    account_id: checking.id,
    to_account_id: null,
    date: `2020-01-${String((idx % 28) + 1).padStart(2, "0")}`,
    type: "expense" as const,
    amount: 100 + idx,
    payee: `Merchant ${idx}`,
  }));
  assert.equal(collectExistingDedupeKeys(largeLedger).length, 5050);
  assert.equal(collectExistingDedupeKeys(largeLedger, [], undefined, 5000).length, 5000);
});

test("smsPipeline: multi-currency golden tests (GBP+limit, EUR, INR, JPY, KWD, unknown, billed AED, balance-only, offline)", () => {
  const ledger = demoLedger();
  const aedAcc = ledger.accounts[0]!;
  const link = makeLink("link-mc", aedAcc.id, ["SAMPLEBANK"], {
    card_last4: "0000",
    auto_add_mode: "auto_high_confidence",
    confidence_threshold: 0.6,
  });

  const baseFxRates = {
    "GBP|AED|2026-03-10": { rate: 4.65, rateDate: "2026-03-10", provider: "fawazahmed0" },
    "EUR|AED|2026-03-10": { rate: 4.02, rateDate: "2026-03-10", provider: "fawazahmed0" },
    "INR|AED|2026-03-10": { rate: 0.043, rateDate: "2026-03-10", provider: "fawazahmed0" },
    "JPY|AED|2026-03-10": { rate: 0.024, rateDate: "2026-03-10", provider: "fawazahmed0" },
    "KWD|AED|2026-03-10": { rate: 11.96, rateDate: "2026-03-10", provider: "fawazahmed0" },
  };
  const ts = Date.UTC(2026, 2, 10, 10, 0, 0);
  const ctx = buildTestContext([link], { fxRates: baseFxRates });

  // 1. Acceptance check: GBP 12.00 + Avl Cr. Limit AED 7,000.00 -> GBP 1200, AED 5580 estimated, NEVER AED 7000
  const gbpRes = processSingleSms(
    {
      id: "mc-1",
      sender: "SAMPLEBANK",
      timestampMs: ts,
      body: "Purchase of GBP 12.00 with Credit Card ending 0000 at SAMPLE STORE LONDON. Avl Cr. Limit is AED 7,000.00",
    },
    ctx,
  );
  assert.notEqual(gbpRes.action, "skip");
  assert.equal(gbpRes.transaction?.original_currency, "GBP");
  assert.equal(gbpRes.transaction?.original_amount, 1200);
  assert.equal(gbpRes.transaction?.amount, 5580);
  assert.equal(gbpRes.transaction?.fx_rate, 4.65);
  assert.equal(gbpRes.transaction?.fx_source, "api_estimate");
  assert.equal(gbpRes.transaction?.fx_status, "estimated");

  // 2. EUR via symbol and generic fallback
  const eurRes = processSingleSms(
    {
      id: "mc-2",
      sender: "SAMPLEBANK",
      timestampMs: ts,
      body: "Card ending 0000 spent €25.00 at SAMPLE BISTRO PARIS. Avl Cr. Limit is AED 7,000.00",
    },
    ctx,
  );
  assert.equal(eurRes.transaction?.original_currency, "EUR");
  assert.equal(eurRes.transaction?.original_amount, 2500);
  assert.equal(eurRes.transaction?.amount, 10050);
  assert.equal(eurRes.transaction?.fx_status, "estimated");

  // 3. INR
  const inrRes = processSingleSms(
    {
      id: "mc-3",
      sender: "SAMPLEBANK",
      timestampMs: ts,
      body: "Purchase of INR 1,000.00 with Credit Card ending 0000 at SAMPLE MARKET MUMBAI. Avl Bal is AED 4,000.00",
    },
    ctx,
  );
  assert.equal(inrRes.transaction?.original_currency, "INR");
  assert.equal(inrRes.transaction?.original_amount, 100000);
  assert.equal(inrRes.transaction?.amount, 4300);

  // 4. JPY (0 decimals): JPY 1,500 -> original_amount = 1500
  const jpyRes = processSingleSms(
    {
      id: "mc-4",
      sender: "SAMPLEBANK",
      timestampMs: ts,
      body: "Purchase of JPY 1,500 with Credit Card ending 0000 at SAMPLE RAMEN TOKYO. Avl Bal is AED 4,000.00",
    },
    ctx,
  );
  assert.equal(jpyRes.transaction?.original_currency, "JPY");
  assert.equal(jpyRes.transaction?.original_amount, 1500);
  assert.equal(jpyRes.transaction?.amount, 3600);

  // 5. KWD (3 decimals): KWD 2.500 -> original_amount = 2500
  const kwdRes = processSingleSms(
    {
      id: "mc-5",
      sender: "SAMPLEBANK",
      timestampMs: ts,
      body: "Purchase of KWD 2.500 with Credit Card ending 0000 at SAMPLE BAKERY. Avl Bal is AED 4,000.00",
    },
    ctx,
  );
  assert.equal(kwdRes.transaction?.original_currency, "KWD");
  assert.equal(kwdRes.transaction?.original_amount, 2500);
  assert.equal(kwdRes.transaction?.amount, 2990);

  // 6. Unknown 3-letter code -> keeps transaction, exponent 2, warns unknown_currency_code, routes to needs_review
  const unknownRes = processSingleSms(
    {
      id: "mc-6",
      sender: "SAMPLEBANK",
      timestampMs: ts,
      body: "Purchase of ZZZ 42.50 with Credit Card ending 0000 at SAMPLE VENDOR. Avl Bal is AED 4,000.00",
    },
    ctx,
  );
  assert.equal(unknownRes.action, "needs_review");
  assert.equal(unknownRes.transaction?.original_currency, "ZZZ");
  assert.equal(unknownRes.transaction?.original_amount, 4250);
  assert.equal(unknownRes.transaction?.fx_status, "estimated");
  assert.ok(unknownRes.warnings?.includes("unknown_currency_code"));

  // 7. Dual foreign + billed AED amount -> bank_sms + exact, implied rate 4.675
  const billedRes = processSingleSms(
    {
      id: "mc-7",
      sender: "SAMPLEBANK",
      timestampMs: ts,
      body: "Purchase of GBP 12.00 (AED 56.10 billed) with Credit Card ending 0000 at SAMPLE STORE LONDON. Avl Cr. Limit is AED 7,000.00",
    },
    ctx,
  );
  assert.equal(billedRes.transaction?.original_currency, "GBP");
  assert.equal(billedRes.transaction?.original_amount, 1200);
  assert.equal(billedRes.transaction?.amount, 5610);
  assert.equal(billedRes.transaction?.fx_rate, 4.675);
  assert.equal(billedRes.transaction?.fx_source, "bank_sms");
  assert.equal(billedRes.transaction?.fx_status, "exact");

  // 8. Balance / credit limit only SMS -> skipped, NEVER becomes a transaction amount
  const limitOnlyRes = processSingleSms(
    {
      id: "mc-8",
      sender: "SAMPLEBANK",
      timestampMs: ts,
      body: "Card ending 0000 alert: Avl Cr. Limit is AED 7,000.00. Available balance is AED 3,500.00.",
    },
    ctx,
  );
  assert.equal(limitOnlyRes.action, "skip");
  assert.equal(limitOnlyRes.transaction, undefined);

  // 9. Offline with no cached FX rate -> saved as needs_review with rate_unavailable, NEVER skipped
  const offlineCtx = buildTestContext([link], { fxRates: {} });
  const offlineRes = processSingleSms(
    {
      id: "mc-9",
      sender: "SAMPLEBANK",
      timestampMs: ts,
      body: "Purchase of GBP 12.00 with Credit Card ending 0000 at TALABAT. Avl Cr. Limit is AED 7,000.00",
    },
    offlineCtx,
  );
  assert.equal(offlineRes.action, "needs_review");
  assert.equal(offlineRes.transaction?.original_currency, "GBP");
  assert.equal(offlineRes.transaction?.original_amount, 1200);
  assert.equal(offlineRes.transaction?.amount, 0);
  assert.equal(offlineRes.transaction?.fx_status, "estimated");
  assert.ok(offlineRes.warnings?.includes("rate_unavailable"));
  assert.deepEqual(offlineRes.needsFxRate, { from: "GBP", to: "AED", date: "2026-03-10" });
});


