import { GraduationCap, ShieldCheck, Trash2 } from "lucide-react";
import { translateText as uiText } from "./i18n";
import type { LearnedTemplate } from "./sms/types";

function renderSkeletonPreview(skeleton: string) {
  return skeleton.split(/(\{[A-Z]+\})/g).map((part, idx) =>
    /^\{[A-Z]+\}$/.test(part) ? (
      <span
        key={idx}
        style={{
          display: "inline-block",
          padding: "0 5px",
          margin: "0 1px",
          borderRadius: "5px",
          fontSize: "0.75rem",
          fontWeight: 600,
          background: "var(--accent-soft, rgba(16, 185, 129, 0.14))",
          color: "var(--accent, #059669)",
        }}
      >
        {part}
      </span>
    ) : (
      <span key={idx}>{part}</span>
    ),
  );
}

export function LearnedTemplatesSection({
  templates,
  busy = false,
  onDelete,
}: {
  templates: LearnedTemplate[];
  busy?: boolean;
  onDelete: (template: LearnedTemplate) => void;
}) {
  return (
    <div style={{ display: "grid", gap: "10px", marginTop: "6px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <GraduationCap size={16} />
          <strong style={{ fontSize: "0.94rem" }}>
            {uiText("Learned message formats")} ({templates.length})
          </strong>
        </div>
        <span
          className="muted"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            fontSize: "0.76rem",
          }}
        >
          <ShieldCheck size={13} /> {uiText("On-device only")}
        </span>
      </div>

      {templates.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: "0.84rem" }}>
          {uiText(
            "No taught formats yet. Open “Couldn't read” and tap Teach Fuloos on any unfamiliar bank alert to add one.",
          )}
        </p>
      ) : (
        <div style={{ display: "grid", gap: "8px" }}>
          {templates.map((tpl) => {
            const lastUsed = tpl.last_hit_at
              ? new Date(tpl.last_hit_at).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })
              : uiText("Not matched yet");
            return (
              <div
                key={tpl.id}
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
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: "0.86rem" }}>
                      {tpl.bank_id || tpl.sender_norm || uiText("Any bank")}
                    </strong>
                    {tpl.bank_id && tpl.sender_norm && tpl.bank_id.toUpperCase() !== tpl.sender_norm && (
                      <span className="muted" style={{ fontSize: "0.76rem" }}>
                        ({tpl.sender_norm})
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: "0.72rem",
                        padding: "1px 7px",
                        borderRadius: "999px",
                        background:
                          tpl.direction === "credit"
                            ? "rgba(16, 185, 129, 0.14)"
                            : "rgba(239, 68, 68, 0.12)",
                        color: tpl.direction === "credit" ? "#047857" : "#b91c1c",
                        fontWeight: 600,
                      }}
                    >
                      {tpl.direction === "credit" ? uiText("Money in") : uiText("Money out")} ·{" "}
                      {tpl.txn_type.replace(/_/g, " ")}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={uiText("Delete learned format")}
                    disabled={busy}
                    onClick={() => onDelete(tpl)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div
                  style={{
                    fontSize: "0.8rem",
                    lineHeight: 1.5,
                    color: "var(--text)",
                    wordBreak: "break-word",
                  }}
                >
                  {renderSkeletonPreview(tpl.pattern.skeleton)}
                </div>
                <div
                  className="muted"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "0.74rem",
                  }}
                >
                  <span>
                    {tpl.hits} {tpl.hits === 1 ? uiText("match") : uiText("matches")}
                  </span>
                  <span>
                    {uiText("Last used:")} {lastUsed}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
