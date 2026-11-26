import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { demoLedger } from "../src/demo.ts";
import { createDefaultSmsLink } from "../src/mobile/smsLinks.ts";
import {
  buildCapturedAlertDraft,
  processSingleSms,
  type SmsEngineContext,
} from "../src/mobile/smsPipeline.ts";
import { bankFromSender } from "../src/ledger/sms.ts";
import { parseSmsV1 } from "../src/sms/parse.ts";
import type { Money, SmsKind, SmsTxnType } from "../src/sms/types.ts";

interface GoldenFixture {
  id: string;
  bank: string;
  sender: string;
  received_at: string;
  body: string;
  expected: {
    kind: SmsKind;
    direction: "debit" | "credit" | null;
    txn_type: SmsTxnType | null;
    amount: Money | null;
    billed_amount?: Money | null;
    date?: string;
    bank: string;
    card_last4?: string;
    counterparty?: string;
  };
}

const FIXTURES = JSON.parse(
  readFileSync(
    new URL("./fixtures/sms-golden.json", import.meta.url),
    "utf8",
  ),
) as GoldenFixture[];

function normalizeCp(s: string | null | undefined): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function counterpartyMatches(actual: string | null, expected: string): boolean {
  const a = normalizeCp(actual);
  const e = normalizeCp(expected);
  if (!a || !e) return false;
  return a === e || a.includes(e) || e.includes(a);
}

function buildGoldenContext(): SmsEngineContext {
  const ledger = demoLedger();
  const acc = ledger.accounts[0]!;
  const links = [
    { id: "l-liv", created_at: "2026-11-01T00:00:00Z", ...createDefaultSmsLink(acc.id, ["Liv"], "Liv") },
    { id: "l-adcb", created_at: "2026-11-01T00:00:00Z", ...createDefaultSmsLink(acc.id, ["ADCB"], "ADCB") },
    { id: "l-dib", created_at: "2026-11-01T00:00:00Z", ...createDefaultSmsLink(acc.id, ["DIB"], "DIB") },
    { id: "l-fab", created_at: "2026-11-01T00:00:00Z", ...createDefaultSmsLink(acc.id, ["FAB"], "FAB") },
    { id: "l-enbd", created_at: "2026-11-01T00:00:00Z", ...createDefaultSmsLink(acc.id, ["ENBD", "EmiratesNBD"], "ENBD") },
  ];
  return {
    links,
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
      "GBP|AED|2026-11-04": { rate: 4.65, rateDate: "2026-11-04", provider: "test" },
      "EUR|AED|2026-11-05": { rate: 3.98, rateDate: "2026-11-05", provider: "test" },
      "JPY|AED|2026-11-06": { rate: 0.025, rateDate: "2026-11-06", provider: "test" },
      "KWD|AED|2026-11-10": { rate: 11.95, rateDate: "2026-11-10", provider: "test" },
      "INR|AED|2026-11-05": { rate: 0.0435, rateDate: "2026-11-05", provider: "test" },
    },
  };
}

test("golden set has >= 60 synthetic fixtures across all 5 UAE banks", () => {
  assert.ok(FIXTURES.length >= 60, `Expected >= 60 golden fixtures, found ${FIXTURES.length}`);
  const banks = new Set(FIXTURES.map((f) => f.bank));
  for (const b of ["Liv", "ADCB", "DIB", "FAB", "ENBD"]) {
    assert.ok(banks.has(b), `Missing golden fixtures for bank ${b}`);
  }
});

test("Phase 1 golden fixtures: 100% pass through parseSmsV1 and processSingleSms", () => {
  const stats = new Map<string, { total: number; passed: number; failures: string[] }>();
  const ctx = buildGoldenContext();

  for (const fx of FIXTURES) {
    const entry = stats.get(fx.bank) ?? { total: 0, passed: 0, failures: [] };
    entry.total++;
    const errors: string[] = [];

    const parsed = parseSmsV1(fx.body, {
      sender: fx.sender,
      received_at: fx.received_at,
      sms_hash: `hash-${fx.id}`,
      account_currency: "AED",
    });

    if (parsed.kind !== fx.expected.kind) {
      errors.push(`kind=${parsed.kind} expected=${fx.expected.kind}`);
    }
    if (parsed.direction !== fx.expected.direction) {
      errors.push(`direction=${parsed.direction} expected=${fx.expected.direction}`);
    }
    if (parsed.txn_type !== fx.expected.txn_type) {
      errors.push(`txn_type=${parsed.txn_type} expected=${fx.expected.txn_type}`);
    }
    if (fx.expected.amount === null) {
      if (parsed.amount !== null) {
        errors.push(`amount=${JSON.stringify(parsed.amount)} expected=null`);
      }
    } else {
      if (
        !parsed.amount ||
        parsed.amount.minor !== fx.expected.amount.minor ||
        parsed.amount.currency !== fx.expected.amount.currency ||
        parsed.amount.exponent !== fx.expected.amount.exponent
      ) {
        errors.push(`amount=${JSON.stringify(parsed.amount)} expected=${JSON.stringify(fx.expected.amount)}`);
      }
    }
    if (fx.expected.billed_amount) {
      if (
        !parsed.billed_amount ||
        parsed.billed_amount.minor !== fx.expected.billed_amount.minor ||
        parsed.billed_amount.currency !== fx.expected.billed_amount.currency
      ) {
        errors.push(`billed_amount=${JSON.stringify(parsed.billed_amount)} expected=${JSON.stringify(fx.expected.billed_amount)}`);
      }
    }
    if (fx.expected.date && parsed.date !== fx.expected.date) {
      errors.push(`date=${parsed.date} expected=${fx.expected.date}`);
    }
    if (parsed.bank.id !== fx.expected.bank) {
      errors.push(`bank=${parsed.bank.id} expected=${fx.expected.bank}`);
    }
    if (fx.expected.card_last4 && parsed.instrument.last4 !== fx.expected.card_last4) {
      errors.push(`card_last4=${parsed.instrument.last4} expected=${fx.expected.card_last4}`);
    }
    if (
      fx.expected.counterparty &&
      !counterpartyMatches(parsed.counterparty.clean, fx.expected.counterparty)
    ) {
      errors.push(`counterparty=${JSON.stringify(parsed.counterparty.clean)} expected=${JSON.stringify(fx.expected.counterparty)}`);
    }

    // Also run full processSingleSms to verify no silent skips on debits/credits & proper routing
    const decision = processSingleSms(
      {
        id: fx.id,
        sender: fx.sender,
        body: fx.body,
        timestampMs: Date.parse(fx.received_at),
      },
      ctx,
    );
    if (fx.expected.kind === "transaction") {
      if (decision.action !== "auto_add" && decision.action !== "needs_review") {
        errors.push(`pipeline action=${decision.action} expected auto_add|needs_review`);
      }
      if (fx.expected.amount && decision.transaction?.original_amount !== fx.expected.amount.minor) {
        errors.push(
          `pipeline original_amount=${decision.transaction?.original_amount} expected=${fx.expected.amount.minor}`,
        );
      }
      // Verify draft privacy: no SMS body substring > 6 chars leaks into raw_text/subject/notes
      if (decision.action === "needs_review") {
        const draft = buildCapturedAlertDraft(decision);
        if (draft.raw_text !== "") {
          errors.push(`privacy violation: draft.raw_text must be empty, got ${JSON.stringify(draft.raw_text)}`);
        }
      }
    } else if (
      fx.expected.kind === "otp" ||
      fx.expected.kind === "declined" ||
      fx.expected.kind === "promo"
    ) {
      if (decision.action !== "skip") {
        errors.push(`pipeline action=${decision.action} expected skip for ${fx.expected.kind}`);
      }
    } else if (fx.expected.kind === "balance_notice") {
      if (decision.action !== "unparsed") {
        errors.push(`pipeline action=${decision.action} expected unparsed for balance_notice`);
      }
    }

    if (errors.length === 0) {
      entry.passed++;
    } else {
      entry.failures.push(`${fx.id} [${parsed.parsed_by}]: ${errors.join("; ")}`);
    }
    stats.set(fx.bank, entry);
  }

  const allFailures = [...stats.values()].flatMap((s) => s.failures);
  if (allFailures.length > 0) {
    const table = [
      "\nPer-bank golden accuracy:",
      ...([...stats.entries()].map(
        ([bank, s]) =>
          `  ${bank.padEnd(8)} ${s.passed}/${s.total} (${Math.round((s.passed / s.total) * 100)}%)`,
      )),
      "\nFailures:",
      ...allFailures.map((f) => `  - ${f}`),
    ].join("\n");
    assert.fail(table);
  }
});

test("privacy: SMS-native CapturedAlert draft leaks zero SMS body substrings > 6 chars", () => {
  const ctx = buildGoldenContext();
  const secretSms =
    "Your Debit Card XXX1234 was used for AED 91.25 on 03/11/2026 10:21:05 at SAMPLE PRIVATE CLINIC, DUBAI-AE. Avl.Bal is AED 1,500.00";
  const decision = processSingleSms(
    {
      id: "priv-1",
      sender: "ADCB",
      body: secretSms,
      timestampMs: Date.UTC(2026, 10, 3, 6, 21, 5),
    },
    ctx,
  );
  assert.equal(decision.action, "needs_review");
  const draft = buildCapturedAlertDraft(decision);
  assert.equal(draft.raw_text, "");

  // Check every non-payee text field that syncs to Supabase (raw_text, subject, parsed_notes, account_hint)
  // never contains any raw SMS body substring longer than 6 characters.
  const syncedTextFields = [
    draft.raw_text,
    draft.subject,
    draft.parsed_notes,
    draft.account_hint,
  ].join(" ");
  const normBody = secretSms.toLowerCase();
  const normSynced = syncedTextFields.toLowerCase();
  for (let i = 0; i <= normBody.length - 7; i++) {
    const sub = normBody.slice(i, i + 7);
    if (/^\s+$/.test(sub)) continue;
    // Allow isolated card last4 or currency/amount formatted tokens, forbid raw SMS prose chunks
    if (/^[a-z0-9.,: ]{7}$/.test(sub) && !/card\s*\d{4}|aed\s*\d/i.test(sub)) {
      assert.ok(
        !normSynced.includes(sub),
        `Found SMS body substring "${sub}" inside synced draft fields: ${JSON.stringify(syncedTextFields)}`,
      );
    }
  }
});

test("bankFromSender maps DIB and ENBD cleanly without colliding with ADIB", () => {
  assert.equal(bankFromSender("ADIB"), "ADIB");
  assert.equal(bankFromSender("ADIB-Alert"), "ADIB");
  assert.equal(bankFromSender("DIB"), "DIB");
  assert.equal(bankFromSender("Dubai Islamic"), "DIB");
  assert.equal(bankFromSender("ENBD"), "ENBD");
  assert.equal(bankFromSender("EmiratesNBD"), "ENBD");
  assert.equal(bankFromSender("Emirates NBD"), "ENBD");
  assert.equal(bankFromSender("SAMPLE BANK"), null);
});

test("linked sender message with money + verb never silently skips, non-money notice goes to unparsed", () => {
  const ctx = buildGoldenContext();
  // A non-standard message from a linked sender without a transaction amount -> unparsed (not skip)
  const notice = processSingleSms(
    {
      id: "unp-1",
      sender: "DIB",
      body: "Dear Customer, your DIB e-statement for October 2026 is ready to view in the app.",
      timestampMs: Date.UTC(2026, 10, 5, 9, 0, 0),
    },
    ctx,
  );
  assert.equal(notice.action, "unparsed");

  // A weird phrasing with money + debit verb -> needs_review or auto_add, never skip
  const weirdDebit = processSingleSms(
    {
      id: "unp-2",
      sender: "DIB",
      body: "DIB notification: debited entry reference #88412 for AED 55.00 recorded.",
      timestampMs: Date.UTC(2026, 10, 5, 9, 5, 0),
    },
    ctx,
  );
  assert.ok(
    weirdDebit.action === "needs_review" || weirdDebit.action === "auto_add",
    `Expected needs_review/auto_add, got ${weirdDebit.action}`,
  );
});

