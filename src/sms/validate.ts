/* Strict post-parse validator for every `fuloos.sms/1` parser layer.
   Pure TypeScript, sandbox-safe (no DOM, React, Node, or i18n imports). */
import { roundHalfAwayFromZero } from "../currency.ts";
import type { Money, ParsedSmsV1 } from "./types.ts";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  parsed: ParsedSmsV1;
}

const ARABIC_INDIC_MAP: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٬": ",", "٫": ".",
};

/** Normalise Arabic-Indic/Persian digits and Arabic decimal/thousand punctuation to ASCII. */
export function normalizeDigitsForValidation(text: string): string {
  return String(text ?? "").replace(
    /[٠-٩۰-۹٬٫]/g,
    (ch) => ARABIC_INDIC_MAP[ch] ?? ch,
  );
}

/**
 * Matches the start of a balance or credit-limit clause in English or Arabic.
 * Any number sitting inside one of these clauses must never be accepted as the transaction amount.
 */
export const BALANCE_OR_LIMIT_CLAUSE_RE =
  /(?:\b(?:avl\.?\s*(?:cr\.?\s*)?(?:bal(?:ance)?|limit|lmt)|avail(?:able)?\s*(?:cr(?:edit)?\.?\s*)?(?:bal(?:ance)?|limit|lmt)|cr(?:edit)?\.?\s*limit|remaining\s+(?:bal(?:ance)?|limit)|current\s+bal(?:ance)?|new\s+bal(?:ance)?|account\s+bal(?:ance)?|a\/c\s+bal(?:ance)?|bal(?:ance)?\s*(?:is|:|after|now)?|bal\.)\b|(?:ال)?رصيد(?:\s+(?:المتاح|الحالي|المتبقي))?|(?:ال)?حد(?:\s+الائتماني)?)/gi;

interface TextNumberOccurrence {
  raw: string;
  value: number;
  start: number;
  end: number;
  inBalanceOrLimit: boolean;
}

/** Find spans in `normText` that belong to balance or limit clauses. */
function findBalanceLimitSpans(normText: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(BALANCE_OR_LIMIT_CLAUSE_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(normText)) !== null) {
    const start = m.index;
    // Clause extends to the next sentence-ending period followed by whitespace/end,
    // newline, semicolon, or end of string (whichever comes first, capped at 90 chars).
    const rest = normText.slice(start);
    const boundary = /(?:\.(?:\s|$)|[\n;|])/.exec(rest.slice(m[0].length));
    const len = boundary
      ? m[0].length + boundary.index + 1
      : Math.min(rest.length, 90);
    spans.push({ start, end: start + len });
  }
  return spans;
}

/** Extract every numeric literal from normalised text along with whether it sits in a balance/limit clause. */
function extractNumericOccurrences(normText: string): TextNumberOccurrence[] {
  const balanceSpans = findBalanceLimitSpans(normText);
  const out: TextNumberOccurrence[] = [];
  // Match numbers with optional sign, thousands commas, and optional decimal part.
  // Avoid matching card/account digits embedded inside words like XXX1234 unless separated.
  const numRe = /(?<![A-Za-z0-9_.])(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)(?![A-Za-z0-9_])/g;
  // Also handle concatenated currency+number like AED45.00 or USD1,200.50 or GBP12
  const attachedRe = /(?<![A-Za-z])(?:[A-Z]{3}|[€£₹$])(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)(?![A-Za-z0-9_])/gi;

  const seen = new Set<string>();
  const push = (raw: string, start: number, end: number) => {
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const val = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(val)) return;
    const inBalanceOrLimit = balanceSpans.some(
      (sp) => start >= sp.start && start < sp.end,
    );
    out.push({ raw, value: val, start, end, inBalanceOrLimit });
  };

  let m: RegExpExecArray | null;
  while ((m = numRe.exec(normText)) !== null) {
    push(m[1], m.index, m.index + m[1].length);
  }
  while ((m = attachedRe.exec(normText)) !== null) {
    const numStart = m.index + m[0].length - m[1].length;
    push(m[1], numStart, numStart + m[1].length);
  }
  return out;
}

/** Check whether a Money value matches a literal numeric occurrence in the text. */
function moneyMatchesOccurrence(money: Money, occ: TextNumberOccurrence): boolean {
  const factor = 10 ** money.exponent;
  const occMinor = roundHalfAwayFromZero(occ.value * factor);
  return occMinor === money.minor || Math.abs(occMinor) === Math.abs(money.minor);
}

/** Parse a YYYY-MM-DD string into a UTC midnight epoch ms, verifying it is a real calendar date. */
export function parseStrictIsoDateUtc(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() + 1 !== m ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt.getTime();
}

function isoDateFromReceived(receivedAt: string): string {
  const raw = String(receivedAt || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const candidate = raw.slice(0, 10);
    if (parseStrictIsoDateUtc(candidate) !== null) return candidate;
  }
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) {
    return new Date(ms).toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function layerConfidenceFactor(parsedBy: string): number {
  const tag = String(parsedBy || "").toLowerCase();
  if (tag.startsWith("learned:")) return 1.0;
  if (tag.startsWith("template:")) return 0.95;
  if (tag.startsWith("universal")) return 0.9;
  return 0.85;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 10000) / 10000;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Validate a `ParsedSmsV1` output against the raw SMS text.
 * Every parser layer (learned, bank template, universal) must pass through this function.
 */
export function validateParsedSmsV1(
  text: string,
  candidate: ParsedSmsV1,
): ValidationResult {
  const normText = normalizeDigitsForValidation(text);
  const occurrences = extractNumericOccurrences(normText);
  const warnings = [...candidate.warnings];

  const addWarning = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };

  // 1. Verify every money field literally appears in the SMS text
  if (candidate.amount !== null) {
    if (!Number.isInteger(candidate.amount.minor) || candidate.amount.minor <= 0) {
      return { valid: false, reason: "amount_must_be_positive_integer", parsed: candidate };
    }
    const matching = occurrences.filter((occ) =>
      moneyMatchesOccurrence(candidate.amount!, occ),
    );
    if (matching.length === 0) {
      return { valid: false, reason: "amount_not_found_in_text", parsed: candidate };
    }
    // Amount must NEVER come solely from a balance or limit clause
    const outsideBalance = matching.some((occ) => !occ.inBalanceOrLimit);
    if (!outsideBalance) {
      return { valid: false, reason: "amount_in_balance_or_limit_clause", parsed: candidate };
    }
  }

  if (candidate.billed_amount !== null) {
    if (
      !Number.isInteger(candidate.billed_amount.minor) ||
      candidate.billed_amount.minor <= 0
    ) {
      return { valid: false, reason: "billed_amount_invalid", parsed: candidate };
    }
    const matching = occurrences.filter(
      (occ) => !occ.inBalanceOrLimit && moneyMatchesOccurrence(candidate.billed_amount!, occ),
    );
    if (matching.length === 0) {
      return { valid: false, reason: "billed_amount_not_found_in_text", parsed: candidate };
    }
  }

  if (candidate.balance_after !== null) {
    if (!Number.isInteger(candidate.balance_after.minor)) {
      return { valid: false, reason: "balance_after_invalid", parsed: candidate };
    }
    const matching = occurrences.filter((occ) =>
      moneyMatchesOccurrence(candidate.balance_after!, occ),
    );
    if (matching.length === 0) {
      return { valid: false, reason: "balance_after_not_found_in_text", parsed: candidate };
    }
  }

  // 2. Transaction-specific invariants
  if (candidate.kind === "transaction") {
    if (candidate.direction !== "debit" && candidate.direction !== "credit") {
      return { valid: false, reason: "transaction_missing_direction", parsed: candidate };
    }
    if (candidate.amount === null) {
      return { valid: false, reason: "transaction_missing_amount", parsed: candidate };
    }
  }

  // 3. Date validation: real calendar date within [received - 400d, received + 2d]
  const receivedIso = isoDateFromReceived(candidate.sms.received_at);
  const receivedUtc = parseStrictIsoDateUtc(receivedIso);
  let finalDate = candidate.date;
  let finalDateSource = candidate.date_source;
  let dateConf = candidate.confidence.date;

  if (finalDate !== null) {
    const parsedUtc = parseStrictIsoDateUtc(finalDate);
    if (parsedUtc === null) {
      finalDate = receivedIso;
      finalDateSource = "received";
      dateConf = Math.min(dateConf, 0.7);
      addWarning("date_out_of_range");
    } else if (receivedUtc !== null) {
      const diffDays = (parsedUtc - receivedUtc) / DAY_MS;
      if (diffDays > 2 || diffDays < -400) {
        finalDate = receivedIso;
        finalDateSource = "received";
        dateConf = Math.min(dateConf, 0.7);
        addWarning("date_out_of_range");
      }
    }
  } else if (candidate.kind === "transaction") {
    finalDate = receivedIso;
    finalDateSource = "received";
  }

  // 4. Recompute overall confidence = min(field confidences) * layerFactor
  const factor = layerConfidenceFactor(candidate.parsed_by);
  const amountConf = clamp01(candidate.confidence.amount);
  const directionConf = clamp01(candidate.confidence.direction);
  const clampedDateConf = clamp01(dateConf);
  const counterpartyConf = clamp01(candidate.confidence.counterparty);

  let overall: number;
  if (candidate.kind === "transaction") {
    const minField = Math.min(
      amountConf,
      directionConf,
      clampedDateConf,
      counterpartyConf,
    );
    overall = clamp01(minField * factor);
    if (candidate.parsed_by.toLowerCase().startsWith("universal")) {
      overall = Math.min(overall, 0.9);
    }
  } else {
    overall = clamp01(candidate.confidence.overall * factor);
  }

  const normalized: ParsedSmsV1 = {
    ...candidate,
    date: finalDate,
    date_source: finalDateSource,
    confidence: {
      overall,
      amount: amountConf,
      direction: directionConf,
      date: clampedDateConf,
      counterparty: counterpartyConf,
    },
    warnings,
  };

  return { valid: true, parsed: normalized };
}
