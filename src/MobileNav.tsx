import { useState } from "react";
import {
  BarChart3,
  Inbox,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  PiggyBank,
  ReceiptText,
  Repeat,
  Settings as SettingsIcon,
  Tags,
  Target,
  Wallet,
  Wand2,
  X,
} from "lucide-react";
import { backend, type Session } from "./client";
import { emptyLedger, type Ledger } from "./domain";
import { useLocale, type TranslationKey } from "./i18n";

const PRIMARY_TABS = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Transactions", icon: ReceiptText },
  { name: "Budgets", icon: PiggyBank },
  { name: "Accounts", icon: Wallet },
] as const;

const MORE_PAGES = [
  { name: "Recurring", icon: Repeat },
  { name: "Goals", icon: Target },
  { name: "Net Worth", icon: Landmark },
  { name: "Reports", icon: BarChart3 },
  { name: "Categories", icon: Tags },
] as const;

const MORE_PAGE_SET = new Set<string>(MORE_PAGES.map((p) => p.name));

export function MobileNav({
  page,
  demo,
  session,
  pendingAlertCount,
  linkedSmsCount,
  onNavigate,
  onOpenSettings,
  onOpenRules,
  onOpenCaptureAlerts,
  onOpenSmsAutoCapture,
  onSignOutDemo,
}: {
  page: string;
  demo: boolean;
  session: Session | null;
  pendingAlertCount: number;
  linkedSmsCount: number;
  onNavigate: (page: string) => void;
  onOpenSettings: () => void;
  onOpenRules: () => void;
  onOpenCaptureAlerts: () => void;
  onOpenSmsAutoCapture: () => void;
  onSignOutDemo: (empty: Ledger) => void;
}) {
  const { t } = useLocale();
  const [moreOpen, setMoreOpen] = useState(false);

  const isMoreActive = MORE_PAGE_SET.has(page);

  function go(next: string) {
    setMoreOpen(false);
    onNavigate(next);
  }

  return (
    <>
      <nav className="mobile-bottom-nav" aria-label={t("workspace.label")}>
        {PRIMARY_TABS.map(({ name, icon: Icon }) => {
          const active = page === name;
          return (
            <button
              key={name}
              type="button"
              className={`mobile-nav-btn ${active ? "is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => go(name)}
            >
              <span className="mobile-nav-icon-wrap">
                <Icon size={20} />
                {name === "Transactions" && pendingAlertCount > 0 && (
                  <span className="mobile-nav-badge" aria-label={`${pendingAlertCount} pending`}>
                    {pendingAlertCount > 9 ? "9+" : pendingAlertCount}
                  </span>
                )}
              </span>
              <span>{t(`nav.${name}` as TranslationKey)}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`mobile-nav-btn ${isMoreActive || moreOpen ? "is-active" : ""}`}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        >
          <span className="mobile-nav-icon-wrap">
            <Menu size={20} />
            {pendingAlertCount > 0 && (
              <span className="mobile-nav-dot" aria-hidden />
            )}
          </span>
          <span>More</span>
        </button>
      </nav>

      {moreOpen && (
        <div
          className="mobile-sheet-backdrop"
          role="presentation"
          onClick={() => setMoreOpen(false)}
        >
          <div
            className="mobile-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More workspace sections"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mobile-sheet-handle" aria-hidden />
            <div className="mobile-sheet-head">
              <div>
                <span className="eyebrow">{t("workspace.label")}</span>
                <h3>
                  {demo
                    ? t("workspace.demo")
                    : session?.user.email?.split("@")[0] || t("brand.name")}
                </h3>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={t("common.close")}
                onClick={() => setMoreOpen(false)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="mobile-sheet-grid">
              {MORE_PAGES.map(({ name, icon: Icon }) => (
                <button
                  key={name}
                  type="button"
                  className={`mobile-sheet-tile ${page === name ? "is-active" : ""}`}
                  onClick={() => go(name)}
                >
                  <Icon size={19} />
                  <span>{t(`nav.${name}` as TranslationKey)}</span>
                </button>
              ))}
            </div>

            <div className="mobile-sheet-list">
              <button
                type="button"
                className="mobile-sheet-row"
                onClick={() => {
                  setMoreOpen(false);
                  onOpenSmsAutoCapture();
                }}
              >
                <MessageSquareText size={18} />
                <span>SMS Auto-Capture</span>
                <small className="muted">
                  {linkedSmsCount > 0 ? `${linkedSmsCount} linked` : "Set up"}
                </small>
              </button>

              <button
                type="button"
                className="mobile-sheet-row"
                onClick={() => {
                  setMoreOpen(false);
                  onOpenCaptureAlerts();
                }}
              >
                <Inbox size={18} />
                <span>{t("settings.capturedAlerts")}</span>
                {pendingAlertCount > 0 && (
                  <span className="mobile-sheet-pill">{pendingAlertCount}</span>
                )}
              </button>

              <button
                type="button"
                className="mobile-sheet-row"
                onClick={() => {
                  setMoreOpen(false);
                  onOpenRules();
                }}
              >
                <Wand2 size={18} />
                <span>{t("common.manageRules")}</span>
              </button>

              <button
                type="button"
                className="mobile-sheet-row"
                onClick={() => {
                  setMoreOpen(false);
                  onOpenSettings();
                }}
              >
                <SettingsIcon size={18} />
                <span>{t("common.settings")}</span>
              </button>

              <button
                type="button"
                className="mobile-sheet-row is-danger"
                onClick={() => {
                  setMoreOpen(false);
                  if (demo) {
                    onSignOutDemo(emptyLedger);
                  } else {
                    backend?.signOut();
                  }
                }}
              >
                <LogOut size={18} />
                <span>{t("common.signOut")}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
