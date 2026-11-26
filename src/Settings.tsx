import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  FlaskConical,
  Inbox,
  MessageSquareText,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  formatCurrencyInput,
  parseCurrencyMinor,
} from "./currency";
import { CurrencyPicker } from "./CurrencyPicker";
import { useDensity, type Density } from "./density";
import {
  defaultUserSettings,
  type ConfirmForeignMode,
  type UserSettings,
} from "./domain";
import { useLocale, type Locale } from "./i18n";
import type { InboxDryRunSenderStats } from "./mobile/platformBridge";

/** Profile settings. Holds appearance, currency, list layout, data & backup, and account deletion. */
export function SettingsDialog({
  onClose,
  onDeleteAccount,
  onOpenRules,
  onOpenCaptureAlerts,
  onOpenSmsAutoCapture,
  onOpenUnparsedSms,
  onRunInboxDryRun,
  pendingAlertCount = 0,
  unparsedSmsCount = 0,
  linkedSmsCount = 0,
  userSettings,
  onSaveUserSettings,
  security,
  notifications,
  household,
  smsSection,
  dataBackup,
}: {
  onClose: () => void;
  /** Only offered when signed in (not in the demo workspace). */
  onDeleteAccount?: () => void;
  onOpenRules?: () => void;
  onOpenCaptureAlerts?: () => void;
  onOpenSmsAutoCapture?: () => void;
  onOpenUnparsedSms?: () => void;
  onRunInboxDryRun?: () => Promise<{ supported: boolean; senders: InboxDryRunSenderStats[] }>;
  pendingAlertCount?: number;
  unparsedSmsCount?: number;
  linkedSmsCount?: number;
  userSettings?: UserSettings;
  onSaveUserSettings?: (next: UserSettings) => void;
  security?: ReactNode;
  notifications?: ReactNode;
  household?: ReactNode;
  smsSection?: ReactNode;
  dataBackup?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [density, setDensity] = useDensity();
  const { locale, setLocale, t } = useLocale();
  const activeSettings = userSettings ?? defaultUserSettings;
  const [thresholdText, setThresholdText] = useState(() =>
    formatCurrencyInput(
      activeSettings.confirm_foreign_threshold,
      activeSettings.reporting_currency,
    ),
  );
  useEffect(() => {
    setThresholdText(
      formatCurrencyInput(
        activeSettings.confirm_foreign_threshold,
        activeSettings.reporting_currency,
      ),
    );
  }, [
    activeSettings.confirm_foreign_threshold,
    activeSettings.reporting_currency,
  ]);
  const choices: { value: Density; title: string; text: string }[] = [
    {
      value: "compact",
      title: t("settings.compactTitle"),
      text: t("settings.compactText"),
    },
    {
      value: "relaxed",
      title: t("settings.relaxedTitle"),
      text: t("settings.relaxedText"),
    },
  ];
  const languages: { value: Locale; label: string }[] = [
    { value: "en", label: t("settings.langEn") },
    { value: "ar", label: t("settings.langAr") },
  ];
  useEffect(() => {
    dialog.current?.showModal();
    if (
      new URLSearchParams(window.location.search).get("settings") ===
      "notifications"
    ) {
      const section =
        dialog.current?.querySelector("#notifications-heading") ??
        dialog.current?.querySelector(".notifications-settings");
      section?.scrollIntoView?.({ block: "start" });
      const url = new URL(window.location.href);
      url.searchParams.delete("settings");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    }
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal settings-modal"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="settings-title"
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">{t("settings.eyebrow")}</span>
          <h2 id="settings-title">{t("settings.title")}</h2>
        </div>
        <button
          className="icon-button"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {onSaveUserSettings && (
        <fieldset className="density-field">
          <legend>{t("fx.reportingCurrency")}</legend>
          <p className="muted small">{t("fx.reportingCurrencyHint")}</p>
          <div style={{ marginTop: "8px", marginBottom: "14px" }}>
            <CurrencyPicker
              value={activeSettings.reporting_currency}
              ariaLabel={t("fx.reportingCurrency")}
              onChange={(nextCurr) =>
                onSaveUserSettings({
                  ...activeSettings,
                  reporting_currency: nextCurr,
                })
              }
            />
          </div>
          <label style={{ display: "block", marginBottom: "6px" }}>
            <strong style={{ fontSize: "0.88rem" }}>
              {t("fx.confirmMode")}
            </strong>
          </label>
          <p className="muted small" style={{ marginTop: 0, marginBottom: "8px" }}>
            {t("fx.confirmModeHint")}
          </p>
          <div className="language-options">
            {(
              [
                ["always", t("fx.confirmAlways")],
                ["above_threshold", t("fx.confirmAbove")],
                ["never", t("fx.confirmNever")],
              ] as Array<[ConfirmForeignMode, string]>
            ).map(([modeVal, label]) => (
              <label
                key={modeVal}
                className={`language-option ${activeSettings.confirm_foreign_mode === modeVal ? "is-selected" : ""}`}
              >
                <span>{label}</span>
                <input
                  type="radio"
                  name="confirm_foreign_mode"
                  value={modeVal}
                  checked={activeSettings.confirm_foreign_mode === modeVal}
                  onChange={() =>
                    onSaveUserSettings({
                      ...activeSettings,
                      confirm_foreign_mode: modeVal,
                    })
                  }
                />
              </label>
            ))}
          </div>
          {activeSettings.confirm_foreign_mode === "above_threshold" && (
            <label style={{ display: "block", marginTop: "10px" }}>
              <span className="muted small">
                {t("fx.confirmThreshold")} ({activeSettings.reporting_currency})
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={thresholdText}
                onChange={(e) => setThresholdText(e.target.value)}
                onBlur={() => {
                  try {
                    const minorVal = parseCurrencyMinor(
                      thresholdText,
                      activeSettings.reporting_currency,
                    );
                    if (minorVal >= 0) {
                      onSaveUserSettings({
                        ...activeSettings,
                        confirm_foreign_threshold: minorVal,
                      });
                    }
                  } catch {
                    setThresholdText(
                      formatCurrencyInput(
                        activeSettings.confirm_foreign_threshold,
                        activeSettings.reporting_currency,
                      ),
                    );
                  }
                }}
                style={{ marginTop: "4px", maxWidth: "180px" }}
              />
            </label>
          )}
        </fieldset>
      )}
      <fieldset className="density-field">
        <legend>
          {t("settings.appearance")} · {t("settings.language")}
        </legend>
        <p className="muted small">{t("settings.languageHint")}</p>
        <div className="language-options">
          {languages.map((lang) => (
            <label
              key={lang.value}
              className={`language-option ${locale === lang.value ? "is-selected" : ""}`}
            >
              <span>{lang.label}</span>
              <input
                type="radio"
                name="locale"
                value={lang.value}
                checked={locale === lang.value}
                onChange={() => setLocale(lang.value)}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="density-field">
        <legend>{t("settings.layout")}</legend>
        <p className="muted small">{t("settings.layoutHint")}</p>
        <div className="density-options">
          {choices.map((c) => (
            <label
              key={c.value}
              className={`density-option ${density === c.value ? "is-selected" : ""}`}
            >
              <input
                type="radio"
                name="density"
                value={c.value}
                checked={density === c.value}
                onChange={() => setDensity(c.value)}
              />
              <span className={`density-preview ${c.value}`} aria-hidden>
                {c.value === "compact" ? (
                  <>
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </>
                ) : (
                  <>
                    <em />
                    <b>
                      <span />
                      <span />
                    </b>
                    <b>
                      <span />
                      <span />
                    </b>
                  </>
                )}
              </span>
              <strong>{c.title}</strong>
              <small>{c.text}</small>
            </label>
          ))}
        </div>
      </fieldset>
      {security}
      {notifications}
      {household}
      {onOpenRules && (
        <div className="settings-danger">
          <div>
            <b>{t("settings.rulesTitle")}</b>
            <p className="muted small">{t("settings.rulesText")}</p>
          </div>
          <button type="button" className="secondary" onClick={onOpenRules}>
            <Wand2 size={15} /> {t("common.manageRules")}
          </button>
        </div>
      )}
      {onOpenSmsAutoCapture && (
        <div className="settings-danger">
          <div>
            <b>SMS Auto-Capture (Android)</b>
            <p className="muted small">
              Link accounts to bank SMS senders, backfill history, and configure
              Android notification channels.
            </p>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={onOpenSmsAutoCapture}
          >
            <MessageSquareText size={15} /> Manage SMS
            {linkedSmsCount > 0 ? ` (${linkedSmsCount})` : ""}
          </button>
        </div>
      )}
      {onOpenCaptureAlerts && (
        <div className="settings-danger">
          <div>
            <b>{t("settings.captureTitle")}</b>
            <p className="muted small">{t("settings.captureText")}</p>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={onOpenCaptureAlerts}
          >
            <Inbox size={15} /> {t("settings.capturedAlerts")}
            {pendingAlertCount > 0 ? ` (${pendingAlertCount})` : ""}
          </button>
        </div>
      )}
      {onOpenUnparsedSms && (
        <div className="settings-danger">
          <div>
            <b>Couldn&apos;t read (on-device SMS)</b>
            <p className="muted small">
              Messages from linked banks that Fuloos couldn&apos;t read yet. Stored
              only on this device.
            </p>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={onOpenUnparsedSms}
          >
            <AlertCircle size={15} /> Couldn&apos;t read
            {unparsedSmsCount > 0 ? ` (${unparsedSmsCount})` : ""}
          </button>
        </div>
      )}
      {smsSection}
      {onRunInboxDryRun && (
        <InboxDryRunSection onRun={onRunInboxDryRun} />
      )}
      {dataBackup}
      {onDeleteAccount && (
        <div className="settings-danger">
          <div>
            <b>{t("settings.deleteAccountTitle")}</b>
            <p className="muted small">{t("settings.deleteAccountText")}</p>
          </div>
          <button className="secondary danger" onClick={onDeleteAccount}>
            <Trash2 size={15} /> {t("settings.deleteEllipsis")}
          </button>
        </div>
      )}
      <div className="modal-actions">
        <button className="primary" onClick={onClose}>
          {t("common.done")}
        </button>
      </div>
    </dialog>
  );
}

function InboxDryRunSection({
  onRun,
}: {
  onRun: () => Promise<{ supported: boolean; senders: InboxDryRunSenderStats[] }>;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    supported: boolean;
    senders: InboxDryRunSenderStats[];
  } | null>(null);
  const [err, setErr] = useState("");

  async function handleRun() {
    setRunning(true);
    setErr("");
    try {
      const res = await onRun();
      setResult(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Dry run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="settings-danger" style={{ display: "grid", gap: "10px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <b>Test parser on my inbox (debug)</b>
          <p className="muted small">
            Dry-runs the last 500 SMS from linked senders locally. Shows counts
            only — no message text, no writes, nothing sent.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={running}
          onClick={() => void handleRun()}
        >
          <FlaskConical size={15} />{" "}
          {running ? "Testing…" : "Test parser on my inbox"}
        </button>
      </div>
      {err && <p className="error">{err}</p>}
      {result && (
        <div style={{ fontSize: "0.84rem" }}>
          {!result.supported ? (
            <p className="muted small">
              Available in debug Android builds with SMS permission granted.
            </p>
          ) : result.senders.length === 0 ? (
            <p className="muted small">
              No messages found for your currently linked senders.
            </p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "4px 6px" }}>Sender</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Parsed</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Review</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Couldn&apos;t read</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Skipped</th>
                </tr>
              </thead>
              <tbody>
                {result.senders.map((s) => (
                  <tr key={s.sender} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "4px 6px", fontWeight: 600 }}>{s.sender}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{s.parsed}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{s.review}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{s.unparsed}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{s.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
