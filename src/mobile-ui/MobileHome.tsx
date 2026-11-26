import {
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  MessageSquareText,
  WifiOff,
} from "lucide-react";
import { budgetReport } from "../budgets";
import type { Session } from "../client";
import {
  money,
  shiftMonth,
  type Ledger,
  type Transaction,
} from "../domain";
import { translateText as uiText } from "../i18n";
import { formatMonthShort, MobileTxCard } from "./MobileTxRow";

function timeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return uiText("Good morning");
  if (hour < 17) return uiText("Good afternoon");
  return uiText("Good evening");
}

function userDisplayName(demo: boolean, session: Session | null): {
  name: string;
  initials: string;
} {
  if (demo) return { name: uiText("Demo"), initials: "DM" };
  const raw = session?.user.email?.split("@")[0] ?? "Fuloos";
  const clean = raw.replace(/[._-]+/g, " ").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  const name = parts[0]
    ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
    : "Fuloos";
  const initials =
    parts.length >= 2
      ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
      : name.slice(0, 2).toUpperCase();
  return { name, initials };
}

export function MobileHome({
  ledger,
  session,
  demo,
  online,
  month,
  net,
  summary,
  monthly,
  hidden,
  pendingAlertCount,
  pendingAlertPreview,
  error,
  onToggleHidden,
  onChangeMonth,
  onOpenFilteredActivity,
  onOpenActivity,
  onOpenBudgets,
  onOpenMore,
  onOpenCaptureAlerts,
  onSelectTransaction,
  onExitDemo,
  onRetry,
}: {
  ledger: Ledger;
  session: Session | null;
  demo: boolean;
  online: boolean;
  month: string;
  net: number;
  summary: { income: number; expense: number };
  monthly: Transaction[];
  hidden: boolean;
  pendingAlertCount: number;
  pendingAlertPreview: string;
  error: string;
  onToggleHidden: () => void;
  onChangeMonth: (nextMonth: string) => void;
  onOpenFilteredActivity: (kind: "income" | "expense") => void;
  onOpenActivity: () => void;
  onOpenBudgets: () => void;
  onOpenMore: () => void;
  onOpenCaptureAlerts: () => void;
  onSelectTransaction: (tx: Transaction) => void;
  onExitDemo: () => void;
  onRetry: () => void;
}) {
  const { name, initials } = userDisplayName(demo, session);
  const accountsById = new Map(ledger.accounts.map((a) => [a.id, a]));
  const categoriesById = new Map(ledger.categories.map((c) => [c.id, c]));

  const incomeCount = monthly.filter((t) => t.type === "income").length;
  const expenseCount = monthly.filter((t) => t.type === "expense").length;

  const budgets = budgetReport(ledger, month, month);
  const hasBudgets = budgets.totalBudget > 0;
  const budgetPct = hasBudgets
    ? Math.round((budgets.totalActual / budgets.totalBudget) * 100)
    : 0;

  const recentTx = [...monthly]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6);

  const fmt = (fils: number) => (hidden ? "••••••" : money(fils));
  const netDelta = summary.income - summary.expense;
  const netDeltaSign = netDelta >= 0 ? "+" : "−";

  return (
    <div className="m-page">
      {/* Compact Native Top Bar */}
      <div className="m-topbar">
        <button
          type="button"
          className="m-user-chip"
          onClick={onOpenMore}
          aria-label={uiText("Workspace & Settings")}
        >
          <div className="m-avatar">{initials}</div>
          <div style={{ minWidth: 0 }}>
            <div className="m-greeting">{timeGreeting()}</div>
            <div className="m-username">{name}</div>
          </div>
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div className="m-month-pill" role="group" aria-label={uiText("Month")}>
            <button
              type="button"
              aria-label={uiText("Previous month")}
              onClick={() => onChangeMonth(shiftMonth(month, -1))}
            >
              <ChevronLeft size={15} className="rtl-flip" />
            </button>
            <span className="m-num">{formatMonthShort(month)}</span>
            <button
              type="button"
              aria-label={uiText("Next month")}
              onClick={() => onChangeMonth(shiftMonth(month, 1))}
            >
              <ChevronRight size={15} className="rtl-flip" />
            </button>
          </div>

          <button
            type="button"
            className="m-icon-circle"
            aria-label={uiText("Captured alerts")}
            onClick={onOpenCaptureAlerts}
          >
            <Bell size={17} />
            {pendingAlertCount > 0 && <span className="m-icon-dot" aria-hidden />}
          </button>
        </div>
      </div>

      {/* Compact status strips if offline / demo / error */}
      {!online && !demo && (
        <div className="m-alert-box is-error" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <WifiOff size={15} />
          <span>{uiText("Offline — viewing cached ledger")}</span>
        </div>
      )}

      {demo && (
        <div className="m-demo-strip">
          <span>{uiText("Exploring demo workspace")}</span>
          <button type="button" onClick={onExitDemo}>
            {uiText("Sign in")}
          </button>
        </div>
      )}

      {error && (
        <div
          className="m-alert-box is-error"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
        >
          <span>{error}</span>
          <button type="button" className="m-link-btn" style={{ color: "inherit" }} onClick={onRetry}>
            {uiText("Retry")}
          </button>
        </div>
      )}

      {/* Bold Emerald Balance Hero Card */}
      <section className="m-hero" aria-label={uiText("Total net balance")}>
        <div className="m-hero-orb" aria-hidden />
        <div className="m-hero-top">
          <span className="m-hero-label">{uiText("Total Balance")}</span>
          <button
            type="button"
            className="m-hero-eye"
            aria-label={hidden ? uiText("Show balances") : uiText("Hide balances")}
            onClick={onToggleHidden}
          >
            {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <div className="m-hero-amount m-num">{fmt(net)}</div>
        <div className="m-hero-foot">
          <span style={{ opacity: 0.85 }}>
            {ledger.accounts.length}{" "}
            {ledger.accounts.length === 1 ? uiText("account") : uiText("accounts")}
          </span>
          <span className={`m-hero-delta m-num ${netDelta < 0 ? "is-neg" : ""}`}>
            {hidden ? "••••" : `${netDeltaSign}${money(Math.abs(netDelta))} ${uiText("net")}`}
          </span>
        </div>
      </section>

      {/* Ivy-style Dual Income / Expense Pill Cards */}
      <div className="m-stat-grid">
        <button
          type="button"
          className="m-stat-card"
          onClick={() => onOpenFilteredActivity("income")}
        >
          <div className="m-stat-head">
            <span className="m-stat-icon is-inc">
              <ArrowDownLeft size={15} />
            </span>
            <span className="m-stat-label">{uiText("Income")}</span>
          </div>
          <div className="m-stat-val is-inc m-num">{fmt(summary.income)}</div>
          <div className="m-stat-sub">
            {incomeCount}{" "}
            {incomeCount === 1 ? uiText("deposit") : uiText("deposits")}
          </div>
        </button>

        <button
          type="button"
          className="m-stat-card"
          onClick={() => onOpenFilteredActivity("expense")}
        >
          <div className="m-stat-head">
            <span className="m-stat-icon is-exp">
              <ArrowUpRight size={15} />
            </span>
            <span className="m-stat-label">{uiText("Expenses")}</span>
          </div>
          <div className="m-stat-val is-exp m-num">{fmt(summary.expense)}</div>
          <div className="m-stat-sub">
            {hasBudgets
              ? `${budgetPct}% ${uiText("of budget")}`
              : `${expenseCount} ${expenseCount === 1 ? uiText("entry") : uiText("entries")}`}
          </div>
        </button>
      </div>

      {/* Actionable SMS Auto-Capture Alert Strip */}
      {pendingAlertCount > 0 && (
        <div className="m-sms-banner">
          <div className="m-sms-banner-icon" aria-hidden>
            <MessageSquareText size={18} />
          </div>
          <div className="m-sms-banner-text">
            <div className="m-sms-banner-title">
              {pendingAlertCount}{" "}
              {pendingAlertCount === 1
                ? uiText("captured alert needs review")
                : uiText("captured alerts need review")}
            </div>
            {pendingAlertPreview && (
              <div className="m-sms-banner-sub">{pendingAlertPreview}</div>
            )}
          </div>
          <button
            type="button"
            className="m-sms-banner-btn"
            onClick={onOpenCaptureAlerts}
          >
            {uiText("Review")}
          </button>
        </div>
      )}

      {/* Monthly Budget Pacing Strip */}
      <button type="button" className="m-pacing-strip" onClick={onOpenBudgets}>
        <div
          className="m-pacing-pct m-num"
          style={
            budgetPct > 100
              ? { background: "var(--m-exp-bg)", color: "var(--m-exp)" }
              : budgetPct >= 80
                ? { background: "var(--m-warn-bg)", color: "var(--m-warn)" }
                : undefined
          }
        >
          {hasBudgets ? `${Math.min(budgetPct, 999)}%` : "—"}
        </div>
        <div className="m-pacing-body">
          <div className="m-pacing-row">
            <span>{uiText("Monthly Budgets")}</span>
            <small className="m-num">
              {hasBudgets
                ? `${fmt(budgets.totalActual)} / ${fmt(budgets.totalBudget)}`
                : uiText("Set limits")}
            </small>
          </div>
          <div className="m-bar-track">
            <div
              className="m-bar-fill"
              style={{
                width: `${hasBudgets ? Math.min(100, budgetPct) : 0}%`,
                background:
                  budgetPct > 100
                    ? "var(--m-exp)"
                    : budgetPct >= 80
                      ? "var(--m-warn)"
                      : "var(--m-brand)",
              }}
            />
          </div>
        </div>
        <ChevronRight size={17} style={{ color: "var(--m-muted)" }} className="rtl-flip" />
      </button>

      {/* Recent Activity Feed */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="m-section-head">
          <span className="m-section-title">{uiText("Recent Activity")}</span>
          <button type="button" className="m-link-btn" onClick={onOpenActivity}>
            {uiText("See all")}
          </button>
        </div>

        {recentTx.length === 0 ? (
          <div className="m-empty">
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--m-text)" }}>
              {uiText("No activity this month yet")}
            </div>
            <div style={{ fontSize: 12 }}>
              {uiText("Tap the + button below to log your first expense or income.")}
            </div>
          </div>
        ) : (
          <div className="m-tx-list">
            {recentTx.map((tx) => (
              <MobileTxCard
                key={tx.id}
                tx={tx}
                category={tx.category_id ? categoriesById.get(tx.category_id) : undefined}
                account={accountsById.get(tx.account_id)}
                toAccount={tx.to_account_id ? accountsById.get(tx.to_account_id) : undefined}
                hidden={hidden}
                onSelect={onSelectTransaction}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
