import assert from "node:assert/strict";
import test from "node:test";
import { parseSmsV1 } from "../src/sms/parse.ts";

test("universal extractor handles Arabic bank SMS with Arabic-Indic digits", () => {
  const sms =
    "تم شراء بمبلغ ١٢٥.٥٠ درهم لدى SAMPLE CAFE على بطاقة تنتهي بـ 1234 بتاريخ 05/11/2026. الرصيد المتاح 4,500.00 درهم.";
  const res = parseSmsV1(sms, {
    sender: "SAMPLEBANK",
    received_at: "2026-11-05T09:15:00Z",
    account_currency: "AED",
  });
  assert.equal(res.kind, "transaction");
  assert.equal(res.direction, "debit");
  assert.equal(res.txn_type, "purchase");
  assert.equal(res.amount?.currency, "AED");
  assert.equal(res.amount?.minor, 12550);
  assert.equal(res.date, "2026-11-05");
  assert.equal(res.instrument.last4, "1234");
  assert.equal(res.balance_after?.minor, 450000);
  assert.equal(res.balance_after?.label, "available_balance");
  assert.match(res.counterparty.clean ?? "", /sample cafe/i);
  assert.equal(res.parsed_by, "universal@1");
  assert.ok(res.confidence.overall <= 0.9);
});

test("universal extractor handles Arabic salary credit and Arabic OTP", () => {
  const salarySms =
    "تم إيداع راتب بمبلغ 15,000.00 درهم في حسابك بتاريخ 01/11/2026. الرصيد الحالي 22,500.00 درهم.";
  const salaryRes = parseSmsV1(salarySms, {
    sender: "SAMPLEBANK",
    received_at: "2026-11-01T08:00:00Z",
    account_currency: "AED",
  });
  assert.equal(salaryRes.kind, "transaction");
  assert.equal(salaryRes.direction, "credit");
  assert.equal(salaryRes.txn_type, "salary");
  assert.equal(salaryRes.amount?.minor, 1500000);

  const otpSms = "رمز التحقق الخاص بك هو 482910 لا تشاركه مع أحد.";
  const otpRes = parseSmsV1(otpSms, {
    sender: "SAMPLEBANK",
    received_at: "2026-11-01T08:05:00Z",
    account_currency: "AED",
  });
  assert.equal(otpRes.kind, "otp");
  assert.equal(otpRes.amount, null);
});

test("universal extractor handles currency symbols (€, £, ₹, and $ when unambiguous)", () => {
  const gbp = parseSmsV1(
    "Your card ending 0000 was charged £18.50 at SAMPLE BOOKSHOP on 06/11/2026. Avl limit AED 8,000.00",
    { sender: "SAMPLEBANK", received_at: "2026-11-06T12:00:00Z", account_currency: "AED" },
  );
  assert.equal(gbp.kind, "transaction");
  assert.equal(gbp.amount?.currency, "GBP");
  assert.equal(gbp.amount?.minor, 1850);
  assert.equal(gbp.balance_after?.label, "available_limit");

  const eur = parseSmsV1(
    "Purchase of €42.90 at SAMPLE BISTRO on 2026-11-06 19:30.",
    { sender: "SAMPLEBANK", received_at: "2026-11-06T19:35:00Z", account_currency: "AED" },
  );
  assert.equal(eur.kind, "transaction");
  assert.equal(eur.amount?.currency, "EUR");
  assert.equal(eur.amount?.minor, 4290);
  assert.equal(eur.date, "2026-11-06");
  assert.equal(eur.time, "19:30");

  const usd = parseSmsV1(
    "You spent $14.99 at SAMPLE STREAMING on Nov 06, 2026.",
    { sender: "SAMPLEBANK", received_at: "2026-11-06T20:00:00Z", account_currency: "AED" },
  );
  assert.equal(usd.kind, "transaction");
  assert.equal(usd.amount?.currency, "USD");
  assert.equal(usd.amount?.minor, 1499);
});

test("universal extractor captures bracketed billed_amount and lowers confidence on conflicting direction verbs", () => {
  const foreignWithBilled = parseSmsV1(
    "Card *0000 purchase of GBP 12.00 (AED 55.80) at SAMPLE CAFE on 04/11/2026. Avl Bal AED 1,200.00",
    { sender: "SAMPLEBANK", received_at: "2026-11-04T11:00:00Z", account_currency: "AED" },
  );
  assert.equal(foreignWithBilled.kind, "transaction");
  assert.equal(foreignWithBilled.amount?.currency, "GBP");
  assert.equal(foreignWithBilled.amount?.minor, 1200);
  assert.equal(foreignWithBilled.billed_amount?.currency, "AED");
  assert.equal(foreignWithBilled.billed_amount?.minor, 5580);
  assert.equal(foreignWithBilled.balance_after?.minor, 120000);

  const conflicting = parseSmsV1(
    "Notice: amount AED 80.00 debited and later credited reference #123.",
    { sender: "SAMPLEBANK", received_at: "2026-11-04T11:05:00Z", account_currency: "AED" },
  );
  assert.equal(conflicting.kind, "transaction");
  assert.ok(conflicting.warnings.includes("conflicting_direction_signals"));
  assert.ok(conflicting.confidence.direction <= 0.6);
  assert.ok(conflicting.confidence.overall <= 0.55);
});
