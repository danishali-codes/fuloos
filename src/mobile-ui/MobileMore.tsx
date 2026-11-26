import {
  BarChart3,
  ChevronRight,
  Fingerprint,
  Globe,
  Landmark,
  LogOut,
  MessageSquareText,
  Moon,
  PiggyBank,
  Repeat,
  Settings as SettingsIcon,
  Sun,
  Tags,
  Target,
  Upload,
  Wand2,
} from "lucide-react";
import type { AppLockConfig } from "../appLock";
import type { Session } from "../client";
import {
  money,
  reportingCurrency,
  type Ledger,
} from "../domain";
import { translateText as uiText, useLocale } from "../i18n";
import type { SmsAccountLink } from "../mobile/smsLinks";
import { useThemeMode } from "./useThemeMode";

export function MobileMore({
  ledger,
  session,
  demo,
  online,
  hidden,
  lockConfig,
  pendingAlertCount,
  estimatedCount = 0,
  smsLinks,
  onNavigate,
  onOpenSmsAutoCapture,
  onOpenCaptureAlerts,
  onOpenConfirmAmounts,
  onOpenRules,
  onOpenImport,
  onOpenSettings,
  onSignOut,
}: {
  ledger: Ledger;
  session: Session | null;
  demo: boolean;
  online: boolean;
  hidden: boolean;
  lockConfig: AppLockConfig | null;
  pendingAlertCount: number;
  estimatedCount?: number;
  smsLinks: SmsAccountLink[];
  onNavigate: (page: string) => void;
  onOpenSmsAutoCapture: () => void;
  onOpenCaptureAlerts: () => void;
  onOpenConfirmAmounts?: (txId?: string) => void;
  onOpenRules: () => void;
  onOpenImport: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const { locale, toggleLocale } = useLocale();
  const { theme, toggleTheme } = useThemeMode();
  const repCurr = reportingCurrency(ledger);

  const email = demo ? uiText("Demo workspace") : session?.user.email ?? "Fuloos";
  const displayName = demo
    ? uiText("Demo Account")
    : (session?.user.email?.split("@")[0] ?? "Fuloos")
        .replace(/[._-]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase() || "FL";

  const activeSmsLinks = smsLinks.filter((l) => l.enabled);
  const linkedBanks = [
    ...new Set(activeSmsLinks.flatMap((l) => l.senders.slice(0, 1))),
  ].slice(0, 2);

  const budgetsCount = (ledger.budgets ?? []).length;
  const recurringCount = (ledger.recurring ?? []).filter(
    (r) => r.status === "active",
  ).length;
  const goalsSaved = (ledger.goals ?? []).reduce(
    (s, g) => s + g.current_amount,
    0,
  );
  const nwItemsCount = (ledger.net_worth_items ?? []).length;

  const tools = [
    {
      page: "Budgets",
      label: uiText("Budgets"),
      sub:
        budgetsCount > 0
          ? `${budgetsCount} ${uiText("active")}`
          : uiText("Set limits"),
      icon: PiggyBank,
    },
    {
      page: "Recurring",
      label: uiText("Recurring"),
      sub:
        recurringCount > 0
          ? `${recurringCount} ${uiText("active")}`
          : uiText("Bills & income"),
      icon: Repeat,
    },
    {
      page: "Goals",
      label: uiText("Goals"),
      sub:
        goalsSaved > 0
          ? hidden
            ? "••••"
            : money(goalsSaved, repCurr)
          : uiText("Savings"),
      icon: Target,
    },
    {
      page: "Net Worth",
      label: uiText("Net Worth"),
      sub:
        nwItemsCount > 0
          ? `${nwItemsCount} ${uiText("items")}`
          : uiText("Assets & debt"),
      icon: Landmark,
    },
    {
      page: "Reports",
      label: uiText("Reports"),
      sub: uiText("Insights"),
      icon: BarChart3,
    },
    {
      page: "Categories",
      label: uiText("Categories"),
      sub: `${ledger.categories.length} ${uiText("items")}`,
      icon: Tags,
    },
  ];

  return (
    <div className="m-page">
      {/* Profile Header Card */}
      <div className="m-card m-profile-card">
        <div className="m-profile-avatar">{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 800,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {displayName}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--m-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {email}
          </div>
        </div>
        <span
          className="m-mini-tag"
          style={
            demo
              ? undefined
              : online
                ? { background: "var(--m-inc-bg)", color: "var(--m-inc)" }
                : { background: "var(--m-exp-bg)", color: "var(--m-exp)" }
          }
        >
          {demo ? uiText("Demo") : online ? uiText("Online") : uiText("Offline")}
        </span>
      </div>

      {/* Featured Android SMS Auto-Capture Hero Card */}
      <section className="m-sms-hero" aria-label="SMS Auto-Capture">
        <div className="m-sms-hero-head">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 13,
                background: "rgba(255,255,255,0.16)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <MessageSquareText size={18} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>
                {uiText("SMS Auto-Capture")}
              </div>
              <div style={{ fontSize: 11.5, opacity: 0.85 }}>
                {activeSmsLinks.length > 0
                  ? `${activeSmsLinks.length} ${uiText("linked")}${linkedBanks.length ? ` · ${linkedBanks.join(", ")}` : ""}`
                  : uiText("On-device UAE bank SMS parser")}
              </div>
            </div>
          </div>
          <span
            style={{
              padding: "3px 9px",
              borderRadius: 999,
              fontSize: 10.5,
              fontWeight: 800,
              background: "rgba(163, 240, 190, 0.22)",
              color: "#d7fce4",
            }}
          >
            {activeSmsLinks.length > 0 ? uiText("Active") : uiText("Set up")}
          </span>
        </div>

        <div className="m-sms-hero-actions">
          <button
            type="button"
            className="is-white"
            onClick={onOpenCaptureAlerts}
          >
            {uiText("Review Queue")}
            {pendingAlertCount > 0 ? ` (${pendingAlertCount})` : ""}
          </button>
          <button
            type="button"
            className="is-glass"
            onClick={onOpenSmsAutoCapture}
          >
            {uiText("SMS & Backfill")}
          </button>
        </div>
      </section>

      {/* Secondary Workspaces 3x2 Grid */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="m-section-head">
          <span className="m-section-title">{uiText("Tools & Planning")}</span>
        </div>
        <div className="m-tools-grid">
          {tools.map(({ page, label, sub, icon: Icon }) => (
            <button
              key={page}
              type="button"
              className="m-tool-tile"
              onClick={() => onNavigate(page)}
            >
              <div className="m-tool-icon">
                <Icon size={18} />
              </div>
              <div className="m-tool-name">{label}</div>
              <div className="m-tool-sub m-num">{sub}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Preferences & Actions List */}
      <div className="m-card m-pref-list">
        <button type="button" className="m-pref-row" onClick={toggleTheme}>
          <span className="m-pref-left">
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            <span>{uiText("Dark Appearance")}</span>
          </span>
          <span className={`m-switch ${theme === "dark" ? "is-on" : ""}`}>
            <span className="m-switch-knob" />
          </span>
        </button>

        <button type="button" className="m-pref-row" onClick={toggleLocale}>
          <span className="m-pref-left">
            <Globe size={17} />
            <span>{uiText("Language")}</span>
          </span>
          <span style={{ color: "var(--m-brand)", fontWeight: 800 }}>
            {locale === "ar" ? "العربية (RTL)" : "English"}
          </span>
        </button>

        <button type="button" className="m-pref-row" onClick={onOpenSettings}>
          <span className="m-pref-left">
            <Fingerprint size={17} />
            <span>{uiText("App Lock & Security")}</span>
          </span>
          <span style={{ color: "var(--m-muted)", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 4 }}>
            {lockConfig ? uiText("On") : uiText("Off")}
            <ChevronRight size={15} className="rtl-flip" />
          </span>
        </button>

        <button type="button" className="m-pref-row" onClick={onOpenRules}>
          <span className="m-pref-left">
            <Wand2 size={17} />
            <span>{uiText("Auto-Categorisation Rules")}</span>
          </span>
          <ChevronRight size={15} style={{ color: "var(--m-muted)" }} className="rtl-flip" />
        </button>

        <button type="button" className="m-pref-row" onClick={onOpenImport}>
          <span className="m-pref-left">
            <Upload size={17} />
            <span>{uiText("Import CSV Statement")}</span>
          </span>
          <ChevronRight size={15} style={{ color: "var(--m-muted)" }} className="rtl-flip" />
        </button>

        {onOpenConfirmAmounts && (
          <button
            type="button"
            className="m-pref-row"
            onClick={() => onOpenConfirmAmounts()}
          >
            <span className="m-pref-left">
              <Globe size={17} />
              <span>{uiText("Confirm amounts")}</span>
            </span>
            <span style={{ color: estimatedCount > 0 ? "var(--m-brand)" : "var(--m-muted)", fontWeight: 700, fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 4 }}>
              {estimatedCount > 0 ? `${estimatedCount} pending` : uiText("All confirmed")}
              <ChevronRight size={15} className="rtl-flip" />
            </span>
          </button>
        )}

        <button type="button" className="m-pref-row" onClick={onOpenSettings}>
          <span className="m-pref-left">
            <SettingsIcon size={17} />
            <span>{uiText("Settings, Backup & Household")}</span>
          </span>
          <ChevronRight size={15} style={{ color: "var(--m-muted)" }} className="rtl-flip" />
        </button>

        <button
          type="button"
          className="m-pref-row is-danger"
          onClick={onSignOut}
        >
          <span className="m-pref-left">
            <LogOut size={17} />
            <span>{uiText("Sign Out")}</span>
          </span>
        </button>
      </div>
    </div>
  );
}
