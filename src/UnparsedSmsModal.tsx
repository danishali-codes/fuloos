import { useEffect, useRef } from "react";
import { AlertCircle, GraduationCap, ShieldCheck, Trash2, X } from "lucide-react";
import type { UnparsedSmsItem } from "./mobile/platformBridge";
import { translateText as uiText } from "./i18n";

export function UnparsedSmsModal({
  items,
  busy = false,
  onDismiss,
  onTeach,
  onClose,
}: {
  items: UnparsedSmsItem[];
  busy?: boolean;
  onDismiss: (item: UnparsedSmsItem) => void;
  onTeach?: (item: UnparsedSmsItem) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="unparsed-sms-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">{uiText("ON-DEVICE SMS PARSER")}</span>
          <h2 id="unparsed-sms-title">
            {uiText("Couldn't read")} {items.length > 0 ? `(${items.length})` : ""}
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={uiText("Close dialog")}
          disabled={busy}
          onClick={onClose}
        >
          <X size={21} />
        </button>
      </div>

      <div style={{ display: "grid", gap: "12px" }}>
        <div
          className="notice"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            margin: 0,
            fontSize: "0.86rem",
          }}
        >
          <ShieldCheck size={16} style={{ flexShrink: 0 }} />
          <span>
            {uiText(
              "Stored only on this device — SMS text is never uploaded to the cloud. Teach Fuloos once and future messages in the same format will parse automatically.",
            )}
          </span>
        </div>

        {items.length === 0 ? (
          <div className="empty" style={{ padding: "28px 16px" }}>
            <AlertCircle size={26} />
            <h3>{uiText("All caught up")}</h3>
            <p className="muted">
              {uiText(
                "No unread messages from your linked banks are waiting here.",
              )}
            </p>
          </div>
        ) : (
          <div style={{ display: "grid", gap: "10px", maxHeight: "56vh", overflowY: "auto" }}>
            {items.map((item) => {
              const dateLabel = item.received_at
                ? new Date(item.received_at).toLocaleString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "";
              return (
                <div
                  key={item.id}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "12px",
                    padding: "12px 14px",
                    background: "var(--surface)",
                    display: "grid",
                    gap: "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <strong style={{ fontSize: "0.92rem" }}>{item.sender}</strong>
                    <span className="muted" style={{ fontSize: "0.78rem" }}>
                      {dateLabel}
                    </span>
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "0.86rem",
                      lineHeight: 1.45,
                      color: "var(--text)",
                      background: "var(--bg)",
                      padding: "8px 10px",
                      borderRadius: "8px",
                      fontFamily: "var(--font-mono, ui-monospace, monospace)",
                      wordBreak: "break-word",
                    }}
                  >
                    {item.body}
                  </p>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: "8px",
                    }}
                  >
                    <button
                      type="button"
                      className="secondary compact-btn"
                      disabled={busy}
                      onClick={() => onDismiss(item)}
                    >
                      <Trash2 size={14} /> {uiText("Dismiss")}
                    </button>
                    {onTeach && (
                      <button
                        type="button"
                        className="primary compact-btn"
                        disabled={busy}
                        onClick={() => onTeach(item)}
                      >
                        <GraduationCap size={15} /> {uiText("Teach Fuloos")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </dialog>
  );
}
