import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  makeMoney,
  mapLegacySmsType,
  mapV1ToLegacySmsType,
  type ParsedSmsV1,
} from "../src/sms/types.ts";
import { validateParsedSmsV1 } from "../src/sms/validate.ts";
import type { SmsType } from "../src/ledger/sms.ts";

const SCHEMA = JSON.parse(
  readFileSync(
    new URL("../docs/fuloos-sms-v1.schema.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

/** Minimal Draft 2020-12 JSON Schema subset validator covering every keyword used in fuloos-sms-v1.schema.json. */
function assertMatchesSchema(
  value: unknown,
  schemaNode: Record<string, unknown>,
  root: Record<string, unknown>,
  path = "$",
): void {
  if (typeof schemaNode.$ref === "string") {
    const refPath = schemaNode.$ref.replace(/^#\//, "").split("/");
    let target: unknown = root;
    for (const seg of refPath) {
      target = (target as Record<string, unknown>)[seg];
    }
    assert.ok(target && typeof target === "object", `Unresolved $ref ${schemaNode.$ref}`);
    assertMatchesSchema(value, target as Record<string, unknown>, root, path);
    return;
  }

  if (Array.isArray(schemaNode.oneOf)) {
    let matched = 0;
    for (const branch of schemaNode.oneOf as Record<string, unknown>[]) {
      try {
        assertMatchesSchema(value, branch, root, path);
        matched++;
      } catch {
        // branch did not match
      }
    }
    assert.equal(matched, 1, `${path}: expected value to match exactly 1 oneOf branch (matched ${matched})`);
    return;
  }

  if ("const" in schemaNode) {
    assert.deepEqual(value, schemaNode.const, `${path}: expected const ${String(schemaNode.const)}`);
  }

  if (Array.isArray(schemaNode.enum)) {
    assert.ok(
      schemaNode.enum.includes(value),
      `${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schemaNode.enum)}`,
    );
  }

  if (schemaNode.type) {
    const allowed = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
    const actualType =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value === "number" && Number.isInteger(value)
            ? "integer"
            : typeof value;
    const ok = allowed.some(
      (t) => t === actualType || (t === "number" && actualType === "integer"),
    );
    assert.ok(ok, `${path}: expected type ${allowed.join("|")}, got ${actualType}`);
  }

  if (typeof value === "string") {
    if (typeof schemaNode.minLength === "number") {
      assert.ok(value.length >= schemaNode.minLength, `${path}: minLength ${schemaNode.minLength}`);
    }
    if (typeof schemaNode.pattern === "string") {
      assert.match(value, new RegExp(schemaNode.pattern), `${path}: pattern ${schemaNode.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schemaNode.minimum === "number") {
      assert.ok(value >= schemaNode.minimum, `${path}: minimum ${schemaNode.minimum}`);
    }
    if (typeof schemaNode.maximum === "number") {
      assert.ok(value <= schemaNode.maximum, `${path}: maximum ${schemaNode.maximum}`);
    }
  }

  if (Array.isArray(value) && schemaNode.items && typeof schemaNode.items === "object") {
    value.forEach((item, idx) =>
      assertMatchesSchema(item, schemaNode.items as Record<string, unknown>, root, `${path}[${idx}]`),
    );
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schemaNode.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (Array.isArray(schemaNode.required)) {
      for (const req of schemaNode.required as string[]) {
        assert.ok(req in obj, `${path}: missing required key "${req}"`);
      }
    }
    if (schemaNode.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        assert.ok(k in props, `${path}: unexpected additional property "${k}"`);
      }
    }
    for (const [k, propSchema] of Object.entries(props)) {
      if (k in obj) {
        assertMatchesSchema(obj[k], propSchema, root, `${path}.${k}`);
      }
    }
  }
}

function sampleParsed(overrides: Partial<ParsedSmsV1> = {}): ParsedSmsV1 {
  return {
    schema: "fuloos.sms/1",
    kind: "transaction",
    direction: "debit",
    txn_type: "purchase",
    amount: makeMoney(4500, "AED"),
    billed_amount: null,
    balance_after: { minor: 150000, currency: "AED", exponent: 2, label: "available_balance" },
    date: "2026-11-03",
    time: "10:21",
    date_source: "text",
    counterparty: {
      raw: "SAMPLE CAFE,DUBAI-AE",
      name: "SAMPLE CAFE",
      clean: "SAMPLE CAFE",
      city: "DUBAI",
      country: "AE",
    },
    instrument: { kind: "debit_card", last4: "1234" },
    bank: { id: "ADCB", source: "sender" },
    sms: { sender: "ADCB", received_at: "2026-11-03T06:21:05Z", hash: "abc123" },
    parsed_by: "template:ADCB/debit_purchase",
    confidence: { overall: 0.95, amount: 1, direction: 1, date: 1, counterparty: 0.9 },
    warnings: [],
    ...overrides,
  };
}

test("all 17 legacy SmsType values map cleanly onto fuloos.sms/1", () => {
  const allLegacy: SmsType[] = [
    "purchase",
    "bill_payment",
    "cash_withdrawal",
    "bank_fee",
    "transfer_out",
    "card_repayment",
    "loan_repayment",
    "internal_out",
    "other_debit",
    "refund",
    "transfer_in",
    "income",
    "internal_in",
    "card_payment_received",
    "otp",
    "declined",
    "notice",
  ];
  assert.equal(allLegacy.length, 17);
  for (const legacy of allLegacy) {
    const mapped = mapLegacySmsType(legacy);
    assert.ok(mapped.kind);
    if (mapped.kind === "transaction") {
      assert.ok(mapped.direction === "debit" || mapped.direction === "credit");
      assert.ok(mapped.txn_type !== null);
    }
    // Round-trip back to legacy SmsType should always yield a valid SmsType
    const roundTrip = mapV1ToLegacySmsType(mapped.kind, mapped.txn_type, mapped.direction);
    assert.ok(allLegacy.includes(roundTrip));
  }
});

test("sample fuloos.sms/1 payloads validate against docs/fuloos-sms-v1.schema.json", () => {
  const tx = sampleParsed();
  const otp = sampleParsed({
    kind: "otp",
    direction: null,
    txn_type: null,
    amount: null,
    balance_after: null,
    date: "2026-11-03",
    time: null,
    date_source: "received",
    counterparty: { raw: null, name: null, clean: null, city: null, country: null },
    instrument: { kind: null, last4: null },
    parsed_by: "universal@1",
    confidence: { overall: 0.9, amount: 0, direction: 0, date: 1, counterparty: 0 },
  });
  const foreignJpy = sampleParsed({
    amount: makeMoney(1500, "JPY"),
    billed_amount: makeMoney(3750, "AED"),
    balance_after: { minor: 700000, currency: "AED", exponent: 2, label: "available_limit" },
  });
  const foreignKwd = sampleParsed({
    amount: makeMoney(2500, "KWD"),
  });

  for (const payload of [tx, otp, foreignJpy, foreignKwd]) {
    assertMatchesSchema(payload, SCHEMA, SCHEMA);
  }
});

test("validateParsedSmsV1 accepts valid transaction and scales overall confidence by layer factor", () => {
  const sms =
    "Your Debit Card XXX1234 was used for AED45.00 on 03/11/2026 10:21:05 at SAMPLE CAFE,DUBAI-AE. Avl.Bal is AED 1,500.00";
  const res = validateParsedSmsV1(sms, sampleParsed());
  assert.equal(res.valid, true);
  // min(1, 1, 1, 0.9) * 0.95 = 0.855
  assert.equal(res.parsed.confidence.overall, 0.855);
  assertMatchesSchema(res.parsed, SCHEMA, SCHEMA);

  // Learned template uses layer factor 1.0
  const learnedRes = validateParsedSmsV1(
    sms,
    sampleParsed({
      parsed_by: "learned:tpl_1",
      confidence: { overall: 1, amount: 1, direction: 1, date: 1, counterparty: 1 },
    }),
  );
  assert.equal(learnedRes.valid, true);
  assert.equal(learnedRes.parsed.confidence.overall, 1);

  // Universal extractor is capped at <= 0.9
  const uniRes = validateParsedSmsV1(
    sms,
    sampleParsed({
      parsed_by: "universal@1",
      confidence: { overall: 1, amount: 1, direction: 1, date: 1, counterparty: 1 },
    }),
  );
  assert.equal(uniRes.valid, true);
  assert.equal(uniRes.parsed.confidence.overall, 0.9);
});

test("validateParsedSmsV1 rejects amounts not present in text or sitting in balance/limit clauses", () => {
  const sms =
    "Purchase of GBP 12.00 with Credit Card ending 0000 at SAMPLE STORE LONDON. Avl Cr. Limit is AED 7,000.00";

  // Hallucinated number not in text -> reject
  const badHallucinated = validateParsedSmsV1(
    sms,
    sampleParsed({ amount: makeMoney(9999, "AED") }),
  );
  assert.equal(badHallucinated.valid, false);
  assert.equal(badHallucinated.reason, "amount_not_found_in_text");

  // Credit limit grabbed as amount -> reject
  const badLimit = validateParsedSmsV1(
    sms,
    sampleParsed({ amount: makeMoney(700000, "AED"), balance_after: null }),
  );
  assert.equal(badLimit.valid, false);
  assert.equal(badLimit.reason, "amount_in_balance_or_limit_clause");

  // Arabic balance clause -> reject
  const arabicSms = "تم استخدام البطاقة بقيمة 25.00 درهم. الرصيد المتاح 4,500.00 درهم";
  const badArabicBal = validateParsedSmsV1(
    arabicSms,
    sampleParsed({ amount: makeMoney(450000, "AED"), balance_after: null }),
  );
  assert.equal(badArabicBal.valid, false);
  assert.equal(badArabicBal.reason, "amount_in_balance_or_limit_clause");

  // Arabic-Indic digits for actual amount -> accept
  const arabicIndicSms = "تم شراء بمبلغ ٤٥٫٠٠ درهم لدى مقهى تجريبي. الرصيد المتاح ١٬٥٠٠٫٠٠ درهم";
  const goodArabicIndic = validateParsedSmsV1(
    arabicIndicSms,
    sampleParsed({
      amount: makeMoney(4500, "AED"),
      balance_after: { minor: 150000, currency: "AED", exponent: 2, label: "available_balance" },
    }),
  );
  assert.equal(goodArabicIndic.valid, true);
});

test("validateParsedSmsV1 rejects transaction with null direction and falls back out-of-range dates", () => {
  const sms = "Your Debit Card XXX1234 was used for AED 45.00 on 03/11/2026 at SAMPLE CAFE.";

  const noDir = validateParsedSmsV1(sms, sampleParsed({ direction: null, balance_after: null }));
  assert.equal(noDir.valid, false);
  assert.equal(noDir.reason, "transaction_missing_direction");

  // Date > 2 days in the future -> fall back to received date with warning
  const futureDate = validateParsedSmsV1(
    sms,
    sampleParsed({
      date: "2026-11-20",
      date_source: "text",
      balance_after: null,
      sms: { sender: "ADCB", received_at: "2026-11-03T10:00:00Z", hash: "h1" },
    }),
  );
  assert.equal(futureDate.valid, true);
  assert.equal(futureDate.parsed.date, "2026-11-03");
  assert.equal(futureDate.parsed.date_source, "received");
  assert.ok(futureDate.parsed.warnings.includes("date_out_of_range"));

  // Non-existent calendar date (Feb 30) -> fall back to received date
  const fakeCal = validateParsedSmsV1(
    sms,
    sampleParsed({
      date: "2026-02-30",
      date_source: "text",
      balance_after: null,
      sms: { sender: "ADCB", received_at: "2026-03-01T10:00:00Z", hash: "h2" },
    }),
  );
  assert.equal(fakeCal.valid, true);
  assert.equal(fakeCal.parsed.date, "2026-03-01");
  assert.ok(fakeCal.parsed.warnings.includes("date_out_of_range"));
});
