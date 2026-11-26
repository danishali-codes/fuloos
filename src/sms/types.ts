/* Canonical on-device SMS parsing schema (`fuloos.sms/1`).
   Pure TypeScript, sandbox-safe (no DOM, React, Node, or i18n imports). */
import { getCurrencyDecimals } from "../currency.ts";
import type { SmsType } from "../ledger/sms.ts";

export type SmsKind =
  | "transaction"
  | "otp"
  | "declined"
  | "balance_notice"
  | "promo"
  | "unknown";

export type SmsTxnType =
  | "purchase"
  | "refund"
  | "cash_withdrawal"
  | "bill_payment"
  | "transfer_out"
  | "transfer_in"
  | "salary"
  | "fee"
  | "card_repayment"
  | "loan_repayment"
  | "internal_move"
  | "other";

export type MoneyExponent = 0 | 2 | 3;

export interface Money {
  minor: number;
  currency: string;
  exponent: MoneyExponent;
}

export type BalanceLabel = "available_balance" | "available_limit" | "balance";

export interface BalanceMoney extends Money {
  label: BalanceLabel;
}

export interface CounterpartyInfo {
  raw: string | null;
  name: string | null;
  clean: string | null;
  city: string | null;
  country: string | null;
}

export interface InstrumentInfo {
  kind: "credit_card" | "debit_card" | "account" | null;
  last4: string | null;
}

export type BankSource = "link" | "sender" | "template" | "learned" | "guess" | null;

export interface BankInfo {
  id: string | null;
  source: BankSource;
}

export interface SmsEnvelope {
  sender: string;
  received_at: string;
  hash: string;
}

export interface ParseConfidence {
  overall: number;
  amount: number;
  direction: number;
  date: number;
  counterparty: number;
}

export interface ParsedSmsV1 {
  schema: "fuloos.sms/1";
  kind: SmsKind;
  direction: "debit" | "credit" | null;
  txn_type: SmsTxnType | null;
  /** What the merchant charged, in original currency. */
  amount: Money | null;
  /** Account-currency amount if the SMS explicitly prints it. */
  billed_amount: Money | null;
  balance_after: BalanceMoney | null;
  /** YYYY-MM-DD */
  date: string | null;
  /** HH:mm */
  time: string | null;
  date_source: "text" | "received";
  counterparty: CounterpartyInfo;
  instrument: InstrumentInfo;
  bank: BankInfo;
  /** Metadata only — never includes body text. */
  sms: SmsEnvelope;
  /** e.g. "learned:<templateId>", "template:ADCB/purchase", "universal@1" */
  parsed_by: string;
  confidence: ParseConfidence;
  warnings: string[];
}

export type LearnedSlotKind =
  | "AMOUNT"
  | "CUR"
  | "DATE"
  | "TIME"
  | "CARD"
  | "MERCHANT"
  | "BAL"
  | "NUM";

export interface LearnedTemplatePattern {
  /** Wording-only template string with slot placeholders (e.g. "{CUR} {AMOUNT} at {MERCHANT}"). */
  skeleton: string;
  /** Token sequence used to compile a tolerant regex matcher. */
  tokens: Array<
    | { kind: "literal"; text: string }
    | { kind: "slot"; slot: LearnedSlotKind; index: number }
  >;
}

/**
 * Self-contained, versioned on-device learned SMS format.
 * Stores ONLY fixed bank wording and typed slot markers — never user amounts,
 * merchants, account numbers, or card digits.
 */
export interface LearnedTemplate {
  template_version: 1;
  id: string;
  sender_norm: string;
  skeleton_hash: string;
  pattern: LearnedTemplatePattern;
  /** Maps semantic field name ("amount", "currency", "merchant", "date", "time", "card", "balance") to slot key. */
  field_map: Record<string, string>;
  direction: "debit" | "credit";
  txn_type: SmsTxnType;
  bank_id: string | null;
  created_at: string;
  hits: number;
  last_hit_at: string | null;
}

export interface ParseContext {
  sender: string;
  /** ISO-8601 timestamp or YYYY-MM-DD of when the SMS was received. */
  received_at: string;
  /** Deterministic SMS identity hash (sender + body + timestamp to the minute). */
  sms_hash?: string;
  /** Explicit bank template override from the account link. */
  link_bank_template?: string | null;
  /** On-device learned templates to try first. */
  learned_templates?: ReadonlyArray<LearnedTemplate>;
  /** Currency of the linked account (defaults to "AED"). */
  account_currency?: string;
  /** Testing/benchmark switch: skip bank templates when true. */
  disable_bank_templates?: boolean;
  /** Testing/benchmark switch: skip learned templates when true. */
  disable_learned_templates?: boolean;
}

export interface LegacyTypeMapping {
  kind: SmsKind;
  txn_type: SmsTxnType | null;
  direction: "debit" | "credit" | null;
}

/** Map any of the 17 legacy SmsType values onto canonical `fuloos.sms/1` fields. */
export function mapLegacySmsType(type: SmsType): LegacyTypeMapping {
  switch (type) {
    case "purchase":
      return { kind: "transaction", txn_type: "purchase", direction: "debit" };
    case "bill_payment":
      return { kind: "transaction", txn_type: "bill_payment", direction: "debit" };
    case "cash_withdrawal":
      return { kind: "transaction", txn_type: "cash_withdrawal", direction: "debit" };
    case "bank_fee":
      return { kind: "transaction", txn_type: "fee", direction: "debit" };
    case "transfer_out":
      return { kind: "transaction", txn_type: "transfer_out", direction: "debit" };
    case "card_repayment":
      return { kind: "transaction", txn_type: "card_repayment", direction: "debit" };
    case "loan_repayment":
      return { kind: "transaction", txn_type: "loan_repayment", direction: "debit" };
    case "internal_out":
      return { kind: "transaction", txn_type: "internal_move", direction: "debit" };
    case "other_debit":
      return { kind: "transaction", txn_type: "other", direction: "debit" };
    case "refund":
      return { kind: "transaction", txn_type: "refund", direction: "credit" };
    case "transfer_in":
      return { kind: "transaction", txn_type: "transfer_in", direction: "credit" };
    case "income":
      return { kind: "transaction", txn_type: "salary", direction: "credit" };
    case "internal_in":
      return { kind: "transaction", txn_type: "internal_move", direction: "credit" };
    case "card_payment_received":
      return { kind: "transaction", txn_type: "card_repayment", direction: "credit" };
    case "otp":
      return { kind: "otp", txn_type: null, direction: null };
    case "declined":
      return { kind: "declined", txn_type: null, direction: null };
    case "notice":
      return { kind: "unknown", txn_type: null, direction: null };
  }
}

/** Map canonical `fuloos.sms/1` fields back to legacy SmsType for adapters. */
export function mapV1ToLegacySmsType(
  kind: SmsKind,
  txnType: SmsTxnType | null,
  direction: "debit" | "credit" | null,
): SmsType {
  if (kind === "otp") return "otp";
  if (kind === "declined") return "declined";
  if (kind !== "transaction") return "notice";
  switch (txnType) {
    case "purchase":
      return "purchase";
    case "refund":
      return "refund";
    case "cash_withdrawal":
      return "cash_withdrawal";
    case "bill_payment":
      return "bill_payment";
    case "transfer_out":
      return "transfer_out";
    case "transfer_in":
      return "transfer_in";
    case "salary":
      return "income";
    case "fee":
      return "bank_fee";
    case "card_repayment":
      return direction === "credit" ? "card_payment_received" : "card_repayment";
    case "loan_repayment":
      return "loan_repayment";
    case "internal_move":
      return direction === "credit" ? "internal_in" : "internal_out";
    case "other":
    default:
      return direction === "credit" ? "transfer_in" : "other_debit";
  }
}

/** Return the ISO 4217 exponent clamped to 0 | 2 | 3 (using currencyData.ts). */
export function moneyExponent(currency: string): MoneyExponent {
  const dec = getCurrencyDecimals(currency);
  if (dec === 0) return 0;
  if (dec === 3) return 3;
  return 2;
}

export function makeMoney(minor: number, currency: string): Money {
  const code = String(currency || "AED").trim().toUpperCase();
  return {
    minor: Math.round(minor),
    currency: code,
    exponent: moneyExponent(code),
  };
}
