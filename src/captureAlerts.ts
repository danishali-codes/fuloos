import type { ImportTransaction } from "./csv.ts";
import {
  uaeToday,
  validateTransaction,
  type Account,
  type CaptureAlertSource,
  type CapturedAlert,
  type Ledger,
} from "./domain.ts";
import type { UserSuggestion } from "./ledger/learning.ts";
import {
  DEFAULT_CURRENCY,
  getPeggedFallbackRate,
  convertMinor,
  normalizeCurrencyCode,
} from "./currency.ts";
import {
  bankForMessage,
  cleanName,
  dateInText,
  detectBank,
  extractCurrencyAmount,
  parseSms,
  stripBalanceAndLimitClauses,
} from "./ledger/sms.ts";
import { displayPayee } from "./ledger/smsImport.ts";
import { applyRules } from "./rules.ts";

export function pendingCapturedAlerts(
  alerts: readonly CapturedAlert[] | undefined,
): CapturedAlert[] {
  if (!alerts?.length) return [];
  return alerts
    .filter((a) => a.status === "pending")
    .slice()
    .sort((a, b) => b.created_at_iso.localeCompare(a.created_at_iso));
}

export function matchAccountHint(
  hint: string,
  accounts: readonly Account[],
  defaultAccountId?: string | null,
): string {
  if (!accounts.length) return "";
  const normHint = hint.toLowerCase().trim();
  if (normHint) {
    const digits = /\b(\d{4})\b/.exec(normHint)?.[1];
    if (digits) {
      const byDigits = accounts.find((a) => a.name.includes(digits));
      if (byDigits) return byDigits.id;
    }
    const tokens = normHint
      .split(/[\s·\-_/]+/)
      .filter((t) => t.length >= 3 && t !== "card");
    for (const tok of tokens) {
      const byName = accounts.find((a) =>
        a.name.toLowerCase().includes(tok),
      );
      if (byName) return byName.id;
    }
  }
  if (defaultAccountId && accounts.some((a) => a.id === defaultAccountId)) {
    return defaultAccountId;
  }
  return accounts[0].id;
}

/** Parse a clipboard/share-sheet bank alert text into an unsaved CapturedAlert draft. */
export function parseClipboardOrShareAlert(
  rawText: string,
  options: {
    source?: CaptureAlertSource;
    subject?: string;
    fallbackDate?: string;
  } = {},
): Omit<CapturedAlert, "id"> {
  const text = rawText.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("Paste or copy a bank alert first.");

  const fallbackDate = options.fallbackDate || uaeToday();
  const batchBank = detectBank([text]);
  const bank = bankForMessage(text, batchBank);
  const parsed = parseSms(text, bank);
  const parsedDate = parsed.date_in_text || dateInText(text) || fallbackDate;

  let parsedType: CapturedAlert["parsed_type"] = "unknown";
  if (parsed.direction === "debit") parsedType = "expense";
  else if (parsed.direction === "credit") parsedType = "income";

  let parsedCurrency = parsed.currency
    ? normalizeCurrencyCode(parsed.currency)
    : undefined;
  let parsedOriginalAmount = parsed.amount_minor ?? undefined;
  let parsedAmount = 0;
  let parsedFxRate: number | undefined;
  let parsedFxStatus: CapturedAlert["parsed_fx_status"] = "exact";
  let parsedFxSource: CapturedAlert["parsed_fx_source"] = "same_currency";

  if (parsedOriginalAmount && parsedCurrency) {
    if (parsedCurrency === DEFAULT_CURRENCY) {
      parsedAmount = parsedOriginalAmount;
      parsedFxRate = 1;
    } else if (
      parsed.billed_currency === DEFAULT_CURRENCY &&
      parsed.billed_amount_minor
    ) {
      parsedAmount = parsed.billed_amount_minor;
      parsedFxSource = "bank_sms";
      parsedFxStatus = "exact";
    } else {
      const pegged = getPeggedFallbackRate(parsedCurrency, DEFAULT_CURRENCY);
      if (pegged !== null) {
        parsedAmount = convertMinor(
          parsedOriginalAmount,
          parsedCurrency,
          DEFAULT_CURRENCY,
          pegged,
        );
        parsedFxRate = pegged;
        parsedFxSource = "manual_rate";
        parsedFxStatus = "estimated";
      } else {
        parsedAmount = 0;
        parsedFxSource = undefined;
        parsedFxStatus = "estimated";
      }
    }
  }

  let parsedPayee =
    displayPayee(parsed.merchant_clean) ||
    displayPayee(cleanName(parsed.merchant)) ||
    "";

  // Fallback for ENBD / generic alerts not matched by sms.ts rules
  if (parsedType === "unknown" || (parsedAmount === 0 && !parsedOriginalAmount)) {
    const nonBalance = stripBalanceAndLimitClauses(text.replace(/\n+/g, " "));
    const extracted = extractCurrencyAmount(nonBalance);
    if (extracted) {
      parsedCurrency = extracted.currency;
      parsedOriginalAmount = extracted.amountMinor;
      if (extracted.currency === DEFAULT_CURRENCY) {
        parsedAmount = extracted.amountMinor;
        parsedFxRate = 1;
        parsedFxSource = "same_currency";
        parsedFxStatus = "exact";
      } else {
        const pegged = getPeggedFallbackRate(extracted.currency, DEFAULT_CURRENCY);
        if (pegged !== null) {
          parsedAmount = convertMinor(
            extracted.amountMinor,
            extracted.currency,
            DEFAULT_CURRENCY,
            pegged,
          );
          parsedFxRate = pegged;
          parsedFxSource = "manual_rate";
          parsedFxStatus = "estimated";
        } else {
          parsedFxSource = undefined;
          parsedFxStatus = "estimated";
        }
      }
    }
    if (parsedType === "unknown") {
      if (/\b(?:credited|deposited|salary|refund|received)\b/i.test(nonBalance)) {
        parsedType = "income";
      } else if (
        /\b(?:debited|purchase|spent|charged|paid|withdrawal|pos)\b/i.test(
          nonBalance,
        )
      ) {
        parsedType = "expense";
      }
    }
    if (!parsedPayee) {
      const atMatch =
        /\bat\s+([A-Za-z0-9][A-Za-z0-9\s&*.'-]{1,60}?)(?:\s+on\s+\d|\s*\.|$)/i.exec(
          nonBalance,
        );
      if (atMatch) {
        parsedPayee = displayPayee(cleanName(atMatch[1])) || atMatch[1].trim();
      }
    }
  }

  const cardMatch =
    parsed.card_last4 ||
    /(?:card\s+(?:ending(?:\s+with)?|no\.?|xx+|\*+)\s*|ending\s+)(\d{4})\b/i.exec(
      text,
    )?.[1] ||
    "";
  const detectedBank =
    bank || (/\benbd\b|emirates\s*nbd/i.test(text) ? "ENBD" : null);
  const accountHint = [detectedBank, cardMatch ? `Card ${cardMatch}` : ""]
    .filter(Boolean)
    .join(" · ");

  return {
    source: options.source ?? "shortcut",
    subject: (options.subject ?? "").trim().slice(0, 200),
    raw_text: text.slice(0, 8000),
    parsed_type: parsedType,
    parsed_amount: parsedAmount,
    parsed_date: parsedDate,
    parsed_payee: parsedPayee.slice(0, 120),
    parsed_notes: `Captured ${detectedBank ? `${detectedBank} ` : ""}alert`,
    account_hint: accountHint.slice(0, 64),
    status: "pending",
    created_at_iso: new Date().toISOString(),
    ...(parsedCurrency ? { parsed_currency: parsedCurrency } : {}),
    ...(parsedOriginalAmount !== undefined
      ? { parsed_original_amount: parsedOriginalAmount }
      : {}),
    ...(parsedFxRate !== undefined ? { parsed_fx_rate: parsedFxRate } : {}),
    ...(parsedFxSource ? { parsed_fx_source: parsedFxSource } : {}),
    ...(parsedCurrency ? { parsed_fx_status: parsedFxStatus } : {}),
    ...(parsed.warnings.length ? { warnings: parsed.warnings } : {}),
  };
}

export interface AlertDraftOverrides {
  account_id?: string;
  category_id?: string | null;
  type?: "expense" | "income";
  amount?: number;
  date?: string;
  payee?: string;
  notes?: string;
}

export function suggestCategoryForAlert(
  alert: CapturedAlert,
  ledger: Ledger,
  suggest?: (merchant: string | null, amountAed: number) => UserSuggestion,
): {
  category_id: string | null;
  payee: string;
  tags: string[];
  suggestion: UserSuggestion | null;
} {
  const cleaned = cleanName(alert.parsed_payee || null);
  let suggestion: UserSuggestion | null = null;
  let category_id: string | null = null;
  let payee = alert.parsed_payee || "";

  if (alert.parsed_type !== "income" && suggest) {
    suggestion = suggest(cleaned, (alert.parsed_amount || 0) / 100);
    if (suggestion.category_id) category_id = suggestion.category_id;
    if (suggestion.payee) payee = suggestion.payee;
  }

  const rules = ledger.rules ?? [];
  let tags: string[] = [];
  if (rules.length) {
    const res = applyRules(
      rules,
      {
        type: alert.parsed_type === "income" ? "income" : "expense",
        amount: alert.parsed_amount || 0,
        category_id,
        payee,
        notes: alert.parsed_notes || "",
      },
      { overwriteCategory: false, overwritePayee: false },
    );
    if (res.matchedRules.length) {
      category_id = res.category_id;
      payee = res.payee;
      tags = res.tags;
    }
  }

  return { category_id, payee, tags, suggestion };
}

export function alertToImportTransaction(
  alert: CapturedAlert,
  ledger: Ledger,
  overrides: AlertDraftOverrides = {},
  suggest?: (merchant: string | null, amountAed: number) => UserSuggestion,
): ImportTransaction {
  const type =
    overrides.type ??
    (alert.parsed_type === "income" ? "income" : "expense");
  const linkedAccountId =
    alert.account_id &&
    ledger.accounts.some((a) => a.id === alert.account_id)
      ? alert.account_id
      : "";
  const account_id =
    overrides.account_id ||
    linkedAccountId ||
    matchAccountHint(alert.account_hint, ledger.accounts);
  const amount =
    overrides.amount !== undefined ? overrides.amount : alert.parsed_amount;
  const date = overrides.date || alert.parsed_date || uaeToday();

  const suggested = suggestCategoryForAlert(alert, ledger, suggest);
  const category_id =
    type === "income"
      ? (overrides.category_id ?? null)
      : overrides.category_id !== undefined
        ? overrides.category_id
        : suggested.category_id;
  const payee = (overrides.payee ?? suggested.payee ?? "").trim();
  const notes = (overrides.notes ?? alert.parsed_notes ?? "").trim();

  if (amount <= 0) {
    throw new Error("Enter an amount greater than 0 before importing.");
  }

  const tx: ImportTransaction = {
    date,
    account_id,
    to_account_id: null,
    category_id,
    type,
    amount,
    payee,
    notes,
    ...(suggested.tags.length ? { tags: suggested.tags } : {}),
  };
  validateTransaction(tx, ledger);
  return tx;
}

export function buildCaptureWebhookUrl(
  baseUrl: string,
  backendKind: "pocketbase" | "supabase" = "pocketbase",
  overrideUrl?: string,
): string {
  if (overrideUrl?.trim()) return overrideUrl.trim();
  const trimmed = baseUrl.replace(/\/$/, "");
  if (backendKind === "supabase") {
    return `${trimmed}/functions/v1/inbound-capture`;
  }
  return `${trimmed}/api/fuloos/inbound-email`;
}

export function buildShortcutSnippet(webhookUrl: string, token: string): string {
  const t = token || "<YOUR_CAPTURE_TOKEN>";
  return `curl -X POST "${webhookUrl}" \\
  -H "Content-Type: application/json" \\
  -d '{"token":"${t}","source":"shortcut","text":"Purchase of AED 45.00 with Debit Card ending 1234 at TALABAT, DUBAI."}'`;
}
