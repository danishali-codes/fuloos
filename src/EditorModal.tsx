import { translateText as uiText } from "./i18n";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  Download,
  Paperclip,
  Plus,
  Split,
  Trash2,
  Unlink,
  Wand2,
  X,
} from "lucide-react";
import { ColorPicker, EmojiField } from "./Appearance";
import {
  computeImpliedRate,
  convertMinor,
  formatCurrency,
  formatCurrencyInput,
  formatFxRate,
  normalizeCurrencyCode,
  parseCurrencyMinor,
  type FxSource,
  type FxStatus,
} from "./currency";
import { CurrencyPicker } from "./CurrencyPicker";
import {
  accountCurrency,
  balance,
  balanceAsOfDate,
  errorMessage,
  hasBalanceAnchor,
  isIsoCalendarDate,
  money,
  NO_BALANCE_DATE,
  openingDateFor,
  today,
  validateTransaction,
  type Account,
  type AccountType,
  type Category,
  type Kind,
  type Ledger,
  type Transaction,
  type TransactionSplit,
} from "./domain";
import {
  collectLedgerTags,
  isReceiptPdf,
  splitRemainder,
  validateReceiptFile,
} from "./enrichment";
import { fxRateService } from "./fxRates";
import { applyRules } from "./rules";
import { TagInput } from "./TagInput";

export const ACCOUNT_TYPES: Record<AccountType, string> = {
  current: "Current",
  savings: "Savings",
  credit_card: "Credit card",
  cash: "Cash",
  other: "Other",
};

const COLORS = [
  "#1d5b48",
  "#b08448",
  "#696198",
  "#619a92",
  "#b86e69",
  "#768db1",
];

export type EditorModalState =
  | { kind: "account"; item?: Account }
  | { kind: "category"; item?: Category }
  | { kind: "transaction"; item?: Transaction }
  | null;

interface SplitDraftRow {
  category_id: string;
  amountText: string;
  notes: string;
}

export function Editor({
  modal,
  ledger,
  busy,
  demo = false,
  onLoadReceiptUrl,
  onClose,
  save,
  onUnlinkOccurrence,
}: {
  modal: NonNullable<EditorModalState>;
  ledger: Ledger;
  busy: boolean;
  demo?: boolean;
  onLoadReceiptUrl?: (txId: string, filename: string) => Promise<string>;
  onClose: () => void;
  save: (
    table: "accounts" | "categories" | "transactions",
    value: Record<string, unknown>,
    id?: string,
    options?: { receiptFile?: File | null; removeReceipt?: boolean },
  ) => Promise<void>;
  onUnlinkOccurrence: (occurrenceId: string) => void;
}) {
  const item = modal.item;
  const txItem = modal.kind === "transaction" ? modal.item : undefined;
  const accItem = modal.kind === "account" ? modal.item : undefined;
  const [accountType, setAccountType] = useState<AccountType>(
    accItem?.type ?? "current",
  );
  const [accountFormCurrency, setAccountFormCurrency] = useState<string>(() =>
    normalizeCurrencyCode(accItem?.currency),
  );
  const [kind, setKind] = useState<Kind>(txItem ? txItem.type : "expense"),
    [error, setError] = useState("");
  const [accountId, setAccountId] = useState(
    () => txItem?.account_id ?? ledger.accounts[0]?.id ?? "",
  );
  const [toAccountId, setToAccountId] = useState(
    () => txItem?.to_account_id ?? "",
  );
  const [dateValue, setDateValue] = useState(() => txItem?.date ?? today());

  const selectedAccount = ledger.accounts.find((a) => a.id === accountId);
  const accCurr = accountCurrency(selectedAccount);
  const selectedToAccount = ledger.accounts.find((a) => a.id === toAccountId);
  const toAccCurr = accountCurrency(selectedToAccount);

  const [txCurrency, setTxCurrency] = useState<string>(() => {
    if (txItem?.original_currency) {
      return normalizeCurrencyCode(txItem.original_currency);
    }
    return accountCurrency(
      ledger.accounts.find(
        (a) => a.id === (txItem?.account_id ?? ledger.accounts[0]?.id),
      ),
    );
  });

  const [originalAmountText, setOriginalAmountText] = useState(() => {
    if (!txItem) return "";
    const origCurr = normalizeCurrencyCode(txItem.original_currency ?? accCurr);
    const origAmt = txItem.original_amount ?? txItem.amount;
    return formatCurrencyInput(origAmt, origCurr);
  });
  const [amountText, setAmountText] = useState(() =>
    txItem ? formatCurrencyInput(txItem.amount, accCurr) : "",
  );
  const [toAmountText, setToAmountText] = useState(() => {
    if (!txItem || txItem.type !== "transfer") return "";
    const destAcc = ledger.accounts.find((a) => a.id === txItem.to_account_id);
    const destCurr = accountCurrency(destAcc);
    return formatCurrencyInput(txItem.to_amount ?? txItem.amount, destCurr);
  });
  const [fxRateText, setFxRateText] = useState(() =>
    txItem?.fx_rate && txItem.fx_rate > 0 ? formatFxRate(txItem.fx_rate) : "1",
  );
  const [fxRateDate, setFxRateDate] = useState(
    () => txItem?.fx_rate_date ?? txItem?.date ?? today(),
  );
  const [fxSource, setFxSource] = useState<FxSource>(
    () => txItem?.fx_source ?? "same_currency",
  );
  const [fxStatus, setFxStatus] = useState<FxStatus>(
    () => txItem?.fx_status ?? "exact",
  );
  const [userEditedAccountAmount, setUserEditedAccountAmount] = useState(
    () => Boolean(txItem && txItem.fx_status !== "estimated"),
  );
  const [userEditedToAmount, setUserEditedToAmount] = useState(
    () => Boolean(txItem?.to_amount !== undefined),
  );
  const [rateLoading, setRateLoading] = useState(false);

  const [categoryId, setCategoryId] = useState(
    txItem?.type !== "transfer" ? (txItem?.category_id ?? "") : "",
  );
  const [payee, setPayee] = useState(txItem?.payee ?? "");
  const [notes, setNotes] = useState(txItem?.notes ?? "");
  const [tags, setTags] = useState<string[]>(txItem?.tags ?? []);
  const [splits, setSplits] = useState<SplitDraftRow[]>(() =>
    (txItem?.splits ?? []).map((s) => ({
      category_id: s.category_id ?? "",
      amountText: formatCurrencyInput(s.amount, accCurr),
      notes: s.notes ?? "",
    })),
  );
  const [ruleNotice, setRuleNotice] = useState("");
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [removeReceipt, setRemoveReceipt] = useState(false);
  const [receiptPreviewUrl, setReceiptPreviewUrl] = useState<string>("");
  const [receiptLoading, setReceiptLoading] = useState(false);

  const isForeign = kind !== "transfer" && txCurrency !== accCurr;
  const isCrossCurrencyTransfer =
    kind === "transfer" && Boolean(selectedToAccount) && toAccCurr !== accCurr;

  const dialog = useRef<HTMLDialogElement>(null);
  const tagSuggestions = useMemo(() => collectLedgerTags(ledger), [ledger]);
  const linkedOccurrence = useMemo(
    () =>
      txItem
        ? (ledger.recurring_occurrences ?? []).find(
            (o) => o.transaction_id === txItem.id,
          )
        : undefined,
    [txItem, ledger.recurring_occurrences],
  );
  const linkedSchedule = useMemo(
    () =>
      linkedOccurrence
        ? (ledger.recurring ?? []).find(
            (r) => r.id === linkedOccurrence.recurring_id,
          )
        : undefined,
    [linkedOccurrence, ledger.recurring],
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    if (receiptFile) {
      const url = URL.createObjectURL(receiptFile);
      setReceiptPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    if (!removeReceipt && txItem?.receipt) {
      if (txItem.receipt.startsWith("blob:")) {
        setReceiptPreviewUrl(txItem.receipt);
        return;
      }
      if (onLoadReceiptUrl && !demo) {
        let active = true;
        let createdUrl = "";
        setReceiptLoading(true);
        onLoadReceiptUrl(txItem.id, txItem.receipt)
          .then((url) => {
            if (!active) {
              URL.revokeObjectURL(url);
              return;
            }
            createdUrl = url;
            setReceiptPreviewUrl(url);
          })
          .catch(() => {
            if (active) setReceiptPreviewUrl("");
          })
          .finally(() => {
            if (active) setReceiptLoading(false);
          });
        return () => {
          active = false;
          if (createdUrl) URL.revokeObjectURL(createdUrl);
        };
      }
    }
    setReceiptPreviewUrl("");
  }, [
    receiptFile,
    removeReceipt,
    txItem?.id,
    txItem?.receipt,
    onLoadReceiptUrl,
    demo,
  ]);

  // Fetch live historical rate for foreign transactions or cross-currency transfers.
  useEffect(() => {
    if (modal.kind !== "transaction") return;
    if (isForeign) {
      if (
        txItem &&
        normalizeCurrencyCode(txItem.original_currency) === txCurrency &&
        txItem.date === dateValue &&
        txItem.account_id === accountId &&
        txItem.fx_rate &&
        txItem.fx_rate > 0
      ) {
        return;
      }
      let active = true;
      setRateLoading(true);
      fxRateService
        .getRate(txCurrency, accCurr, dateValue)
        .then((res) => {
          if (!active) return;
          if (res.rate !== null && res.rate > 0) {
            setFxRateText(formatFxRate(res.rate));
            setFxRateDate(res.rateDate);
            setFxSource(res.source ?? "manual_rate");
            setFxStatus(res.status);
            if (!userEditedAccountAmount && originalAmountText.trim()) {
              try {
                const origM = parseCurrencyMinor(originalAmountText, txCurrency);
                const conv = convertMinor(origM, txCurrency, accCurr, res.rate);
                setAmountText(formatCurrencyInput(conv, accCurr));
              } catch {
                // Ignore partial input.
              }
            }
          } else {
            setFxRateText("");
            setFxSource("manual_rate");
            setFxStatus("estimated");
          }
        })
        .catch(() => {
          // Keep offline fallback state.
        })
        .finally(() => {
          if (active) setRateLoading(false);
        });
      return () => {
        active = false;
      };
    }

    if (isCrossCurrencyTransfer) {
      let active = true;
      setRateLoading(true);
      fxRateService
        .getRate(accCurr, toAccCurr, dateValue)
        .then((res) => {
          if (!active) return;
          if (res.rate !== null && res.rate > 0) {
            setFxRateText(formatFxRate(res.rate));
            setFxRateDate(res.rateDate);
            setFxSource(res.source ?? "manual_rate");
            if (!userEditedToAmount && amountText.trim()) {
              try {
                const fromM = parseCurrencyMinor(amountText, accCurr);
                const toM = convertMinor(fromM, accCurr, toAccCurr, res.rate);
                setToAmountText(formatCurrencyInput(toM, toAccCurr));
              } catch {
                // Ignore partial typing.
              }
            }
          }
        })
        .catch(() => {
          // Ignore offline lookup failure.
        })
        .finally(() => {
          if (active) setRateLoading(false);
        });
      return () => {
        active = false;
      };
    }

    setRateLoading(false);
  }, [
    modal.kind,
    isForeign,
    isCrossCurrencyTransfer,
    txCurrency,
    accCurr,
    toAccCurr,
    dateValue,
    accountId,
  ]);

  const parsedParentAmount = useMemo(() => {
    try {
      const txt = isForeign ? amountText : originalAmountText || amountText;
      return txt.trim() ? parseCurrencyMinor(txt, accCurr) : 0;
    } catch {
      return 0;
    }
  }, [amountText, originalAmountText, isForeign, accCurr]);

  const parsedSplits = useMemo<TransactionSplit[]>(() => {
    return splits.map((row) => {
      let amt = 0;
      try {
        amt = row.amountText.trim()
          ? parseCurrencyMinor(row.amountText, accCurr)
          : 0;
      } catch {
        amt = -1;
      }
      return {
        category_id: row.category_id || null,
        amount: amt,
        ...(row.notes.trim() ? { notes: row.notes.trim() } : {}),
      };
    });
  }, [splits, accCurr]);

  const remainingFils = useMemo(
    () => splitRemainder(parsedParentAmount, parsedSplits),
    [parsedParentAmount, parsedSplits],
  );

  function handleApplyRules() {
    setRuleNotice("");
    const rules = ledger.rules ?? [];
    if (!rules.length) {
      setRuleNotice("No rules configured yet.");
      return;
    }
    const result = applyRules(
      rules,
      {
        type: kind,
        payee,
        notes,
        amount: parsedParentAmount,
        category_id: categoryId || null,
        tags,
      },
      { overwriteCategory: !categoryId, overwritePayee: !payee.trim() },
    );
    if (!result.matchedRules.length) {
      setRuleNotice("No enabled rules matched.");
      return;
    }
    if (result.category_id && !categoryId) setCategoryId(result.category_id);
    if (result.payee && result.payee !== payee) setPayee(result.payee);
    setTags(result.tags);
    setRuleNotice(
      `Applied ${result.matchedRules.length} ${result.matchedRules.length === 1 ? "rule" : "rules"}: ${result.matchedRules.map((r) => r.name).join(", ")}`,
    );
  }

  function syncAccountFromOriginal(
    nextOrigText: string,
    nextCurr: string,
    nextRateText: string,
  ) {
    try {
      if (!nextOrigText.trim()) return;
      const origMinor = parseCurrencyMinor(nextOrigText, nextCurr);
      const rate = Number(nextRateText);
      if (origMinor >= 0 && Number.isFinite(rate) && rate > 0) {
        const conv = convertMinor(origMinor, nextCurr, accCurr, rate);
        setAmountText(formatCurrencyInput(conv, accCurr));
      }
    } catch {
      // Allow incomplete typing while editing.
    }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget),
      s = (key: string) => String(f.get(key) ?? "").trim();
    try {
      if (modal.kind === "account") {
        const balanceText = s("balance");
        const asOf = s("balance_as_of") || today();
        if (balanceText && !isIsoCalendarDate(asOf))
          throw new Error("Choose a valid date for the balance.");
        const accType = s("type") as AccountType;
        const curr = normalizeCurrencyCode(accountFormCurrency);
        let creditCardFields: Record<string, number> = {
          credit_limit: 0,
          statement_day: 0,
          payment_due_day: 0,
          apr_bps: 0,
          minimum_payment: 0,
        };
        if (accType === "credit_card") {
          const limitText = s("credit_limit");
          const minPayText = s("minimum_payment");
          const stmtText = s("statement_day");
          const dueText = s("payment_due_day");
          const aprText = s("apr_pct");

          const creditLimit = limitText ? parseCurrencyMinor(limitText, curr) : 0;
          if (creditLimit < 0)
            throw new Error("Credit limit must be zero or greater.");
          const minPayment = minPayText ? parseCurrencyMinor(minPayText, curr) : 0;
          if (minPayment < 0)
            throw new Error("Minimum payment must be zero or greater.");

          let statementDay = 0;
          if (stmtText) {
            const parsed = Number(stmtText);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31)
              throw new Error("Statement day must be between 1 and 31.");
            statementDay = parsed;
          }

          let paymentDueDay = 0;
          if (dueText) {
            const parsed = Number(dueText);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31)
              throw new Error("Payment due day must be between 1 and 31.");
            paymentDueDay = parsed;
          }

          let aprBps = 0;
          if (aprText) {
            const parsed = Number(aprText);
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000)
              throw new Error("APR must be between 0% and 1000%.");
            aprBps = Math.round(parsed * 100);
          }

          creditCardFields = {
            credit_limit: creditLimit,
            statement_day: statementDay,
            payment_due_day: paymentDueDay,
            apr_bps: aprBps,
            minimum_payment: minPayment,
          };
        }
        const value = {
          name: s("name"),
          type: accType,
          currency: curr,
          // No balance given: the balance is just the sum of transactions.
          opening_balance: balanceText ? parseCurrencyMinor(balanceText, curr) : 0,
          opening_date: balanceText ? openingDateFor(asOf) : NO_BALANCE_DATE,
          color: s("color"),
          emoji: s("emoji"),
          ...creditCardFields,
        };
        if (!value.name) throw new Error("Enter an account name.");
        await save("accounts", value, item?.id);
      } else if (modal.kind === "category") {
        const value = {
          name: s("name"),
          description: s("description"),
          color: s("color"),
          emoji: s("emoji"),
        };
        if (!value.name) throw new Error("Enter a category name.");
        await save("categories", value, item?.id);
      } else {
        const chosenAccountId = accountId || s("account_id");
        const chosenToAccountId = kind === "transfer" ? toAccountId || s("to_account_id") : null;
        const chosenDate = dateValue || s("date");
        const srcCurr = accountCurrency(
          ledger.accounts.find((a) => a.id === chosenAccountId),
        );
        const destCurr = chosenToAccountId
          ? accountCurrency(
              ledger.accounts.find((a) => a.id === chosenToAccountId),
            )
          : srcCurr;

        let txAmount: number;
        let origAmount: number;
        let origCurrency: string;
        let finalRate = 1;
        let finalRateDate = chosenDate;
        let finalSource: FxSource = "same_currency";
        let finalStatus: FxStatus = "exact";
        let toAmount: number | undefined;

        if (kind === "transfer") {
          const fromInput = amountText.trim() || originalAmountText.trim();
          if (!fromInput) throw new Error(`Enter the ${srcCurr} transfer amount.`);
          txAmount = parseCurrencyMinor(fromInput, srcCurr);
          origAmount = txAmount;
          origCurrency = srcCurr;
          if (destCurr !== srcCurr) {
            if (!toAmountText.trim()) {
              throw new Error(`Enter the receiving ${destCurr} amount.`);
            }
            toAmount = parseCurrencyMinor(toAmountText, destCurr);
            if (toAmount <= 0) {
              throw new Error("Receiving amount must be greater than zero.");
            }
            finalRate = computeImpliedRate(txAmount, srcCurr, toAmount, destCurr) || 1;
            finalSource = userEditedToAmount ? "user_confirmed" : fxSource;
            finalStatus = "exact";
          }
        } else if (txCurrency !== srcCurr) {
          if (!originalAmountText.trim()) {
            throw new Error(`Enter the ${txCurrency} amount.`);
          }
          origAmount = parseCurrencyMinor(originalAmountText, txCurrency);
          origCurrency = txCurrency;
          if (amountText.trim()) {
            txAmount = parseCurrencyMinor(amountText, srcCurr);
            if (userEditedAccountAmount && txAmount > 0) {
              finalRate =
                computeImpliedRate(origAmount, txCurrency, txAmount, srcCurr) || 1;
              finalSource = "user_confirmed";
              finalStatus = "exact";
            } else {
              const r = Number(fxRateText);
              finalRate = Number.isFinite(r) && r > 0 ? r : 1;
              finalSource = fxSource === "same_currency" ? "manual_rate" : fxSource;
              finalStatus = fxStatus;
            }
          } else {
            const r = Number(fxRateText);
            if (Number.isFinite(r) && r > 0) {
              txAmount = convertMinor(origAmount, txCurrency, srcCurr, r);
              finalRate = r;
              finalSource = fxSource === "same_currency" ? "manual_rate" : fxSource;
              finalStatus = fxStatus;
            } else {
              txAmount = 0;
              finalRate = 1;
              finalSource = "manual_rate";
              finalStatus = "estimated";
            }
          }
          finalRateDate = fxRateDate || chosenDate;
        } else {
          const input = originalAmountText.trim() || amountText.trim();
          if (!input) throw new Error(`Enter the ${srcCurr} amount.`);
          txAmount = parseCurrencyMinor(input, srcCurr);
          origAmount = txAmount;
          origCurrency = srcCurr;
        }

        const activeSplits =
          kind !== "transfer" && splits.length > 0 ? parsedSplits : [];
        const value: Record<string, unknown> = {
          type: kind,
          amount: txAmount,
          ...(toAmount !== undefined ? { to_amount: toAmount } : { to_amount: null }),
          original_amount: origAmount,
          original_currency: origCurrency,
          fx_rate: finalRate,
          fx_rate_date: finalRateDate,
          fx_source: finalSource,
          fx_status: finalStatus,
          account_id: chosenAccountId,
          to_account_id: chosenToAccountId,
          category_id: kind === "transfer" ? null : categoryId || null,
          date: chosenDate,
          payee: payee.trim(),
          notes: notes.trim(),
          tags,
          splits: activeSplits,
        };
        validateTransaction(
          { ...(value as Omit<Transaction, "id">), id: item?.id },
          ledger,
        );
        await save("transactions", value, item?.id, {
          receiptFile,
          removeReceipt,
        });
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <dialog
      ref={dialog}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">{uiText("MAKE IT YOURS")}</span>
          <h2 id="modal-title">
            {item ? uiText("Edit") : uiText("Add")} {modal.kind}
          </h2>
        </div>
        <button
          disabled={busy}
          className="icon-button"
          aria-label={uiText("Close dialog")}
          onClick={onClose}
        >
          <X size={21} />
        </button>
      </div>
      <form onSubmit={submit}>
        {modal.kind === "transaction" ? (
          <>
            {ledger.accounts.length === 0 && (
              <div className="notice">
                {" "}
                {uiText(
                  "Create an account first to start adding transactions.",
                )}{" "}
              </div>
            )}
            {linkedOccurrence && (
              <div className="notice linked-banner">
                <span>
                  {" "}
                  {uiText("Linked to")}{" "}
                  <b>{linkedSchedule?.name ?? "recurring schedule"}</b> (
                  {linkedOccurrence.occurrence_date})
                </span>
                <button
                  type="button"
                  className="secondary compact-btn"
                  disabled={busy}
                  onClick={() => onUnlinkOccurrence(linkedOccurrence.id)}
                >
                  <Unlink size={13} /> {uiText("Unlink")}{" "}
                </button>
              </div>
            )}
            <div className="type-switch">
              {(["expense", "income", "transfer"] as const).map((k) => (
                <button
                  type="button"
                  disabled={Boolean(
                    linkedSchedule && k !== linkedSchedule.type,
                  )}
                  className={kind === k ? "selected" : ""}
                  key={k}
                  onClick={() => setKind(k)}
                >
                  {k === "expense" ? (
                    <ArrowUpRight size={16} />
                  ) : k === "income" ? (
                    <ArrowDownLeft size={16} />
                  ) : (
                    <ArrowLeftRight size={16} />
                  )}{" "}
                  {k}
                </button>
              ))}
            </div>
            {kind === "transfer" ? (
              <div className="form-row">
                <label>
                  {uiText("Amount")} ({accCurr})
                  <input
                    name="amount"
                    autoFocus
                    required
                    inputMode="decimal"
                    placeholder={formatCurrencyInput(0, accCurr)}
                    value={amountText}
                    onChange={(e) => {
                      const next = e.target.value;
                      setAmountText(next);
                      setOriginalAmountText(next);
                      if (isCrossCurrencyTransfer && !userEditedToAmount) {
                        const r = Number(fxRateText);
                        if (next.trim() && Number.isFinite(r) && r > 0) {
                          try {
                            const fromM = parseCurrencyMinor(next, accCurr);
                            setToAmountText(
                              formatCurrencyInput(
                                convertMinor(fromM, accCurr, toAccCurr, r),
                                toAccCurr,
                              ),
                            );
                          } catch {
                            // Ignore partial input.
                          }
                        }
                      }
                    }}
                  />
                </label>
                {isCrossCurrencyTransfer && (
                  <label>
                    {uiText("Receiving amount")} ({toAccCurr})
                    <input
                      name="to_amount"
                      required
                      inputMode="decimal"
                      placeholder={formatCurrencyInput(0, toAccCurr)}
                      value={toAmountText}
                      onChange={(e) => {
                        setToAmountText(e.target.value);
                        setUserEditedToAmount(true);
                      }}
                    />
                  </label>
                )}
              </div>
            ) : (
              <div className="form-row">
                <label style={{ flex: 2 }}>
                  {uiText("Amount")} ({txCurrency})
                  <input
                    name="original_amount"
                    autoFocus
                    required
                    inputMode="decimal"
                    placeholder={formatCurrencyInput(0, txCurrency)}
                    value={originalAmountText}
                    onChange={(e) => {
                      const next = e.target.value;
                      setOriginalAmountText(next);
                      if (!isForeign) {
                        setAmountText(next);
                      } else if (!userEditedAccountAmount) {
                        syncAccountFromOriginal(next, txCurrency, fxRateText);
                      }
                    }}
                  />
                </label>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
                  <span className="field-label">{uiText("Currency")}</span>
                  <CurrencyPicker
                    value={txCurrency}
                    compact
                    disabled={busy}
                    onChange={(nextCurr) => {
                      setTxCurrency(nextCurr);
                      setUserEditedAccountAmount(false);
                      if (nextCurr === accCurr) {
                        setAmountText(originalAmountText);
                        setFxRateText("1");
                        setFxSource("same_currency");
                        setFxStatus("exact");
                      }
                    }}
                  />
                </div>
              </div>
            )}
            {isCrossCurrencyTransfer && (
              <p className="form-hint">
                {rateLoading
                  ? uiText("Fetching exchange rate…")
                  : (() => {
                      try {
                        const fm = parseCurrencyMinor(amountText, accCurr);
                        const tm = parseCurrencyMinor(toAmountText, toAccCurr);
                        if (fm > 0 && tm > 0) {
                          const implied = computeImpliedRate(fm, accCurr, tm, toAccCurr);
                          return `Cross-currency transfer · 1 ${accCurr} = ${formatFxRate(implied)} ${toAccCurr}`;
                        }
                      } catch {
                        // Ignore partial input.
                      }
                      return fxRateText
                        ? `Cross-currency transfer · Est. 1 ${accCurr} = ${fxRateText} ${toAccCurr}`
                        : "Cross-currency transfer between accounts in different currencies.";
                    })()}
              </p>
            )}
            {isForeign && (
              <div className="enrichment-section">
                <div className="enrichment-section-head">
                  <span className="field-label">
                    {uiText("Charged to account")} ({accCurr})
                  </span>
                  <span className="muted small">
                    {rateLoading
                      ? uiText("Fetching rate…")
                      : fxStatus === "estimated"
                        ? `≈ ${uiText("Estimated")} (${fxRateDate || dateValue})`
                        : uiText("Confirmed")}
                  </span>
                </div>
                <div className="form-row">
                  <label>
                    {accCurr} {uiText("Amount")}
                    <input
                      name="amount"
                      inputMode="decimal"
                      placeholder={formatCurrencyInput(0, accCurr)}
                      value={amountText}
                      disabled={busy}
                      onChange={(e) => {
                        const nextAmt = e.target.value;
                        setAmountText(nextAmt);
                        setUserEditedAccountAmount(true);
                        try {
                          const origM = parseCurrencyMinor(originalAmountText, txCurrency);
                          const accM = parseCurrencyMinor(nextAmt, accCurr);
                          if (origM > 0 && accM > 0) {
                            setFxRateText(
                              formatFxRate(
                                computeImpliedRate(origM, txCurrency, accM, accCurr),
                              ),
                            );
                            setFxSource("user_confirmed");
                            setFxStatus("exact");
                          }
                        } catch {
                          // Ignore partial input.
                        }
                      }}
                    />
                  </label>
                  <label>
                    1 {txCurrency} = {accCurr}
                    <input
                      name="fx_rate"
                      inputMode="decimal"
                      value={fxRateText}
                      disabled={busy}
                      onChange={(e) => {
                        const nextRate = e.target.value;
                        setFxRateText(nextRate);
                        setUserEditedAccountAmount(false);
                        setFxSource("manual_rate");
                        syncAccountFromOriginal(
                          originalAmountText,
                          txCurrency,
                          nextRate,
                        );
                      }}
                    />
                  </label>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                    marginTop: "4px",
                  }}
                >
                  <p className="form-hint" style={{ margin: 0 }}>
                    {fxStatus === "estimated"
                      ? `Approximate rate for ${fxRateDate || dateValue}. Edit ${accCurr} amount to confirm.`
                      : `Confirmed in ${accCurr}.`}
                  </p>
                  {fxStatus === "estimated" && amountText.trim() && (
                    <button
                      type="button"
                      className="secondary compact-btn"
                      onClick={() => {
                        setFxSource("user_confirmed");
                        setFxStatus("exact");
                        setUserEditedAccountAmount(true);
                      }}
                    >
                      {uiText("Looks right")}
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="form-row">
              <label>
                {kind === "transfer"
                  ? uiText("From account")
                  : uiText("Account")}
                <select
                  name="account_id"
                  required
                  value={accountId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    const prevAccCurr = accCurr;
                    setAccountId(nextId);
                    const acc = ledger.accounts.find((a) => a.id === nextId);
                    const nextAccCurr = accountCurrency(acc);
                    if (!txItem && txCurrency === prevAccCurr) {
                      setTxCurrency(nextAccCurr);
                    }
                    setUserEditedAccountAmount(false);
                  }}
                >
                  {ledger.accounts.map((a) => {
                    const c = accountCurrency(a);
                    return (
                      <option value={a.id} key={a.id}>
                        {a.name} ({c})
                      </option>
                    );
                  })}
                </select>
              </label>
              {kind === "transfer" ? (
                <label>
                  {uiText("To account")}
                  <select
                    name="to_account_id"
                    required
                    value={toAccountId}
                    onChange={(e) => {
                      setToAccountId(e.target.value);
                      setUserEditedToAmount(false);
                    }}
                  >
                    <option value="" disabled>
                      {uiText("Choose account")}
                    </option>
                    {ledger.accounts.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.name} ({accountCurrency(a)})
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label>
                  {uiText("Category")}
                  <select
                    key={kind}
                    name="category_id"
                    value={categoryId}
                    disabled={splits.length > 0}
                    onChange={(e) => setCategoryId(e.target.value)}
                  >
                    <option value="">
                      {splits.length > 0
                        ? uiText("Split across categories")
                        : uiText("Uncategorized")}
                    </option>
                    {ledger.categories.map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <label>
              {uiText("Date")}
              <input
                required
                name="date"
                type="date"
                value={dateValue}
                onChange={(e) => setDateValue(e.target.value)}
              />
            </label>
            <label>
              {kind === "transfer"
                ? uiText("Description")
                : uiText("Payee / description")}
              <input
                name="payee"
                maxLength={160}
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
                placeholder={
                  kind === "income"
                    ? "e.g. Monthly salary"
                    : kind === "transfer"
                      ? "e.g. Moving to savings"
                      : "e.g. Spinneys"
                }
              />
            </label>
            <label>
              {" "}
              {uiText("Notes")}{" "}
              <span className="muted">{uiText("Optional")}</span>
              <textarea
                name="notes"
                maxLength={1000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={uiText("Anything you’d like to remember")}
              />
            </label>
            {kind !== "transfer" && (ledger.rules?.length ?? 0) > 0 && (
              <div className="enrichment-rule-bar">
                <button
                  type="button"
                  className="secondary compact-btn"
                  disabled={busy}
                  onClick={handleApplyRules}
                >
                  <Wand2 size={14} /> {uiText("Apply rules")}{" "}
                </button>
                {ruleNotice && (
                  <span className="muted small">{ruleNotice}</span>
                )}
              </div>
            )}
            <div className="field-block">
              <span className="field-label">
                {" "}
                {uiText("Tags")}{" "}
                <span className="muted">{uiText("Optional")}</span>
              </span>
              <TagInput
                tags={tags}
                onChange={setTags}
                suggestions={tagSuggestions}
                disabled={busy}
              />
            </div>
            {kind !== "transfer" && (
              <div className="enrichment-section">
                <div className="enrichment-section-head">
                  <span className="field-label">
                    <Split size={14} /> {uiText("Split transaction")}{" "}
                  </span>
                  <button
                    type="button"
                    className="secondary compact-btn"
                    disabled={busy}
                    onClick={() => {
                      if (splits.length === 0) {
                        const half = Math.floor(parsedParentAmount / 2);
                        const rem = parsedParentAmount - half;
                        setSplits([
                          {
                            category_id: categoryId,
                            amountText:
                              parsedParentAmount > 0
                                ? formatCurrencyInput(half, accCurr)
                                : "",
                            notes: "",
                          },
                          {
                            category_id: "",
                            amountText:
                              parsedParentAmount > 0
                                ? formatCurrencyInput(rem, accCurr)
                                : "",
                            notes: "",
                          },
                        ]);
                      } else {
                        setSplits((rows) => [
                          ...rows,
                          {
                            category_id: "",
                            amountText:
                              remainingFils > 0
                                ? formatCurrencyInput(remainingFils, accCurr)
                                : "",
                            notes: "",
                          },
                        ]);
                      }
                    }}
                  >
                    <Plus size={13} />{" "}
                    {splits.length === 0
                      ? uiText("Split across categories")
                      : uiText("Add split")}
                  </button>
                </div>
                {splits.length > 0 && (
                  <div className="splits-list">
                    {splits.map((row, idx) => (
                      <div className="split-row" key={idx}>
                        <select
                          aria-label={`Split ${idx + 1} category`}
                          value={row.category_id}
                          onChange={(e) =>
                            setSplits((rows) =>
                              rows.map((r, i) =>
                                i === idx
                                  ? { ...r, category_id: e.target.value }
                                  : r,
                              ),
                            )
                          }
                        >
                          <option value="">{uiText("Uncategorized")}</option>
                          {ledger.categories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label={`Split ${idx + 1} amount`}
                          inputMode="decimal"
                          placeholder={formatCurrencyInput(0, accCurr)}
                          value={row.amountText}
                          onChange={(e) =>
                            setSplits((rows) =>
                              rows.map((r, i) =>
                                i === idx
                                  ? { ...r, amountText: e.target.value }
                                  : r,
                              ),
                            )
                          }
                        />
                        <input
                          aria-label={`Split ${idx + 1} notes`}
                          maxLength={200}
                          placeholder={uiText("Note")}
                          value={row.notes}
                          onChange={(e) =>
                            setSplits((rows) =>
                              rows.map((r, i) =>
                                i === idx ? { ...r, notes: e.target.value } : r,
                              ),
                            )
                          }
                        />
                        <button
                          type="button"
                          className="icon-button delete"
                          aria-label={`Remove split ${idx + 1}`}
                          onClick={() =>
                            setSplits((rows) =>
                              rows.filter((_, i) => i !== idx),
                            )
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                    <div className="splits-footer">
                      <span
                        className={`small ${remainingFils === 0 ? "muted" : "error-text"}`}
                      >
                        {remainingFils === 0
                          ? uiText("Splits balanced")
                          : `Remaining: ${money(remainingFils, accCurr)}`}
                      </span>
                      {remainingFils !== 0 && splits.length > 0 && (
                        <button
                          type="button"
                          className="text-button small"
                          onClick={() => {
                            const lastIdx = splits.length - 1;
                            const currentLast =
                              parsedSplits[lastIdx]?.amount > 0
                                ? parsedSplits[lastIdx].amount
                                : 0;
                            const nextLast = currentLast + remainingFils;
                            if (nextLast > 0) {
                              setSplits((rows) =>
                                rows.map((r, i) =>
                                  i === lastIdx
                                    ? {
                                        ...r,
                                        amountText: formatCurrencyInput(nextLast, accCurr),
                                      }
                                    : r,
                                ),
                              );
                            }
                          }}
                        >
                          {uiText("Fill remainder on last line")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="enrichment-section">
              <div className="enrichment-section-head">
                <span className="field-label">
                  <Paperclip size={14} /> {uiText("Receipt")}{" "}
                  <span className="muted">
                    {uiText("JPEG, PNG, WebP, PDF · max 5 MB")}
                  </span>
                </span>
              </div>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    validateReceiptFile(file);
                    setError("");
                    setReceiptFile(file);
                    setRemoveReceipt(false);
                  } catch (err) {
                    setError(errorMessage(err));
                    e.target.value = "";
                  }
                }}
              />
              {receiptLoading && (
                <p className="muted small">
                  {uiText("Loading receipt preview…")}
                </p>
              )}
              {(receiptFile || (!removeReceipt && txItem?.receipt)) && (
                <div className="receipt-preview-box">
                  {receiptPreviewUrl &&
                  !isReceiptPdf(receiptFile?.name ?? txItem?.receipt ?? "") ? (
                    <img
                      src={receiptPreviewUrl}
                      alt={uiText("Receipt preview")}
                      className="receipt-thumb"
                    />
                  ) : (
                    <span className="muted small">
                      {receiptFile?.name ?? txItem?.receipt}
                    </span>
                  )}
                  <div className="receipt-actions">
                    {receiptPreviewUrl && (
                      <a
                        href={receiptPreviewUrl}
                        download={
                          receiptFile?.name ?? txItem?.receipt ?? "receipt"
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="secondary compact-btn"
                      >
                        <Download size={13} /> {uiText("Open / Download")}{" "}
                      </a>
                    )}
                    <button
                      type="button"
                      className="secondary compact-btn danger-outline"
                      disabled={busy}
                      onClick={() => {
                        setReceiptFile(null);
                        setRemoveReceipt(true);
                        setReceiptPreviewUrl("");
                      }}
                    >
                      <Trash2 size={13} /> {uiText("Remove")}{" "}
                    </button>
                  </div>
                  {demo && (
                    <small className="muted">
                      {" "}
                      {uiText(
                        "Demo mode: receipt stays in browser memory for this session.",
                      )}{" "}
                    </small>
                  )}
                </div>
              )}
            </div>
            {kind === "transfer" && (
              <p className="form-hint">
                {" "}
                {uiText(
                  "Both accounts update together. Transfers are excluded from income and expenses.",
                )}{" "}
              </p>
            )}
          </>
        ) : modal.kind === "account" ? (
          <>
            <label>
              {" "}
              {uiText("Account name")}{" "}
              <input
                required
                autoFocus
                name="name"
                maxLength={80}
                defaultValue={modal.item?.name}
                placeholder={uiText("e.g. My everyday account")}
              />
            </label>
            <div className="form-row">
              <label>
                {uiText("Account type")}
                <select
                  name="type"
                  value={accountType}
                  onChange={(e) =>
                    setAccountType(e.target.value as AccountType)
                  }
                >
                  {Object.entries(ACCOUNT_TYPES).map(([value, label]) => (
                    <option value={value} key={value}>
                      {uiText(label)}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span className="field-label">{uiText("Currency")}</span>
                <CurrencyPicker
                  name="currency"
                  value={accountFormCurrency}
                  disabled={busy}
                  onChange={setAccountFormCurrency}
                />
              </div>
            </div>
            <p className="form-hint">
              Balances for this account are stored in {accountFormCurrency}.
              Dashboard totals and reports convert into your reporting currency.
            </p>
            <div className="form-row">
              <label>
                {uiText("Balance")} ({accountFormCurrency}){" "}
                <span className="muted">{uiText("Optional")}</span>
                <input
                  inputMode="decimal"
                  name="balance"
                  placeholder={formatCurrencyInput(0, accountFormCurrency)}
                  defaultValue={
                    modal.item && hasBalanceAnchor(modal.item)
                      ? formatCurrencyInput(
                          modal.item.opening_balance,
                          accountFormCurrency,
                        )
                      : ""
                  }
                />
              </label>
              <label>
                {uiText("As of end of")}
                <input
                  name="balance_as_of"
                  type="date"
                  defaultValue={
                    modal.item && hasBalanceAnchor(modal.item)
                      ? balanceAsOfDate(modal.item)
                      : today()
                  }
                />
              </label>
            </div>
            <p className="form-hint">
              {uiText(
                "Enter what your bank shows at the end of a day. Transactions after that day are added to it. Earlier ones are already part of it, so you can add past transactions at any time without changing this balance. Leave it blank to just add up your transactions. Use a negative balance for credit card debt or an overdraft.",
              )}{" "}
              {modal.item && (
                <>
                  {uiText("The app currently shows")}{" "}
                  {money(
                    balance(modal.item, ledger.transactions),
                    accountCurrency(modal.item),
                  )}{" "}
                  {uiText("for this account.")}
                </>
              )}
            </p>
            {accountType === "credit_card" && (
              <div className="enrichment-section">
                <div className="enrichment-section-head">
                  <span className="field-label">
                    {uiText("Credit card details")}{" "}
                    <span className="muted">{uiText("Optional")}</span>
                  </span>
                </div>
                <div className="form-row">
                  <label>
                    {uiText("Credit limit")} ({accountFormCurrency})
                    <input
                      inputMode="decimal"
                      name="credit_limit"
                      placeholder={formatCurrencyInput(0, accountFormCurrency)}
                      defaultValue={
                        modal.item?.credit_limit
                          ? formatCurrencyInput(
                              modal.item.credit_limit,
                              accountFormCurrency,
                            )
                          : ""
                      }
                    />
                  </label>
                  <label>
                    {uiText("Minimum payment")} ({accountFormCurrency})
                    <input
                      inputMode="decimal"
                      name="minimum_payment"
                      placeholder={formatCurrencyInput(0, accountFormCurrency)}
                      defaultValue={
                        modal.item?.minimum_payment
                          ? formatCurrencyInput(
                              modal.item.minimum_payment,
                              accountFormCurrency,
                            )
                          : ""
                      }
                    />
                  </label>
                </div>
                <div className="form-row">
                  <label>
                    {" "}
                    {uiText("Statement day (1–31)")}{" "}
                    <input
                      type="number"
                      min={1}
                      max={31}
                      name="statement_day"
                      placeholder={uiText("e.g. 20")}
                      defaultValue={modal.item?.statement_day || ""}
                    />
                  </label>
                  <label>
                    {" "}
                    {uiText("Payment due day (1–31)")}{" "}
                    <input
                      type="number"
                      min={1}
                      max={31}
                      name="payment_due_day"
                      placeholder={uiText("e.g. 10")}
                      defaultValue={modal.item?.payment_due_day || ""}
                    />
                  </label>
                  <label>
                    {" "}
                    {uiText("APR (%)")}{" "}
                    <input
                      inputMode="decimal"
                      name="apr_pct"
                      placeholder={uiText("e.g. 29.99")}
                      defaultValue={
                        modal.item?.apr_bps
                          ? (modal.item.apr_bps / 100).toFixed(2)
                          : ""
                      }
                    />
                  </label>
                </div>
              </div>
            )}
            <EmojiField defaultValue={modal.item?.emoji} />
            <ColorPicker
              defaultValue={
                modal.item?.color ??
                COLORS[ledger.accounts.length % COLORS.length]
              }
            />
          </>
        ) : (
          <>
            <label>
              {" "}
              {uiText("Category name")}{" "}
              <input
                autoFocus
                required
                name="name"
                maxLength={80}
                defaultValue={modal.item?.name}
                placeholder={uiText("e.g. Coffee & cafés")}
              />
            </label>
            <p className="form-hint">
              {" "}
              {uiText("Use this category for both income and expenses.")}{" "}
            </p>
            <label>
              {" "}
              {uiText("Description")}{" "}
              <span className="muted">{uiText("Optional")}</span>
              <textarea
                name="description"
                maxLength={500}
                defaultValue={modal.item?.description}
                placeholder={uiText("What belongs in this category?")}
              />
            </label>
            <EmojiField defaultValue={modal.item?.emoji} />
            <ColorPicker
              defaultValue={
                modal.item?.color ??
                COLORS[ledger.categories.length % COLORS.length]
              }
            />
          </>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            {" "}
            {uiText("Cancel")}{" "}
          </button>
          <button
            className="primary"
            disabled={
              busy || (modal.kind === "transaction" && !ledger.accounts.length)
            }
          >
            {busy
              ? uiText("Saving…")
              : item
                ? uiText("Save changes")
                : `Add ${modal.kind}`}
            <Check size={16} />
          </button>
        </div>
      </form>
    </dialog>
  );
}
