import {
  Home,
  LayoutGrid,
  Plus,
  ReceiptText,
  Wallet,
} from "lucide-react";
import { translateText as uiText } from "../i18n";

export type MobileTabId = "Overview" | "Transactions" | "Accounts" | "More";

export function MobileBottomNav({
  activeTab,
  pendingAlertCount,
  disabled,
  onSelectTab,
  onQuickAdd,
}: {
  activeTab: MobileTabId;
  pendingAlertCount: number;
  disabled?: boolean;
  onSelectTab: (tab: MobileTabId) => void;
  onQuickAdd: () => void;
}) {
  return (
    <nav className="m-nav" aria-label={uiText("Primary navigation")}>
      <div className="m-nav-inner">
        <button
          type="button"
          className={`m-nav-tab ${activeTab === "Overview" ? "is-active" : ""}`}
          aria-current={activeTab === "Overview" ? "page" : undefined}
          onClick={() => onSelectTab("Overview")}
        >
          <span className="m-nav-icon-pill">
            <Home size={20} />
          </span>
          <span>{uiText("Home")}</span>
        </button>

        <button
          type="button"
          className={`m-nav-tab ${activeTab === "Transactions" ? "is-active" : ""}`}
          aria-current={activeTab === "Transactions" ? "page" : undefined}
          onClick={() => onSelectTab("Transactions")}
        >
          <span className="m-nav-icon-pill">
            <ReceiptText size={20} />
          </span>
          <span>{uiText("Activity")}</span>
        </button>

        <div className="m-nav-fab-slot">
          <button
            type="button"
            className="m-nav-fab"
            disabled={disabled}
            aria-label={uiText("Add transaction")}
            onClick={onQuickAdd}
          >
            <Plus size={26} strokeWidth={2.6} />
          </button>
        </div>

        <button
          type="button"
          className={`m-nav-tab ${activeTab === "Accounts" ? "is-active" : ""}`}
          aria-current={activeTab === "Accounts" ? "page" : undefined}
          onClick={() => onSelectTab("Accounts")}
        >
          <span className="m-nav-icon-pill">
            <Wallet size={20} />
          </span>
          <span>{uiText("Accounts")}</span>
        </button>

        <button
          type="button"
          className={`m-nav-tab ${activeTab === "More" ? "is-active" : ""}`}
          aria-current={activeTab === "More" ? "page" : undefined}
          onClick={() => onSelectTab("More")}
        >
          <span className="m-nav-icon-pill">
            <LayoutGrid size={20} />
            {pendingAlertCount > 0 && <span className="m-icon-dot" aria-hidden />}
          </span>
          <span>{uiText("More")}</span>
        </button>
      </div>
    </nav>
  );
}
