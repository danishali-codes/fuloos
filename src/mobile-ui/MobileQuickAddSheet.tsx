import { useState } from "react";
import { Delete, SlidersHorizontal, WifiOff, X } from "lucide-react";
import {
  errorMessage,
  minor,
  today,
  validateTransaction,
  type Kind,
  type Ledger,
  type Transaction,
} from "../domain";
import { translateText as uiText } from "../i18n";
import {
  pickDefaultAccountId,
  readRememberedAccount,
  saveRememberedAccount,
  type QuickAddDraft,
} from "../quickAdd";
import { evaluateCalculatorExpression } from "./isMobileApkMode";

const NUMPAD_KEYS = [
  "7",
  "8",
  "9",
  "÷",
  "4",
  "5",
  "6",
  "×",
  "1",
  "2",
  "3",
  "−",
  ".",
  "0",
  "⌫",
  "+",
] as const;

export function MobileQuickAddSheet({
  ledger,
  initialDraft,
  editingTx,
  busy,
  online,
  demo,
  onClose,
  onSave,
  onAddAccount,
  onOpenFullEditor,
}: {
  ledger: Ledger;
  initialDraft?: Partial<QuickAddDraft>;
  editingTx?: Transaction | null;
  busy: boolean;
  online: boolean;
  demo: boolean;
  onClose: () => void;
  onSave: (
    table: "transactions",
    value: Record<string, unknown>,
    id?: string,
  ) => Promise<void>;
  onAddAccount: () => void;
  onOpenFullEditor: (tx?: Transaction) => void;
}) {
  const [type, setType] = useState<Kind>(
    editingTx?.type ?? initialDraft?.type ?? "expense",
  );
  const [expr, setExpr] = useState<string>(() => {
    if (editingTx) return (editingTx.amount / 100).toFixed(2).replace(/\.00$/, "");
    if (initialDraft?.amount) return initialDraft.amount;
    return "0";
  });
  const [accountId, setAccountId] = useState<string>(
    () =>
      editingTx?.account_id ??
      pickDefaultAccountId(
        ledger.accounts,
        initialDraft?.accountId ?? readRememberedAccount(),
      ),
  );
  const [toAccountId, setToAccountId] = useState<string>(() => {
    if (editingTx?.to_account_id) return editingTx.to_account_id;
    const other = ledger.accounts.find((a) => a.id !== accountId);
    return other?.id ?? "";
  });
  const [categoryId, setCategoryId] = useState<string>(
    editingTx?.category_id ?? initialDraft?.categoryId ?? "",
  );
  const [payee, setPayee] = useState<string>(
    editingTx?.payee ?? initialDraft?.payee ?? "",
  );
  const [date, setDate] = useState<string>(
    editingTx?.date ?? initialDraft?.date ?? today(),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const offlineLocked = !online && !demo;
  const evaluated = evaluateCalculatorExpression(expr);
  const hasOperator = /[+−×÷\-*/]/.test(expr.slice(1));
  const displayEvaluated =
    evaluated !== null && evaluated > 0
      ? evaluated.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : "0.00";

  function handleSelectAccount(nextId: string) {
    setAccountId(nextId);
    if (toAccountId === nextId) {
      const other = ledger.accounts.find((a) => a.id !== nextId);
      setToAccountId(other?.id ?? "");
    }
  }

  function pressKey(key: string) {
    setError("");
    if (key === "⌫") {
      setExpr((prev) => (prev.length > 1 ? prev.slice(0, -1) : "0"));
      return;
    }
    const isOp = ["+", "−", "×", "÷"].includes(key);
    setExpr((prev) => {
      if (prev.length >= 18) return prev;
      if (isOp) {
        if (prev === "0") return prev;
        if (["+", "−", "×", "÷"].includes(prev[prev.length - 1])) {
          return prev.slice(0, -1) + key;
        }
        return prev + key;
      }
      if (key === ".") {
        const lastPart = prev.split(/[+−×÷]/).pop() ?? "";
        if (lastPart.includes(".")) return prev;
        return prev + ".";
      }
      if (prev === "0") return key;
      return prev + key;
    });
  }

  async function handleSave() {
    setError("");
    if (offlineLocked) {
      setError(uiText("You're offline. Reconnect to save this transaction."));
      return;
    }
    if (evaluated === null || evaluated <= 0) {
      setError(uiText("Enter an amount greater than zero."));
      return;
    }
    if (!accountId) {
      setError(uiText("Choose an account."));
      return;
    }
    if (type === "transfer" && (!toAccountId || toAccountId === accountId)) {
      setError(uiText("Choose a different destination account."));
      return;
    }
    try {
      const amountFils = minor(evaluated.toFixed(2));
      const record: Omit<Transaction, "id"> = {
        type,
        amount: amountFils,
        account_id: accountId,
        to_account_id: type === "transfer" ? toAccountId : null,
        category_id: type === "transfer" ? null : categoryId || null,
        date,
        payee: payee.trim().slice(0, 120),
        notes: editingTx?.notes ?? "",
        ...(editingTx?.tags ? { tags: editingTx.tags } : {}),
      };
      validateTransaction(record, ledger);
      saveRememberedAccount(accountId);
      setSaving(true);
      await onSave("transactions", record, editingTx?.id);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const kindClass =
    type === "income"
      ? "is-income"
      : type === "transfer"
        ? "is-transfer"
        : "is-expense";

  if (ledger.accounts.length === 0) {
    return (
      <div className="m-sheet-backdrop" role="presentation" onClick={onClose}>
        <div
          className="m-sheet"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="m-sheet-handle" aria-hidden />
          <div style={{ fontSize: 17, fontWeight: 800 }}>
            {uiText("Create an account first")}
          </div>
          <p style={{ fontSize: 13, color: "var(--m-muted)" }}>
            {uiText(
              "Add at least one bank, card, or cash account before recording transactions.",
            )}
          </p>
          <button
            type="button"
            className="m-primary-btn"
            onClick={() => {
              onClose();
              onAddAccount();
            }}
          >
            {uiText("Add account")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="m-qa-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={editingTx ? uiText("Edit transaction") : uiText("Add transaction")}
    >
      {/* Top Bar */}
      <div className="m-qa-top">
        <button
          type="button"
          className="m-icon-circle"
          aria-label={uiText("Close")}
          onClick={onClose}
        >
          <X size={18} />
        </button>

        <div className="m-qa-kinds" role="tablist">
          {(["expense", "income", "transfer"] as const).map((k) => {
            const active = type === k;
            const disabledTransfer = k === "transfer" && ledger.accounts.length < 2;
            return (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={disabledTransfer}
                className={active ? `is-${k}` : ""}
                onClick={() => {
                  setType(k);
                  setError("");
                  if (k === "transfer" && (!toAccountId || toAccountId === accountId)) {
                    const other = ledger.accounts.find((a) => a.id !== accountId);
                    setToAccountId(other?.id ?? "");
                  }
                }}
              >
                {k === "expense"
                  ? uiText("Expense")
                  : k === "income"
                    ? uiText("Income")
                    : uiText("Transfer")}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="m-icon-circle"
          aria-label={uiText("Full transaction form (splits, FX, receipt)")}
          title={uiText("Full form")}
          onClick={() => {
            onClose();
            onOpenFullEditor(editingTx ?? undefined);
          }}
        >
          <SlidersHorizontal size={16} />
        </button>
      </div>

      {/* Offline warning */}
      {offlineLocked && (
        <div className="m-alert-box is-error" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          <WifiOff size={14} />
          <span>{uiText("Offline — reconnect to save")}</span>
        </div>
      )}

      {/* Big Amount Display + Payee + Date */}
      <div className="m-qa-display">
        <div className={`m-qa-amount-pill ${kindClass}`}>
          <span className="m-qa-amount-cur">AED</span>
          <span className="m-qa-amount-num m-num">{expr}</span>
        </div>
        {hasOperator && evaluated !== null && (
          <div className="m-qa-expr-preview m-num">= AED {displayEvaluated}</div>
        )}
        <div className="m-qa-meta-row">
          <input
            type="text"
            className="m-qa-payee-input"
            placeholder={
              type === "transfer"
                ? uiText("Transfer note (optional)")
                : uiText("Payee or merchant…")
            }
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
          />
          <input
            type="date"
            className="m-qa-date-input m-num"
            aria-label={uiText("Date")}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>

      {/* Account + Category / To-Account horizontal chips */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div className="m-qa-pick-label">
            {type === "transfer" ? uiText("From Account") : uiText("Account")}
          </div>
          <div className="m-hscroll">
            {ledger.accounts.map((acc) => {
              const selected = accountId === acc.id;
              return (
                <button
                  key={acc.id}
                  type="button"
                  className="m-qa-chip"
                  style={
                    selected
                      ? {
                          background: acc.color || "var(--m-brand)",
                          color: "#ffffff",
                          borderColor: "transparent",
                        }
                      : undefined
                  }
                  onClick={() => handleSelectAccount(acc.id)}
                >
                  <span
                    className="m-qa-dot"
                    style={{ background: selected ? "#ffffff" : acc.color }}
                  />
                  <span>{acc.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {type === "transfer" ? (
          <div>
            <div className="m-qa-pick-label">{uiText("To Account")}</div>
            <div className="m-hscroll">
              {ledger.accounts
                .filter((a) => a.id !== accountId)
                .map((acc) => {
                  const selected = toAccountId === acc.id;
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      className="m-qa-chip"
                      style={
                        selected
                          ? {
                              background: acc.color || "var(--m-trf)",
                              color: "#ffffff",
                              borderColor: "transparent",
                            }
                          : undefined
                      }
                      onClick={() => setToAccountId(acc.id)}
                    >
                      <span
                        className="m-qa-dot"
                        style={{ background: selected ? "#ffffff" : acc.color }}
                      />
                      <span>{acc.name}</span>
                    </button>
                  );
                })}
            </div>
          </div>
        ) : (
          <div>
            <div className="m-qa-pick-label">{uiText("Category")}</div>
            <div className="m-hscroll">
              <button
                type="button"
                className="m-qa-chip"
                style={
                  !categoryId
                    ? {
                        background: "var(--m-brand)",
                        color: "var(--m-brand-on)",
                        borderColor: "transparent",
                      }
                    : undefined
                }
                onClick={() => setCategoryId("")}
              >
                {uiText("None")}
              </button>
              {ledger.categories.map((cat) => {
                const selected = categoryId === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    className="m-qa-chip"
                    style={
                      selected
                        ? {
                            background: cat.color || "var(--m-brand)",
                            color: "#ffffff",
                            borderColor: "transparent",
                          }
                        : undefined
                    }
                    onClick={() => setCategoryId(cat.id)}
                  >
                    {cat.emoji ? (
                      <span>{cat.emoji}</span>
                    ) : (
                      <span
                        className="m-qa-dot"
                        style={{ background: selected ? "#ffffff" : cat.color }}
                      />
                    )}
                    <span>{cat.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="m-alert-box is-error" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}

      {/* Calculator Numpad + Save CTA */}
      <div>
        <div className="m-numpad" role="group" aria-label={uiText("Calculator keypad")}>
          {NUMPAD_KEYS.map((key) => {
            const isOp = ["+", "−", "×", "÷"].includes(key);
            return (
              <button
                key={key}
                type="button"
                className={`m-key ${isOp ? "is-op" : ""}`}
                aria-label={key === "⌫" ? uiText("Backspace") : key}
                onClick={() => pressKey(key)}
              >
                {key === "⌫" ? <Delete size={20} /> : key}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className={`m-qa-save-btn ${kindClass}`}
          disabled={busy || saving || offlineLocked}
          onClick={() => void handleSave()}
        >
          {saving
            ? uiText("Saving…")
            : editingTx
              ? `${uiText("Save Changes")} · AED ${displayEvaluated}`
              : `${uiText("Add")} ${
                  type === "expense"
                    ? uiText("Expense")
                    : type === "income"
                      ? uiText("Income")
                      : uiText("Transfer")
                } · AED ${displayEvaluated}`}
        </button>
      </div>
    </div>
  );
}
