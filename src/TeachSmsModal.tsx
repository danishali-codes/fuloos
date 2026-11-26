import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  GraduationCap,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { translateText as uiText } from "./i18n";
import {
  buildLearnedTemplateFromSpans,
  suggestTeachSelections,
  type TeachToken,
  type TextSpan,
} from "./sms/learned";
import type { LearnedTemplate, SmsTxnType } from "./sms/types";

export interface TeachSmsTarget {
  id?: number;
  sender: string;
  body: string;
  received_at?: string;
  sms_hash?: string;
  bank_id?: string | null;
}

type RoleKey = "amount" | "merchant" | "date" | "balance";

const ROLE_META: Record<
  RoleKey,
  { label: string; bg: string; border: string; text: string }
> = {
  amount: {
    label: "Amount",
    bg: "rgba(16, 185, 129, 0.16)",
    border: "rgba(16, 185, 129, 0.7)",
    text: "#047857",
  },
  merchant: {
    label: "Merchant",
    bg: "rgba(59, 130, 246, 0.15)",
    border: "rgba(59, 130, 246, 0.7)",
    text: "#1d4ed8",
  },
  date: {
    label: "Date",
    bg: "rgba(245, 158, 11, 0.16)",
    border: "rgba(245, 158, 11, 0.7)",
    text: "#b45309",
  },
  balance: {
    label: "Balance",
    bg: "rgba(100, 116, 139, 0.16)",
    border: "rgba(100, 116, 139, 0.65)",
    text: "#475569",
  },
};

const TXN_TYPE_OPTIONS: Array<{ value: SmsTxnType; label: string }> = [
  { value: "purchase", label: "Purchase" },
  { value: "transfer_out", label: "Transfer out" },
  { value: "transfer_in", label: "Transfer in" },
  { value: "bill_payment", label: "Bill payment" },
  { value: "cash_withdrawal", label: "ATM / Cash" },
  { value: "salary", label: "Salary" },
  { value: "refund", label: "Refund" },
  { value: "fee", label: "Fee / Charge" },
  { value: "card_repayment", label: "Card repayment" },
  { value: "loan_repayment", label: "Loan / Finance" },
  { value: "other", label: "Other" },
];

function tokenOverlapsSpan(tok: TeachToken, span: TextSpan | null): boolean {
  if (!span) return false;
  return tok.start < span.end && tok.end > span.start;
}

function renderSkeletonChips(skeleton: string) {
  const parts = skeleton.split(/(\{[A-Z]+\})/g);
  return parts.map((part, idx) => {
    if (/^\{[A-Z]+\}$/.test(part)) {
      return (
        <span
          key={idx}
          style={{
            display: "inline-block",
            padding: "1px 6px",
            margin: "0 2px",
            borderRadius: "6px",
            fontSize: "0.78rem",
            fontWeight: 600,
            background: "var(--accent-soft, rgba(16, 185, 129, 0.15))",
            color: "var(--accent, #059669)",
          }}
        >
          {part}
        </span>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

export function TeachSmsModal({
  target,
  busy = false,
  onSave,
  onClose,
}: {
  target: TeachSmsTarget;
  busy?: boolean;
  onSave: (template: LearnedTemplate, target: TeachSmsTarget) => Promise<void> | void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  const initial = useMemo(
    () => suggestTeachSelections(target.body, target.sender),
    [target.body, target.sender],
  );

  const [activeRole, setActiveRole] = useState<RoleKey>("amount");
  const [amountSpan, setAmountSpan] = useState<TextSpan | null>(initial.amountSpan);
  const [currencySpan, setCurrencySpan] = useState<TextSpan | null>(initial.currencySpan);
  const [merchantSpan, setMerchantSpan] = useState<TextSpan | null>(initial.merchantSpan);
  const [dateSpan, setDateSpan] = useState<TextSpan | null>(initial.dateSpan);
  const [balanceSpan, setBalanceSpan] = useState<TextSpan | null>(initial.balanceSpan);
  const [direction, setDirection] = useState<"debit" | "credit">(initial.direction);
  const [txnType, setTxnType] = useState<SmsTxnType>(initial.txnType);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function getTokenRole(tok: TeachToken): RoleKey | null {
    if (tokenOverlapsSpan(tok, amountSpan)) return "amount";
    if (tokenOverlapsSpan(tok, merchantSpan)) return "merchant";
    if (tokenOverlapsSpan(tok, dateSpan)) return "date";
    if (tokenOverlapsSpan(tok, balanceSpan)) return "balance";
    return null;
  }

  function handleChipClick(tok: TeachToken) {
    const span: TextSpan = { start: tok.start, end: tok.end };
    if (activeRole === "amount") {
      setAmountSpan(span);
      setCurrencySpan(null);
      if (tokenOverlapsSpan(tok, merchantSpan)) setMerchantSpan(null);
      if (tokenOverlapsSpan(tok, dateSpan)) setDateSpan(null);
      if (tokenOverlapsSpan(tok, balanceSpan)) setBalanceSpan(null);
      return;
    }
    if (activeRole === "merchant") {
      if (tokenOverlapsSpan(tok, merchantSpan)) {
        setMerchantSpan(null);
        return;
      }
      // Extend contiguous merchant selection if user taps an adjacent word
      if (merchantSpan) {
        const gapAfter = tok.start - merchantSpan.end;
        const gapBefore = merchantSpan.start - tok.end;
        if (gapAfter >= 0 && gapAfter <= 3) {
          setMerchantSpan({ start: merchantSpan.start, end: tok.end });
          return;
        }
        if (gapBefore >= 0 && gapBefore <= 3) {
          setMerchantSpan({ start: tok.start, end: merchantSpan.end });
          return;
        }
      }
      setMerchantSpan(span);
      return;
    }
    if (activeRole === "date") {
      setDateSpan(tokenOverlapsSpan(tok, dateSpan) ? null : span);
      return;
    }
    if (activeRole === "balance") {
      setBalanceSpan(tokenOverlapsSpan(tok, balanceSpan) ? null : span);
    }
  }

  function handleResetGuesses() {
    setAmountSpan(initial.amountSpan);
    setCurrencySpan(initial.currencySpan);
    setMerchantSpan(initial.merchantSpan);
    setDateSpan(initial.dateSpan);
    setBalanceSpan(initial.balanceSpan);
    setDirection(initial.direction);
    setTxnType(initial.txnType);
  }

  const previewTemplate = useMemo<LearnedTemplate | null>(() => {
    if (!amountSpan) return null;
    return buildLearnedTemplateFromSpans({
      sender: target.sender,
      body: initial.normalizedText,
      amountSpan,
      currencySpan,
      merchantSpan,
      dateSpan,
      balanceSpan,
      direction,
      txnType,
      bankId: target.bank_id ?? null,
    });
  }, [
    target.sender,
    target.bank_id,
    initial.normalizedText,
    amountSpan,
    currencySpan,
    merchantSpan,
    dateSpan,
    balanceSpan,
    direction,
    txnType,
  ]);

  const spanText = (sp: TextSpan | null) =>
    sp ? initial.normalizedText.slice(sp.start, sp.end) : "";

  async function handleSave() {
    if (!previewTemplate || saving || busy) return;
    setSaving(true);
    try {
      await onSave(previewTemplate, target);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="teach-sms-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!saving && !busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving && !busy) onClose();
      }}
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">
            {uiText("TEACH FULOOS")} · {target.sender}
          </span>
          <h2 id="teach-sms-title">{uiText("Teach this message format")}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={uiText("Close dialog")}
          disabled={saving || busy}
          onClick={onClose}
        >
          <X size={21} />
        </button>
      </div>

      <div style={{ display: "grid", gap: "14px" }}>
        <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
          {uiText(
            "Tap a field below, then tap the matching word in the SMS. Tap adjacent words to include a multi-word merchant.",
          )}
        </p>

        {/* Active role selector tabs */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {(["amount", "merchant", "date", "balance"] as RoleKey[]).map((role) => {
            const meta = ROLE_META[role];
            const isActive = activeRole === role;
            const currentVal =
              role === "amount"
                ? spanText(amountSpan)
                : role === "merchant"
                  ? spanText(merchantSpan)
                  : role === "date"
                    ? spanText(dateSpan)
                    : spanText(balanceSpan);
            return (
              <button
                key={role}
                type="button"
                className="compact-btn"
                onClick={() => setActiveRole(role)}
                style={{
                  border: `1.5px solid ${isActive ? meta.border : "var(--border)"}`,
                  background: isActive ? meta.bg : "var(--surface)",
                  color: isActive ? meta.text : "var(--text)",
                  borderRadius: "999px",
                  padding: "6px 12px",
                  fontSize: "0.82rem",
                  fontWeight: isActive ? 700 : 500,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>
                  {uiText(meta.label)}
                  {role === "amount" ? " *" : ""}
                </span>
                {currentVal && (
                  <span
                    style={{
                      fontSize: "0.75rem",
                      opacity: 0.85,
                      maxWidth: "110px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ({currentVal})
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            className="secondary compact-btn"
            onClick={handleResetGuesses}
            title={uiText("Reset to auto-detected fields")}
            style={{ marginLeft: "auto" }}
          >
            <RotateCcw size={13} /> {uiText("Reset")}
          </button>
        </div>

        {/* Tappable SMS chips */}
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "12px",
            padding: "12px",
            background: "var(--bg)",
            display: "flex",
            flexWrap: "wrap",
            gap: "6px",
            lineHeight: 1.5,
          }}
        >
          {initial.tokens.map((tok) => {
            const role = getTokenRole(tok);
            const meta = role ? ROLE_META[role] : null;
            const isPunct = tok.kind === "punct";
            return (
              <button
                key={tok.index}
                type="button"
                disabled={isPunct}
                onClick={() => handleChipClick(tok)}
                style={{
                  border: meta
                    ? `1.5px solid ${meta.border}`
                    : "1px solid var(--border)",
                  background: meta
                    ? meta.bg
                    : isPunct
                      ? "transparent"
                      : "var(--surface)",
                  color: meta ? meta.text : "var(--text)",
                  borderRadius: "8px",
                  padding: isPunct ? "4px 4px" : "4px 9px",
                  fontSize: "0.86rem",
                  fontFamily:
                    tok.kind === "number" || tok.kind === "card" || tok.kind === "date"
                      ? "var(--font-mono, ui-monospace, monospace)"
                      : "inherit",
                  fontWeight: meta ? 650 : 450,
                  cursor: isPunct ? "default" : "pointer",
                  opacity: isPunct ? 0.65 : 1,
                }}
              >
                {tok.text}
                {meta && (
                  <span
                    style={{
                      marginLeft: "5px",
                      fontSize: "0.68rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.03em",
                      opacity: 0.9,
                    }}
                  >
                    {uiText(meta.label)}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Direction + transaction type */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "12px",
            alignItems: "end",
          }}
        >
          <div>
            <span
              className="muted"
              style={{ display: "block", fontSize: "0.78rem", marginBottom: "6px" }}
            >
              {uiText("Direction")}
            </span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
              <button
                type="button"
                className={direction === "debit" ? "primary compact-btn" : "secondary compact-btn"}
                onClick={() => {
                  setDirection("debit");
                  if (txnType === "transfer_in" || txnType === "salary" || txnType === "refund") {
                    setTxnType("purchase");
                  }
                }}
              >
                {uiText("Money out")}
              </button>
              <button
                type="button"
                className={direction === "credit" ? "primary compact-btn" : "secondary compact-btn"}
                onClick={() => {
                  setDirection("credit");
                  if (txnType === "purchase" || txnType === "bill_payment" || txnType === "cash_withdrawal") {
                    setTxnType("transfer_in");
                  }
                }}
              >
                {uiText("Money in")}
              </button>
            </div>
          </div>

          <label style={{ display: "grid", gap: "6px", margin: 0 }}>
            <span className="muted" style={{ fontSize: "0.78rem" }}>
              {uiText("Transaction type")}
            </span>
            <select
              value={txnType}
              onChange={(e) => setTxnType(e.target.value as SmsTxnType)}
            >
              {TXN_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {uiText(opt.label)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Wording-only skeleton preview */}
        {previewTemplate && (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "10px",
              padding: "10px 12px",
              background: "var(--surface)",
              display: "grid",
              gap: "6px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "0.76rem",
                fontWeight: 600,
                color: "var(--muted)",
              }}
            >
              <ShieldCheck size={14} />
              <span>{uiText("Format saved on this device (no personal data)")}</span>
            </div>
            <div style={{ fontSize: "0.84rem", lineHeight: 1.6, wordBreak: "break-word" }}>
              {renderSkeletonChips(previewTemplate.pattern.skeleton)}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={saving || busy}
            onClick={onClose}
          >
            {uiText("Cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!previewTemplate || saving || busy}
            onClick={() => void handleSave()}
          >
            {saving ? (
              uiText("Saving…")
            ) : (
              <>
                <GraduationCap size={16} /> <Check size={15} />{" "}
                {uiText("Save format")}
              </>
            )}
          </button>
        </div>
      </div>
    </dialog>
  );
}
