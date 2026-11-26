import { useEffect } from "react";
import { App as CapApp } from "@capacitor/app";
import { StatusBar, Style } from "@capacitor/status-bar";
import type { Session } from "../client";
import type { Ledger } from "../domain";
import { loadLedgerModel } from "../ledger/loader";
import { loadMap } from "../ledger/mapping";
import type { LearningStore } from "../ledger/learningStore";
import { platformBridge, type NativeAuthRegistration } from "./platformBridge";
import type { SmsAccountLink } from "./smsLinks";
import {
  collectExistingDedupeKeys,
  type SmsEngineContext,
} from "./smsPipeline";

/**
 * Coordinates Capacitor native mobile lifecycle hooks:
 *  - Registers the signed-in account with the Android background SMS workers
 *    (PocketBase token, or the Supabase project whose session they share via the Keystore)
 *  - Syncs serialized SMS engine context (links, categories, rules, ML examples, base model, existing ledger keys) for offline background processing
 *  - Syncs Android StatusBar color with Fuloos light/dark theme
 *  - Handles hardware Back button and deep links from Android notifications
 *  - Refreshes ledger on resume or when background SMS processing adds a transaction
 */
export function useNativeMobile({
  demo,
  nativeAuth,
  onResumeSession,
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
  /** Background-sync registration for the signed-in account (null when signed out). */
  nativeAuth: NativeAuthRegistration | null;
  /** Called on resume so the app adopts tokens the background workers refreshed. */
  onResumeSession?: () => Promise<void>;
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
  const ownerKey =
    !demo && session && nativeAuth
      ? `${nativeAuth.url.trim().replace(/\/+$/, "")}|${session.user.id}`
      : "";
  const authKey = demo || !nativeAuth ? "" : JSON.stringify(nativeAuth);

  // 1. Register the account with the Android background workers (Keystore-backed)
  useEffect(() => {
    if (!platformBridge.isNativePlatform()) return;
    if (!demo && session && nativeAuth) {
      void platformBridge.syncAuthSession(nativeAuth);
    } else {
      void platformBridge.clearAuthSession();
    }
    // authKey captures every field of nativeAuth (including a PocketBase token change).
  }, [demo, authKey, session?.user.id]);

  // 2. Sync serialized engine context for headless Android WorkManager background processing
  useEffect(() => {
    if (!platformBridge.isNativePlatform() || demo || !session || !ownerKey)
      return;
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
          existingKeys: collectExistingDedupeKeys(
            ledger.transactions,
            ledger.captured_alerts ?? [],
            undefined,
            5000,
          ),
        };
        await platformBridge.syncEngineContext(ctx, ownerKey);
      } catch {
        /* ignore background sync errors */
      }
    })();

    return () => {
      active = false;
    };
  }, [
    demo,
    ownerKey,
    session?.user.id,
    links,
    ledger.accounts,
    ledger.categories,
    ledger.rules,
    ledger.transactions,
    ledger.captured_alerts,
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
          color: dark ? "#0f1914" : "#f5f7f3",
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
    const secondaryPages = new Set([
      "Budgets",
      "Recurring",
      "Goals",
      "Net Worth",
      "Reports",
      "Categories",
    ]);
    void CapApp.addListener("backButton", () => {
      if (hasOpenModal) {
        onCloseTopModal();
        return;
      }
      if (secondaryPages.has(page)) {
        onNavigate("More");
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
        void (async () => {
          await onResumeSession?.();
          void platformBridge.triggerCatchUpSync();
          onReloadLedger();
        })();
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
    onResumeSession,
  ]);
}
