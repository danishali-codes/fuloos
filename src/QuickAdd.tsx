import { translateText as uiText } from "./i18n";
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Download,
  Plus,
  RefreshCw,
  WifiOff,
  X,
} from "lucide-react";
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
import { accountCurrency, errorMessage, today, type Ledger } from "./domain";
import { collectLedgerTags } from "./enrichment";
import { fxRateService } from "./fxRates";
import { TagInput } from "./TagInput";
import {
  buildQuickAddTransaction,
  pickDefaultAccountId,
  readRememberedAccount,
  saveRememberedAccount,
  type QuickAddDraft,
  type QuickAddKind,
} from "./quickAdd";

export function QuickAddModal({
  ledger,
  initialDraft,
  busy,
  online,
  demo,
  onClose,
  onSave,
  onAddAccount,
}: {
  ledger: Ledger;
  initialDraft?: Partial<QuickAddDraft>;
  busy: boolean;
  online: boolean;
  demo: boolean;
  onClose: () => void;
  onSave: (
    table: "transactions",
    value: Record<string, unknown>,
  ) => Promise<void>;
  onAddAccount: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const [type, setType] = useState<QuickAddKind>(
    initialDraft?.type ?? "expense",
  );
  const initialAccountId = pickDefaultAccountId(
    ledger.accounts,
    initialDraft?.accountId ?? readRememberedAccount(),
  );
  const initialAccCurrency = accountCurrency(
    ledger.accounts.find((a) => a.id === initialAccountId),
  );
  const [accountId, setAccountId] = useState(initialAccountId);
  const selectedAccount = ledger.accounts.find((a) => a.id === accountId);
  const accCurr = accountCurrency(selectedAccount);

  const [txCurrency, setTxCurrency] = useState(
    normalizeCurrencyCode(initialDraft?.currency ?? initialAccCurrency),
  );
  const [enteredAmount, setEnteredAmount] = useState(initialDraft?.amount ?? "");
  const [accountAmountText, setAccountAmountText] = useState(
    initialDraft?.amount ?? "",
  );
  const [fxRateText, setFxRateText] = useState("1");
  const [fxRateDate, setFxRateDate] = useState(initialDraft?.date ?? today());
  const [fxSource, setFxSource] = useState<FxSource>("same_currency");
  const [fxStatus, setFxStatus] = useState<FxStatus>("exact");
  const [userEditedAccountAmount, setUserEditedAccountAmount] = useState(false);
  const [rateLoading, setRateLoading] = useState(false);

  const [categoryId, setCategoryId] = useState(initialDraft?.categoryId ?? "");
  const [payee, setPayee] = useState(initialDraft?.payee ?? "");
  const [date, setDate] = useState(initialDraft?.date ?? today());
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState("");
  const tagSuggestions = collectLedgerTags(ledger);

  const isForeign = txCurrency !== accCurr;

  useEffect(() => {
    dialog.current?.showModal();
    amountRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!accountId && ledger.accounts.length > 0) {
      const nextId = pickDefaultAccountId(
        ledger.accounts,
        readRememberedAccount(),
      );
      setAccountId(nextId);
      const nextCurr = accountCurrency(
        ledger.accounts.find((a) => a.id === nextId),
      );
      if (!initialDraft?.currency) setTxCurrency(nextCurr);
    }
  }, [accountId, ledger.accounts, initialDraft?.currency]);

  // Fetch historical FX rate when transaction currency differs from account currency.
  useEffect(() => {
    if (!isForeign) {
      setFxRateText("1");
      setFxRateDate(date);
      setFxSource("same_currency");
      setFxStatus("exact");
      setUserEditedAccountAmount(false);
      setRateLoading(false);
      return;
    }
    let active = true;
    setRateLoading(true);
    fxRateService
      .getRate(txCurrency, accCurr, date)
      .then((res) => {
        if (!active) return;
        if (res.rate !== null && res.rate > 0) {
          setFxRateText(formatFxRate(res.rate));
          setFxRateDate(res.rateDate);
          setFxSource(res.source ?? "manual_rate");
          setFxStatus(res.status);
          if (!userEditedAccountAmount && enteredAmount.trim()) {
            try {
              const origMinor = parseCurrencyMinor(enteredAmount, txCurrency);
              const conv = convertMinor(origMinor, txCurrency, accCurr, res.rate);
              setAccountAmountText(formatCurrencyInput(conv, accCurr));
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
  }, [isForeign, txCurrency, accCurr, date]);

  // Keep estimated account amount synced when user types the original amount.
  useEffect(() => {
    if (!isForeign || userEditedAccountAmount) return;
    const rate = Number(fxRateText);
    if (!enteredAmount.trim() || !Number.isFinite(rate) || rate <= 0) {
      if (!enteredAmount.trim()) setAccountAmountText("");
      return;
    }
    try {
      const origMinor = parseCurrencyMinor(enteredAmount, txCurrency);
      const conv = convertMinor(origMinor, txCurrency, accCurr, rate);
      setAccountAmountText(formatCurrencyInput(conv, accCurr));
    } catch {
      // Ignore incomplete typing.
    }
  }, [enteredAmount, fxRateText, txCurrency, accCurr, isForeign, userEditedAccountAmount]);

  const offlineLocked = !online && !demo;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (offlineLocked) {
      setError("You're offline. Reconnect to save this transaction.");
      return;
    }
    try {
      if (!isForeign) {
        const record = buildQuickAddTransaction(
          {
            type,
            amount: enteredAmount,
            currency: accCurr,
            accountId,
            categoryId,
            payee,
            date,
          },
          ledger,
        );
        saveRememberedAccount(accountId);
        await onSave("transactions", {
          ...record,
          ...(tags.length > 0 ? { tags } : {}),
        });
        onClose();
        return;
      }

      if (!enteredAmount.trim()) {
        throw new Error(`Enter the ${txCurrency} amount.`);
      }
      const origMinor = parseCurrencyMinor(enteredAmount, txCurrency);
      if (origMinor <= 0) {
        throw new Error("Enter an amount greater than zero.");
      }

      let accMinor = 0;
      let finalRate = Number(fxRateText);
      let finalSource: FxSource = fxSource;
      let finalStatus: FxStatus = fxStatus;

      if (accountAmountText.trim()) {
        accMinor = parseCurrencyMinor(accountAmountText, accCurr);
        if (userEditedAccountAmount && accMinor > 0) {
          finalRate = computeImpliedRate(origMinor, txCurrency, accMinor, accCurr);
          finalSource = "user_confirmed";
          finalStatus = "exact";
        }
      } else if (Number.isFinite(finalRate) && finalRate > 0) {
        accMinor = convertMinor(origMinor, txCurrency, accCurr, finalRate);
      }

      if (!Number.isFinite(finalRate) || finalRate <= 0) {
        finalRate = 1;
        finalSource = "manual_rate";
        finalStatus = "estimated";
      }

      saveRememberedAccount(accountId);
      await onSave("transactions", {
        type,
        amount: accMinor,
        original_amount: origMinor,
        original_currency: txCurrency,
        fx_rate: finalRate,
        fx_rate_date: fxRateDate || date,
        fx_source: finalSource,
        fx_status: finalStatus,
        account_id: accountId,
        to_account_id: null,
        category_id: categoryId || null,
        date,
        payee: payee.trim().slice(0, 120),
        notes: "",
        ...(tags.length > 0 ? { tags } : {}),
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  let estPreviewLabel = "";
  if (isForeign && accountAmountText.trim()) {
    try {
      const m = parseCurrencyMinor(accountAmountText, accCurr);
      estPreviewLabel = `${fxStatus === "estimated" ? "≈ " : ""}${formatCurrency(m, accCurr)}`;
    } catch {
      estPreviewLabel = "";
    }
  }

  return (
    <dialog
      ref={dialog}
      className="modal quick-add-modal"
      aria-labelledby="quick-add-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">
            {uiText("QUICK ADD")} · {txCurrency}
          </span>
          <h2 id="quick-add-title">{uiText("Add transaction")}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={uiText("Close")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>

      {offlineLocked && (
        <div className="pwa-inline-notice" role="status">
          <WifiOff size={15} />
          <span>{uiText("You're offline — reconnect to save changes.")}</span>
        </div>
      )}

      {ledger.accounts.length === 0 ? (
        <div className="quick-add-empty">
          <p className="muted">
            {uiText(
              "Create an account first so Fuloos knows where this transaction belongs.",
            )}
          </p>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>
              {uiText("Cancel")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={offlineLocked}
              onClick={() => {
                onClose();
                onAddAccount();
              }}
            >
              {uiText("Add account")}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="quick-add-form">
          <div
            className="quick-add-kinds"
            role="group"
            aria-label={uiText("Type")}
          >
            <button
              type="button"
              className={type === "expense" ? "active" : ""}
              onClick={() => setType("expense")}
            >
              <ArrowUpRight size={15} /> {uiText("Expense")}
            </button>
            <button
              type="button"
              className={type === "income" ? "active" : ""}
              onClick={() => setType("income")}
            >
              <ArrowDownLeft size={15} /> {uiText("Income")}
            </button>
          </div>

          <div className="form-row">
            <label style={{ flex: 2 }}>
              {uiText("Amount")} ({txCurrency})
              <input
                ref={amountRef}
                required
                inputMode="decimal"
                name="amount"
                placeholder={formatCurrencyInput(0, txCurrency)}
                value={enteredAmount}
                onChange={(e) => {
                  setEnteredAmount(e.target.value);
                  setUserEditedAccountAmount(false);
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
                }}
              />
            </div>
          </div>

          {isForeign && (
            <div className="enrichment-section">
              <div className="enrichment-section-head">
                <span className="field-label">
                  {uiText("Charged to account")} ({accCurr})
                </span>
                <span className="muted small">
                  {rateLoading
                    ? uiText("Fetching rate…")
                    : estPreviewLabel ||
                      (fxRateText
                        ? `1 ${txCurrency} = ${fxRateText} ${accCurr}`
                        : uiText("Rate unavailable"))}
                </span>
              </div>
              <div className="form-row">
                <label>
                  {accCurr} {uiText("Amount")}
                  <input
                    inputMode="decimal"
                    placeholder={formatCurrencyInput(0, accCurr)}
                    value={accountAmountText}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value;
                      setAccountAmountText(next);
                      setUserEditedAccountAmount(true);
                      try {
                        const origM = parseCurrencyMinor(enteredAmount, txCurrency);
                        const accM = parseCurrencyMinor(next, accCurr);
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
                        // Ignore partial typing.
                      }
                    }}
                  />
                </label>
                <label>
                  1 {txCurrency} = {accCurr}
                  <input
                    inputMode="decimal"
                    value={fxRateText}
                    disabled={busy}
                    onChange={(e) => {
                      setFxRateText(e.target.value);
                      setUserEditedAccountAmount(false);
                      setFxSource("manual_rate");
                    }}
                  />
                </label>
              </div>
              <p className="form-hint">
                {fxStatus === "estimated"
                  ? `Estimated from ${fxRateDate || date} rate. Edit the ${accCurr} amount above if you already know what your bank charged, or confirm it later.`
                  : `Confirmed amount in ${accCurr}.`}
              </p>
            </div>
          )}

          <div className="form-row">
            <label>
              {uiText("Account")}
              <select
                name="account_id"
                value={accountId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  const prevAccCurr = accCurr;
                  setAccountId(nextId);
                  const nextAccCurr = accountCurrency(
                    ledger.accounts.find((a) => a.id === nextId),
                  );
                  if (txCurrency === prevAccCurr) {
                    setTxCurrency(nextAccCurr);
                  }
                  setUserEditedAccountAmount(false);
                }}
              >
                {ledger.accounts.map((a) => {
                  const c = accountCurrency(a);
                  return (
                    <option key={a.id} value={a.id}>
                      {a.emoji ? `${a.emoji} ` : ""}
                      {a.name} ({c})
                    </option>
                  );
                })}
              </select>
            </label>
            <label>
              {uiText("Category")}
              <select
                name="category_id"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">{uiText("Uncategorized")}</option>
                {ledger.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji ? `${c.emoji} ` : ""}
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="form-row">
            <label>
              {uiText("Payee")}{" "}
              <span className="muted">{uiText("Optional")}</span>
              <input
                name="payee"
                maxLength={120}
                placeholder={uiText("e.g. Sample Store, Cafe")}
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
              />
            </label>
            <label>
              {uiText("Date")}
              <input
                required
                type="date"
                name="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
          </div>

          <div className="field-block">
            <span className="field-label">
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
              {uiText("Cancel")}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={busy || offlineLocked}
            >
              {busy
                ? uiText("Saving…")
                : offlineLocked
                  ? uiText("Offline")
                  : type === "income"
                    ? uiText("Add income")
                    : uiText("Add expense")}
              <Check size={16} />
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

export function QuickAddFab({
  disabled,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="quick-add-fab"
      aria-label={uiText("Quick add transaction")}
      title={uiText("Quick add transaction (N)")}
      disabled={disabled}
      onClick={onClick}
    >
      <Plus size={22} />
    </button>
  );
}

export function PwaBanners({
  online,
  demo,
  updateAvailable,
  onApplyUpdate,
  canInstall,
  onInstall,
}: {
  online: boolean;
  demo: boolean;
  updateAvailable: boolean;
  onApplyUpdate: () => void;
  canInstall: boolean;
  onInstall: () => void;
}) {
  if (online && !updateAvailable && !canInstall) return null;

  return (
    <div className="pwa-banners">
      {!online && (
        <div className="pwa-banner pwa-banner-offline" role="status">
          <span>
            <WifiOff size={15} />
            {demo
              ? uiText("You're offline. Demo workspace changes stay in memory.")
              : uiText(
                  "You're offline. Viewing cached app shell — saving changes is paused until you reconnect.",
                )}
          </span>
        </div>
      )}
      {updateAvailable && (
        <div className="pwa-banner pwa-banner-update" role="status">
          <span>
            <RefreshCw size={15} />{" "}
            {uiText("A new version of Fuloos is ready.")}{" "}
          </span>
          <button type="button" onClick={onApplyUpdate}>
            {uiText("Update now")}
          </button>
        </div>
      )}
      {canInstall && online && !updateAvailable && (
        <div className="pwa-banner pwa-banner-install">
          <span>
            <Download size={15} />{" "}
            {uiText(
              "Install Fuloos for faster access and quick-add shortcuts.",
            )}{" "}
          </span>
          <button type="button" onClick={onInstall}>
            {uiText("Install app")}
          </button>
        </div>
      )}
    </div>
  );
}
