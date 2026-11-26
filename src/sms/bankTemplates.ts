/* Hand-written tolerant bank SMS templates (Phase 1) complementing
   `src/ledger/rules.generated.ts` (which is never hand-edited).
   Pure TypeScript, sandbox-safe (no DOM, React, Node, or i18n imports). */
import {
  cleanName,
  normalizeSmsDigits,
  splitMerchant,
  stripBalanceAndLimitClauses,
  type SmsType,
} from "../ledger/sms.ts";

export interface BankTemplateRule {
  id: string;
  type: SmsType;
  regex: RegExp;
}

/** All supported bank template identifiers shown in SMS link settings. */
export const ALL_SMS_BANKS = [
  "ADCB",
  "ADIB",
  "DIB",
  "ENBD",
  "FAB",
  "Liv",
  "Mashreq",
] as const;

// Reusable fragments: tolerant spacing, optional punctuation, card masks, currency-before-or-after amount
const CUR_AMT =
  "(?:(?<currency>[A-Z]{3})\\s*(?<amount>\\d[\\d,]*(?:\\.\\d{1,3})?)|(?<amount_pre>\\d[\\d,]*(?:\\.\\d{1,3})?)\\s*(?<currency_post>[A-Z]{3}))";
const CARD_MASK = "(?:[X*#]+\\s*|ending(?:\\s+(?:in|with))?\\s+)?(?<card>\\d{4})";
const OPT_BAL =
  "(?:.*?(?:Avl\\.?\\s*(?:Cr\\.?\\s*)?(?:Bal(?:ance)?|limit|lmt)|Available\\s+(?:Cr(?:edit)?\\.?\\s*)?(?:Bal(?:ance)?|limit|lmt)|Balance)\\s*(?:is|:)?\\s*(?:[A-Z]{3}\\s*)?(?<balance>-?\\d[\\d,]*(?:\\.\\d+)?))?";

/**
 * Hand-written bank templates tried alongside `LEDGER_RULES.BANK_RULES[bank]`
 * ONLY when the bank is known from `link.bank_template` or `sender`.
 */
export const HANDWRITTEN_BANK_TEMPLATES: Record<string, BankTemplateRule[]> = {
  ADCB: [
    // Debit or Credit card cash withdrawal (must come before generic "was used for")
    {
      id: "ADCB/cash_withdrawal",
      type: "cash_withdrawal",
      regex: new RegExp(
        `(?:Your\\s+)?(?:Debit|Credit|Cr\\.?)\\s*Card\\s+${CARD_MASK}\\s+(?:was\\s+)?used\\s+for\\s+cash\\s+withdrawal\\s+of\\s+${CUR_AMT}(?:\\s+on\\s+\\d{2}[/-]\\d{2}[/-]\\d{2,4}(?:\\s+[\\d:]+)?)?(?:\\s+at\\s+(?<merchant_raw>.+?))?(?:\\.(?:\\s|$)|\\s+Avl|\\s+Avail|$)${OPT_BAL}`,
        "is",
      ),
    },
    // Debit card purchase with XXX1234 or ****1234 mask (optional Your, optional space after currency)
    {
      id: "ADCB/debit_purchase",
      type: "purchase",
      regex: new RegExp(
        `(?:Your\\s+)?Debit\\s*Card\\s+${CARD_MASK}\\s+(?:was\\s+)?used\\s+for\\s+${CUR_AMT}(?:\\s*\\([^)]*\\))?(?:\\s+on\\s+\\d{2}[/-]\\d{2}[/-]\\d{2,4}(?:\\s+[\\d:]+)?)?\\s+at\\s+(?<merchant_raw>.+?)(?:\\.(?:\\s|$)|\\s+Avl|\\s+Avail|$)${OPT_BAL}`,
        "is",
      ),
    },
    // Credit card purchase with XXX1234 or ****1234 mask (tolerant punctuation and spacing)
    {
      id: "ADCB/credit_purchase",
      type: "purchase",
      regex: new RegExp(
        `(?:Your\\s+)?(?:Cr\\.?\\s*Card|Credit\\s*Card)\\s+${CARD_MASK}\\s+(?:was\\s+)?used\\s+for\\s+${CUR_AMT}(?:\\s*\\([^)]*\\))?(?:\\s+on\\s+\\d{2}[/-]\\d{2}[/-]\\d{2,4}(?:\\s+[\\d:]+)?)?\\s+at\\s+(?<merchant_raw>.+?)(?:\\.(?:\\s|$)|\\s+Avl|\\s+Avail|$)${OPT_BAL}`,
        "is",
      ),
    },
    // Alternate ADCB phrasing: "AED 48.50 spent on your ADCB Card XX4512 at ..."
    {
      id: "ADCB/card_spent",
      type: "purchase",
      regex: new RegExp(
        `^\\s*${CUR_AMT}\\s+spent\\s+on\\s+(?:your\\s+)?(?:ADCB\\s+)?(?:Debit\\s+|Credit\\s+)?Card\\s+${CARD_MASK}\\s+at\\s+(?<merchant_raw>.+?)(?:\\s+on\\s+\\d{2}[/-]\\d{2}[/-]\\d{2,4}|\\.(?:\\s|$)|\\s+Avl|$)${OPT_BAL}`,
        "is",
      ),
    },
    // Salary / account credit
    {
      id: "ADCB/salary",
      type: "income",
      regex: new RegExp(
        `(?:Your\\s+)?(?:account|a\\/c)\\s+\\S+\\s+has\\s+been\\s+credited\\s+with\\s+${CUR_AMT}.*?\\bsalary\\b(?:\\s+(?:from|by)\\s+(?<merchant_raw>[^.]+))?${OPT_BAL}`,
        "is",
      ),
    },
    // Generic account credit
    {
      id: "ADCB/account_credit",
      type: "transfer_in",
      regex: new RegExp(
        `(?:Your\\s+)?(?:account|a\\/c)\\s+\\S+\\s+has\\s+been\\s+credited\\s+with\\s+${CUR_AMT}(?:\\s+on\\s+\\S+)?(?:\\s+(?:from|by|towards|for)\\s+(?<merchant_raw>[^.]+))?${OPT_BAL}`,
        "is",
      ),
    },
    // Generic account debit
    {
      id: "ADCB/account_debit",
      type: "other_debit",
      regex: new RegExp(
        `(?:Your\\s+)?(?:account|a\\/c)\\s+\\S+\\s+has\\s+been\\s+debited\\s+with\\s+${CUR_AMT}(?:\\s+on\\s+\\S+)?(?:\\s+(?:towards|for|to|by)\\s+(?<merchant_raw>[^.]+))?${OPT_BAL}`,
        "is",
      ),
    },
  ],

  DIB: [
    // Cash withdrawal on DIB debit/credit card
    {
      id: "DIB/atm_withdrawal",
      type: "cash_withdrawal",
      regex: new RegExp(
        `Cash\\s+Withdrawal\\s+of\\s+${CUR_AMT}\\s+(?:on|with)\\s+(?:your\\s+)?(?:DIB\\s+)?(?:Debit|Credit)?\\s*Card\\s+${CARD_MASK}(?:\\s+at\\s+(?<merchant_raw>.+?))?(?:\\s+on\\s+\\d{1,2}[-/][A-Za-z0-9]{2,3}[-/]\\d{2,4}|\\.(?:\\s|$)|\\s+Avl|$)${OPT_BAL}`,
        "is",
      ),
    },
    // DIB card refund
    {
      id: "DIB/refund",
      type: "refund",
      regex: new RegExp(
        `${CUR_AMT}\\s+has\\s+been\\s+refunded.*?(?:Card\\s+${CARD_MASK})?(?:.*?at\\s+(?<merchant_raw>.+?))?(?:\\s+on\\s+\\d{1,2}[-/][A-Za-z0-9]{2,3}[-/]\\d{2,4}|\\.(?:\\s|$)|\\s+Avl|$)${OPT_BAL}`,
        "is",
      ),
    },
    {
      id: "DIB/refund_of",
      type: "refund",
      regex: new RegExp(
        `Refund\\s+of\\s+${CUR_AMT}.*?(?:Card\\s+${CARD_MASK})?(?:.*?at\\s+(?<merchant_raw>.+?))?(?:\\s+on\\s+\\d{1,2}[-/][A-Za-z0-9]{2,3}[-/]\\d{2,4}|\\.(?:\\s|$)|\\s+Avl|$)${OPT_BAL}`,
        "is",
      ),
    },
    // DIB debit or credit card purchase
    {
      id: "DIB/card_purchase",
      type: "purchase",
      regex: new RegExp(
        `(?:Your\\s+)?(?:DIB\\s+)?(?:Debit|Credit)\\s*Card\\s+${CARD_MASK}\\s+(?:was\\s+)?used\\s+for\\s+${CUR_AMT}(?:\\s*\\([^)]*\\))?\\s+at\\s+(?<merchant_raw>.+?)(?:\\s+on\\s+\\d{1,2}[-/][A-Za-z0-9]{2,3}[-/]\\d{2,4}|\\.(?:\\s|$)|\\s+Avl|\\s+Avail|$)${OPT_BAL}`,
        "is",
      ),
    },
    // DIB account credit: salary
    {
      id: "DIB/salary",
      type: "income",
      regex: new RegExp(
        `(?:Your\\s+)?(?:DIB\\s+)?(?:A\\/C|Account)\\s*(?:No\\.?\\s*)?\\S+\\s+has\\s+been\\s+credited\\s+with\\s+${CUR_AMT}.*?\\bsalary\\b(?:\\s+(?:from|by)\\s+(?<merchant_raw>[^.]+))?${OPT_BAL}`,
        "is",
      ),
    },
    // DIB account credit: transfer / deposit
    {
      id: "DIB/account_credit",
      type: "transfer_in",
      regex: new RegExp(
        `(?:Your\\s+)?(?:DIB\\s+)?(?:A\\/C|Account)\\s*(?:No\\.?\\s*)?\\S+\\s+has\\s+been\\s+credited\\s+with\\s+${CUR_AMT}(?:\\s+on\\s+\\S+)?(?:\\s+(?:by|from|towards|for)\\s+(?<merchant_raw>[^.]+))?${OPT_BAL}`,
        "is",
      ),
    },
    // DIB account debit: credit card payment
    {
      id: "DIB/card_payment",
      type: "card_repayment",
      regex: new RegExp(
        `(?:Your\\s+)?(?:DIB\\s+)?(?:A\\/C|Account)\\s*(?:No\\.?\\s*)?\\S+\\s+has\\s+been\\s+debited\\s+with\\s+${CUR_AMT}.*?(?:Credit\\s+Card\\s+Payment|Card\\s+Payment|Card\\s+Repayment)${OPT_BAL}`,
        "is",
      ),
    },
    // DIB account debit: finance / loan installment
    {
      id: "DIB/finance_repayment",
      type: "loan_repayment",
      regex: new RegExp(
        `(?:Your\\s+)?(?:DIB\\s+)?(?:A\\/C|Account)\\s*(?:No\\.?\\s*)?\\S+\\s+has\\s+been\\s+debited\\s+with\\s+${CUR_AMT}.*?(?:Finance|Installment|Instalment|Murabaha|Loan\\s+Repayment|Auto\\s+Finance|Home\\s+Finance)${OPT_BAL}`,
        "is",
      ),
    },
    // DIB account debit: fee / charges / VAT
    {
      id: "DIB/fee",
      type: "bank_fee",
      regex: new RegExp(
        `(?:Your\\s+)?(?:DIB\\s+)?(?:A\\/C|Account)\\s*(?:No\\.?\\s*)?\\S+\\s+has\\s+been\\s+debited\\s+with\\s+${CUR_AMT}.*?(?:Charges|Fee|Fees|VAT|Commission)${OPT_BAL}`,
        "is",
      ),
    },
    // DIB account debit: funds transfer
    {
      id: "DIB/transfer_out",
      type: "transfer_out",
      regex: new RegExp(
        `(?:Your\\s+)?(?:DIB\\s+)?(?:A\\/C|Account)\\s*(?:No\\.?\\s*)?\\S+\\s+has\\s+been\\s+debited\\s+with\\s+${CUR_AMT}.*?(?:Funds?\\s+Transfer|Transfer|Remittance)(?:\\s+to\\s+(?<merchant_raw>[^.]+))?${OPT_BAL}`,
        "is",
      ),
    },
    // DIB account debit: bill payment
    {
      id: "DIB/bill_payment",
      type: "bill_payment",
      regex: new RegExp(
        `(?:Your\\s+)?(?:DIB\\s+)?(?:A\\/C|Account)\\s*(?:No\\.?\\s*)?\\S+\\s+has\\s+been\\s+debited\\s+with\\s+${CUR_AMT}(?:\\s+on\\s+\\S+)?\\s+(?:towards|for)\\s+(?<merchant_raw>[^.]*?(?:Bill|DEWA|SEWA|FEWA|ADDC|Etisalat|DU|Salik|Utility)[^.]*)${OPT_BAL}`,
        "is",
      ),
    },
    // DIB generic account debit
    {
      id: "DIB/account_debit",
      type: "other_debit",
      regex: new RegExp(
        `(?:Your\\s+)?(?:DIB\\s+)?(?:A\\/C|Account)\\s*(?:No\\.?\\s*)?\\S+\\s+has\\s+been\\s+debited\\s+with\\s+${CUR_AMT}(?:\\s+on\\s+\\S+)?(?:\\s+(?:towards|for|to|by)\\s+(?<merchant_raw>[^.]+))?${OPT_BAL}`,
        "is",
      ),
    },
  ],

  ENBD: [
    // ENBD card purchase
    {
      id: "ENBD/card_purchase",
      type: "purchase",
      regex: new RegExp(
        `^\\s*Purchase\\s+of\\s+${CUR_AMT}(?:\\s*\\([^)]*\\))?\\s+with\\s+(?:Debit|Credit)\\s+Card\\s+${CARD_MASK}\\s+at\\s+(?<merchant_raw>.+?)(?:\\s+on\\s+\\d{2}[/-]\\d{2}[/-]\\d{2,4}|\\.(?:\\s|$)|\\s+Avl|\\s+Avail|$)${OPT_BAL}`,
        "is",
      ),
    },
    // ENBD card ATM cash withdrawal
    {
      id: "ENBD/atm_withdrawal",
      type: "cash_withdrawal",
      regex: new RegExp(
        `^\\s*Cash\\s+Withdrawal\\s+of\\s+${CUR_AMT}\\s+with\\s+(?:Debit|Credit)\\s+Card\\s+${CARD_MASK}(?:\\s+at\\s+(?<merchant_raw>.+?))?(?:\\s+on\\s+\\d{2}[/-]\\d{2}[/-]\\d{2,4}|\\.(?:\\s|$)|\\s+Avl|$)${OPT_BAL}`,
        "is",
      ),
    },
    // ENBD refund
    {
      id: "ENBD/refund",
      type: "refund",
      regex: new RegExp(
        `^\\s*(?:Purchase\\s+amount\\s+of\\s+|Refund\\s+of\\s+)${CUR_AMT}\\s+at\\s+(?<merchant_raw>.+?)\\s+on\\s+(?:your\\s+)?(?:Debit|Credit)\\s+Card\\s+${CARD_MASK}.*?(?:refunded|processed)${OPT_BAL}`,
        "is",
      ),
    },
    // ENBD bill payment
    {
      id: "ENBD/bill_payment",
      type: "bill_payment",
      regex: new RegExp(
        `Bill\\s+payment\\s+of\\s+${CUR_AMT}\\s+(?:to|for)\\s+(?<merchant_raw>.+?)\\s+has\\s+been\\s+(?:debited|paid|processed)${OPT_BAL}`,
        "is",
      ),
    },
    // ENBD salary
    {
      id: "ENBD/salary",
      type: "income",
      regex: new RegExp(
        `^\\s*Salary\\s+of\\s+${CUR_AMT}\\s+has\\s+been\\s+credited${OPT_BAL}`,
        "is",
      ),
    },
    // ENBD fee
    {
      id: "ENBD/fee",
      type: "bank_fee",
      regex: new RegExp(
        `^\\s*${CUR_AMT}\\s+has\\s+been\\s+debited\\s+from\\s+(?:your\\s+)?(?:account|a\\/c).*?(?:Fee|Fees|Charges|VAT)${OPT_BAL}`,
        "is",
      ),
    },
    // ENBD transfer out
    {
      id: "ENBD/transfer_out",
      type: "transfer_out",
      regex: new RegExp(
        `^\\s*${CUR_AMT}\\s+has\\s+been\\s+(?:transferred|debited)\\s+from\\s+(?:your\\s+)?(?:account|a\\/c)\\s+\\S+\\s+(?:to|towards)\\s+(?<merchant_raw>.+?)(?:\\s+on\\s+\\d{2}[/-]\\d{2}[/-]\\d{2,4}|\\.(?:\\s|$)|\\s+Avl|$)${OPT_BAL}`,
        "is",
      ),
    },
    // ENBD account credit / transfer in
    {
      id: "ENBD/account_credit",
      type: "transfer_in",
      regex: new RegExp(
        `^\\s*${CUR_AMT}\\s+has\\s+been\\s+(?:credited|deposited)\\s+to\\s+(?:your\\s+)?(?:account|a\\/c)\\s+\\S+(?:\\s+(?:from|by)\\s+(?<merchant_raw>.+?))?(?:\\s+on\\s+\\d{2}[/-]\\d{2}[/-]\\d{2,4}|\\.(?:\\s|$)|\\s+Avl|$)${OPT_BAL}`,
        "is",
      ),
    },
    // ENBD generic account debit
    {
      id: "ENBD/account_debit",
      type: "other_debit",
      regex: new RegExp(
        `^\\s*${CUR_AMT}\\s+has\\s+been\\s+debited\\s+from\\s+(?:your\\s+)?(?:account|a\\/c)\\s+\\S+(?:\\s+on\\s+\\S+)?(?:\\s+(?:towards|for|to|by)\\s+(?<merchant_raw>.+?))?(?:\\.(?:\\s|$)|\\s+Avl|$)${OPT_BAL}`,
        "is",
      ),
    },
  ],

  FAB: [
    // FAB debit card purchase (rules.generated.ts only has Credit Card Purchase)
    {
      id: "FAB/debit_purchase",
      type: "purchase",
      regex: new RegExp(
        `Debit\\s+Card\\s+Purchase\\s+Card\\s+No\\s+[X*]+(?<card>\\d{4})\\s+${CUR_AMT}\\s+(?<merchant_raw>.+?)\\s+\\d{2}/\\d{2}/\\d{2,4}\\s+[\\d:]+${OPT_BAL}`,
        "is",
      ),
    },
    // FAB salary credit
    {
      id: "FAB/salary",
      type: "income",
      regex: new RegExp(
        `Salary\\s+of\\s+${CUR_AMT}\\s+has\\s+been\\s+credited\\s+to\\s+(?:your\\s+)?FAB\\s+account${OPT_BAL}`,
        "is",
      ),
    },
    // FAB refund
    {
      id: "FAB/refund",
      type: "refund",
      regex: new RegExp(
        `Refund\\s+of\\s+${CUR_AMT}\\s+on\\s+(?:your\\s+)?(?:FAB\\s+)?(?:Debit\\s+|Credit\\s+)?Card\\s+[X*]+(?<card>\\d{4})\\s+at\\s+(?<merchant_raw>.+?)(?:\\s+on\\s+\\d{2}[/-]\\d{2}[/-]\\d{2,4}|\\.(?:\\s|$)|\\s+Avl|$)${OPT_BAL}`,
        "is",
      ),
    },
    // FAB service fee
    {
      id: "FAB/fee",
      type: "bank_fee",
      regex: new RegExp(
        `${CUR_AMT}\\s+has\\s+been\\s+debited\\s+from\\s+(?:your\\s+)?FAB\\s+account\\s+for\\s+(?<merchant_raw>[^.]*?(?:Fee|Fees|Charges|VAT)[^.]*)${OPT_BAL}`,
        "is",
      ),
    },
  ],
};

const PROMO_KEYWORDS_RE =
  /\b(?:exclusive\s+offer|special\s+offer|limited[- ]time\s+offer|win\s+big|stand\s+a\s+chance\s+to\s+win|chance\s+to\s+win|\d+%\s*off\b|discount\s+up\s+to|cashback\s+offer|apply\s+now|pre[- ]approved|enjoy\s+\d+%|spend\s+and\s+win|get\s+\d+%\s*off)\b/i;

const TRANSACTION_VERB_RE =
  /(?:\b(?:debited|deducted|purchase|spent|used\s+for|charged|paid|withdrawn|withdrawal|transferred|credited|deposited|received|refund|refunded|reversed|salary|processed|payment\s+of|payment\s+instructions)\b|خصم|شراء|سحب|إيداع|ايداع|استرداد|راتب|تحويل)/i;

const BALANCE_NOTICE_RE =
  /(?:\b(?:available\s+bal(?:ance)?|avl\.?\s*bal(?:ance)?|current\s+(?:account\s+)?bal(?:ance)?|account\s+bal(?:ance)?|closing\s+bal(?:ance)?)\b|(?:ال)?رصيد(?:\s+(?:المتاح|الحالي)))/i;

/** True when text is a promotional / marketing SMS with no real transaction verb. */
export function isPromoSms(text: string): boolean {
  const norm = normalizeSmsDigits(text).replace(/\s+/g, " ").trim();
  if (!PROMO_KEYWORDS_RE.test(norm)) return false;
  return !TRANSACTION_VERB_RE.test(norm);
}

/** True when text only reports a balance/limit with no debit/credit transaction verb. */
export function isBalanceOnlyNotice(text: string): boolean {
  const norm = normalizeSmsDigits(text).replace(/\s+/g, " ").trim();
  if (!BALANCE_NOTICE_RE.test(norm)) return false;
  return !TRANSACTION_VERB_RE.test(norm);
}

const GENERIC_NON_COUNTERPARTY_RE =
  /^(?:your\s+(?:account|a\/c|card|debit\s+card|credit\s+card|fab\s+account|dib\s+account|adcb\s+account|enbd\s+account|liv\s+account)|account\s+no\.?|a\/c\s+no\.?|salary|funds?\s+transfer|local\s+transfer|transfer|bill\s+payment|credit\s+card\s+payment|card\s+payment|auto\s+finance|finance|installment|service\s+fee|account\s+charges|card\s+annual\s+fee|vat|online\s+payment|your\s+transaction|cash\s+withdrawal).*$/i;

/**
 * Extract a counterparty name from "at / towards / to / from / by / for / @" clauses
 * when a bank template did not capture a merchant_raw group (or captured a generic phrase).
 */
export function extractCounterpartyFromText(
  text: string,
  bank: string | null = null,
): {
  raw: string | null;
  name: string | null;
  clean: string | null;
  city: string | null;
  country: string | null;
} {
  const nonBal = stripBalanceAndLimitClauses(normalizeSmsDigits(text))
    .replace(/\s+/g, " ")
    .trim();

  // Order of preference: explicit counterparty prepositions
  const patterns: RegExp[] = [
    /\b(?:at|@)\s+([A-Za-z0-9][A-Za-z0-9\s&*.,'\/-]{1,70}?)(?=\s+on\s+\d|\s+with\s+(?:debit|credit|card)|\s+has\s+been|\s+was\s+|\s+(?:Avl|Avail|Bal)\b|\s*\.(?:\s|$)|$)/gi,
    /\b(?:towards|to|from|by|for)\s+([A-Za-z0-9][A-Za-z0-9\s&*.,'\/-]{1,70}?)(?=\s+(?:from|to|towards|by)\s+|\s+on\s+\d|\s+has\s+been|\s+was\s+|\s+(?:Avl|Avail|Bal)\b|\s*\.(?:\s|$)|$)/gi,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(nonBal)) !== null) {
      let candidate = m[1].trim().replace(/[.,;:\s]+$/, "");
      // Strip leading nested prepositions like "Salary from SAMPLE EMPLOYER" or "Funds Transfer to SAMPLE BENEFICIARY"
      const nested =
        /^(?:salary|funds?\s+transfer|local\s+transfer|instant\s+transfer|transfer|payment|bill\s+payment|remittance)\s+(?:to|from|by|towards|for)\s+(.+)$/i.exec(
          candidate,
        );
      if (nested) candidate = nested[1].trim();
      // Skip card / account references ("your account XXX4567", "Credit Card ending 1234", "AED 50.00")
      if (!candidate || candidate.length < 2) continue;
      if (/^(?:[A-Z]{3}\s*)?\d[\d,]*(?:\.\d+)?$/i.test(candidate)) continue;
      if (/^(?:your\s+)?(?:debit|credit|cr\.?)?\s*card\b/i.test(candidate)) continue;
      if (/^(?:your\s+)?(?:[A-Z]{2,12}\s+)?(?:account|a\/c|saving)\b/i.test(candidate)) continue;
      if (GENERIC_NON_COUNTERPARTY_RE.test(candidate)) continue;

      const [name, city, country] = splitMerchant(candidate, bank);
      const clean = cleanName(name);
      if (clean && clean.length >= 2) {
        return {
          raw: candidate,
          name: name ?? candidate,
          clean,
          city,
          country,
        };
      }
    }
  }

  return { raw: null, name: null, clean: null, city: null, country: null };
}
