import {
  ArrowLeftRight,
  Pencil,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  money,
  today,
  type Account,
  type Category,
  type Transaction,
} from "../domain";
import { translateText as uiText } from "../i18n";
import { hexAlpha } from "./isMobileApkMode";

export function formatShortDate(iso: string): string {
  const t = today();
  if (iso === t) return uiText("Today");
  const d = new Date(`${t}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);
  if (iso === yesterday) return uiText("Yesterday");
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export function formatMonthShort(ym: string): string {
  return new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
  });
}

function categoryGlyph(cat: Category | undefined, tx: Transaction) {
  if (tx.type === "transfer") {
    return <ArrowLeftRight size={18} style={{ color: "var(--m-trf)" }} />;
  }
  if (cat?.emoji) return <span>{cat.emoji}</span>;
  const letter = (cat?.name || tx.payee || "•").trim().charAt(0).toUpperCase();
  return (
    <span
      style={{
        fontSize: 15,
        fontWeight: 800,
        color: cat?.color || "var(--m-brand)",
      }}
    >
      {letter}
    </span>
  );
}

export function MobileTxCard({
  tx,
  category,
  account,
  toAccount,
  hidden,
  onSelect,
}: {
  tx: Transaction;
  category?: Category;
  account?: Account;
  toAccount?: Account;
  hidden: boolean;
  onSelect: (tx: Transaction) => void;
}) {
  const badgeBg =
    tx.type === "transfer"
      ? "var(--m-trf-bg)"
      : hexAlpha(category?.color ?? "#1b4a39", 0.16);

  const accountSubtitle =
    tx.type === "transfer"
      ? `${account?.name ?? uiText("Account")} → ${toAccount?.name ?? uiText("Account")}`
      : account?.name ?? uiText("Account");

  const sign = tx.type === "income" ? "+" : tx.type === "expense" ? "−" : "";
  const formattedAmt = hidden ? "••••••" : `${sign}${money(tx.amount)}`;
  const isSms = Boolean(tx.tags?.some((tag) => /sms/i.test(tag)));
  const isSplit = Boolean(tx.splits && tx.splits.length > 0);

  return (
    <button
      type="button"
      className="m-tx-card"
      onClick={() => onSelect(tx)}
    >
      <div className="m-cat-badge" style={{ background: badgeBg }} aria-hidden>
        {categoryGlyph(category, tx)}
      </div>
      <div className="m-tx-info">
        <div className="m-tx-payee">
          {tx.payee || category?.name || uiText("Transaction")}
        </div>
        <div className="m-tx-meta">
          <span>{accountSubtitle}</span>
          {isSms && <span className="m-mini-tag">SMS</span>}
          {isSplit && <span className="m-mini-tag">{uiText("Split")}</span>}
        </div>
      </div>
      <div className="m-tx-right">
        <div
          className={`m-tx-amount m-num ${
            tx.type === "income"
              ? "is-income"
              : tx.type === "transfer"
                ? "is-transfer"
                : ""
          }`}
        >
          {formattedAmt}
        </div>
        <div className="m-tx-date">{formatShortDate(tx.date)}</div>
      </div>
    </button>
  );
}

export function MobileTxDetailSheet({
  tx,
  category,
  account,
  toAccount,
  hidden,
  busy,
  onClose,
  onQuickEdit,
  onFullEdit,
  onDelete,
}: {
  tx: Transaction;
  category?: Category;
  account?: Account;
  toAccount?: Account;
  hidden: boolean;
  busy: boolean;
  onClose: () => void;
  onQuickEdit: (tx: Transaction) => void;
  onFullEdit: (tx: Transaction) => void;
  onDelete: (tx: Transaction) => void;
}) {
  const badgeBg =
    tx.type === "transfer"
      ? "var(--m-trf-bg)"
      : hexAlpha(category?.color ?? "#1b4a39", 0.16);
  const sign = tx.type === "income" ? "+" : tx.type === "expense" ? "−" : "";
  const accountLabel =
    tx.type === "transfer"
      ? `${account?.name ?? ""} → ${toAccount?.name ?? ""}`
      : account?.name ?? "";

  return (
    <div
      className="m-sheet-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="m-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={uiText("Transaction details")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="m-sheet-handle" aria-hidden />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div className="m-cat-badge" style={{ background: badgeBg }}>
              {categoryGlyph(category, tx)}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {tx.payee || category?.name || uiText("Transaction")}
              </div>
              <div style={{ fontSize: 12, color: "var(--m-muted)" }}>
                {category?.name ?? uiText("Uncategorized")} · {formatShortDate(tx.date)}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="m-icon-circle"
            aria-label={uiText("Close")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div
          style={{
            borderRadius: 18,
            padding: 16,
            textAlign: "center",
            background: "var(--m-soft)",
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--m-muted)", textTransform: "uppercase" }}>
            {tx.type}
          </div>
          <div
            className={`m-num ${
              tx.type === "income" ? "is-income" : tx.type === "transfer" ? "is-transfer" : ""
            }`}
            style={{
              fontSize: 28,
              fontWeight: 800,
              marginTop: 4,
              color:
                tx.type === "income"
                  ? "var(--m-inc)"
                  : tx.type === "expense"
                    ? "var(--m-exp)"
                    : "var(--m-trf)",
            }}
          >
            {hidden ? "••••••" : `${sign}${money(tx.amount)}`}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--m-text-soft)", marginTop: 4 }}>
            {accountLabel}
          </div>
          {tx.notes && (
            <div style={{ fontSize: 12, color: "var(--m-muted)", marginTop: 6 }}>
              {tx.notes}
            </div>
          )}
          {tx.tags && tx.tags.length > 0 && (
            <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {tx.tags.map((tag) => (
                <span key={tag} className="m-mini-tag" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <Tag size={10} /> {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button
            type="button"
            className="m-primary-btn"
            style={{ height: 44, fontSize: 13.5 }}
            disabled={busy}
            onClick={() => {
              onClose();
              // Split and foreign-currency rows carry fields the calculator
              // sheet cannot edit; changing only the amount would leave their
              // splits / original amount out of sync, so use the full editor.
              if (tx.splits?.length || tx.original_currency) onFullEdit(tx);
              else onQuickEdit(tx);
            }}
          >
            <Pencil size={15} /> {uiText("Quick Edit")}
          </button>
          <button
            type="button"
            className="m-google-btn"
            style={{ height: 44, fontSize: 13.5 }}
            disabled={busy}
            onClick={() => {
              onClose();
              onFullEdit(tx);
            }}
          >
            {uiText("Full Details")}
          </button>
        </div>

        <button
          type="button"
          className="m-google-btn"
          style={{
            height: 44,
            fontSize: 13.5,
            borderColor: "transparent",
            background: "var(--m-exp-bg)",
            color: "var(--m-exp)",
          }}
          disabled={busy}
          onClick={() => {
            onClose();
            onDelete(tx);
          }}
        >
          <Trash2 size={15} /> {uiText("Delete Transaction")}
        </button>
      </div>
    </div>
  );
}
