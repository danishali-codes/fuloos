import React from "react";
import { ArrowLeft, Plus } from "lucide-react";
import type { AppLockConfig } from "../appLock";
import { pendingCapturedAlerts } from "../captureAlerts";
import type { Session } from "../client";
import type { Account, Budget, Ledger, Transaction } from "../domain";
import { translateText as uiText } from "../i18n";
import type { SmsAccountLink } from "../mobile/smsLinks";
import type { QuickAddDraft } from "../quickAdd";
import { MobileAccounts } from "./MobileAccounts";
import { MobileBottomNav, type MobileTabId } from "./MobileBottomNav";
import { MobileBudgets } from "./MobileBudgets";
import { MobileHome } from "./MobileHome";
import { MobileMore } from "./MobileMore";
import { MobileQuickAddSheet } from "./MobileQuickAddSheet";
import { MobileTransactions } from "./MobileTransactions";
import { MobileTxDetailSheet } from "./MobileTxRow";

const SECONDARY_PAGES = new Set([
  "Recurring",
  "Goals",
  "Net Worth",
  "Reports",
  "Categories",
]);

export function MobileAppShell({
  page,
  ledger,
  session,
  demo,
  online,
  month,
  net,
  summary,
  monthly,
  hidden,
  busy,
  error,
  search,
  kindFilter,
  accountFilter,
  lockConfig,
  smsLinks,
  quickAdd,
  editingQuickTx,
  selectedTx,
  onSelectTx,
  onNavigate,
  onToggleHidden,
  onChangeMonth,
  onSearch,
  onKindFilter,
  onAccountFilter,
  onOpenQuickAdd,
  onCloseQuickAdd,
  onQuickEditTx,
  onOpenFullTxEditor,
  onDeleteTx,
  onSaveTransaction,
  onAddAccount,
  onEditAccount,
  onDeleteAccount,
  onAddBudget,
  onEditBudget,
  onOpenSmsAutoCapture,
  onOpenCaptureAlerts,
  onOpenUnparsedSms,
  unparsedSmsCount = 0,
  onOpenConfirmAmounts,
  estimatedCount = 0,
  onOpenRules,
  onOpenImport,
  onOpenSettings,
  onSignOut,
  onRetry,
  onPrimarySubpageAction,
  secondaryContent,
}: {
  page: string;
  ledger: Ledger;
  session: Session | null;
  demo: boolean;
  online: boolean;
  month: string;
  net: number;
  summary: { income: number; expense: number; estimatedCount?: number };
  monthly: Transaction[];
  hidden: boolean;
  busy: boolean;
  error: string;
  search: string;
  kindFilter: string;
  accountFilter: string;
  lockConfig: AppLockConfig | null;
  smsLinks: SmsAccountLink[];
  quickAdd: Partial<QuickAddDraft> | null;
  editingQuickTx: Transaction | null;
  selectedTx: Transaction | null;
  onSelectTx: (tx: Transaction | null) => void;
  onNavigate: (next: string) => void;
  onToggleHidden: () => void;
  onChangeMonth: (nextMonth: string) => void;
  onSearch: (q: string) => void;
  onKindFilter: (k: string) => void;
  onAccountFilter: (id: string) => void;
  onOpenQuickAdd: (draft?: Partial<QuickAddDraft>) => void;
  onCloseQuickAdd: () => void;
  onQuickEditTx: (tx: Transaction) => void;
  onOpenFullTxEditor: (tx?: Transaction) => void;
  onDeleteTx: (tx: Transaction) => void;
  onSaveTransaction: (
    table: "transactions",
    value: Record<string, unknown>,
    id?: string,
  ) => Promise<void>;
  onAddAccount: () => void;
  onEditAccount: (acc: Account) => void;
  onDeleteAccount: (acc: Account) => void;
  onAddBudget: (categoryId?: string) => void;
  onEditBudget: (budget: Budget) => void;
  onOpenSmsAutoCapture: (accountId?: string) => void;
  onOpenCaptureAlerts: () => void;
  onOpenUnparsedSms?: () => void;
  unparsedSmsCount?: number;
  onOpenConfirmAmounts?: (txId?: string) => void;
  estimatedCount?: number;
  onOpenRules: () => void;
  onOpenImport: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
  onRetry: () => void;
  onPrimarySubpageAction: () => void;
  secondaryContent: React.ReactNode;
}) {
  const pendingAlerts = pendingCapturedAlerts(ledger.captured_alerts);
  const pendingAlertPreview = pendingAlerts
    .slice(0, 2)
    .map((a) => a.parsed_payee || a.sms_sender || a.subject)
    .filter(Boolean)
    .join(" · ");

  const activeTab: MobileTabId =
    page === "Overview"
      ? "Overview"
      : page === "Transactions"
        ? "Transactions"
        : page === "Accounts"
          ? "Accounts"
          : "More";

  const isSecondaryPage = SECONDARY_PAGES.has(page);
  const accountsById = new Map(ledger.accounts.map((a) => [a.id, a]));
  const categoriesById = new Map(ledger.categories.map((c) => [c.id, c]));

  return (
    <div className="m-app">
      {page === "Overview" && (
        <MobileHome
          ledger={ledger}
          session={session}
          demo={demo}
          online={online}
          month={month}
          net={net}
          summary={summary}
          monthly={monthly}
          hidden={hidden}
          pendingAlertCount={pendingAlerts.length}
          pendingAlertPreview={pendingAlertPreview}
          estimatedCount={estimatedCount}
          error={error}
          onToggleHidden={onToggleHidden}
          onChangeMonth={onChangeMonth}
          onOpenFilteredActivity={(kind) => {
            onNavigate("Transactions");
            onKindFilter(kind);
          }}
          onOpenActivity={() => onNavigate("Transactions")}
          onOpenBudgets={() => onNavigate("Budgets")}
          onOpenMore={() => onNavigate("More")}
          onOpenCaptureAlerts={onOpenCaptureAlerts}
          onOpenConfirmAmounts={onOpenConfirmAmounts}
          onSelectTransaction={onSelectTx}
          onExitDemo={onSignOut}
          onRetry={onRetry}
        />
      )}

      {page === "Transactions" && (
        <MobileTransactions
          ledger={ledger}
          monthly={monthly}
          month={month}
          search={search}
          kindFilter={kindFilter}
          accountFilter={accountFilter}
          hidden={hidden}
          pendingAlertCount={pendingAlerts.length}
          onChangeMonth={onChangeMonth}
          onSearch={onSearch}
          onKindFilter={onKindFilter}
          onAccountFilter={onAccountFilter}
          onSelectTransaction={onSelectTx}
          onOpenCaptureAlerts={onOpenCaptureAlerts}
        />
      )}

      {page === "Accounts" && (
        <MobileAccounts
          ledger={ledger}
          monthly={monthly}
          net={net}
          hidden={hidden}
          smsLinks={smsLinks}
          onAddAccount={onAddAccount}
          onEditAccount={onEditAccount}
          onDeleteAccount={onDeleteAccount}
          onViewTransactions={(accountId) => {
            onNavigate("Transactions");
            onAccountFilter(accountId);
          }}
          onOpenSmsAutoCapture={onOpenSmsAutoCapture}
        />
      )}

      {page === "Budgets" && (
        <MobileBudgets
          ledger={ledger}
          month={month}
          hidden={hidden}
          onChangeMonth={onChangeMonth}
          onBack={() => onNavigate("More")}
          onAddBudget={onAddBudget}
          onEditBudget={onEditBudget}
        />
      )}

      {page === "More" && (
        <MobileMore
          ledger={ledger}
          session={session}
          demo={demo}
          online={online}
          hidden={hidden}
          lockConfig={lockConfig}
          pendingAlertCount={pendingAlerts.length}
          unparsedSmsCount={unparsedSmsCount}
          estimatedCount={estimatedCount}
          smsLinks={smsLinks}
          onNavigate={onNavigate}
          onOpenSmsAutoCapture={() => onOpenSmsAutoCapture()}
          onOpenCaptureAlerts={onOpenCaptureAlerts}
          onOpenUnparsedSms={onOpenUnparsedSms}
          onOpenConfirmAmounts={onOpenConfirmAmounts}
          onOpenRules={onOpenRules}
          onOpenImport={onOpenImport}
          onOpenSettings={onOpenSettings}
          onSignOut={onSignOut}
        />
      )}

      {isSecondaryPage && (
        <>
          <div className="m-subpage-bar">
            <div className="m-subpage-left">
              <button
                type="button"
                className="m-icon-circle"
                aria-label={uiText("Back")}
                onClick={() => onNavigate("More")}
              >
                <ArrowLeft size={17} className="rtl-flip" />
              </button>
              <h1 className="m-page-title" style={{ fontSize: 19 }}>
                {uiText(page)}
              </h1>
            </div>
            {page !== "Reports" && (
              <button
                type="button"
                className="m-pill-btn is-brand"
                disabled={busy}
                onClick={onPrimarySubpageAction}
              >
                <Plus size={14} /> {uiText("Add")}
              </button>
            )}
          </div>
          <div className="m-subpage-body">{secondaryContent}</div>
        </>
      )}

      <MobileBottomNav
        activeTab={activeTab}
        pendingAlertCount={pendingAlerts.length}
        disabled={busy}
        onSelectTab={(tab) => onNavigate(tab)}
        onQuickAdd={() => onOpenQuickAdd({})}
      />

      {selectedTx && (
        <MobileTxDetailSheet
          tx={selectedTx}
          category={
            selectedTx.category_id
              ? categoriesById.get(selectedTx.category_id)
              : undefined
          }
          account={accountsById.get(selectedTx.account_id)}
          toAccount={
            selectedTx.to_account_id
              ? accountsById.get(selectedTx.to_account_id)
              : undefined
          }
          hidden={hidden}
          busy={busy}
          onClose={() => onSelectTx(null)}
          onQuickEdit={onQuickEditTx}
          onFullEdit={onOpenFullTxEditor}
          onConfirmAmount={
            onOpenConfirmAmounts
              ? (tx) => onOpenConfirmAmounts(tx.id)
              : undefined
          }
          onDelete={onDeleteTx}
        />
      )}

      {(quickAdd || editingQuickTx) && (
        <MobileQuickAddSheet
          ledger={ledger}
          initialDraft={quickAdd ?? undefined}
          editingTx={editingQuickTx}
          busy={busy}
          online={online}
          demo={demo}
          onClose={onCloseQuickAdd}
          onSave={onSaveTransaction}
          onAddAccount={onAddAccount}
          onOpenFullEditor={onOpenFullTxEditor}
        />
      )}
    </div>
  );
}
