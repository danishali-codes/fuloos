import { translateText as uiText } from "./i18n";
import { backend } from "./client";
import { useRef, useState } from "react";
import { Download, FileJson, FileSpreadsheet, Upload } from "lucide-react";
import {
  createBackup,
  isLedgerEmpty,
  MAX_BACKUP_BYTES,
  parseAndValidateBackup,
  serializeBackup,
  type BackupPreview,
  type FuloosBackup,
  type RestoreMode,
} from "./backup";
import type { PresetStore } from "./csvPresets";
import { errorMessage, plural, today, type Ledger } from "./domain";
import { downloadBlob, transactionsToCsv } from "./export";

export function DataBackup({
  ledger,
  demo = false,
  presetStore,
  busy,
  onRestore,
}: {
  ledger: Ledger;
  demo?: boolean;
  presetStore: Pick<PresetStore, "load" | "save">;
  busy?: boolean;
  onRestore: (backup: FuloosBackup, mode: RestoreMode) => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<{
    backup: FuloosBackup;
    preview: BackupPreview;
  } | null>(null);
  const workspaceEmpty = isLedgerEmpty(ledger);
  const [mode, setMode] = useState<RestoreMode>(
    workspaceEmpty ? "empty" : "merge",
  );
  const [confirmed, setConfirmed] = useState(false);

  const disabled = Boolean(busy || exporting || restoring);

  async function handleExportCsv() {
    setError("");
    setStatus("");
    setExporting(true);
    try {
      const csv = transactionsToCsv(ledger.transactions, ledger);
      downloadBlob(
        csv,
        `fuloos-transactions-${today()}.csv`,
        "text/csv;charset=utf-8",
      );
      setStatus(
        `Exported ${plural(ledger.transactions.length, "transaction")} to CSV.`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  async function handleExportJson() {
    setError("");
    setStatus("");
    setExporting(true);
    try {
      const { presets } = await presetStore.load();
      const backup = createBackup(ledger, presets);
      const api = demo ? null : backend;
      if (api) {
        const [notifications, households] = await Promise.all([
          api.loadNotificationPrefs(),
          api.loadHouseholds(),
        ]);
        if (notifications.supported)
          backup.data.notification_prefs = notifications.prefs;
        const session = await api.getSession();
        if (households.supported)
          backup.data.households = households.households.filter(
            (h) => h.owner_id === session?.user.id,
          );
      }
      let totalReceiptBytes = 0;
      for (const tx of ledger.transactions) {
        if (!tx.receipt) continue;
        const blob = api
          ? await api.getReceiptBlob(tx.id, tx.receipt)
          : await fetch(tx.receipt).then((r) => r.blob());
        totalReceiptBytes += blob.size;
        if (totalReceiptBytes > 50 * 1024 * 1024)
          throw new Error(
            "Receipts exceed 50 MB. Export smaller groups or keep a server backup.",
          );
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(new Error("Could not read receipt."));
          reader.readAsDataURL(blob);
        });
        backup.data.attachments!.push({
          transaction_id: tx.id,
          filename: tx.receipt,
          mime: blob.type,
          base64,
        });
      }
      downloadBlob(
        serializeBackup(backup),
        `fuloos-backup-${today()}.json`,
        "application/json;charset=utf-8",
      );
      setStatus("Downloaded full account backup (JSON).");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  async function handleFileSelect(file: File | undefined) {
    setError("");
    setStatus("");
    setParsed(null);
    setConfirmed(false);
    setFileName(file?.name ?? "");
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      setError("Backup file exceeds the 100 MB size limit.");
      return;
    }
    try {
      const text = await file.text();
      const result = parseAndValidateBackup(text);
      setParsed(result);
      setMode(isLedgerEmpty(ledger) ? "empty" : "merge");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function handleRestore() {
    if (!parsed || !confirmed) return;
    setError("");
    setStatus("");
    setRestoring(true);
    try {
      await onRestore(parsed.backup, mode);
      setStatus(
        `Restore started for ${plural(parsed.preview.counts.transactions, "transaction")} and ${plural(parsed.preview.counts.accounts, "account")}.`,
      );
      setParsed(null);
      setFileName("");
      setConfirmed(false);
      if (fileInput.current) fileInput.current.value = "";
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <section className="data-backup" aria-labelledby="data-backup-heading">
      <div className="data-backup-head">
        <div>
          <h3 id="data-backup-heading">{uiText("Data & backup")}</h3>
          <p className="muted small">
            {" "}
            {uiText(
              "Export your transactions as CSV or download a full JSON backup (accounts, categories, transactions, recurring schedules, occurrences, preferences, budgets, goals, rules, net worth, alerts, receipts and CSV presets). AI learning data, access tokens and other household members are excluded. Restored household groups need new invitations. Browser push must be enabled again.",
            )}{" "}
          </p>
        </div>
      </div>

      <div className="data-backup-actions">
        <button
          type="button"
          className="secondary"
          disabled={disabled || ledger.transactions.length === 0}
          onClick={() => void handleExportCsv()}
        >
          <FileSpreadsheet size={15} />{" "}
          {uiText("Export transactions (CSV)")}{" "}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={disabled}
          onClick={() => void handleExportJson()}
        >
          <FileJson size={15} /> <Download size={14} />{" "}
          {uiText("Full backup (JSON)")}{" "}
        </button>
      </div>

      <div className="data-backup-restore">
        <label className="data-backup-file">
          <span>{uiText("Restore from JSON backup")}</span>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            disabled={disabled}
            onChange={(e) => void handleFileSelect(e.target.files?.[0])}
          />
        </label>

        {parsed && (
          <div className="data-backup-preview">
            <div className="data-backup-preview-head">
              <strong>{fileName || "Backup preview"}</strong>
              <span className="muted small">
                {" "}
                {uiText("Format v")}
                {parsed.preview.formatVersion} {uiText("· Exported")}{" "}
                {parsed.preview.exportedAt.slice(0, 10)}
              </span>
            </div>
            <ul className="data-backup-counts">
              <li>{plural(parsed.preview.counts.accounts, "account")}</li>
              <li>
                {plural(
                  parsed.preview.counts.categories,
                  "category",
                  "categories",
                )}
              </li>
              <li>
                {plural(parsed.preview.counts.transactions, "transaction")}
              </li>
              <li>
                {plural(parsed.preview.counts.recurring, "recurring schedule")}
              </li>
              <li>
                {plural(
                  parsed.preview.counts.recurringOccurrences,
                  "occurrence",
                )}
              </li>
              <li>{plural(parsed.preview.counts.budgets, "budget")}</li>
              <li>{plural(parsed.preview.counts.csvPresets, "CSV preset")}</li>
              {(
                [
                  ["goals", "Goals"],
                  ["contributions", "Contributions"],
                  ["rules", "Transaction rules"],
                  ["netWorthItems", "Net-worth items"],
                  ["valuations", "Valuations"],
                  ["capturedAlerts", "Captured alerts"],
                  ["receipts", "Receipt"],
                  ["households", "Household groups"],
                ] as const
              ).map(([key, label]) =>
                parsed.preview.counts[key] > 0 ? (
                  <li key={key}>
                    {parsed.preview.counts[key]} {uiText(label)}
                  </li>
                ) : null,
              )}
            </ul>

            <fieldset className="data-backup-modes">
              <legend>{uiText("Restore mode")}</legend>
              <label className={!workspaceEmpty ? "is-disabled" : ""}>
                <input
                  type="radio"
                  name="restore-mode"
                  value="empty"
                  disabled={disabled || !workspaceEmpty}
                  checked={mode === "empty"}
                  onChange={() => setMode("empty")}
                />
                <span>
                  {" "}
                  {uiText("Restore into empty account only")}{" "}
                  {!workspaceEmpty && (
                    <small className="muted">
                      {" "}
                      {uiText(
                        "(Unavailable — workspace already has data)",
                      )}{" "}
                    </small>
                  )}
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="restore-mode"
                  value="merge"
                  disabled={disabled}
                  checked={mode === "merge"}
                  onChange={() => setMode("merge")}
                />
                <span>
                  {" "}
                  {uiText(
                    "Merge with existing data (reuses matching accounts & categories, skips duplicate transactions)",
                  )}{" "}
                </span>
              </label>
            </fieldset>

            <label className="data-backup-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={disabled}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                {" "}
                {uiText(
                  "I have reviewed the preview counts and want to restore this backup.",
                )}{" "}
              </span>
            </label>

            <div className="data-backup-restore-actions">
              <button
                type="button"
                className="primary"
                disabled={disabled || !confirmed}
                onClick={() => void handleRestore()}
              >
                <Upload size={15} />{" "}
                {restoring ? uiText("Restoring…") : uiText("Confirm & restore")}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={disabled}
                onClick={() => {
                  setParsed(null);
                  setFileName("");
                  setConfirmed(false);
                  setError("");
                  if (fileInput.current) fileInput.current.value = "";
                }}
              >
                {" "}
                {uiText("Cancel")}{" "}
              </button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="muted small" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
