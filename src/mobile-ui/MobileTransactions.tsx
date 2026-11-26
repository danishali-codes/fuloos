import { useMemo } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  Search,
  X,
} from "lucide-react";
import {
  money,
  shiftMonth,
  type Ledger,
  type Transaction,
} from "../domain";
import { translateText as uiText } from "../i18n";
import {
  formatMonthShort,
  formatShortDate,
  MobileTxCard,
} from "./MobileTxRow";

export function MobileTransactions({
  ledger,
  monthly,
  month,
  search,
  kindFilter,
  accountFilter,
  hidden,
  pendingAlertCount,
  onChangeMonth,
  onSearch,
  onKindFilter,
  onAccountFilter,
  onSelectTransaction,
  onOpenCaptureAlerts,
}: {
  ledger: Ledger;
  monthly: Transaction[];
  month: string;
  search: string;
  kindFilter: string;
  accountFilter: string;
  hidden: boolean;
  pendingAlertCount: number;
  onChangeMonth: (nextMonth: string) => void;
  onSearch: (q: string) => void;
  onKindFilter: (k: string) => void;
  onAccountFilter: (id: string) => void;
  onSelectTransaction: (tx: Transaction) => void;
  onOpenCaptureAlerts: () => void;
}) {
  const accountsById = useMemo(
    () => new Map(ledger.accounts.map((a) => [a.id, a])),
    [ledger.accounts],
  );
  const categoriesById = useMemo(
    () => new Map(ledger.categories.map((c) => [c.id, c])),
    [ledger.categories],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...monthly]
      .filter((tx) => {
        if (kindFilter && tx.type !== kindFilter) return false;
        if (
          accountFilter &&
          tx.account_id !== accountFilter &&
          tx.to_account_id !== accountFilter
        ) {
          return false;
        }
        if (q) {
          const catName = tx.category_id
            ? (categoriesById.get(tx.category_id)?.name ?? "")
            : "";
          const accName = accountsById.get(tx.account_id)?.name ?? "";
          const haystack =
            `${tx.payee} ${tx.notes} ${catName} ${accName} ${(tx.tags ?? []).join(" ")}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [monthly, kindFilter, accountFilter, search, categoriesById, accountsById]);

  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const tx of filtered) {
      const list = map.get(tx.date);
      if (list) list.push(tx);
      else map.set(tx.date, [tx]);
    }
    return [...map.entries()];
  }, [filtered]);

  const selectedAccount = accountFilter
    ? accountsById.get(accountFilter)
    : undefined;

  return (
    <div className="m-page">
      {/* Header */}
      <div className="m-page-head">
        <div>
          <h1 className="m-page-title">{uiText("Activity")}</h1>
          <div className="m-page-sub m-num">
            {filtered.length}{" "}
            {filtered.length === 1
              ? uiText("transaction")
              : uiText("transactions")}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
          {pendingAlertCount > 0 && (
            <button
              type="button"
              className="m-icon-circle"
              aria-label={uiText("Captured alerts")}
              onClick={onOpenCaptureAlerts}
            >
              <Inbox size={17} />
              <span className="m-icon-dot" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* Search Pill */}
      <div className="m-search-wrap">
        <span className="m-search-icon" aria-hidden>
          <Search size={16} />
        </span>
        <input
          type="search"
          className="m-search-input"
          placeholder={uiText("Search merchant, category, note…")}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        {search && (
          <button
            type="button"
            className="m-search-clear"
            aria-label={uiText("Clear search")}
            onClick={() => onSearch("")}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Filter Chips */}
      <div className="m-hscroll">
        {[
          { id: "", label: uiText("All") },
          { id: "expense", label: uiText("Expenses") },
          { id: "income", label: uiText("Income") },
          { id: "transfer", label: uiText("Transfers") },
        ].map((f) => (
          <button
            key={f.id || "all"}
            type="button"
            className={`m-chip ${kindFilter === f.id ? "is-active" : ""}`}
            onClick={() => onKindFilter(f.id)}
          >
            {f.label}
          </button>
        ))}

        {selectedAccount && (
          <button
            type="button"
            className="m-chip is-active"
            onClick={() => onAccountFilter("")}
          >
            <span>{selectedAccount.name}</span>
            <X size={13} />
          </button>
        )}
      </div>

      {/* Grouped Transaction Cards */}
      {groups.length === 0 ? (
        <div className="m-empty">
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--m-text)" }}>
            {uiText("No matching transactions")}
          </div>
          <div style={{ fontSize: 12 }}>
            {search || kindFilter || accountFilter
              ? uiText("Try clearing a filter or switching months.")
              : uiText("Tap the + button below to record a transaction.")}
          </div>
          {(search || kindFilter || accountFilter) && (
            <button
              type="button"
              className="m-pill-btn is-soft"
              onClick={() => {
                onSearch("");
                onKindFilter("");
                onAccountFilter("");
              }}
            >
              {uiText("Reset filters")}
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {groups.map(([dateIso, items]) => {
            const dayNet = items.reduce(
              (sum, tx) =>
                sum +
                (tx.type === "income"
                  ? tx.amount
                  : tx.type === "expense"
                    ? -tx.amount
                    : 0),
              0,
            );
            return (
              <div
                key={dateIso}
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
              >
                <div className="m-group-head">
                  <span>{formatShortDate(dateIso)}</span>
                  {dayNet !== 0 && (
                    <span
                      className="m-num"
                      style={{
                        color: dayNet > 0 ? "var(--m-inc)" : "var(--m-muted)",
                      }}
                    >
                      {hidden
                        ? "••••"
                        : `${dayNet > 0 ? "+" : "−"}${money(Math.abs(dayNet))}`}
                    </span>
                  )}
                </div>
                <div className="m-tx-list">
                  {items.map((tx) => (
                    <MobileTxCard
                      key={tx.id}
                      tx={tx}
                      category={
                        tx.category_id
                          ? categoriesById.get(tx.category_id)
                          : undefined
                      }
                      account={accountsById.get(tx.account_id)}
                      toAccount={
                        tx.to_account_id
                          ? accountsById.get(tx.to_account_id)
                          : undefined
                      }
                      hidden={hidden}
                      onSelect={onSelectTransaction}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
