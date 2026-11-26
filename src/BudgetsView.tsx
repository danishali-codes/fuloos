import { translateText as uiText } from "./i18n";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { PeriodPicker } from "./PeriodPicker";
import {
  ArrowRight,
  Pencil,
  PiggyBank,
  Plus,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import {
  budgetForMonth,
  budgetReport,
  unbudgetedCategories,
  validateBudget,
  type BudgetProgress,
} from "./budgets";
import { formatCurrencyInput, parseCurrencyMinor } from "./currency";
import {
  errorMessage,
  reportingCurrency,
  shiftMonth,
  today,
  type Budget,
  type Category,
  type Ledger,
} from "./domain";

export type BudgetDraft = Omit<Budget, "id">;

export const monthLabel = (month: string) =>
  new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Dubai",
  });

const shortMonth = (month: string) =>
  new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "Asia/Dubai",
  });

export function budgetPeriod(b: Pick<Budget, "start_month" | "end_month">) {
  if (!b.end_month) return `Every month from ${shortMonth(b.start_month)}`;
  if (b.end_month === b.start_month) return `${shortMonth(b.start_month)} only`;
  return `${shortMonth(b.start_month)} – ${shortMonth(b.end_month)}`;
}

function CategoryIcon({ category }: { category: Category }) {
  return (
    <span
      className="category-symbol"
      style={{ color: category.color, background: category.color + "18" }}
    >
      {category.emoji || <Tags size={20} />}
    </span>
  );
}

function BudgetRow({
  row,
  concealed,
  caption,
  actions,
}: {
  row: BudgetProgress;
  concealed: (v: number) => string;
  caption?: string;
  actions?: React.ReactNode;
}) {
  const pct = Number.isFinite(row.ratio) ? Math.round(row.ratio * 100) : null;
  const fill = row.budget > 0 ? Math.min(row.actual / row.budget, 1) : 1;
  return (
    <div className={`category-item budget-row ${row.status}`}>
      <CategoryIcon category={row.category} />
      <div>
        <div className="budget-row-head">
          <b>{row.category.name}</b>
          <span className={`budget-status ${row.status}`}>
            {row.status === "over"
              ? `Over by ${concealed(-row.remaining)}`
              : `${concealed(row.remaining)} left`}
          </span>
        </div>
        <div
          className="budget-bar"
          role="progressbar"
          aria-label={`${row.category.name} budget used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct === null ? 100 : Math.min(pct, 100)}
          aria-valuetext={
            pct === null
              ? "Spending against a zero budget"
              : `${pct}% of budget used`
          }
        >
          <span
            className={row.status}
            style={{
              width: `${(row.actual > 0 || row.budget === 0 ? fill : 0) * 100}%`,
            }}
          />
        </div>
        <p>
          {concealed(row.actual)} {uiText("of")} {concealed(row.budget)}
          {pct !== null && ` · ${pct}%`}
          {caption && ` · ${caption}`}
        </p>
      </div>
      {actions}
    </div>
  );
}

export function BudgetsPage({
  ledger,
  month,
  onMonthChange,
  concealed,
  busy,
  onAdd,
  onEdit,
  onDelete,
}: {
  ledger: Ledger;
  month: string;
  onMonthChange: (month: string) => void;
  concealed: (v: number) => string;
  busy: boolean;
  onAdd: (draft?: Partial<BudgetDraft>) => void;
  onEdit: (budget: Budget) => void;
  onDelete: (budget: Budget) => void;
}) {
  const repCurr = reportingCurrency(ledger);
  const report = useMemo(
    () => budgetReport(ledger, month, month, { reportingCurrency: repCurr }),
    [ledger, month, repCurr],
  );
  const unbudgeted = useMemo(
    () => unbudgetedCategories(ledger, month),
    [ledger, month],
  );
  const budgets = ledger.budgets ?? [];
  const categoryById = new Map(ledger.categories.map((c) => [c.id, c]));
  const allBudgets = budgets
    .slice()
    .sort(
      (a, b) =>
        (categoryById.get(a.category_id)?.name ?? "").localeCompare(
          categoryById.get(b.category_id)?.name ?? "",
        ) || b.start_month.localeCompare(a.start_month),
    );
  const budgetMonths = useMemo(() => {
    // Dot every month that has at least one budget, so gaps are easy to spot.
    const set = new Set<string>();
    for (const b of budgets) {
      if (!/^\d{4}-\d{2}$/.test(b.start_month)) continue;
      const last = b.end_month || shiftMonth(month, 60);
      for (let m = b.start_month; m <= last; m = shiftMonth(m, 1)) set.add(m);
    }
    return set;
  }, [budgets, month]);
  const left = report.totalBudget - report.totalActual;
  const overCount = report.rows.filter((r) => r.status === "over").length;

  return (
    <>
      <div className="period-row">
        <PeriodPicker
          label="Budget month"
          month={month}
          currentMonth={today().slice(0, 7)}
          activeMonths={budgetMonths}
          onChange={(next) => onMonthChange(next.month)}
        />
        <span className="muted">
          {uiText("Budgets compare against expenses only")}
          {(report.estimatedCount ?? 0) > 0 &&
            ` · includes ${report.estimatedCount} estimated ${report.estimatedCount === 1 ? "amount" : "amounts"}`}
        </span>
      </div>
      <section className="stats">
        <article className="stat net">
          <div className="stat-label">
            {" "}
            {uiText("Budgeted")} <PiggyBank size={17} />
          </div>
          <h2>{concealed(report.totalBudget)}</h2>
          <small>
            {report.rows.length}{" "}
            {report.rows.length === 1 ? "category" : "categories"}{" "}
            <span>{monthLabel(month)}</span>
          </small>
          <div className="stat-decoration" />
        </article>
        <article className="stat">
          <div className="stat-label">{uiText("Spent against budgets")}</div>
          <h2>{concealed(report.totalActual)}</h2>
          <small>
            {report.totalBudget > 0
              ? `${Math.round((report.totalActual / report.totalBudget) * 100)}% used`
              : uiText("No limits set")}{" "}
            <span>
              {report.unbudgeted > 0
                ? `${concealed(report.unbudgeted)} unbudgeted`
                : uiText("All spending budgeted")}
            </span>
          </small>
        </article>
        <article className="stat">
          <div className="stat-label">
            {left < 0 ? uiText("Over budget") : uiText("Left to spend")}
          </div>
          <h2 className={left < 0 ? "budget-over-text" : undefined}>
            {concealed(Math.abs(left))}
          </h2>
          <small>
            {overCount
              ? `${overCount} ${overCount === 1 ? "category" : "categories"} over`
              : uiText("Nothing over budget")}
          </small>
        </article>
      </section>
      <div className="category-grid budget-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{monthLabel(month)}</h2>
              <p>{uiText("Spending against each category's monthly limit")}</p>
            </div>
            <span className="count">{report.rows.length}</span>
          </div>
          {report.rows.map((row) => {
            const budget = budgetForMonth(budgets, row.category.id, month)!;
            return (
              <BudgetRow
                key={row.category.id}
                row={row}
                concealed={concealed}
                caption={budgetPeriod(budget)}
                actions={
                  <>
                    <button
                      className="icon-button"
                      aria-label={`Edit ${row.category.name} budget`}
                      disabled={busy}
                      onClick={() => onEdit(budget)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Delete ${row.category.name} budget`}
                      disabled={busy}
                      onClick={() => onDelete(budget)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                }
              />
            );
          })}
          {!report.rows.length && (
            <div className="empty">
              <PiggyBank size={28} />
              <h3>
                {uiText("No budgets for")} {monthLabel(month)}
              </h3>
              <p>
                {ledger.categories.length
                  ? uiText(
                      "Set a monthly limit for a category to track your spending against it.",
                    )
                  : uiText(
                      "Create a category first, then give it a monthly limit.",
                    )}
              </p>
              {ledger.categories.length > 0 && (
                <button
                  className="primary empty-cta"
                  disabled={busy}
                  onClick={() => onAdd({ start_month: month })}
                >
                  <Plus size={16} /> {uiText("Add budget")}{" "}
                </button>
              )}
            </div>
          )}
        </section>
        <div className="budget-side">
          {unbudgeted.length > 0 && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>{uiText("Not budgeted yet")}</h2>
                  <p>
                    {uiText("Categories with spending this month but no limit")}
                  </p>
                </div>
              </div>
              {unbudgeted.map(({ category, actual }) => (
                <div className="category-item" key={category.id}>
                  <CategoryIcon category={category} />
                  <div>
                    <b>{category.name}</b>
                    <p>
                      {concealed(actual)} {uiText("spent")}
                    </p>
                  </div>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      onAdd({ category_id: category.id, start_month: month })
                    }
                  >
                    {" "}
                    {uiText("Set budget")} <ArrowRight size={15} />
                  </button>
                </div>
              ))}
            </section>
          )}
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>{uiText("All budgets")}</h2>
                <p>{uiText("Past, current and upcoming limits")}</p>
              </div>
              <span className="count">{allBudgets.length}</span>
            </div>
            {allBudgets.map((b) => {
              const category = categoryById.get(b.category_id);
              if (!category) return null;
              return (
                <div className="category-item" key={b.id}>
                  <CategoryIcon category={category} />
                  <div>
                    <b>
                      {category.name}{" "}
                      {b.household_id && (
                        <span className="shared-badge">{uiText("Shared")}</span>
                      )}
                    </b>
                    <p>
                      {concealed(b.amount)} {uiText("a month ·")}{" "}
                      {budgetPeriod(b)}
                    </p>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`Edit ${category.name} budget ${budgetPeriod(b)}`}
                    disabled={busy}
                    onClick={() => onEdit(b)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Delete ${category.name} budget ${budgetPeriod(b)}`}
                    disabled={busy}
                    onClick={() => onDelete(b)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
            {!allBudgets.length && (
              <div className="empty">
                <PiggyBank size={28} />
                <h3>{uiText("No budgets yet")}</h3>
                <p>
                  {" "}
                  {uiText(
                    "Budgets repeat every month until you give them an end month.",
                  )}{" "}
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

export function BudgetReportPanel({
  ledger,
  startMonth,
  endMonth,
  rangeLabel,
  concealed,
  onManage,
}: {
  ledger: Ledger;
  startMonth: string;
  endMonth: string;
  rangeLabel: string;
  concealed: (v: number) => string;
  onManage: () => void;
}) {
  const report = useMemo(
    () => budgetReport(ledger, startMonth, endMonth),
    [ledger, startMonth, endMonth],
  );
  const multiMonth = report.months.length > 1;
  return (
    <section className="panel budget-report">
      <div className="panel-heading">
        <div>
          <h2>{uiText("Budget vs actual")}</h2>
          <p>
            {rangeLabel}
            {multiMonth && " · budgets add up across the months they cover"}
          </p>
        </div>
        <button className="text-button" onClick={onManage}>
          {" "}
          {uiText("Manage budgets")} <ArrowRight size={15} />
        </button>
      </div>
      {report.rows.length > 0 ? (
        <>
          <div className="filters">
            <b>
              {uiText("Budgeted")} {concealed(report.totalBudget)}
            </b>
            <b>
              {uiText("Spent")} {concealed(report.totalActual)}
            </b>
            <b
              className={
                report.totalActual > report.totalBudget
                  ? "budget-over-text"
                  : undefined
              }
            >
              {report.totalActual > report.totalBudget
                ? `Over ${concealed(report.totalActual - report.totalBudget)}`
                : `Left ${concealed(report.totalBudget - report.totalActual)}`}
            </b>
            {report.unbudgeted > 0 && (
              <span className="muted">
                {" "}
                {uiText("Unbudgeted spending")} {concealed(report.unbudgeted)}
              </span>
            )}
          </div>
          {report.rows.map((row) => (
            <BudgetRow
              key={row.category.id}
              row={row}
              concealed={concealed}
              caption={
                multiMonth
                  ? `${row.budgetedMonths} of ${report.months.length} months budgeted`
                  : undefined
              }
            />
          ))}
        </>
      ) : (
        <div className="empty">
          <PiggyBank size={28} />
          <h3>{uiText("No budgets in this period")}</h3>
          <p>
            {" "}
            {uiText(
              "Set monthly limits per category to compare them with your spending.",
            )}{" "}
          </p>
        </div>
      )}
    </section>
  );
}

export function BudgetEditorModal({
  ledger,
  item,
  draft,
  busy,
  onClose,
  onSave,
}: {
  ledger: Ledger;
  item?: Budget;
  draft?: Partial<BudgetDraft>;
  busy: boolean;
  onClose: () => void;
  onSave: (value: BudgetDraft, id?: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [repeats, setRepeats] = useState(
    item ? !item.end_month : !draft?.end_month,
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const initial = item ?? draft ?? {};
  // Prefer a category that is still free in the starting month so a new budget does not clash.
  const defaultCategory =
    initial.category_id ??
    (
      ledger.categories.find(
        (c) =>
          !initial.start_month ||
          !budgetForMonth(ledger.budgets ?? [], c.id, initial.start_month),
      ) ?? ledger.categories[0]
    )?.id;
  const repCurr = reportingCurrency(ledger);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget),
      s = (key: string) => String(f.get(key) ?? "").trim();
    try {
      const value: BudgetDraft = {
        category_id: s("category_id"),
        amount: parseCurrencyMinor(s("amount"), repCurr),
        start_month: s("start_month"),
        end_month: repeats ? null : s("end_month") || null,
      };
      if (!repeats && !value.end_month)
        throw new Error("Choose an end month, or let the budget repeat.");
      validateBudget({ ...value, id: item?.id }, ledger);
      await onSave(value, item?.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <dialog
      ref={dialog}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="budget-modal-title"
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">{uiText("SPEND WITH INTENTION")}</span>
          <h2 id="budget-modal-title">
            {item ? uiText("Edit") : uiText("Add")} {uiText("budget")}
          </h2>
        </div>
        <button
          disabled={busy}
          className="icon-button"
          aria-label={uiText("Close dialog")}
          onClick={onClose}
        >
          <X size={21} />
        </button>
      </div>
      <form onSubmit={submit}>
        {!ledger.categories.length && (
          <div className="notice">
            {uiText("Create a category first to set a budget.")}
          </div>
        )}
        <label>
          {" "}
          {uiText("Category")}{" "}
          <select name="category_id" required defaultValue={defaultCategory}>
            {ledger.categories.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {" "}
          {uiText("Monthly limit")} <span className="muted">{repCurr}</span>
          <input
            name="amount"
            required
            autoFocus
            inputMode="decimal"
            placeholder={formatCurrencyInput(0, repCurr)}
            defaultValue={
              initial.amount !== undefined
                ? formatCurrencyInput(initial.amount, repCurr)
                : ""
            }
          />
        </label>
        <div className="form-row">
          <label>
            {" "}
            {uiText("Starts")}{" "}
            <input
              name="start_month"
              type="month"
              placeholder="YYYY-MM"
              pattern="[0-9]{4}-[0-9]{2}"
              required
              min="1970-01"
              max="2100-12"
              defaultValue={initial.start_month}
            />
          </label>
          <label>
            {" "}
            {uiText("Ends")}{" "}
            <input
              name="end_month"
              type="month"
              placeholder="YYYY-MM"
              pattern="[0-9]{4}-[0-9]{2}"
              min="1970-01"
              max="2100-12"
              disabled={repeats}
              required={!repeats}
              defaultValue={initial.end_month ?? ""}
            />
          </label>
        </div>
        <label className="budget-check">
          <input
            type="checkbox"
            checked={repeats}
            onChange={(e) => setRepeats(e.target.checked)}
          />{" "}
          {uiText("Repeat every month with no end date")}{" "}
        </label>
        <p className="form-hint">
          {" "}
          {uiText(
            "Only expenses count toward a budget. Editing the amount changes every month this budget covers; to change it from a later month, give this budget an end month and add a new one.",
          )}{" "}
        </p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            {" "}
            {uiText("Cancel")}{" "}
          </button>
          <button
            className="primary"
            disabled={busy || !ledger.categories.length}
          >
            {busy ? uiText("Saving…") : uiText("Save budget")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
