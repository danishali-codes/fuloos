import { useMemo, useState } from "react";
import {
  MessageSquareText,
  Pencil,
  Plus,
  ReceiptText,
  Trash2,
  X,
} from "lucide-react";
import { computeCardSummary } from "../debtTools";
import {
  accountCurrency,
  balance,
  money,
  reportingCurrency,
  today,
  type Account,
  type Ledger,
  type Transaction,
} from "../domain";
import { translateText as uiText } from "../i18n";
import type { SmsAccountLink } from "../mobile/smsLinks";
import { lightenHex } from "./isMobileApkMode";

function accountTypeLabel(type: Account["type"]): string {
  switch (type) {
    case "current":
      return uiText("Checking");
    case "savings":
      return uiText("Savings");
    case "credit_card":
      return uiText("Credit Card");
    case "cash":
      return uiText("Cash");
    default:
      return uiText("Account");
  }
}

export function MobileAccounts({
  ledger,
  monthly,
  net,
  hidden,
  smsLinks,
  onAddAccount,
  onEditAccount,
  onDeleteAccount,
  onViewTransactions,
  onOpenSmsAutoCapture,
}: {
  ledger: Ledger;
  monthly: Transaction[];
  net: number;
  hidden: boolean;
  smsLinks: SmsAccountLink[];
  onAddAccount: () => void;
  onEditAccount: (acc: Account) => void;
  onDeleteAccount: (acc: Account) => void;
  onViewTransactions: (accountId: string) => void;
  onOpenSmsAutoCapture: (accountId?: string) => void;
}) {
  const [selectedAcc, setSelectedAcc] = useState<Account | null>(null);
  const todayIso = today();
  const repCurr = reportingCurrency(ledger);

  const linksByAccount = useMemo(() => {
    const map = new Map<string, SmsAccountLink[]>();
    for (const l of smsLinks) {
      if (!l.enabled) continue;
      const list = map.get(l.account_id);
      if (list) list.push(l);
      else map.set(l.account_id, [l]);
    }
    return map;
  }, [smsLinks]);

  const monthFlowByAccount = useMemo(() => {
    const map = new Map<string, { inflow: number; outflow: number }>();
    for (const tx of monthly) {
      const from = map.get(tx.account_id) ?? { inflow: 0, outflow: 0 };
      if (tx.type === "income") from.inflow += tx.amount;
      else from.outflow += tx.amount;
      map.set(tx.account_id, from);
      if (tx.type === "transfer" && tx.to_account_id) {
        const to = map.get(tx.to_account_id) ?? { inflow: 0, outflow: 0 };
        to.inflow += tx.to_amount ?? tx.amount;
        map.set(tx.to_account_id, to);
      }
    }
    return map;
  }, [monthly]);

  const fmt = (minorVal: number, curr = repCurr) =>
    hidden ? "••••••" : money(minorVal, curr);
  const activeSmsCount = smsLinks.filter((l) => l.enabled).length;

  return (
    <div className="m-page">
      {/* Header */}
      <div className="m-page-head">
        <div>
          <h1 className="m-page-title">{uiText("Accounts")}</h1>
          <div className="m-page-sub m-num">
            {uiText("Total")} {fmt(net, repCurr)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            className="m-pill-btn is-soft"
            onClick={() => onOpenSmsAutoCapture()}
          >
            <MessageSquareText size={14} />
            <span>
              {activeSmsCount > 0 ? `${activeSmsCount} SMS` : "SMS"}
            </span>
          </button>
          <button
            type="button"
            className="m-pill-btn is-brand"
            onClick={onAddAccount}
          >
            <Plus size={14} />
            <span>{uiText("New")}</span>
          </button>
        </div>
      </div>

      {ledger.accounts.length === 0 ? (
        <div className="m-empty">
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--m-text)" }}>
            {uiText("No accounts yet")}
          </div>
          <div style={{ fontSize: 12.5 }}>
            {uiText("Add your bank accounts, credit cards, or cash wallets.")}
          </div>
          <button
            type="button"
            className="m-pill-btn is-brand"
            onClick={onAddAccount}
          >
            <Plus size={14} /> {uiText("Add account")}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {ledger.accounts.map((acc) => {
            const bal = balance(acc, ledger.transactions);
            const accCurr = accountCurrency(acc);
            const baseColor = acc.color || "#1b5a45";
            const endColor = lightenHex(baseColor, 20);
            const accLinks = linksByAccount.get(acc.id) ?? [];
            const firstLink = accLinks[0];
            const smsLabel = firstLink
              ? `${firstLink.senders[0] ?? "SMS"}${firstLink.card_last4 ? ` · ••${firstLink.card_last4}` : ""}`
              : null;

            const isCredit = acc.type === "credit_card";
            const cardSummary = isCredit
              ? computeCardSummary(acc, bal, ledger.transactions, todayIso)
              : null;
            const flow = monthFlowByAccount.get(acc.id) ?? {
              inflow: 0,
              outflow: 0,
            };

            return (
              <button
                key={acc.id}
                type="button"
                className="m-account-card"
                style={{
                  background: `linear-gradient(135deg, ${baseColor}, ${endColor})`,
                }}
                onClick={() => setSelectedAcc(acc)}
              >
                <div className="m-account-orb" aria-hidden />
                <div className="m-account-top">
                  <div>
                    <div className="m-account-type">
                      {acc.emoji ? `${acc.emoji} ` : ""}
                      {accountTypeLabel(acc.type)} · {accCurr}
                    </div>
                    <div className="m-account-name">{acc.name}</div>
                  </div>
                  {smsLabel ? (
                    <span className="m-account-sms-pill">
                      <MessageSquareText size={11} />
                      <span>{smsLabel}</span>
                    </span>
                  ) : (
                    <span className="m-account-sms-pill is-manual">
                      {uiText("Manual")}
                    </span>
                  )}
                </div>

                <div className="m-account-bal m-num">{fmt(bal, accCurr)}</div>

                {cardSummary && cardSummary.creditLimitFils > 0 ? (
                  <div className="m-account-util">
                    <div className="m-account-util-row">
                      <span>
                        {uiText("Used")} · {Math.round(cardSummary.utilizationPct)}%{" "}
                        {uiText("of")} {fmt(cardSummary.creditLimitFils, accCurr)}
                      </span>
                      {acc.payment_due_day && (
                        <strong>
                          {uiText("Due")} {acc.payment_due_day}
                        </strong>
                      )}
                    </div>
                    <div className="m-account-util-track">
                      <div
                        className="m-account-util-fill"
                        style={{
                          width: `${Math.min(100, cardSummary.utilizationPct)}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="m-account-foot">
                    <span>
                      {uiText("In")}:{" "}
                      <strong className="m-num">
                        {hidden ? "••••" : `+${money(flow.inflow, accCurr)}`}
                      </strong>
                    </span>
                    <span>
                      {uiText("Out")}:{" "}
                      <strong className="m-num">
                        {hidden ? "••••" : `−${money(flow.outflow, accCurr)}`}
                      </strong>
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Account Action Bottom Sheet */}
      {selectedAcc && (
        <div
          className="m-sheet-backdrop"
          role="presentation"
          onClick={() => setSelectedAcc(null)}
        >
          <div
            className="m-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={selectedAcc.name}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="m-sheet-handle" aria-hidden />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ fontSize: 17, fontWeight: 800 }}>
                  {selectedAcc.name}
                </div>
                <div
                  className="m-num"
                  style={{ fontSize: 13, color: "var(--m-muted)" }}
                >
                  {accountTypeLabel(selectedAcc.type)} ·{" "}
                  {fmt(
                    balance(selectedAcc, ledger.transactions),
                    accountCurrency(selectedAcc),
                  )}
                </div>
              </div>
              <button
                type="button"
                className="m-icon-circle"
                aria-label={uiText("Close")}
                onClick={() => setSelectedAcc(null)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="m-card m-pref-list">
              <button
                type="button"
                className="m-pref-row"
                onClick={() => {
                  const id = selectedAcc.id;
                  setSelectedAcc(null);
                  onViewTransactions(id);
                }}
              >
                <span className="m-pref-left">
                  <ReceiptText size={17} /> {uiText("View Activity")}
                </span>
              </button>
              <button
                type="button"
                className="m-pref-row"
                onClick={() => {
                  const id = selectedAcc.id;
                  setSelectedAcc(null);
                  onOpenSmsAutoCapture(id);
                }}
              >
                <span className="m-pref-left">
                  <MessageSquareText size={17} /> {uiText("SMS Auto-Capture & Backfill")}
                </span>
              </button>
              <button
                type="button"
                className="m-pref-row"
                onClick={() => {
                  const acc = selectedAcc;
                  setSelectedAcc(null);
                  onEditAccount(acc);
                }}
              >
                <span className="m-pref-left">
                  <Pencil size={17} /> {uiText("Edit Account")}
                </span>
              </button>
              <button
                type="button"
                className="m-pref-row is-danger"
                onClick={() => {
                  const acc = selectedAcc;
                  setSelectedAcc(null);
                  onDeleteAccount(acc);
                }}
              >
                <span className="m-pref-left">
                  <Trash2 size={17} /> {uiText("Delete Account")}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
