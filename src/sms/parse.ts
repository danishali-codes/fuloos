/* Cascading SMS parser outputting validated `fuloos.sms/1` objects.
   Cascade order:
     1. Learned on-device templates (Phase 3)
     2. Bank templates (hand-written + rules.generated.ts) — ONLY when bank is known from link or sender
     3. Universal field extractor (Phase 2)
   Pure TypeScript, sandbox-safe (no DOM, React, Node, or i18n imports). */
import { isSupportedCurrency } from "../currency.ts";
import { LEDGER_RULES as T } from "../ledger/rules.generated.ts";
import {
  bankFromSender,
  cleanName,
  dateInText,
  extractBalanceAfter,
  extractBilledAmount,
  extractCurrencyAmount,
  normalizeSmsDigits,
  smsAmountToMinor,
  splitMerchant,
  stripBalanceAndLimitClauses,
  type SmsType,
} from "../ledger/sms.ts";
import { extractCardLast4 } from "../mobile/smsLinks.ts";
import {
  extractCounterpartyFromText,
  HANDWRITTEN_BANK_TEMPLATES,
  isBalanceOnlyNotice,
  isPromoSms,
  type BankTemplateRule,
} from "./bankTemplates.ts";
import {
  makeMoney,
  mapLegacySmsType,
  moneyExponent,
  type BalanceLabel,
  type BalanceMoney,
  type BankInfo,
  type InstrumentInfo,
  type LearnedTemplate,
  type ParseContext,
  type ParsedSmsV1,
} from "./types.ts";
import { parseStrictIsoDateUtc, validateParsedSmsV1 } from "./validate.ts";

const COMMON_OTP_RE = new RegExp(T.COMMON_RULES[0][1], T.COMMON_RULES[0][2]);
const COMMON_DECLINED_RE = new RegExp(T.COMMON_RULES[1][1], T.COMMON_RULES[1][2]);

const GENERATED_BANK_RULES: Record<string, BankTemplateRule[]> = Object.fromEntries(
  Object.entries(T.BANK_RULES).map(([bank, list]) => [
    bank,
    (list as readonly (readonly string[])[]).map(([type, src, flags], idx) => ({
      id: `${bank}/${type}#${idx}`,
      type: type as SmsType,
      regex: new RegExp(src, flags),
    })),
  ]),
);

const PARENTHETICAL_BILLED_RE =
  /\s*\(\s*(?:(?:billed|approx\.?|equiv\.?|~|≈)\s*)?(?:[A-Z]{3}\s*\d[\d,]*(?:\.\d{1,3})?|\d[\d,]*(?:\.\d{1,3})?\s*[A-Z]{3})(?:\s*billed)?\s*\)/gi;

const TRANSFER_MERCHANTS_RE = new RegExp(T.TRANSFER_MERCHANTS, "i");

/** Optional pluggable matchers wired by Phase 2 (universal) and Phase 3 (learned). */
export type UniversalParserFn = (
  text: string,
  ctx: ParseContext,
  bank: BankInfo,
  receivedDate: string,
) => ParsedSmsV1 | null;

export type LearnedMatcherFn = (
  text: string,
  ctx: ParseContext,
  bank: BankInfo,
  receivedDate: string,
  templates: ReadonlyArray<LearnedTemplate>,
) => ParsedSmsV1 | null;

let registeredUniversalParser: UniversalParserFn | null = null;
let registeredLearnedMatcher: LearnedMatcherFn | null = null;

export function registerUniversalParser(fn: UniversalParserFn | null): void {
  registeredUniversalParser = fn;
}

export function registerLearnedMatcher(fn: LearnedMatcherFn | null): void {
  registeredLearnedMatcher = fn;
}

/** Extract HH:mm time from an SMS body if present. */
export function extractTimeInText(text: string): string | null {
  const norm = normalizeSmsDigits(text);
  const m = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/.exec(norm);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** Resolve bank identity strictly from link override or sender — never from body text. */
export function resolveBankFromContext(ctx: ParseContext): BankInfo {
  const fromLink = String(ctx.link_bank_template ?? "").trim();
  if (fromLink) {
    return { id: fromLink, source: "link" };
  }
  const fromSender = bankFromSender(ctx.sender);
  if (fromSender) {
    return { id: fromSender, source: "sender" };
  }
  return { id: null, source: null };
}

function receivedIsoDate(receivedAt: string): string {
  const raw = String(receivedAt || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const candidate = raw.slice(0, 10);
    if (parseStrictIsoDateUtc(candidate) !== null) return candidate;
  }
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/** Infer card/account instrument kind and last4 digits from text + optional matched card group. */
export function extractInstrument(
  text: string,
  matchedCard: string | null,
): InstrumentInfo {
  const norm = normalizeSmsDigits(text);
  const last4 = extractCardLast4(norm, matchedCard);
  if (/\b(?:credit\s*card|cr\.?\s*card|cr\.?\s*limit)\b/i.test(norm)) {
    return { kind: "credit_card", last4 };
  }
  if (/\bdebit\s*card\b/i.test(norm)) {
    return { kind: "debit_card", last4 };
  }
  if (last4) {
    return { kind: "debit_card", last4 };
  }
  if (/\b(?:a\/c|acct|account)\b/i.test(norm)) {
    return { kind: "account", last4: null };
  }
  return { kind: null, last4: null };
}

/** Detect balance_after label ("available_limit" vs "available_balance" vs "balance"). */
export function detectBalanceLabel(text: string): BalanceLabel {
  const norm = normalizeSmsDigits(text);
  if (/(?:\b(?:avl\.?\s*cr\.?\s*limit|avail(?:able)?\s*cr(?:edit)?\.?\s*limit|cr(?:edit)?\.?\s*limit|available\s+limit)\b|(?:ال)?حد)/i.test(norm)) {
    return "available_limit";
  }
  if (/(?:\b(?:avl\.?\s*bal(?:ance)?|available\s+bal(?:ance)?)\b|الرصيد\s+المتاح)/i.test(norm)) {
    return "available_balance";
  }
  return "balance";
}

function buildBalanceMoney(
  normText: string,
  balanceValue: number,
  accountCurrency: string,
): BalanceMoney | null {
  if (!Number.isFinite(balanceValue)) return null;
  const code = String(accountCurrency || "AED").trim().toUpperCase();
  const exp = moneyExponent(code);
  const minor = Math.round(balanceValue * 10 ** exp);
  return {
    minor,
    currency: code,
    exponent: exp,
    label: detectBalanceLabel(normText),
  };
}

function makeNonTx(
  kind: ParsedSmsV1["kind"],
  text: string,
  ctx: ParseContext,
  bank: BankInfo,
  receivedDate: string,
  parsedBy: string,
  confidenceOverall: number,
  warnings: string[] = [],
): ParsedSmsV1 {
  const norm = normalizeSmsDigits(text).replace(/\n/g, " ").trim();
  const dateInSms = dateInText(norm);
  const accCurr = String(ctx.account_currency || "AED").trim().toUpperCase();
  const balVal = extractBalanceAfter(norm);
  const candidate: ParsedSmsV1 = {
    schema: "fuloos.sms/1",
    kind,
    direction: null,
    txn_type: null,
    amount: null,
    billed_amount: null,
    balance_after:
      kind === "balance_notice" && Number.isFinite(balVal)
        ? buildBalanceMoney(norm, balVal, accCurr)
        : null,
    date: dateInSms ?? receivedDate,
    time: extractTimeInText(norm),
    date_source: dateInSms ? "text" : "received",
    counterparty: { raw: null, name: null, clean: null, city: null, country: null },
    instrument: extractInstrument(norm, null),
    bank,
    sms: {
      sender: ctx.sender,
      received_at: ctx.received_at,
      hash: ctx.sms_hash ?? "",
    },
    parsed_by: parsedBy,
    confidence: {
      overall: confidenceOverall,
      amount: 0,
      direction: 0,
      date: dateInSms ? 1 : 0.8,
      counterparty: 0,
    },
    warnings,
  };
  const checked = validateParsedSmsV1(text, candidate);
  return checked.valid ? checked.parsed : candidate;
}

/** Try all templates for a known bank (hand-written first, then generated rules). */
function tryBankTemplates(
  text: string,
  ctx: ParseContext,
  bank: BankInfo,
  receivedDate: string,
): ParsedSmsV1 | null {
  if (!bank.id) return null;
  const hand = HANDWRITTEN_BANK_TEMPLATES[bank.id] ?? [];
  const gen = GENERATED_BANK_RULES[bank.id] ?? [];
  const rules = [...hand, ...gen];
  if (!rules.length) return null;

  const norm = normalizeSmsDigits(text).replace(/\n/g, " ").trim();
  const strippedParen = norm
    .replace(PARENTHETICAL_BILLED_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  const candidates = strippedParen !== norm ? [norm, strippedParen] : [norm];
  const accCurr = String(ctx.account_currency || "AED").trim().toUpperCase();

  for (const candidateText of candidates) {
    for (const rule of rules) {
      const m = rule.regex.exec(candidateText);
      if (!m) continue;
      const g = m.groups ?? {};

      // Explicit zero-amount / notice templates inside rules.generated.ts
      if (rule.type === "notice") {
        return makeNonTx("unknown", text, ctx, bank, receivedDate, `template:${rule.id}`, 0.6);
      }

      const currencyRaw = (g.currency || g.currency_post || "").trim().toUpperCase();
      const amountRaw = (g.amount || g.amount_pre || "").trim();
      if (!currencyRaw || !amountRaw) continue;

      const amountMinor = smsAmountToMinor(amountRaw, currencyRaw);
      if (amountMinor === null || amountMinor <= 0) continue;

      let legacyType: SmsType = rule.type;
      const rawMerchantGroup = (g.merchant_raw || "").trim() || null;
      if (
        legacyType === "purchase" &&
        rawMerchantGroup &&
        TRANSFER_MERCHANTS_RE.test(rawMerchantGroup)
      ) {
        legacyType = "transfer_out";
      }

      const mapped = mapLegacySmsType(legacyType);
      if (mapped.kind !== "transaction") {
        return makeNonTx(mapped.kind, text, ctx, bank, receivedDate, `template:${rule.id}`, 0.95);
      }

      // Counterparty: prefer template capture, fall back to preposition extraction for better payees
      let cpRaw = rawMerchantGroup;
      let cpName: string | null = null;
      let cpCity: string | null = null;
      let cpCountry: string | null = null;
      let cpClean: string | null = null;

      if (cpRaw) {
        const [n, c, cc] = splitMerchant(cpRaw, bank.id);
        cpName = n;
        cpCity = c;
        cpCountry = cc;
        cpClean = cleanName(n);
      }
      if (!cpClean) {
        const extracted = extractCounterpartyFromText(norm, bank.id);
        cpRaw = extracted.raw;
        cpName = extracted.name;
        cpClean = extracted.clean;
        cpCity = extracted.city;
        cpCountry = extracted.country;
      }

      const billed = extractBilledAmount(norm, currencyRaw);
      const billedMoney =
        billed && billed.amountMinor > 0
          ? makeMoney(billed.amountMinor, billed.currency)
          : null;

      const balNum =
        g.balance && g.balance.trim()
          ? Number(g.balance.replace(/,/g, ""))
          : extractBalanceAfter(norm);
      const balanceMoney = Number.isFinite(balNum)
        ? buildBalanceMoney(norm, balNum, accCurr)
        : null;

      const dateInSms = dateInText(norm);
      const warnings: string[] = [];
      if (!isSupportedCurrency(currencyRaw)) {
        warnings.push("unknown_currency_code");
      }

      const counterpartyConf = cpClean
        ? 0.95
        : mapped.txn_type === "salary" ||
            mapped.txn_type === "fee" ||
            mapped.txn_type === "card_repayment" ||
            mapped.txn_type === "loan_repayment" ||
            mapped.txn_type === "internal_move"
          ? 0.9
          : 0.75;

      const parsed: ParsedSmsV1 = {
        schema: "fuloos.sms/1",
        kind: "transaction",
        direction: mapped.direction,
        txn_type: mapped.txn_type,
        amount: makeMoney(amountMinor, currencyRaw),
        billed_amount: billedMoney,
        balance_after: balanceMoney,
        date: dateInSms ?? receivedDate,
        time: extractTimeInText(norm),
        date_source: dateInSms ? "text" : "received",
        counterparty: {
          raw: cpRaw,
          name: cpName,
          clean: cpClean,
          city: cpCity,
          country: cpCountry,
        },
        instrument: extractInstrument(norm, g.card || null),
        bank,
        sms: {
          sender: ctx.sender,
          received_at: ctx.received_at,
          hash: ctx.sms_hash ?? "",
        },
        parsed_by: `template:${rule.id}`,
        confidence: {
          overall: 0.95,
          amount: 1.0,
          direction: 1.0,
          date: dateInSms ? 1.0 : 0.85,
          counterparty: counterpartyConf,
        },
        warnings,
      };

      const checked = validateParsedSmsV1(text, parsed);
      if (checked.valid) {
        return checked.parsed;
      }
    }
  }

  return null;
}

const MONEY_IN_NON_BAL_RE =
  /(?:[A-Z]{3}\s*\d[\d,]*(?:\.\d{1,3})?|\d[\d,]*(?:\.\d{1,3})?\s*[A-Z]{3}|[€£₹$]\s*\d[\d,]*(?:\.\d{1,3})?)/i;

const TX_VERB_FOR_RESCUE_RE =
  /(?:\b(?:debited|deducted|purchase|spent|used\s+for|charged|paid|withdrawn|withdrawal|transferred|sent|credited|deposited|received|refund|refunded|reversed|salary|payment)\b|خصم|شراء|سحب|إيداع|ايداع|استرداد|راتب)/i;

/** True when a message has a money figure outside balance/limit clauses AND a debit/credit verb. */
export function hasMoneyAndTransactionVerb(text: string): boolean {
  const nonBal = stripBalanceAndLimitClauses(normalizeSmsDigits(text));
  return MONEY_IN_NON_BAL_RE.test(nonBal) && TX_VERB_FOR_RESCUE_RE.test(nonBal);
}

/**
 * Parse a bank SMS through the validated `fuloos.sms/1` cascade:
 *   1. Learned on-device templates (sender + skeleton)
 *   2. Bank templates (ONLY when bank is known from link or sender)
 *   3. Universal field extractor (Phase 2)
 */
export function parseSmsV1(text: string, ctx: ParseContext): ParsedSmsV1 {
  const rawText = String(text ?? "");
  const norm = normalizeSmsDigits(rawText).replace(/\n/g, " ").trim();
  const bank = resolveBankFromContext(ctx);
  const receivedDate = receivedIsoDate(ctx.received_at);

  // Fast-path non-transaction classification before transaction templates:
  // OTP, declined, and promotional messages must never be parsed as transactions.
  if (COMMON_OTP_RE.test(norm)) {
    return makeNonTx("otp", rawText, ctx, bank, receivedDate, "common:otp", 0.95);
  }
  if (COMMON_DECLINED_RE.test(norm)) {
    return makeNonTx("declined", rawText, ctx, bank, receivedDate, "common:declined", 0.95);
  }
  if (isPromoSms(norm)) {
    return makeNonTx("promo", rawText, ctx, bank, receivedDate, "common:promo", 0.9);
  }

  // Layer 1: Learned templates (Phase 3)
  if (
    !ctx.disable_learned_templates &&
    registeredLearnedMatcher &&
    ctx.learned_templates?.length
  ) {
    const learnedHit = registeredLearnedMatcher(
      rawText,
      ctx,
      bank,
      receivedDate,
      ctx.learned_templates,
    );
    if (learnedHit) {
      const checked = validateParsedSmsV1(rawText, learnedHit);
      if (checked.valid && checked.parsed.kind === "transaction") {
        return checked.parsed;
      }
    }
  }

  // Layer 2: Bank templates (ONLY when bank is known from link or sender, never guessed)
  if (!ctx.disable_bank_templates && bank.id) {
    const templateHit = tryBankTemplates(rawText, ctx, bank, receivedDate);
    if (templateHit && templateHit.kind === "transaction") {
      return templateHit;
    }
  }

  // Layer 3: Universal field extractor (Phase 2) or Phase 1 basic fallback
  if (registeredUniversalParser) {
    const universalHit = registeredUniversalParser(rawText, ctx, bank, receivedDate);
    if (universalHit) {
      const checked = validateParsedSmsV1(rawText, universalHit);
      if (checked.valid) {
        return checked.parsed;
      }
    }
  } else {
    const basicHit = tryBasicPhase1Fallback(rawText, ctx, bank, receivedDate);
    if (basicHit) {
      const checked = validateParsedSmsV1(rawText, basicHit);
      if (checked.valid) {
        return checked.parsed;
      }
    }
  }

  // Balance-only notice (no transaction verb)
  if (isBalanceOnlyNotice(norm)) {
    return makeNonTx(
      "balance_notice",
      rawText,
      ctx,
      bank,
      receivedDate,
      "common:balance_notice",
      0.85,
    );
  }

  // Fallback unknown (never silently drops money+verb alerts in smsPipeline)
  const warnings = hasMoneyAndTransactionVerb(rawText)
    ? ["low_confidence_parse"]
    : [];
  return makeNonTx("unknown", rawText, ctx, bank, receivedDate, "none", 0, warnings);
}

/** Basic Phase 1 fallback for unknown senders until Phase 2's universal extractor is wired. */
function tryBasicPhase1Fallback(
  text: string,
  ctx: ParseContext,
  bank: BankInfo,
  receivedDate: string,
): ParsedSmsV1 | null {
  const norm = normalizeSmsDigits(text).replace(/\n/g, " ").trim();
  const nonBal = stripBalanceAndLimitClauses(norm);
  const extracted = extractCurrencyAmount(nonBal);
  if (!extracted || extracted.amountMinor <= 0) return null;

  let direction: "debit" | "credit" | null = null;
  let txnType: ParsedSmsV1["txn_type"] = "other";
  if (/\b(?:credited|deposited|salary|refund|refunded|reversed|received)\b/i.test(nonBal)) {
    direction = "credit";
    txnType = /\bsalary\b/i.test(nonBal)
      ? "salary"
      : /\b(?:refund|refunded|reversed)\b/i.test(nonBal)
        ? "refund"
        : "transfer_in";
  } else if (
    /\b(?:debited|deducted|purchase|spent|charged|paid|withdrawn|withdrawal|pos|used\s+for|transferred)\b/i.test(
      nonBal,
    )
  ) {
    direction = "debit";
    txnType = /\b(?:atm|cash\s+withdrawal|withdrawn)\b/i.test(nonBal)
      ? "cash_withdrawal"
      : /\b(?:purchase|spent|used\s+for|pos)\b/i.test(nonBal)
        ? "purchase"
        : /\btransfer/i.test(nonBal)
          ? "transfer_out"
          : "other";
  }
  if (!direction) return null;

  const cp = extractCounterpartyFromText(norm, bank.id);
  const billed = extractBilledAmount(norm, extracted.currency);
  const balNum = extractBalanceAfter(norm);
  const accCurr = String(ctx.account_currency || "AED").trim().toUpperCase();
  const dateInSms = dateInText(norm);
  const warnings = extracted.unknownCode ? ["unknown_currency_code"] : [];

  return {
    schema: "fuloos.sms/1",
    kind: "transaction",
    direction,
    txn_type: txnType,
    amount: makeMoney(extracted.amountMinor, extracted.currency),
    billed_amount:
      billed && billed.amountMinor > 0
        ? makeMoney(billed.amountMinor, billed.currency)
        : null,
    balance_after: Number.isFinite(balNum)
      ? buildBalanceMoney(norm, balNum, accCurr)
      : null,
    date: dateInSms ?? receivedDate,
    time: extractTimeInText(norm),
    date_source: dateInSms ? "text" : "received",
    counterparty: cp,
    instrument: extractInstrument(norm, null),
    bank,
    sms: {
      sender: ctx.sender,
      received_at: ctx.received_at,
      hash: ctx.sms_hash ?? "",
    },
    parsed_by: "fallback@1",
    confidence: {
      overall: 0.75,
      amount: 0.9,
      direction: 0.85,
      date: dateInSms ? 1.0 : 0.8,
      counterparty: cp.clean ? 0.85 : 0.6,
    },
    warnings,
  };
}
