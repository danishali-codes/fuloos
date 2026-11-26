import assert from "node:assert/strict";
import test from "node:test";
import { demoLedger } from "../src/demo.ts";
import { createDefaultSmsLink } from "../src/mobile/smsLinks.ts";
import {
  processSingleSms,
  type SmsEngineContext,
} from "../src/mobile/smsPipeline.ts";
import {
  buildLearnedTemplateFromSpans,
  suggestTeachSelections,
} from "../src/sms/learned.ts";
import {
  deleteWebLearnedTemplate,
  listWebLearnedTemplates,
  recordWebLearnedTemplateHit,
  saveWebLearnedTemplate,
} from "../src/sms/learnedStore.ts";
import { parseSmsV1 } from "../src/sms/parse.ts";

test("learned template stores wording-only skeleton with zero user amounts, merchants, or digits", () => {
  const sampleBody =
    "SAMPLE BANK Alert: Card *4512 movement 74.50 AED | Ref: SAMPLE ROASTERY | 12-11-2026 | Bal 9,820.25";
  const amountStart = sampleBody.indexOf("74.50");
  const merchStart = sampleBody.indexOf("SAMPLE ROASTERY");
  const dateStart = sampleBody.indexOf("12-11-2026");
  const balStart = sampleBody.indexOf("9,820.25");

  const tpl = buildLearnedTemplateFromSpans({
    sender: "SAMPLE BANK",
    body: sampleBody,
    amountSpan: { start: amountStart, end: amountStart + "74.50".length },
    merchantSpan: { start: merchStart, end: merchStart + "SAMPLE ROASTERY".length },
    dateSpan: { start: dateStart, end: dateStart + "12-11-2026".length },
    balanceSpan: { start: balStart, end: balStart + "9,820.25".length },
    direction: "debit",
    txnType: "purchase",
  });

  assert.equal(tpl.template_version, 1);
  assert.equal(tpl.sender_norm, "SAMPLE BANK");

  const serialized = JSON.stringify(tpl);
  for (const forbidden of [
    "74.50",
    "SAMPLE ROASTERY",
    "ROASTERY",
    "4512",
    "12-11-2026",
    "9,820.25",
    "9820",
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `Template JSON leaked personal data "${forbidden}": ${serialized}`,
    );
  }
  assert.match(tpl.pattern.skeleton, /\{CARD\}/);
  assert.match(tpl.pattern.skeleton, /\{AMOUNT\}/);
  assert.match(tpl.pattern.skeleton, /\{CUR\}/);
  assert.match(tpl.pattern.skeleton, /\{MERCHANT\}/);
  assert.match(tpl.pattern.skeleton, /\{DATE\}/);
  assert.match(tpl.pattern.skeleton, /\{BAL\}/);
});

test("SAMPLE BANK: 1 teach action makes the next 3 messages of that shape parse at full confidence (1.0)", () => {
  const firstSms =
    "SAMPLE BANK Alert: Card *0000 movement 74.50 AED | Ref: SAMPLE ROASTERY | 12-11-2026";

  // 1. Before teaching, universal extractor cannot infer direction for vague word "movement"
  const before = parseSmsV1(firstSms, {
    sender: "SAMPLE BANK",
    received_at: "2026-11-12T08:40:00Z",
    account_currency: "AED",
  });
  assert.equal(before.kind, "unknown");

  // 2. Teach Fuloos once using pre-filled suggestions + user direction choice
  const suggestion = suggestTeachSelections(firstSms, "SAMPLE BANK");
  assert.ok(suggestion.amountSpan, "suggestTeachSelections should pre-select amountSpan");
  assert.ok(suggestion.merchantSpan, "suggestTeachSelections should pre-select merchantSpan");
  assert.ok(suggestion.dateSpan, "suggestTeachSelections should pre-select dateSpan");

  const learned = buildLearnedTemplateFromSpans({
    sender: "SAMPLE BANK",
    body: firstSms,
    amountSpan: suggestion.amountSpan!,
    currencySpan: suggestion.currencySpan,
    merchantSpan: suggestion.merchantSpan,
    dateSpan: suggestion.dateSpan,
    balanceSpan: suggestion.balanceSpan,
    direction: "debit",
    txnType: "purchase",
  });

  // 3. The next 3 messages of the same shape (different amounts, currencies, cards, merchants, dates)
  const nextThree = [
    {
      body: "SAMPLE BANK Alert: Card *1234 movement 128.00 AED | Ref: SAMPLE PHARMACY | 13-11-2026",
      received_at: "2026-11-13T10:15:00Z",
      expectedMinor: 12800,
      expectedCurrency: "AED",
      expectedMerchant: /sample pharmacy/i,
      expectedDate: "2026-11-13",
      expectedLast4: "1234",
    },
    {
      body: "SAMPLE BANK Alert: Card *5678 movement 19.95 GBP | Ref: SAMPLE BOOKSHOP | 14-11-2026",
      received_at: "2026-11-14T16:30:00Z",
      expectedMinor: 1995,
      expectedCurrency: "GBP",
      expectedMerchant: /sample bookshop/i,
      expectedDate: "2026-11-14",
      expectedLast4: "5678",
    },
    {
      body: "SAMPLE BANK Alert: Card *9012 movement 45.20 EUR | Ref: SAMPLE BAKERY | 15-11-2026",
      received_at: "2026-11-15T09:05:00Z",
      expectedMinor: 4520,
      expectedCurrency: "EUR",
      expectedMerchant: /sample bakery/i,
      expectedDate: "2026-11-15",
      expectedLast4: "9012",
    },
  ];

  const ledger = demoLedger();
  const acc = ledger.accounts[0]!;
  const ctx: SmsEngineContext = {
    links: [
      {
        id: "link-sample-bank",
        created_at: "2026-11-01T00:00:00Z",
        ...createDefaultSmsLink(acc.id, ["SAMPLE BANK"], ""),
      },
    ],
    accounts: ledger.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      opening_date: a.opening_date,
      currency: a.currency,
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
    categoryMap: {},
    baseModel: null,
    existingKeys: [],
    fxRates: {
      "GBP|AED|2026-11-14": { rate: 4.65, rateDate: "2026-11-14", provider: "test" },
      "EUR|AED|2026-11-15": { rate: 3.98, rateDate: "2026-11-15", provider: "test" },
    },
    learnedTemplates: [learned],
  };

  for (let i = 0; i < nextThree.length; i++) {
    const item = nextThree[i];
    const parsed = parseSmsV1(item.body, {
      sender: "SAMPLE BANK",
      received_at: item.received_at,
      account_currency: "AED",
      learned_templates: [learned],
    });
    assert.equal(parsed.kind, "transaction");
    assert.equal(parsed.parsed_by, `learned:${learned.id}`);
    assert.equal(parsed.confidence.overall, 1.0);
    assert.equal(parsed.direction, "debit");
    assert.equal(parsed.txn_type, "purchase");
    assert.equal(parsed.amount?.minor, item.expectedMinor);
    assert.equal(parsed.amount?.currency, item.expectedCurrency);
    assert.equal(parsed.date, item.expectedDate);
    assert.equal(parsed.instrument.last4, item.expectedLast4);
    assert.match(parsed.counterparty.clean ?? "", item.expectedMerchant);

    // Verify full smsPipeline produces a valid decision with parsedBy = learned:<id>
    const decision = processSingleSms(
      {
        id: `sb-${i}`,
        sender: "SAMPLE BANK",
        body: item.body,
        timestampMs: Date.parse(item.received_at),
      },
      ctx,
    );
    assert.ok(
      decision.action === "auto_add" || decision.action === "needs_review",
      `Expected transaction decision, got ${decision.action}`,
    );
    assert.equal(decision.parsedBy, `learned:${learned.id}`);
    assert.equal(decision.transaction?.original_amount, item.expectedMinor);
    assert.equal(decision.transaction?.original_currency, item.expectedCurrency);
  }
});

test("learnedStore persists, increments hit counts, and deletes templates cleanly", async () => {
  const owner = "test-owner-learned";
  const body = "SAMPLE BANK Alert: Card *0000 movement 50.00 AED | Ref: SAMPLE CAFE | 12-11-2026";
  const sug = suggestTeachSelections(body, "SAMPLE BANK");
  const tpl = buildLearnedTemplateFromSpans({
    sender: "SAMPLE BANK",
    body,
    amountSpan: sug.amountSpan!,
    merchantSpan: sug.merchantSpan,
    dateSpan: sug.dateSpan,
    direction: "debit",
    txnType: "purchase",
  });

  await saveWebLearnedTemplate(owner, tpl);
  const loaded1 = await listWebLearnedTemplates(owner);
  assert.equal(loaded1.length, 1);
  assert.equal(loaded1[0].id, tpl.id);
  assert.equal(loaded1[0].hits, 0);

  await recordWebLearnedTemplateHit(owner, tpl.id);
  const loaded2 = await listWebLearnedTemplates(owner);
  assert.equal(loaded2[0].hits, 1);
  assert.ok(loaded2[0].last_hit_at);

  const deleted = await deleteWebLearnedTemplate(owner, tpl.id);
  assert.equal(deleted, true);
  const loaded3 = await listWebLearnedTemplates(owner);
  assert.equal(loaded3.length, 0);
});
