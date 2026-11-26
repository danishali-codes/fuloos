import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Plus,
} from "lucide-react";
import {
  budgetForMonth,
  budgetReport,
  unbudgetedCategories,
} from "../budgets";
import {
  money,
  shiftMonth,
  today,
  type Budget,
  type Ledger,
} from "../domain";
import { translateText as uiText } from "../i18n";
import { hexAlpha } from "./isMobileApkMode";
import { formatMonthShort } from "./MobileTxRow";

function daysRemainingInMonth(ym: string): number {
  const nowIso = today();
  const [y, m] = ym.split("-").map(Number);
  const totalDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (nowIso.slice(0, 7) !== ym) return totalDays;
  const currentDay = Number(nowIso.slice(8, 10));
  return Math.max(1, totalDays - currentDay + 1);
}

export function MobileBudgets({
  ledger,
  month,
  hidden,
  onChangeMonth,
  onBack,
  onAddBudget,
  onEditBudget,
}: {
  ledger: Ledger;
  month: string;
  hidden: boolean;
  onChangeMonth: (next: string) => void;
  onBack: () => void;
  onAddBudget: (categoryId?: string) => void;
  onEditBudget: (budget: Budget) => void;
}) {
  const report = budgetReport(ledger, month, month);
  const unbudgeted = unbudgetedCategories(ledger, month);
  const totalBudget = report.totalBudget;
  const totalActual = report.totalActual;
  const remaining = totalBudget - totalActual;
  const pct = totalBudget > 0 ? Math.round((totalActual / totalBudget) * 100) : 0;
  const daysLeft = daysRemainingInMonth(month);
  const safeDaily = remaining > 0 ? Math.floor(remaining / daysLeft) : 0;
  const fmt = (fils: number) => (hidden ? "••••••" : money(fils));

  return (
    <div className="m-page">
      {/* Header */}
      <div className="m-page-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            className="m-icon-circle"
            aria-label={uiText("Back")}
            onClick={onBack}
          >
            <ArrowLeft size={17} className="rtl-flip" />
          </button>
          <div>
            <h1 className="m-page-title">{uiText("Budgets")}</h1>
            <div className="m-page-sub">
              {formatMonthShort(month)} · {daysLeft}{" "}
              {daysLeft === 1 ? uiText("day left") : uiText("days left")}
            </div>
          </div>
        </div>

        <button
          type="button"
          className="m-pill-btn is-brand"
          onClick={() => onAddBudget()}
        >
          <Plus size={14} /> {uiText("Add")}
        </button>
      </div>

      {/* Month Switcher */}
      <div style={{ display: "flex", justifyContent: "center" }}>
        <div className="m-month-pill">
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
      </div>

      {/* Overall Summary Hero Card */}
      <div className="m-card m-budget-hero">
        <div className="m-budget-hero-top">
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--m-muted)" }}>
              {uiText("Spent so far")}
            </div>
            <div
              className="m-num"
              style={{ fontSize: 26, fontWeight: 800, marginTop: 2 }}
            >
              {fmt(totalActual)}
            </div>
          </div>
          <div style={{ textAlign: "end" }}>
            <div
              className="m-num"
              style={{
                fontSize: 13,
                fontWeight: 800,
                color:
                  pct > 100
                    ? "var(--m-exp)"
                    : pct >= 80
                      ? "var(--m-warn)"
                      : "var(--m-brand)",
              }}
            >
              {pct}% {uiText("used")}
            </div>
            <div
              className="m-num"
              style={{ fontSize: 11.5, color: "var(--m-muted)" }}
            >
              {uiText("of")} {fmt(totalBudget)}
            </div>
          </div>
        </div>

        <div className="m-bar-track" style={{ height: 9, marginTop: 2 }}>
          <div
            className="m-bar-fill"
            style={{
              width: `${Math.min(100, pct)}%`,
              background:
                pct > 100
                  ? "var(--m-exp)"
                  : pct >= 80
                    ? "var(--m-warn)"
                    : "linear-gradient(90deg, var(--m-brand), var(--m-brand-2))",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 12,
            color: "var(--m-text-soft)",
          }}
        >
          <span>
            {remaining > 0 ? (
              <>
                {uiText("Safe pace")}:{" "}
                <strong className="m-num">{fmt(safeDaily)}/d</strong>
              </>
            ) : (
              uiText("Monthly limit reached")
            )}
          </span>
          <span
            className="m-num"
            style={{
              fontWeight: 800,
              color: remaining >= 0 ? "var(--m-inc)" : "var(--m-exp)",
            }}
          >
            {remaining >= 0
              ? `${fmt(remaining)} ${uiText("left")}`
              : `${fmt(Math.abs(remaining))} ${uiText("over")}`}
          </span>
        </div>
      </div>

      {/* Category Budget Cards */}
      {report.rows.length === 0 ? (
        <div className="m-empty">
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--m-text)" }}>
            {uiText("No budgets set for this month")}
          </div>
          <div style={{ fontSize: 12.5 }}>
            {uiText("Add category limits to track your monthly spending pace.")}
          </div>
          <button
            type="button"
            className="m-pill-btn is-brand"
            onClick={() => onAddBudget()}
          >
            <Plus size={14} /> {uiText("Create first budget")}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {report.rows.map((row) => {
            const p =
              row.budget > 0
                ? Math.round((row.actual / row.budget) * 100)
                : row.actual > 0
                  ? 100
                  : 0;
            const over = row.status === "over";
            const near = row.status === "near";
            const barColor = over
              ? "var(--m-exp)"
              : near
                ? "var(--m-warn)"
                : row.category.color || "var(--m-brand)";
            const budgetRecord = budgetForMonth(
              ledger.budgets ?? [],
              row.category.id,
              month,
            );

            return (
              <button
                key={row.category.id}
                type="button"
                className="m-budget-card"
                onClick={() => {
                  if (budgetRecord) onEditBudget(budgetRecord);
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    className="m-cat-badge"
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 14,
                      background: hexAlpha(row.category.color, 0.16),
                    }}
                  >
                    {row.category.emoji || (
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 800,
                          color: row.category.color || "var(--m-brand)",
                        }}
                      >
                        {row.category.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 800,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {row.category.name}
                      </span>
                      <span
                        className="m-num"
                        style={{
                          fontSize: 12.5,
                          fontWeight: 800,
                          color: over ? "var(--m-exp)" : "var(--m-text)",
                          flexShrink: 0,
                        }}
                      >
                        {over
                          ? `${fmt(Math.abs(row.remaining))} ${uiText("over")}`
                          : `${fmt(row.remaining)} ${uiText("left")}`}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        fontSize: 11.5,
                        color: "var(--m-muted)",
                        marginTop: 2,
                      }}
                    >
                      <span className="m-num">
                        {fmt(row.actual)} / {fmt(row.budget)}
                      </span>
                      <span className="m-num" style={{ fontWeight: 700 }}>
                        {p}%
                      </span>
                    </div>
                  </div>
                </div>
                <div className="m-bar-track" style={{ marginTop: 0 }}>
                  <div
                    className="m-bar-fill"
                    style={{
                      width: `${Math.min(100, p)}%`,
                      background: barColor,
                    }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Unbudgeted spending categories quick-add */}
      {unbudgeted.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="m-section-head">
            <span className="m-section-title">
              {uiText("Unbudgeted spending")}
            </span>
          </div>
          {unbudgeted.slice(0, 4).map(({ category, actual }) => (
            <div
              key={category.id}
              className="m-tx-card"
              style={{ justifyContent: "space-between" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <div
                  className="m-cat-badge"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 12,
                    fontSize: 15,
                    background: hexAlpha(category.color, 0.16),
                  }}
                >
                  {category.emoji || category.name.charAt(0).toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                    {category.name}
                  </div>
                  <div
                    className="m-num"
                    style={{ fontSize: 11.5, color: "var(--m-muted)" }}
                  >
                    {fmt(actual)} {uiText("spent")}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="m-pill-btn is-soft"
                onClick={() => onAddBudget(category.id)}
              >
                + {uiText("Budget")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
