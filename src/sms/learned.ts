/* On-device learned SMS templates (Phase 3 — "Teach it once").
   Builds wording-only skeletons with typed slots (zero user amounts, merchants,
   or account/card digits stored), compiles them into tolerant regex matchers,
   and runs as Layer 1 in `parseSmsV1`.

   Pure TypeScript, sandbox-safe (no DOM, React, Node, or i18n imports). */
import { isSupportedCurrency } from "../currency.ts";
import { cleanName, smsAmountToMinor, splitMerchant } from "../ledger/sms.ts";
import { extractCardLast4, normalizeSender } from "../mobile/smsLinks.ts";
import { sha256Hex } from "./hash.ts";
import {
  makeMoney,
  moneyExponent,
  type BalanceMoney,
  type BankInfo,
  type CounterpartyInfo,
  type InstrumentInfo,
  type LearnedSlotKind,
  type LearnedTemplate,
  type LearnedTemplatePattern,
  type ParseContext,
  type ParsedSmsV1,
  type SmsTxnType,
} from "./types.ts";
import {
  classifyDirectionAndType,
  extractMoneyCandidates,
  extractUniversalCounterparty,
  extractUniversalDateAndTime,
  normalizeUniversalText,
} from "./universal.ts";
import { validateParsedSmsV1 } from "./validate.ts";

export interface TextSpan {
  start: number;
  end: number;
}

export type TeachTokenKind =
  | "amount"
  | "currency"
  | "date"
  | "time"
  | "card"
  | "number"
  | "word"
  | "punct";

export interface TeachToken {
  index: number;
  text: string;
  start: number;
  end: number;
  kind: TeachTokenKind;
}

export interface TeachSuggestion {
  normalizedText: string;
  tokens: TeachToken[];
  amountSpan: TextSpan | null;
  currencySpan: TextSpan | null;
  merchantSpan: TextSpan | null;
  dateSpan: TextSpan | null;
  balanceSpan: TextSpan | null;
  direction: "debit" | "credit";
  txnType: SmsTxnType;
}

export interface BuildLearnedTemplateInput {
  sender: string;
  body: string;
  amountSpan: TextSpan;
  currencySpan?: TextSpan | null;
  merchantSpan?: TextSpan | null;
  dateSpan?: TextSpan | null;
  balanceSpan?: TextSpan | null;
  direction: "debit" | "credit";
  txnType: SmsTxnType;
  bankId?: string | null;
  defaultCurrency?: string;
  id?: string;
  createdAt?: string;
}

const DATE_TOKEN_RE =
  /\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/\.](?:\d{1,2}|[A-Za-z]{3})[-/\.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})\b/g;
const TIME_TOKEN_RE = /\b[01]?\d:[0-5]\d(?::[0-5]\d)?(?:\s*[AP]M)?\b|\b2[0-3]:[0-5]\d(?::[0-5]\d)?\b/gi;
const CARD_MASK_RE =
  /(?:[X*\u2022•]{2,}[- ]?\d{2,4}|\*\d{4}\b|\b\d[X*]{2,}[-X*]+\d{2,4}\b|\b[X*]{4,}\d{2,4}\b)/gi;
const NUMBER_TOKEN_RE = /\b\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?\b|\b\d+(?:\.\d{1,3})?\b/g;

function normalizeCurrencyToken(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  if (t === "€") return "EUR";
  if (t === "£") return "GBP";
  if (t === "₹") return "INR";
  if (t === "$") return "USD";
  if (/^(?:درهم|دراهم|د\.?\s*إ\.?|د\.?\s*ا\.?)$/.test(raw.trim())) return "AED";
  if (/^(?:ريال|ر\.?\s*س\.?)$/.test(raw.trim())) return "SAR";
  if (/^[A-Z]{3}$/.test(t) && isSupportedCurrency(t)) return t;
  return null;
}

/** Tokenise a normalised SMS into ordered non-overlapping chips for the Teach UI. */
export function tokenizeSmsForTeach(rawBody: string): {
  normalizedText: string;
  tokens: TeachToken[];
} {
  const norm = normalizeUniversalText(rawBody);
  const specialSpans: Array<{ start: number; end: number; kind: TeachTokenKind }> = [];
  const overlaps = (start: number, end: number) =>
    specialSpans.some((s) => start < s.end && end > s.start);

  const scan = (re: RegExp, kind: TeachTokenKind) => {
    const r = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(norm)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!overlaps(start, end)) {
        specialSpans.push({ start, end, kind });
      }
    }
  };

  scan(DATE_TOKEN_RE, "date");
  scan(TIME_TOKEN_RE, "time");
  scan(CARD_MASK_RE, "card");
  scan(NUMBER_TOKEN_RE, "number");

  // Also split glued currency+amount like "AED45.00" or "£12.50" cleanly into currency + number
  const gluedRe = /(?<![A-Za-z])([A-Z]{3}|[€£₹$])(\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)(?![A-Za-z0-9_])/g;
  let gm: RegExpExecArray | null;
  while ((gm = gluedRe.exec(norm)) !== null) {
    const cur = gm[1];
    const isCur = cur.length === 1 || isSupportedCurrency(cur.toUpperCase());
    if (!isCur) continue;
    const curStart = gm.index;
    const curEnd = curStart + cur.length;
    const numStart = curEnd;
    const numEnd = numStart + gm[2].length;
    if (!overlaps(curStart, curEnd)) {
      specialSpans.push({ start: curStart, end: curEnd, kind: "currency" });
    }
    if (!overlaps(numStart, numEnd)) {
      specialSpans.push({ start: numStart, end: numEnd, kind: "number" });
    }
  }

  specialSpans.sort((a, b) => a.start - b.start);

  const tokens: TeachToken[] = [];
  let cursor = 0;

  const pushPlainSegment = (segStart: number, segEnd: number) => {
    const sub = norm.slice(segStart, segEnd);
    const wordOrPunctRe = /([A-Za-z\u0600-\u06FF][A-Za-z0-9\u0600-\u06FF&'/-]*|[€£₹$]|[^\sA-Za-z0-9\u0600-\u06FF]+)/g;
    let wm: RegExpExecArray | null;
    while ((wm = wordOrPunctRe.exec(sub)) !== null) {
      const text = wm[0];
      const start = segStart + wm.index;
      const end = start + text.length;
      let kind: TeachTokenKind = "word";
      if (normalizeCurrencyToken(text)) {
        kind = "currency";
      } else if (/^[^\w\u0600-\u06FF]+$/.test(text)) {
        kind = "punct";
      }
      tokens.push({ index: tokens.length, text, start, end, kind });
    }
  };

  for (const sp of specialSpans) {
    if (sp.start > cursor) {
      pushPlainSegment(cursor, sp.start);
    }
    tokens.push({
      index: tokens.length,
      text: norm.slice(sp.start, sp.end),
      start: sp.start,
      end: sp.end,
      kind: sp.kind,
    });
    cursor = sp.end;
  }
  if (cursor < norm.length) {
    pushPlainSegment(cursor, norm.length);
  }

  return { normalizedText: norm, tokens };
}

/** Pre-fill Teach UI chip selections using the universal extractor's best guesses. */
export function suggestTeachSelections(
  rawBody: string,
  _sender: string,
): TeachSuggestion {
  const { normalizedText, tokens } = tokenizeSmsForTeach(rawBody);
  const candidates = extractMoneyCandidates(normalizedText);

  const amountCand =
    candidates.find((c) => c.label === "amount") ??
    candidates[0] ??
    null;
  const balanceCand =
    candidates.find((c) => c.label === "balance" || c.label === "limit") ?? null;

  let amountSpan: TextSpan | null = null;
  let currencySpan: TextSpan | null = null;

  if (amountCand) {
    // Locate the numeric sub-span and currency sub-span inside amountCand
    const sub = normalizedText.slice(amountCand.start, amountCand.end);
    const numIdx = sub.indexOf(amountCand.amountStr);
    if (numIdx >= 0) {
      amountSpan = {
        start: amountCand.start + numIdx,
        end: amountCand.start + numIdx + amountCand.amountStr.length,
      };
      // Check adjacent currency token inside amountCand
      const curTok = tokens.find(
        (t) =>
          t.kind === "currency" &&
          t.start >= amountCand.start &&
          t.end <= amountCand.end,
      );
      if (curTok) {
        currencySpan = { start: curTok.start, end: curTok.end };
      }
    } else {
      amountSpan = { start: amountCand.start, end: amountCand.end };
    }
  } else {
    // Fallback to first decimal number token
    const numTok =
      tokens.find((t) => t.kind === "number" && /\.\d{2}$/.test(t.text)) ??
      tokens.find((t) => t.kind === "number");
    if (numTok) {
      amountSpan = { start: numTok.start, end: numTok.end };
    }
  }

  let balanceSpan: TextSpan | null = null;
  if (balanceCand && (!amountSpan || balanceCand.start >= amountSpan.end || balanceCand.end <= amountSpan.start)) {
    const sub = normalizedText.slice(balanceCand.start, balanceCand.end);
    const numIdx = sub.indexOf(balanceCand.amountStr);
    balanceSpan =
      numIdx >= 0
        ? {
            start: balanceCand.start + numIdx,
            end: balanceCand.start + numIdx + balanceCand.amountStr.length,
          }
        : { start: balanceCand.start, end: balanceCand.end };
  }

  // Date guess
  const dateTok = tokens.find((t) => t.kind === "date") ?? null;
  const dateSpan: TextSpan | null = dateTok
    ? { start: dateTok.start, end: dateTok.end }
    : null;

  // Counterparty guess
  let merchantSpan: TextSpan | null = null;
  const cp = extractUniversalCounterparty(
    normalizedText,
    null,
    amountCand?.end,
  );
  if (cp.raw) {
    const idx = normalizedText.indexOf(cp.raw);
    if (idx >= 0) {
      merchantSpan = { start: idx, end: idx + cp.raw.length };
    }
  }

  // Direction & txnType guess
  const cls = classifyDirectionAndType(normalizedText, amountCand?.start ?? 0);
  const direction: "debit" | "credit" = cls.direction ?? "debit";
  const txnType: SmsTxnType =
    cls.direction ? cls.txnType : direction === "credit" ? "transfer_in" : "purchase";

  return {
    normalizedText,
    tokens,
    amountSpan,
    currencySpan,
    merchantSpan,
    dateSpan,
    balanceSpan,
    direction,
    txnType,
  };
}

/**
 * Scrub any accidental digit runs from literal bank wording so zero user numbers
 * (amounts, card/account digits, references, dates) can ever persist in a template.
 */
function splitLiteralWithNumericSlots(
  literal: string,
  nextSlotIndex: () => number,
  tokensOut: LearnedTemplatePattern["tokens"],
): void {
  if (!literal) return;
  const digitRunRe = /\d[\d,.-]*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = digitRunRe.exec(literal)) !== null) {
    if (m.index > last) {
      tokensOut.push({ kind: "literal", text: literal.slice(last, m.index) });
    }
    tokensOut.push({ kind: "slot", slot: "NUM", index: nextSlotIndex() });
    last = m.index + m[0].length;
  }
  if (last < literal.length) {
    tokensOut.push({ kind: "literal", text: literal.slice(last) });
  }
}

/**
 * Build a wording-only, zero-PII `LearnedTemplate` (`template_version: 1`) from
 * a user's chip selections on one SMS message.
 */
export function buildLearnedTemplateFromSpans(
  input: BuildLearnedTemplateInput,
): LearnedTemplate {
  const norm = normalizeUniversalText(input.body);
  const senderNorm = normalizeSender(input.sender);

  interface MarkedSpan {
    start: number;
    end: number;
    slot: LearnedSlotKind;
    field?: string;
  }

  const marked: MarkedSpan[] = [];
  const overlaps = (start: number, end: number) =>
    marked.some((s) => start < s.end && end > s.start);

  const addMarked = (
    span: TextSpan | null | undefined,
    slot: LearnedSlotKind,
    field?: string,
  ) => {
    if (!span) return;
    const start = Math.max(0, Math.min(norm.length, span.start));
    const end = Math.max(start, Math.min(norm.length, span.end));
    if (end <= start) return;
    if (overlaps(start, end)) return;
    marked.push({ start, end, slot, field });
  };

  // 1. Handle user's selected amountSpan — if it includes a currency code/symbol (e.g. "74.50 AED"),
  //    split it cleanly into {AMOUNT} + {CUR} slots!
  const amtText = norm.slice(input.amountSpan.start, input.amountSpan.end);
  const gluedBefore = /^([A-Z]{3}|[€£₹$]|درهم|ريال)\s*(\d[\d,]*(?:\.\d{1,3})?)$/i.exec(amtText.trim());
  const gluedAfter = /^(\d[\d,]*(?:\.\d{1,3})?)\s*([A-Z]{3}|درهم|ريال)$/i.exec(amtText.trim());
  if (gluedBefore) {
    const curOff = amtText.indexOf(gluedBefore[1]);
    const numOff = amtText.indexOf(gluedBefore[2], curOff + gluedBefore[1].length);
    addMarked(
      { start: input.amountSpan.start + curOff, end: input.amountSpan.start + curOff + gluedBefore[1].length },
      "CUR",
      "currency",
    );
    addMarked(
      { start: input.amountSpan.start + numOff, end: input.amountSpan.start + numOff + gluedBefore[2].length },
      "AMOUNT",
      "amount",
    );
  } else if (gluedAfter) {
    const numOff = amtText.indexOf(gluedAfter[1]);
    const curOff = amtText.indexOf(gluedAfter[2], numOff + gluedAfter[1].length);
    addMarked(
      { start: input.amountSpan.start + numOff, end: input.amountSpan.start + numOff + gluedAfter[1].length },
      "AMOUNT",
      "amount",
    );
    addMarked(
      { start: input.amountSpan.start + curOff, end: input.amountSpan.start + curOff + gluedAfter[2].length },
      "CUR",
      "currency",
    );
  } else {
    addMarked(input.amountSpan, "AMOUNT", "amount");
    if (input.currencySpan) {
      addMarked(input.currencySpan, "CUR", "currency");
    } else {
      // Auto-detect an immediately adjacent currency code/symbol around amountSpan
      const { tokens } = tokenizeSmsForTeach(norm);
      const adjacentCur = tokens.find(
        (t) =>
          t.kind === "currency" &&
          (Math.abs(t.end - input.amountSpan.start) <= 2 ||
            Math.abs(t.start - input.amountSpan.end) <= 2),
      );
      if (adjacentCur) {
        addMarked({ start: adjacentCur.start, end: adjacentCur.end }, "CUR", "currency");
      }
    }
  }

  // 2. Other user-selected spans
  addMarked(input.merchantSpan, "MERCHANT", "merchant");
  addMarked(input.dateSpan, "DATE", "date");
  addMarked(input.balanceSpan, "BAL", "balance");

  // 3. Auto-slot remaining dynamic spans (card masks, dates, times, balances, stray numbers)
  //    so zero personal digits ever survive in literal text.
  const scanAuto = (re: RegExp, slot: LearnedSlotKind, field?: string) => {
    const r = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(norm)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!overlaps(start, end)) {
        const alreadyHasField = field ? marked.some((x) => x.field === field) : false;
        marked.push({
          start,
          end,
          slot,
          field: alreadyHasField ? undefined : field,
        });
      }
    }
  };

  scanAuto(CARD_MASK_RE, "CARD", "card");
  scanAuto(DATE_TOKEN_RE, "DATE", "date");
  scanAuto(TIME_TOKEN_RE, "TIME", "time");
  scanAuto(NUMBER_TOKEN_RE, "NUM");

  marked.sort((a, b) => a.start - b.start);

  // 4. Build token stream & field_map
  const tokensOut: LearnedTemplatePattern["tokens"] = [];
  const fieldMap: Record<string, string> = {};
  let slotCounter = 0;
  const nextSlotIndex = () => slotCounter++;

  let cursor = 0;
  for (const sp of marked) {
    if (sp.start > cursor) {
      splitLiteralWithNumericSlots(norm.slice(cursor, sp.start), nextSlotIndex, tokensOut);
    }
    const idx = nextSlotIndex();
    tokensOut.push({ kind: "slot", slot: sp.slot, index: idx });
    if (sp.field && !fieldMap[sp.field]) {
      fieldMap[sp.field] = `s_${idx}`;
    }
    cursor = sp.end;
  }
  if (cursor < norm.length) {
    splitLiteralWithNumericSlots(norm.slice(cursor), nextSlotIndex, tokensOut);
  }

  const skeleton = tokensOut
    .map((t) => (t.kind === "literal" ? t.text : `{${t.slot}}`))
    .join("")
    .replace(/\s+/g, " ")
    .trim();

  const skeletonHash = sha256Hex(`${senderNorm}|${skeleton}`);
  const id = input.id ?? `lt_${skeletonHash.slice(0, 12)}`;

  return {
    template_version: 1,
    id,
    sender_norm: senderNorm,
    skeleton_hash: skeletonHash,
    pattern: {
      skeleton,
      tokens: tokensOut,
    },
    field_map: fieldMap,
    direction: input.direction,
    txn_type: input.txnType,
    bank_id: input.bankId ?? null,
    created_at: input.createdAt ?? new Date().toISOString(),
    hits: 0,
    last_hit_at: null,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slotRegexBody(slot: LearnedSlotKind, isLast: boolean): string {
  switch (slot) {
    case "AMOUNT":
      return "\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,3})?|\\d+(?:\\.\\d{1,3})?";
    case "CUR":
      return "[A-Z]{3}|[€£₹$]|درهم|دراهم|ريال";
    case "DATE":
      return "\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[/.-](?:\\d{1,2}|[A-Za-z]{3})[/.-]\\d{2,4}|\\d{1,2}\\s+[A-Za-z]{3}\\s+\\d{2,4}";
    case "TIME":
      return "\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[AP]M)?";
    case "CARD":
      return "[A-Za-z0-9X*\\u2022•-]*\\d{2,}[A-Za-z0-9X*\\u2022•-]*";
    case "MERCHANT":
      return isLast ? ".+" : ".+?";
    case "BAL":
      return "(?:(?:[A-Z]{3}|[€£₹$])\\s*)?(?:\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,3})?|\\d+(?:\\.\\d{1,3})?)(?:\\s*[A-Z]{3})?";
    case "NUM":
      return "\\d[\\d,.-]*";
  }
}

/** Compile a `LearnedTemplate` into a tolerant RegExp with named slot capture groups. */
export function compileLearnedTemplateRegex(template: LearnedTemplate): RegExp {
  const tokens = template.pattern.tokens;
  let src = "^\\s*";
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === "literal") {
      // Collapse whitespace runs to tolerant \s+ and allow optional spaces around punctuation
      const escaped = escapeRegExp(tok.text)
        .replace(/\\ /g, " ")
        .replace(/\s+/g, "\\s+");
      src += escaped;
    } else {
      const isLast = i === tokens.length - 1;
      const body = slotRegexBody(tok.slot, isLast);
      src += `(?<s_${tok.index}>${body})`;
    }
  }
  src += "\\s*$";
  return new RegExp(src, "i");
}

function parseSlotBalance(rawBal: string, fallbackCurrency: string): BalanceMoney | null {
  const norm = normalizeUniversalText(rawBal);
  const m =
    /(?:([A-Z]{3}|[€£₹$])\s*)?(\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)(?:\s*([A-Z]{3}))?/i.exec(
      norm,
    );
  if (!m) return null;
  const cur =
    (m[1] ? normalizeCurrencyToken(m[1]) : null) ??
    (m[3] ? normalizeCurrencyToken(m[3]) : null) ??
    fallbackCurrency;
  const minor = smsAmountToMinor(m[2], cur);
  if (minor === null) return null;
  return {
    minor,
    currency: cur,
    exponent: moneyExponent(cur),
    label: "balance",
  };
}

/**
 * Layer 1 matcher: try on-device learned templates against an SMS.
 * Same-sender templates are tried first (highest hits / newest first), then
 * any remaining templates matching the exact wording skeleton.
 */
export function matchLearnedTemplates(
  rawText: string,
  ctx: ParseContext,
  bank: BankInfo,
  receivedDate: string,
  templates: ReadonlyArray<LearnedTemplate>,
): ParsedSmsV1 | null {
  if (!templates.length) return null;
  const norm = normalizeUniversalText(rawText);
  if (!norm) return null;

  const senderNorm = normalizeSender(ctx.sender);
  const accCurr = String(ctx.account_currency || "AED").trim().toUpperCase();

  // Order: matching sender first, then others; within group, highest hits then newest
  const ordered = [...templates]
    .filter((t) => t && t.template_version === 1 && Array.isArray(t.pattern?.tokens))
    .sort((a, b) => {
      const aSame = a.sender_norm === senderNorm ? 1 : 0;
      const bSame = b.sender_norm === senderNorm ? 1 : 0;
      if (aSame !== bSame) return bSame - aSame;
      if ((b.hits || 0) !== (a.hits || 0)) return (b.hits || 0) - (a.hits || 0);
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });

  for (const tpl of ordered) {
    let re: RegExp;
    try {
      re = compileLearnedTemplateRegex(tpl);
    } catch {
      continue;
    }
    const m = re.exec(norm);
    if (!m || !m.groups) continue;

    const getField = (name: string): string | null => {
      const key = tpl.field_map[name];
      if (!key) return null;
      const val = m.groups?.[key];
      return val !== undefined && val.trim() ? val.trim() : null;
    };

    const amountRaw = getField("amount");
    if (!amountRaw) continue;

    const curRaw = getField("currency");
    const currency = (curRaw ? normalizeCurrencyToken(curRaw) : null) ?? accCurr;
    const amountMinor = smsAmountToMinor(amountRaw, currency);
    if (amountMinor === null || amountMinor <= 0) continue;

    // Date & time
    const dateRaw = getField("date");
    const timeRaw = getField("time");
    const extractedDt = extractUniversalDateAndTime(
      dateRaw ? `${dateRaw} ${timeRaw ?? ""}`.trim() : norm,
      0,
    );
    const dateInSms = extractedDt.date;
    const timeInSms = extractedDt.time;

    // Counterparty
    const merchantRaw = getField("merchant");
    let counterparty: CounterpartyInfo = {
      raw: null,
      name: null,
      clean: null,
      city: null,
      country: null,
    };
    if (merchantRaw) {
      const [merch, city, country] = splitMerchant(merchantRaw, tpl.bank_id ?? bank.id ?? "");
      const name = (merch ?? merchantRaw).trim() || null;
      const clean = name ? cleanName(name) || name : null;
      counterparty = { raw: merchantRaw, name, clean, city, country };
    }

    // Card / instrument
    const cardRaw = getField("card");
    const last4 = extractCardLast4(cardRaw ? `card ${cardRaw}` : norm, null);
    const instrument: InstrumentInfo = {
      kind: /\bcredit\s*card\b/i.test(norm)
        ? "credit_card"
        : last4
          ? "debit_card"
          : /\b(?:a\/c|acct|account)\b/i.test(norm)
            ? "account"
            : null,
      last4,
    };

    // Balance after
    const balRaw = getField("balance");
    const balanceAfter = balRaw ? parseSlotBalance(balRaw, accCurr) : null;

    const resolvedBank: BankInfo = bank.id
      ? bank
      : tpl.bank_id
        ? { id: tpl.bank_id, source: "learned" }
        : bank;

    const candidate: ParsedSmsV1 = {
      schema: "fuloos.sms/1",
      kind: "transaction",
      direction: tpl.direction,
      txn_type: tpl.txn_type,
      amount: makeMoney(amountMinor, currency),
      billed_amount: null,
      balance_after: balanceAfter,
      date: dateInSms ?? receivedDate,
      time: timeInSms,
      date_source: dateInSms ? "text" : "received",
      counterparty,
      instrument,
      bank: resolvedBank,
      sms: {
        sender: ctx.sender,
        received_at: ctx.received_at,
        hash: ctx.sms_hash ?? "",
      },
      parsed_by: `learned:${tpl.id}`,
      confidence: {
        overall: 1.0,
        amount: 1.0,
        direction: 1.0,
        date: dateInSms ? 1.0 : 1.0,
        counterparty: merchantRaw ? 1.0 : 1.0,
      },
      warnings: [],
    };

    const checked = validateParsedSmsV1(rawText, candidate);
    if (checked.valid && checked.parsed.kind === "transaction") {
      return checked.parsed;
    }
  }

  return null;
}
