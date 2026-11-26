import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCircle2, Globe2, X } from "lucide-react";
import {
  computeImpliedRate,
  formatCurrency,
  formatCurrencyInput,
  formatFxRate,
  normalizeCurrencyCode,
  parseCurrencyMinor,
} from "./currency";
import {
  accountCurrency,
  errorMessage,
  type Ledger,
  type Transaction,
} from "./domain";
import {
  buildConfirmedForeignPatch,
  estimatedTransactions,
} from "./multiCurrency";
import { formatLocalizedDate, translateText as uiText } from "./i18n";

export function ConfirmAmountsModal({
  ledger,
  busy = false,
  initialTxId,
  onConfirm,
  onClose,
}: {
  ledger: Ledger;
  busy?: boolean;
  initialTxId?: string | null;
  onConfirm: (
    tx: Transaction,
    patch: Pick<Transaction, "amount" | "fx_rate" | "fx_source" | "fx_status">,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pending = useMemo(
    () => estimatedTransactions(ledger.transactions),
    [ledger.transactions],
  );
  const accMap = useMemo(
    () => new Map(ledger.accounts.map((a) => [a.id, a])),
    [ledger.accounts],
  );
  const [activeId, setActiveId] = useState<string | null>(
    () => initialTxId ?? pending[0]?.id ?? null,
  );
  const [inputText, setInputText] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  useEffect(() => {
    if (pending.length === 0) {
      setActiveId(null);
      return;
    }
    const stillExists = activeId && pending.some((t) => t.id === activeId);
    const nextId = stillExists ? activeId : pending[0].id;
    setActiveId(nextId);
  }, [pending, activeId]);

  const activeTx = useMemo(
    () => pending.find((t) => t.id === activeId) ?? null,
    [pending, activeId],
  );

  useEffect(() => {
    setError("");
    if (!activeTx) {
      setInputText("");
      return;
    }
    const accCurr = accountCurrency(accMap.get(activeTx.account_id));
    setInputText(
      activeTx.amount > 0 ? formatCurrencyInput(activeTx.amount, accCurr) : "",
    );
  }, [activeTx?.id, accMap]);

  async function handleConfirmInput(tx: Transaction) {
    setError("");
    const accCurr = accountCurrency(accMap.get(tx.account_id));
    try {
      if (!inputText.trim()) {
        throw new Error(`Enter the actual ${accCurr} amount charged.`);
      }
      const actualMinor = parseCurrencyMinor(inputText, accCurr);
      if (actualMinor <= 0) {
        throw new Error("Enter an amount greater than zero.");
      }
      const patch = buildConfirmedForeignPatch(tx, actualMinor, accCurr);
      setSavingId(tx.id);
      await onConfirm(tx, patch);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSavingId(null);
    }
  }

  async function handleLooksRight(tx: Transaction) {
    setError("");
    const accCurr = accountCurrency(accMap.get(tx.account_id));
    if (tx.amount <= 0) {
      setActiveId(tx.id);
      setError(`Enter the actual ${accCurr} amount first.`);
      return;
    }
    try {
      const patch = buildConfirmedForeignPatch(tx, tx.amount, accCurr);
      setSavingId(tx.id);
      await onConfirm(tx, patch);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby="confirm-fx-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ maxWidth: "560px", width: "min(94vw, 560px)" }}
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">{uiText("MULTI-CURRENCY")}</span>
          <h2 id="confirm-fx-title">
            {uiText("Confirm amounts")}{" "}
            {pending.length > 0 && (
              <span className="muted" style={{ fontSize: "0.8em", fontWeight: 500 }}>
                ({pending.length})
              </span>
            )}
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={uiText("Close dialog")}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>

      {pending.length === 0 ? (
        <div style={{ padding: "24px 8px", textAlign: "center" }}>
          <CheckCircle2
            size={36}
            style={{ color: "var(--accent, #1d5b48)", marginBottom: "8px" }}
          />
          <p style={{ fontWeight: 600, margin: "4px 0" }}>
            {uiText("All caught up")}
          </p>
          <p className="muted small">
            Every foreign-currency transaction has a confirmed account amount.
          </p>
          <div className="modal-actions" style={{ justifyContent: "center", marginTop: "16px" }}>
            <button type="button" className="primary" onClick={onClose}>
              {uiText("Done")}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <p className="muted small" style={{ margin: "0 0 4px" }}>
            These transactions used an approximate exchange rate. Enter the real
            amount your account was charged, or tap{" "}
            <strong>{uiText("Looks right")}</strong> to confirm the estimate.
          </p>

          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              maxHeight: "62vh",
              overflowY: "auto",
            }}
          >
            {pending.map((tx) => {
              const acc = accMap.get(tx.account_id);
              const accCurr = accountCurrency(acc);
              const origCurr = normalizeCurrencyCode(
                tx.original_currency ?? accCurr,
              );
              const origMinor = tx.original_amount ?? tx.amount;
              const isActive = tx.id === activeId;
              const isSaving = savingId === tx.id || busy;

              let liveRatePreview = "";
              if (isActive && inputText.trim()) {
                try {
                  const parsed = parseCurrencyMinor(inputText, accCurr);
                  if (parsed > 0 && origMinor > 0 && origCurr !== accCurr) {
                    const implied = computeImpliedRate(
                      origMinor,
                      origCurr,
                      parsed,
                      accCurr,
                    );
                    if (implied > 0) {
                      liveRatePreview = `1 ${origCurr} = ${formatFxRate(implied)} ${accCurr}`;
                    }
                  }
                } catch {
                  // Ignore partial typing.
                }
              }

              return (
                <div
                  key={tx.id}
                  style={{
                    border: isActive
                      ? "1.5px solid var(--accent, #1d5b48)"
                      : "1px solid var(--border, #e2ddd3)",
                    borderRadius: "12px",
                    padding: "12px 14px",
                    background: isActive
                      ? "rgba(29, 91, 72, 0.04)"
                      : "var(--surface, #fff)",
                  }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setActiveId(tx.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActiveId(tx.id);
                      }
                    }}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: "12px",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: "0.95rem",
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        <Globe2 size={14} style={{ opacity: 0.7, flexShrink: 0 }} />
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {tx.payee || uiText("No payee")}
                        </span>
                      </div>
                      <div className="muted small" style={{ marginTop: "2px" }}>
                        {formatLocalizedDate(tx.date)} · {acc?.name ?? "Account"} ({accCurr})
                      </div>
                    </div>
                    <div style={{ textAlign: "end", flexShrink: 0 }}>
                      <div style={{ fontWeight: 650, fontSize: "0.95rem" }}>
                        {formatCurrency(origMinor, origCurr)}
                      </div>
                      <div className="muted small">
                        {tx.amount > 0
                          ? `≈ ${formatCurrency(tx.amount, accCurr)}`
                          : "Rate unavailable"}
                      </div>
                    </div>
                  </div>

                  {isActive && (
                    <div
                      style={{
                        marginTop: "12px",
                        paddingTop: "12px",
                        borderTop: "1px solid var(--border, #e6e1d7)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "10px",
                      }}
                    >
                      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <span style={{ fontSize: "0.82rem", fontWeight: 600 }}>
                          Actual amount charged ({accCurr})
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={inputText}
                          disabled={isSaving}
                          placeholder={formatCurrencyInput(0, accCurr)}
                          onChange={(e) => setInputText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void handleConfirmInput(tx);
                            }
                          }}
                        />
                      </label>

                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: "8px",
                        }}
                      >
                        <span className="muted small">
                          {liveRatePreview ||
                            (tx.fx_rate && tx.fx_rate > 0 && origCurr !== accCurr
                              ? `Est. 1 ${origCurr} = ${formatFxRate(tx.fx_rate)} ${accCurr}`
                              : "")}
                        </span>
                        <div style={{ display: "flex", gap: "8px" }}>
                          {tx.amount > 0 && (
                            <button
                              type="button"
                              className="secondary compact-btn"
                              disabled={isSaving}
                              onClick={() => void handleLooksRight(tx)}
                            >
                              {uiText("Looks right")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="primary compact-btn"
                            disabled={isSaving}
                            onClick={() => void handleConfirmInput(tx)}
                          >
                            <Check size={14} /> {uiText("Confirm")}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </dialog>
  );
}
