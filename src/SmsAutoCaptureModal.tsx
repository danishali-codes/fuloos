import { useEffect, useMemo, useRef, useState } from "react";
import {
  BatteryCharging,
  Bell,
  Check,
  CreditCard,
  History,
  Link2,
  MessageSquareText,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import type { ImportTransaction } from "./csv";
import { transactionKey } from "./csv";
import {
  errorMessage,
  money,
  type Ledger,
} from "./domain";
import { translateText as uiText } from "./i18n";
import { loadLedgerModel, type ModelState } from "./ledger/loader";
import { loadMap } from "./ledger/mapping";
import {
  makeExample,
  type LearningExample,
  type LearningSettings,
} from "./ledger/learning";
import type { LearningStore } from "./ledger/learningStore";
import { BANK_NAMES } from "./ledger/sms";
import {
  platformBridge,
  type SmsPermissionStatus,
} from "./mobile/platformBridge";
import {
  createDefaultSmsLink,
  normalizeCardLast4,
  normalizeSender,
  validateSmsLink,
  type DiscoveredSmsSender,
  type SmsAccountLink,
  type SmsAutoAddMode,
} from "./mobile/smsLinks";
import {
  groupBackfillForReview,
  prepareEngineState,
  processSingleSms,
  type BackfillSummary,
  type SmsDecision,
  type SmsEngineContext,
} from "./mobile/smsPipeline";

type ModalView = "overview" | "link_form" | "backfill";

const SUPPORTED_BANKS = [...BANK_NAMES, "ENBD"];

function makeLinkId(): string {
  return `smslink_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function SmsAutoCaptureModal({
  demo,
  ledger,
  owner,
  learning,
  links,
  initialAccountId,
  onLinksChange,
  onImportTransactions,
  onOpenCaptureAlerts,
  onClose,
}: {
  demo: boolean;
  ledger: Ledger;
  owner: string;
  learning: LearningStore;
  links: SmsAccountLink[];
  initialAccountId?: string;
  onLinksChange: (next: SmsAccountLink[]) => Promise<void>;
  onImportTransactions: (
    rows: ImportTransaction[],
    progress: (n: number) => void,
    source?: string,
    onSaved?: (n: number) => void,
  ) => Promise<void>;
  onOpenCaptureAlerts: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<ModalView>(
    initialAccountId ? "link_form" : "overview",
  );
  const [perms, setPerms] = useState<SmsPermissionStatus | null>(null);
  const [senders, setSenders] = useState<DiscoveredSmsSender[]>([]);
  const [loadingSenders, setLoadingSenders] = useState(false);
  const [modelState, setModelState] = useState<ModelState>({ status: "loading" });
  const [learningSettings, setLearningSettings] =
    useState<LearningSettings | null>(null);
  const [learningExamples, setLearningExamples] = useState<LearningExample[]>([]);
  const [categoryMap, setCategoryMap] = useState(
    () => loadMap(owner, ledger.categories).map,
  );
  const [error, setError] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // Link form state
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState(
    initialAccountId || ledger.accounts[0]?.id || "",
  );
  const [selectedSenders, setSelectedSenders] = useState<string[]>([]);
  const [customSender, setCustomSender] = useState("");
  const [bankTemplate, setBankTemplate] = useState<string>("");
  const [cardLast4, setCardLast4] = useState<string>("");
  const [autoAddMode, setAutoAddMode] = useState<SmsAutoAddMode>(
    "auto_high_confidence",
  );
  const [confidencePct, setConfidencePct] = useState(60);

  // Backfill state
  const [backfillLink, setBackfillLink] = useState<SmsAccountLink | null>(null);
  const [backfillScanning, setBackfillScanning] = useState(false);
  const [backfillSummary, setBackfillSummary] =
    useState<BackfillSummary | null>(null);
  const [backfillAllDecisions, setBackfillAllDecisions] = useState<
    SmsDecision[]
  >([]);
  const [groupCategories, setGroupCategories] = useState<
    Record<string, string>
  >({});
  const [onlySinceOpeningDate, setOnlySinceOpeningDate] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const isAndroid = platformBridge.getPlatform() === "android";
  const canReadNativeSms =
    isAndroid && Boolean(perms?.supportsDirectSms && perms?.readSms);

  const categoryIds = useMemo(
    () => new Set(ledger.categories.map((c) => c.id)),
    [ledger.categories],
  );
  const accountById = useMemo(
    () => new Map(ledger.accounts.map((a) => [a.id, a])),
    [ledger.accounts],
  );

  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    void platformBridge.getPermissionStatus().then((p) => {
      if (live) setPerms(p);
    });
    void loadLedgerModel().then((m) => live && setModelState(m));
    void learning
      .load(categoryIds)
      .then((data) => {
        if (!live) return;
        setLearningSettings(data.settings);
        setLearningExamples(data.examples);
        if (data.storedMap) {
          setCategoryMap((prev) => ({ ...prev, ...data.storedMap }));
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (view !== "link_form") return;
    if (canReadNativeSms || demo) {
      void refreshSenders();
    }
  }, [view, canReadNativeSms, demo]);

  async function refreshSenders() {
    setLoadingSenders(true);
    setError("");
    try {
      const list = await platformBridge.listSmsSenders(demo);
      setSenders(list);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingSenders(false);
    }
  }

  async function handleRequestPermissions() {
    setBusy(true);
    setError("");
    try {
      const next = await platformBridge.requestSmsPermissions();
      setPerms(next);
      if (next.readSms) {
        setStatusMsg("SMS permissions granted. You can now link bank senders.");
        await refreshSenders();
      } else {
        setError(
          "SMS permission was not granted. On Android 13+, sideloaded APKs require enabling 'Allow restricted settings' in App Info first.",
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function startNewLink(preselectedAccountId?: string) {
    setEditingLinkId(null);
    setAccountId(preselectedAccountId || ledger.accounts[0]?.id || "");
    setSelectedSenders([]);
    setCustomSender("");
    setBankTemplate("");
    setCardLast4("");
    setAutoAddMode("auto_high_confidence");
    setConfidencePct(60);
    setError("");
    setStatusMsg("");
    setView("link_form");
  }

  function startEditLink(link: SmsAccountLink) {
    setEditingLinkId(link.id);
    setAccountId(link.account_id);
    setSelectedSenders(link.senders);
    setCustomSender("");
    setBankTemplate(link.bank_template || "");
    setCardLast4(link.card_last4 || "");
    setAutoAddMode(link.auto_add_mode);
    setConfidencePct(Math.round((link.confidence_threshold ?? 0.6) * 100));
    setError("");
    setStatusMsg("");
    setView("link_form");
  }

  function toggleSender(senderObj: DiscoveredSmsSender) {
    const norm = senderObj.normalized;
    setSelectedSenders((prev) => {
      const exists = prev.includes(norm);
      const next = exists ? prev.filter((s) => s !== norm) : [...prev, norm];
      if (!exists && !bankTemplate && senderObj.detectedBank) {
        setBankTemplate(senderObj.detectedBank);
      }
      return next;
    });
  }

  function addCustomSender() {
    const norm = normalizeSender(customSender);
    if (!norm) return;
    if (!selectedSenders.includes(norm)) {
      setSelectedSenders((prev) => [...prev, norm]);
    }
    setCustomSender("");
  }

  const availableCardsForSelectedSenders = useMemo(() => {
    const set = new Set<string>();
    for (const s of senders) {
      if (selectedSenders.includes(s.normalized)) {
        for (const c of s.detectedCardLast4s) set.add(c);
      }
    }
    return [...set].sort();
  }, [senders, selectedSenders]);

  async function handleSaveLink(runBackfillAfter: boolean) {
    setError("");
    setStatusMsg("");
    try {
      const allSenders = [
        ...selectedSenders,
        ...(customSender.trim() ? [normalizeSender(customSender)] : []),
      ].filter(Boolean);
      const uniqueSenders = [...new Set(allSenders)];
      const existing = editingLinkId
        ? links.find((l) => l.id === editingLinkId)
        : undefined;
      const base = createDefaultSmsLink(
        accountId,
        uniqueSenders,
        bankTemplate || null,
        cardLast4 || null,
      );
      const draft: SmsAccountLink = {
        ...base,
        id: existing?.id ?? makeLinkId(),
        auto_add_mode: autoAddMode,
        confidence_threshold: Math.max(0.3, Math.min(0.99, confidencePct / 100)),
        enabled: existing?.enabled ?? true,
        last_synced_at: existing?.last_synced_at ?? 0,
        created_at: existing?.created_at ?? new Date().toISOString(),
      };
      validateSmsLink(draft, ledger.accounts, links);

      setBusy(true);
      const nextLinks = existing
        ? links.map((l) => (l.id === existing.id ? draft : l))
        : [...links, draft];
      await onLinksChange(nextLinks);

      if (runBackfillAfter && (canReadNativeSms || demo)) {
        await runHistoricalScan(draft, nextLinks);
      } else {
        setStatusMsg("SMS account link saved.");
        setView("overview");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function runHistoricalScan(
    targetLink: SmsAccountLink,
    activeLinks: SmsAccountLink[] = links,
  ) {
    setBackfillLink(targetLink);
    setView("backfill");
    setBackfillScanning(true);
    setBackfillSummary(null);
    setGroupCategories({});
    setError("");
    setStatusMsg("");

    try {
      const allMessages = [];
      let offset = 0;
      const pageSize = 500;
      while (true) {
        const page = await platformBridge.readHistoricalSms(targetLink.senders, {
          sinceTimestampMs: 0,
          limit: pageSize,
          offset,
          demoFallback: demo,
        });
        allMessages.push(...page.messages);
        if (!page.hasMore || page.messages.length === 0) break;
        offset += page.messages.length;
        if (offset >= 25000) break;
      }

      // Sort oldest -> newest for consistent duplicate checks & balance ordering.
      allMessages.sort((a, b) => a.timestampMs - b.timestampMs);

      const ctx: SmsEngineContext = {
        links: [targetLink, ...activeLinks.filter((l) => l.id !== targetLink.id)],
        accounts: ledger.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          opening_date: a.opening_date,
        })),
        categories: ledger.categories.map((c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
          emoji: c.emoji,
        })),
        rules: ledger.rules ?? [],
        learningSettings,
        learningExamples,
        categoryMap,
        baseModel: modelState.status === "ready" ? modelState.model : null,
        existingKeys: ledger.transactions.map(transactionKey),
      };

      const prepared = prepareEngineState(ctx);
      const decisions = allMessages
        .map((m) => processSingleSms(m, ctx, prepared))
        // Keep only messages routed to this exact target link (respecting card_last4!)
        .filter((d) => !d.linkId || d.linkId === targetLink.id);

      const summary = groupBackfillForReview(decisions);
      const defaults: Record<string, string> = {};
      for (const g of summary.merchantGroups) {
        if (g.suggestedCategoryId) defaults[g.key] = g.suggestedCategoryId;
      }

      setBackfillAllDecisions(decisions);
      setBackfillSummary(summary);
      setGroupCategories(defaults);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBackfillScanning(false);
    }
  }

  async function handleCommitBackfill() {
    if (!backfillLink || !backfillSummary) return;
    const account = accountById.get(backfillLink.account_id);
    const minDate = onlySinceOpeningDate ? account?.opening_date : undefined;

    const toImport: { decision: SmsDecision; tx: ImportTransaction }[] = [];

    for (const d of backfillSummary.readyToImport) {
      if (!d.transaction) continue;
      if (minDate && d.transaction.date < minDate) continue;
      toImport.push({ decision: d, tx: d.transaction });
    }

    const newLearningRows: LearningExample[] = [];
    for (const g of backfillSummary.merchantGroups) {
      const chosenCatId = groupCategories[g.key] || null;
      for (const d of g.decisions) {
        if (!d.transaction) continue;
        if (minDate && d.transaction.date < minDate) continue;
        const tx: ImportTransaction = {
          ...d.transaction,
          category_id: d.transaction.type === "expense" ? chosenCatId : null,
        };
        toImport.push({ decision: d, tx });
        if (
          learningSettings?.learn_consent &&
          tx.type === "expense" &&
          chosenCatId
        ) {
          const ex = makeExample({
            merchant: d.merchantClean ?? tx.payee,
            payee: tx.payee,
            amount: tx.amount,
            category_id: chosenCatId,
            suggested_category_id: g.suggestedCategoryId,
            source: "sms",
            model_version:
              modelState.status === "ready"
                ? modelState.model.meta.version
                : "rules",
          });
          if (ex) newLearningRows.push(ex);
        }
      }
    }

    if (!toImport.length) {
      setError("No new transactions to import for the selected range.");
      return;
    }

    setBusy(true);
    setError("");
    setImportProgress({ done: 0, total: toImport.length });
    try {
      await onImportTransactions(
        toImport.map((item) => item.tx),
        (done) => setImportProgress({ done, total: toImport.length }),
        "SMS backfill:",
      );

      if (newLearningRows.length) {
        await learning.addExamples(newLearningRows).catch(() => {});
      }

      // Mark all scanned SMS hashes as processed on-device and advance watermark so future background runs only process NEW SMSes.
      const newestTs = backfillAllDecisions.reduce(
        (max, d) => Math.max(max, d.timestampMs || 0),
        Date.now(),
      );
      await platformBridge.markHashesProcessed(
        backfillAllDecisions.map((d) => ({
          smsHash: d.smsHash,
          androidSmsId: d.androidSmsId,
          accountId: backfillLink.account_id,
          status:
            d.action === "skip" || d.duplicate ? "skipped" : "imported",
        })),
      );

      const updatedLinks = links.map((l) =>
        l.id === backfillLink.id ? { ...l, last_synced_at: newestTs } : l,
      );
      await onLinksChange(updatedLinks);

      setStatusMsg(
        `Imported ${toImport.length} transactions from ${backfillLink.senders.join(", ")}. Future SMS messages will now be captured automatically.`,
      );
      setImportProgress(null);
      setView("overview");
    } catch (e) {
      setError(errorMessage(e));
      setImportProgress(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleLink(link: SmsAccountLink) {
    setBusy(true);
    try {
      await onLinksChange(
        links.map((l) =>
          l.id === link.id ? { ...l, enabled: !l.enabled } : l,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteLink(linkId: string) {
    setBusy(true);
    try {
      await onLinksChange(links.filter((l) => l.id !== linkId));
      setStatusMsg("SMS sender link removed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCatchUpNow() {
    setBusy(true);
    setError("");
    try {
      const enqueued = await platformBridge.triggerCatchUpSync();
      setStatusMsg(
        enqueued
          ? "Background SMS catch-up scan started."
          : "Background catch-up sync runs on the Android app.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const backfillAccount = backfillLink
    ? accountById.get(backfillLink.account_id)
    : null;

  return (
    <dialog
      ref={dialog}
      className="modal csv-modal sms-modal sms-auto-modal"
      aria-labelledby="sms-auto-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">{uiText("NATIVE SMS AUTOMATION")}</span>
          <h2 id="sms-auto-title">
            {view === "overview" && uiText("SMS Auto-Capture")}
            {view === "link_form" &&
              (editingLinkId
                ? uiText("Edit SMS Account Link")
                : uiText("Link Account to SMS Sender"))}
            {view === "backfill" && uiText("Scan Historical SMS")}
          </h2>
        </div>
        <button
          className="icon-button"
          disabled={busy}
          onClick={onClose}
          aria-label={uiText("Close SMS Auto-Capture")}
        >
          <X size={18} />
        </button>
      </div>

      <div className="csv-body">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {statusMsg && (
          <p role="status" className="notice">
            {statusMsg}
          </p>
        )}

        {view === "overview" && (
          <>
            <div className="sms-privacy-banner">
              <ShieldCheck size={18} />
              <div>
                <strong>{uiText("On-device privacy first")}</strong>
                <p className="muted small">
                  {uiText(
                    "Raw bank SMS messages are parsed and categorized strictly on your phone. High-confidence transactions are added straight to PocketBase; low-confidence items sync masked previews so you can confirm them on mobile or web.",
                  )}
                </p>
              </div>
            </div>

            {isAndroid && perms && !perms.supportsDirectSms && (
              <div className="sms-info-card">
                <Smartphone size={18} />
                <div>
                  <strong>{uiText("Play Store flavor installed")}</strong>
                  <p className="muted small">
                    {uiText(
                      "Direct SMS inbox access is available in the direct-install Android APK flavor. You can still review captured alerts and import SMS Backup XML files.",
                    )}
                  </p>
                </div>
              </div>
            )}

            {isAndroid && perms?.supportsDirectSms && !perms.readSms && (
              <div className="sms-permission-card">
                <div>
                  <strong>{uiText("Grant Android SMS & Notification Access")}</strong>
                  <p className="muted small">
                    {uiText(
                      "Allow Fuloos to read bank senders for one-time historical import and listen for incoming alerts in the background.",
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void handleRequestPermissions()}
                >
                  {uiText("Enable SMS Access")}
                </button>
              </div>
            )}

            {!isAndroid && (
              <div className="sms-info-card">
                <Smartphone size={18} />
                <div>
                  <strong>
                    {demo
                      ? uiText("Interactive Demo Preview")
                      : uiText("Android App Feature")}
                  </strong>
                  <p className="muted small">
                    {demo
                      ? uiText(
                          "Try linking an account to sample UAE bank senders (ADCB with card routing, or Liv) and run the merchant-grouped backfill wizard right here.",
                        )
                      : uiText(
                          "Install the Fuloos Android APK to link bank SMS senders and automatically import transactions in the background. Low-confidence SMS drafts synced from your phone appear in Captured Alerts on desktop web.",
                        )}
                  </p>
                </div>
              </div>
            )}

            <div className="sms-section-head">
              <h3>
                {uiText("Linked accounts")} ({links.length})
              </h3>
              <div className="sms-section-actions">
                {isAndroid && links.length > 0 && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void handleCatchUpNow()}
                  >
                    <RefreshCw size={14} /> {uiText("Scan missed SMS")}
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !ledger.accounts.length}
                  onClick={() => startNewLink()}
                >
                  <Plus size={15} /> {uiText("Link account")}
                </button>
              </div>
            </div>

            {!links.length ? (
              <div className="sms-empty-box">
                <MessageSquareText size={24} />
                <p>
                  {uiText(
                    "No accounts linked to SMS senders yet. Link a bank account or credit card to backfill past SMS transactions and auto-track new ones.",
                  )}
                </p>
              </div>
            ) : (
              <div className="sms-link-list">
                {links.map((link) => {
                  const acc = accountById.get(link.account_id);
                  return (
                    <div
                      key={link.id}
                      className={`sms-link-card ${link.enabled ? "" : "is-paused"}`}
                    >
                      <div className="sms-link-main">
                        <div className="sms-link-title-row">
                          <strong>{acc?.name ?? uiText("Deleted account")}</strong>
                          {link.card_last4 && (
                            <span className="sms-pill">
                              <CreditCard size={12} /> ••{link.card_last4}
                            </span>
                          )}
                          <span className="sms-pill is-soft">
                            {link.auto_add_mode === "auto_high_confidence"
                              ? `Auto ≥${Math.round(link.confidence_threshold * 100)}%`
                              : uiText("Always review")}
                          </span>
                        </div>
                        <div className="small muted">
                          <Link2 size={12} style={{ verticalAlign: "-2px" }} />{" "}
                          {link.senders.join(", ")}
                          {link.bank_template ? ` · ${link.bank_template}` : ""}
                          {link.last_synced_at > 0
                            ? ` · Synced ${new Date(link.last_synced_at).toLocaleDateString()}`
                            : " · Not backfilled yet"}
                        </div>
                      </div>
                      <div className="sms-link-actions">
                        {(canReadNativeSms || demo) && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => void runHistoricalScan(link)}
                            title={uiText("Scan all historical SMS from this sender")}
                          >
                            <History size={14} /> {uiText("Backfill")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => void handleToggleLink(link)}
                        >
                          {link.enabled ? uiText("Pause") : uiText("Resume")}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => startEditLink(link)}
                        >
                          {uiText("Edit")}
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          disabled={busy}
                          aria-label={uiText("Remove SMS link")}
                          onClick={() => void handleDeleteLink(link.id)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="sms-android-settings">
              <h4>{uiText("Android ecosystem & review settings")}</h4>
              <div className="sms-settings-buttons">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    onClose();
                    onOpenCaptureAlerts();
                  }}
                >
                  <MessageSquareText size={15} /> {uiText("Open Review Queue")}
                </button>
                {isAndroid && (
                  <>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void platformBridge.openNotificationSettings(
                          "fuloos_tx_review",
                        )
                      }
                    >
                      <Bell size={15} /> {uiText("Review Alert Channel")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void platformBridge.openNotificationSettings(
                          "fuloos_tx_auto",
                        )
                      }
                    >
                      <Bell size={15} /> {uiText("Auto-Added Channel")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void platformBridge.openBatteryOptimizationSettings()
                      }
                    >
                      <BatteryCharging size={15} />{" "}
                      {perms?.ignoringBatteryOptimizations
                        ? uiText("Background unrestricted")
                        : uiText("Allow background SMS")}
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {view === "link_form" && (
          <div className="sms-form">
            <label>
              {uiText("Fuloos account")}
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {ledger.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.emoji ? `${a.emoji} ` : ""}
                    {a.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="sms-sender-picker">
              <div className="sms-section-head">
                <strong>{uiText("Select SMS sender(s)")}</strong>
                {(canReadNativeSms || demo) && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={loadingSenders}
                    onClick={() => void refreshSenders()}
                  >
                    <RefreshCw size={13} />{" "}
                    {loadingSenders ? uiText("Scanning…") : uiText("Refresh")}
                  </button>
                )}
              </div>

              {senders.length > 0 && (
                <div className="sms-discovered-list">
                  {senders.map((s) => {
                    const checked = selectedSenders.includes(s.normalized);
                    return (
                      <button
                        key={s.normalized}
                        type="button"
                        className={`sms-sender-option ${checked ? "is-selected" : ""}`}
                        onClick={() => toggleSender(s)}
                      >
                        <div className="sms-sender-option-top">
                          <strong>{s.address}</strong>
                          <span className="small muted">
                            {s.detectedBank ? `${s.detectedBank} · ` : ""}
                            {s.messageCount} SMS
                          </span>
                        </div>
                        <small className="muted sms-sample-line">
                          {s.sampleMasked}
                        </small>
                        {s.detectedCardLast4s.length > 0 && (
                          <div className="sms-card-tags">
                            {s.detectedCardLast4s.map((c) => (
                              <span key={c} className="sms-pill is-soft">
                                Card ••{c}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="sms-custom-sender-row">
                <input
                  type="text"
                  value={customSender}
                  placeholder={uiText("Or type a sender ID (e.g. ADCB, LIV, ENBD)")}
                  onChange={(e) => setCustomSender(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustomSender();
                    }
                  }}
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={addCustomSender}
                >
                  {uiText("Add")}
                </button>
              </div>

              {selectedSenders.length > 0 && (
                <div className="sms-quick-chips">
                  {selectedSenders.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="sms-chip is-active"
                      onClick={() =>
                        setSelectedSenders((prev) => prev.filter((x) => x !== s))
                      }
                    >
                      {s} ×
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="csv-grid">
              <label>
                {uiText("Card routing (optional last 4 digits)")}
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={cardLast4}
                  placeholder={uiText("All cards / leave empty")}
                  onChange={(e) =>
                    setCardLast4(e.target.value.replace(/\D/g, "").slice(0, 4))
                  }
                />
                <span className="muted small">
                  {uiText(
                    "Split debit vs credit card alerts from the same bank sender.",
                  )}
                </span>
                {availableCardsForSelectedSenders.length > 0 && (
                  <div className="sms-quick-chips">
                    <button
                      type="button"
                      className={`sms-chip ${!cardLast4 ? "is-active" : ""}`}
                      onClick={() => setCardLast4("")}
                    >
                      {uiText("All cards")}
                    </button>
                    {availableCardsForSelectedSenders.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`sms-chip ${cardLast4 === c ? "is-active" : ""}`}
                        onClick={() => setCardLast4(c)}
                      >
                        ••{c}
                      </button>
                    ))}
                  </div>
                )}
              </label>

              <label>
                {uiText("Bank SMS template")}
                <select
                  value={bankTemplate}
                  onChange={(e) => setBankTemplate(e.target.value)}
                >
                  <option value="">{uiText("Auto-detect from sender/text")}</option>
                  {SUPPORTED_BANKS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                {uiText("When a new SMS arrives")}
                <select
                  value={autoAddMode}
                  onChange={(e) =>
                    setAutoAddMode(e.target.value as SmsAutoAddMode)
                  }
                >
                  <option value="auto_high_confidence">
                    {uiText("Auto-add high confidence, ask when unsure")}
                  </option>
                  <option value="always_review">
                    {uiText("Always ask me before adding")}
                  </option>
                </select>
              </label>

              {autoAddMode === "auto_high_confidence" && (
                <label>
                  {uiText("Auto-add confidence threshold")}: {confidencePct}%
                  <input
                    type="range"
                    min={40}
                    max={90}
                    step={5}
                    value={confidencePct}
                    onChange={(e) => setConfidencePct(Number(e.target.value))}
                  />
                  <span className="muted small">
                    {uiText(
                      "Below this confidence, Fuloos sends a quick-categorize notification and syncs a draft to PocketBase.",
                    )}
                  </span>
                </label>
              )}
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setView("overview")}
              >
                {uiText("Back")}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void handleSaveLink(false)}
              >
                {uiText("Save link only")}
              </button>
              {(canReadNativeSms || demo) && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void handleSaveLink(true)}
                >
                  <History size={15} /> {uiText("Save & Scan History")}
                </button>
              )}
            </div>
          </div>
        )}

        {view === "backfill" && backfillLink && (
          <div className="sms-backfill">
            {backfillScanning ? (
              <div className="sms-empty-box">
                <RefreshCw size={24} className="sms-spin" />
                <p>
                  {uiText("Scanning SMS history for")}{" "}
                  <strong>{backfillLink.senders.join(", ")}</strong>…
                </p>
              </div>
            ) : backfillSummary ? (
              <>
                <div className="sms-backfill-stats">
                  <div className="sms-stat-tile">
                    <span>{uiText("Scanned")}</span>
                    <strong>{backfillSummary.totalScanned}</strong>
                  </div>
                  <div className="sms-stat-tile is-good">
                    <span>{uiText("Auto-categorised")}</span>
                    <strong>{backfillSummary.readyToImport.length}</strong>
                  </div>
                  <div className="sms-stat-tile is-warn">
                    <span>{uiText("Needs category")}</span>
                    <strong>
                      {backfillSummary.lowConfidenceItems.length}
                      {backfillSummary.merchantGroups.length > 0
                        ? ` (${backfillSummary.merchantGroups.length} merchants)`
                        : ""}
                    </strong>
                  </div>
                  <div className="sms-stat-tile">
                    <span>{uiText("Skipped / Dupes")}</span>
                    <strong>
                      {backfillSummary.skippedCount +
                        backfillSummary.duplicateCount}
                    </strong>
                  </div>
                </div>

                {backfillAccount && backfillSummary.oldestDate && (
                  <div className="sms-opening-box">
                    <label className="sms-checkbox-row">
                      <input
                        type="checkbox"
                        checked={onlySinceOpeningDate}
                        onChange={(e) =>
                          setOnlySinceOpeningDate(e.target.checked)
                        }
                      />
                      <span>
                        {uiText("Only import transactions on/after")}{" "}
                        <strong>{backfillAccount.name}</strong>{" "}
                        {uiText("opening date")} ({backfillAccount.opening_date})
                      </span>
                    </label>
                    {backfillSummary.latestBalanceAfter != null && (
                      <small className="muted">
                        {uiText("Latest SMS reported balance:")}{" "}
                        <strong>
                          {money(backfillSummary.latestBalanceAfter)}
                        </strong>
                        {backfillSummary.oldestDate && backfillSummary.newestDate
                          ? ` · Range: ${backfillSummary.oldestDate} to ${backfillSummary.newestDate}`
                          : ""}
                      </small>
                    )}
                  </div>
                )}

                {backfillSummary.merchantGroups.length > 0 && (
                  <div className="sms-merchant-review">
                    <h4>
                      {uiText(
                        "Categorise unfamiliar merchants once (applies to every matching SMS)",
                      )}
                    </h4>
                    <div className="sms-merchant-list">
                      {backfillSummary.merchantGroups.map((g) => {
                        const selectedCat = groupCategories[g.key] ?? "";
                        return (
                          <div key={g.key} className="sms-merchant-card">
                            <div className="sms-merchant-head">
                              <div>
                                <strong>{g.merchantDisplay}</strong>
                                <small className="muted">
                                  {g.count}{" "}
                                  {g.count === 1 ? "SMS" : "SMSes"} ·{" "}
                                  {money(-g.totalFils)} · Latest {g.sampleDate}
                                </small>
                              </div>
                              <select
                                value={selectedCat}
                                onChange={(e) =>
                                  setGroupCategories((prev) => ({
                                    ...prev,
                                    [g.key]: e.target.value,
                                  }))
                                }
                              >
                                <option value="">
                                  {uiText("Leave uncategorised")}
                                </option>
                                {ledger.categories.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.emoji ? `${c.emoji} ` : ""}
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {g.topSuggestions.length > 0 && (
                              <div className="sms-quick-chips">
                                {g.topSuggestions.map((s) => (
                                  <button
                                    key={s.category_id}
                                    type="button"
                                    className={`sms-chip ${selectedCat === s.category_id ? "is-active" : ""}`}
                                    onClick={() =>
                                      setGroupCategories((prev) => ({
                                        ...prev,
                                        [g.key]: s.category_id,
                                      }))
                                    }
                                  >
                                    {s.name} ({Math.round(s.confidence * 100)}%)
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {importProgress && (
                  <p className="notice">
                    {uiText("Importing transactions…")} {importProgress.done} /{" "}
                    {importProgress.total}
                  </p>
                )}

                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => setView("overview")}
                  >
                    {uiText("Back")}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      busy ||
                      backfillSummary.readyToImport.length +
                        backfillSummary.lowConfidenceItems.length ===
                        0
                    }
                    onClick={() => void handleCommitBackfill()}
                  >
                    <Check size={15} />{" "}
                    {uiText("Import")}{" "}
                    {backfillSummary.readyToImport.length +
                      backfillSummary.lowConfidenceItems.length}{" "}
                    {uiText("transactions")}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </dialog>
  );
}
