import { useEffect } from "react";
import { App as CapApp } from "@capacitor/app";
import { StatusBar, Style } from "@capacitor/status-bar";
import type { Session } from "../client";
import type { Ledger } from "../domain";
import { loadLedgerModel } from "../ledger/loader";
import { loadMap } from "../ledger/mapping";
import type { LearningStore } from "../ledger/learningStore";
import { platformBridge } from "./platformBridge";
import type { SmsAccountLink } from "./smsLinks";
import type { SmsEngineContext } from "./smsPipeline";

/**
 * Coordinates Capacitor native mobile lifecycle hooks:
 *  - Syncs PocketBase auth session into Android Keystore (EncryptedSharedPreferences)
 *  - Syncs serialized SMS engine context (links, categories, rules, ML examples, base model) for offline background processing
 *  - Syncs Android StatusBar color with Fuloos light/dark theme
 *  - Handles hardware Back button and deep links from Android notifications
 *  - Refreshes ledger on resume or when background SMS processing adds a transaction
 */
export function useNativeMobile({
  demo,
  pbUrl,
  session,
  ledger,
  links,
  learningStore,
  page,
  hasOpenModal,
  onCloseTopModal,
  onNavigate,
  onOpenCaptureAlerts,
  onOpenSmsAutoCapture,
  onReloadLedger,
}: {
  demo: boolean;
  pbUrl: string;
  session: Session | null;
  ledger: Ledger;
  links: SmsAccountLink[];
  learningStore: LearningStore;
  page: string;
  hasOpenModal: boolean;
  onCloseTopModal: () => void;
  onNavigate: (page: string) => void;
  onOpenCaptureAlerts: () => void;
  onOpenSmsAutoCapture: () => void;
  onReloadLedger: () => void;
}) {
  // 1. Sync PocketBase auth credentials into Android EncryptedSharedPreferences
  useEffect(() => {
    if (!platformBridge.isNativePlatform()) return;
    if (!demo && session && pbUrl) {
      void platformBridge.syncAuthSession(pbUrl, session.token, session.user.id);
    } else {
      void platformBridge.clearAuthSession();
    }
  }, [demo, pbUrl, session?.token, session?.user.id]);

  // 2. Sync serialized engine context for headless Android WorkManager background processing
  useEffect(() => {
    if (!platformBridge.isNativePlatform() || demo || !session) return;
    let active = true;
    const owner = session.user.id;
    const categoryIds = new Set(ledger.categories.map((c) => c.id));

    void (async () => {
      try {
        const [modelState, learnData] = await Promise.all([
          loadLedgerModel(),
          learningStore.load(categoryIds).catch(() => null),
        ]);
        if (!active) return;
        const baseMap = loadMap(owner, ledger.categories).map;
        const mergedMap = learnData?.storedMap
          ? { ...baseMap, ...learnData.storedMap }
          : baseMap;

        const ctx: SmsEngineContext = {
          links,
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
          learningSettings: learnData?.settings ?? null,
          learningExamples: learnData?.examples ?? [],
          categoryMap: mergedMap,
          baseModel: modelState.status === "ready" ? modelState.model : null,
        };
        await platformBridge.syncEngineContext(ctx);
      } catch {
        /* ignore background sync errors */
      }
    })();

    return () => {
      active = false;
    };
  }, [
    demo,
    session?.user.id,
    links,
    ledger.accounts,
    ledger.categories,
    ledger.rules,
    learningStore,
  ]);

  // 3. Sync StatusBar with light/dark theme attribute on <html>
  useEffect(() => {
    if (!platformBridge.isNativePlatform()) return;
    const applyTheme = () => {
      const dark = document.documentElement.dataset.theme === "dark";
      void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(
        () => {},
      );
      if (platformBridge.getPlatform() === "android") {
        void StatusBar.setBackgroundColor({
          color: dark ? "#161f1c" : "#fcfcfa",
        }).catch(() => {});
      }
    };
    applyTheme();
    const obs = new MutationObserver(applyTheme);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  // 4. Hardware Back button on Android
  useEffect(() => {
    if (!platformBridge.isNativePlatform()) return;
    let handle: { remove: () => Promise<void> } | null = null;
    void CapApp.addListener("backButton", () => {
      if (hasOpenModal) {
        onCloseTopModal();
        return;
      }
      if (page !== "Overview") {
        onNavigate("Overview");
        return;
      }
      void CapApp.minimizeApp().catch(() => {});
    }).then((h) => {
      handle = h;
    });
    return () => {
      void handle?.remove();
    };
  }, [hasOpenModal, page, onCloseTopModal, onNavigate]);

  // 5. Notification deep links, live smsProcessed refresh, and resume catch-up sync
  useEffect(() => {
    if (!platformBridge.isNativePlatform()) return;
    let deepLinkHandle: { remove: () => Promise<void> } | null = null;
    let smsHandle: { remove: () => Promise<void> } | null = null;
    let resumeHandle: { remove: () => Promise<void> } | null = null;

    const dispatchDeepLink = (action: string) => {
      if (action === "open_review") {
        onOpenCaptureAlerts();
        onReloadLedger();
      } else if (action === "open_sms_settings") {
        onOpenSmsAutoCapture();
      } else if (action === "open_transaction") {
        onNavigate("Transactions");
        onReloadLedger();
      }
    };

    void platformBridge.getPendingDeepLink().then((ev) => {
      if (ev) dispatchDeepLink(ev.action);
    });
    void platformBridge
      .onDeepLink((ev) => dispatchDeepLink(ev.action))
      .then((h) => {
        deepLinkHandle = h;
      });
    void platformBridge
      .onSmsProcessed(() => {
        onReloadLedger();
      })
      .then((h) => {
        smsHandle = h;
      });
    void CapApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive && !demo && session) {
        void platformBridge.triggerCatchUpSync();
        onReloadLedger();
      }
    }).then((h) => {
      resumeHandle = h;
    });

    return () => {
      void deepLinkHandle?.remove();
      void smsHandle?.remove();
      void resumeHandle?.remove();
    };
  }, [
    demo,
    session?.user.id,
    onNavigate,
    onOpenCaptureAlerts,
    onOpenSmsAutoCapture,
    onReloadLedger,
  ]);
}
