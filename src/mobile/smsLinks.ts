import type { Account } from "../domain.ts";
import { DEFAULT_REVIEW_THRESHOLD } from "../ledger/categoriser.ts";
import { bankFromSender } from "../ledger/sms.ts";

export type SmsAutoAddMode = "auto_high_confidence" | "always_review";

export interface SmsAccountLink {
  id: string;
  account_id: string;
  /** One or more normalized SMS sender addresses (e.g. ["ADCB", "ADCB-ALERT"]). */
  senders: string[];
  /** Optional bank parser override ("ADCB" | "Liv" | "Mashreq" | "FAB" | "ADIB" | "ENBD" | null for auto). */
  bank_template: string | null;
  /** Optional 4-digit card suffix to route multi-card alerts from the same bank sender to specific accounts. */
  card_last4: string | null;
  auto_add_mode: SmsAutoAddMode;
  /** Confidence threshold (0..1) above which transactions are auto-added in auto_high_confidence mode. */
  confidence_threshold: number;
  enabled: boolean;
  /** Epoch milliseconds of the newest SMS already scanned/processed for this link. */
  last_synced_at: number;
  created_at: string;
}

export interface DiscoveredSmsSender {
  address: string;
  normalized: string;
  messageCount: number;
  latestTimestamp: number;
  sampleMasked: string;
  detectedBank: string | null;
  detectedCardLast4s: string[];
}

export function normalizeSender(sender: string | null | undefined): string {
  return String(sender ?? "")
    .trim()
    .replace(/^[A-Za-z]{2}-/, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function normalizeCardLast4(
  value: string | null | undefined,
): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length !== 4) return null;
  return digits;
}

/**
 * Extract a 4-digit card suffix from either parser output or common UAE bank alert patterns
 * (e.g. "Card ending 1234", "Card XX1234", "Card ****1234", "Card No. ...1234").
 */
export function extractCardLast4(
  message: string,
  parsedCard: string | null | undefined = null,
): string | null {
  const fromParsed = normalizeCardLast4(parsedCard);
  if (fromParsed) return fromParsed;
  const text = String(message ?? "");
  const m =
    /(?:card\s+(?:ending(?:\s+(?:in|with))?|no\.?|number|xx+|\*+)\s*|ending\s+(?:in|with)?\s*|xx+|[*]{2,})(\d{4})\b/i.exec(
      text,
    );
  return m ? normalizeCardLast4(m[1]) : null;
}

/**
 * Resolve which linked Fuloos account should receive an SMS from `sender` (with optional `cardLast4`).
 * Priority:
 *  1. Enabled link matching sender AND exact card_last4 (most specific — splits debit vs credit cards).
 *  2. Enabled link matching sender with no card_last4 filter (catch-all account for that bank).
 *  3. null if no enabled link matches (or if every link for this sender requires a different card_last4).
 */
export function matchSmsToLink(
  sender: string | null | undefined,
  cardLast4: string | null | undefined,
  links: ReadonlyArray<SmsAccountLink>,
): SmsAccountLink | null {
  const normSender = normalizeSender(sender);
  if (!normSender) return null;
  const normCard = normalizeCardLast4(cardLast4);

  const matchingSender = links.filter(
    (link) =>
      link.enabled &&
      link.senders.some((s) => {
        const target = normalizeSender(s);
        return target.length > 0 && target === normSender;
      }),
  );

  if (!matchingSender.length) return null;

  if (normCard) {
    const exactCard = matchingSender.find(
      (link) => normalizeCardLast4(link.card_last4) === normCard,
    );
    if (exactCard) return exactCard;
  }

  const catchAll = matchingSender.find(
    (link) => !normalizeCardLast4(link.card_last4),
  );
  return catchAll ?? null;
}

export function detectBankForSenderOrText(
  sender: string | null | undefined,
  message: string,
): string | null {
  const fromSender = bankFromSender(sender);
  if (fromSender) return fromSender;
  const combined = `${sender ?? ""} ${message}`;
  if (/\benbd\b|emirates\s*nbd/i.test(combined)) return "ENBD";
  return null;
}

export function validateSmsLink(
  draft: Omit<SmsAccountLink, "id" | "created_at"> & { id?: string },
  accounts: ReadonlyArray<Pick<Account, "id">>,
  existingLinks: ReadonlyArray<SmsAccountLink> = [],
): void {
  if (!draft.account_id || !accounts.some((a) => a.id === draft.account_id)) {
    throw new Error("Choose a valid Fuloos account.");
  }
  const senders = draft.senders
    .map(normalizeSender)
    .filter((s) => s.length > 0);
  if (!senders.length) {
    throw new Error("Add at least one SMS sender ID.");
  }
  if (
    draft.card_last4 !== null &&
    draft.card_last4 !== "" &&
    !normalizeCardLast4(draft.card_last4)
  ) {
    throw new Error("Card routing filter must be exactly 4 digits.");
  }
  if (
    draft.auto_add_mode !== "auto_high_confidence" &&
    draft.auto_add_mode !== "always_review"
  ) {
    throw new Error("Choose a valid automation mode.");
  }
  if (
    !Number.isFinite(draft.confidence_threshold) ||
    draft.confidence_threshold < 0.3 ||
    draft.confidence_threshold > 0.99
  ) {
    throw new Error("Confidence threshold must be between 30% and 99%.");
  }
  const card = normalizeCardLast4(draft.card_last4);
  for (const other of existingLinks) {
    if (draft.id && other.id === draft.id) continue;
    const otherCard = normalizeCardLast4(other.card_last4);
    if (otherCard !== card) continue;
    const overlap = other.senders.find((s) =>
      senders.includes(normalizeSender(s)),
    );
    if (overlap) {
      throw new Error(
        card
          ? `Sender "${overlap}" with card ••${card} is already linked to another account.`
          : `Sender "${overlap}" is already linked as a catch-all. Add a 4-digit card filter to route a separate card.`,
      );
    }
  }
}

export function createDefaultSmsLink(
  accountId: string,
  senders: string[],
  bankTemplate: string | null = null,
  cardLast4: string | null = null,
): Omit<SmsAccountLink, "id" | "created_at"> {
  return {
    account_id: accountId,
    senders: [...new Set(senders.map(normalizeSender).filter(Boolean))],
    bank_template: bankTemplate,
    card_last4: normalizeCardLast4(cardLast4),
    auto_add_mode: "auto_high_confidence",
    confidence_threshold: DEFAULT_REVIEW_THRESHOLD,
    enabled: true,
    last_synced_at: 0,
  };
}
