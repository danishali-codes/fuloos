import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { maskForDisplay } from "../ledger/sms.ts";
import {
  detectBankForSenderOrText,
  extractCardLast4,
  normalizeSender,
  type DiscoveredSmsSender,
  type SmsAccountLink,
} from "./smsLinks.ts";
import type { RawNativeSms, SmsEngineContext } from "./smsPipeline.ts";

export type PlatformKind = "android" | "ios" | "web";
export type BuildFlavor = "direct" | "play" | "web";

export interface SmsPermissionStatus {
  readSms: boolean;
  receiveSms: boolean;
  postNotifications: boolean;
  ignoringBatteryOptimizations: boolean;
  supportsDirectSms: boolean;
  buildFlavor: BuildFlavor;
}

export interface NativeDeepLinkEvent {
  action: "open_review" | "open_transaction" | "open_sms_settings";
  alertId?: string;
  transactionId?: string;
}

export interface NativeSmsProcessedEvent {
  action: "auto_add" | "needs_review";
  transactionId?: string;
  alertId?: string;
  accountId?: string;
}

interface FuloosSmsPluginInterface {
  getPermissionStatus(): Promise<SmsPermissionStatus>;
  requestSmsPermissions(): Promise<SmsPermissionStatus>;
  listSmsSenders(): Promise<{ senders: DiscoveredSmsSender[] }>;
  readHistoricalSms(options: {
    senders: string[];
    sinceTimestampMs?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ messages: RawNativeSms[]; total: number; hasMore: boolean }>;
  getLinks(options?: { ownerKey?: string }): Promise<{ links: SmsAccountLink[] }>;
  saveLinks(options: {
    links: SmsAccountLink[];
    ownerKey?: string;
  }): Promise<{ ok: boolean }>;
  syncEngineContext(options: {
    contextJson: string;
    ownerKey?: string;
  }): Promise<{ ok: boolean }>;
  syncAuthSession(options: {
    pbUrl: string;
    token: string;
    userId: string;
  }): Promise<{ ok: boolean }>;
  clearAuthSession(): Promise<{ ok: boolean }>;
  markHashesProcessed(options: {
    ownerKey?: string;
    entries: Array<{
      smsHash: string;
      androidSmsId?: string;
      accountId?: string;
      transactionId?: string;
      status: string;
    }>;
  }): Promise<{ ok: boolean }>;
  triggerCatchUpSync(): Promise<{ enqueued: boolean }>;
  openNotificationSettings(options?: { channelId?: string }): Promise<void>;
  openBatteryOptimizationSettings(): Promise<void>;
  isBiometricAvailable(): Promise<{ available: boolean }>;
  authenticateBiometric(options: {
    title: string;
    subtitle?: string;
  }): Promise<{ authenticated: boolean }>;
  getPendingDeepLink(): Promise<{ event: NativeDeepLinkEvent | null }>;
  addListener(
    eventName: "deepLink",
    listenerFunc: (event: NativeDeepLinkEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "smsProcessed",
    listenerFunc: (event: NativeSmsProcessedEvent) => void,
  ): Promise<PluginListenerHandle>;
}

const FuloosSmsNative = registerPlugin<FuloosSmsPluginInterface>("FuloosSms");

const WEB_LINKS_STORAGE_KEY = "fuloos.mobile.smsLinks.v1";

/** Realistic UAE bank SMS samples used ONLY in demo mode on web so the linking & backfill workflow can be previewed end-to-end. */
const DEMO_SAMPLE_SMS: RawNativeSms[] = [
  {
    id: "demo-1",
    sender: "ADCB",
    timestampMs: Date.now() - 1000 * 60 * 60 * 24 * 12,
    body: "AED 48.50 spent on your ADCB Card XX4512 at TALABAT, DUBAI-AE on 07/11/2026. Avl Bal is AED 4,210.50.",
  },
  {
    id: "demo-2",
    sender: "ADCB",
    timestampMs: Date.now() - 1000 * 60 * 60 * 24 * 10,
    body: "AED 32.00 spent on your ADCB Card XX4512 at BOON SPECIALTY COFFEE, DUBAI-AE on 09/11/2026. Avl Bal is AED 4,178.50.",
  },
  {
    id: "demo-3",
    sender: "ADCB",
    timestampMs: Date.now() - 1000 * 60 * 60 * 24 * 8,
    body: "AED 29.00 spent on your ADCB Card XX4512 at BOON SPECIALTY COFFEE, DUBAI-AE on 11/11/2026. Avl Bal is AED 4,149.50.",
  },
  {
    id: "demo-4",
    sender: "ADCB",
    timestampMs: Date.now() - 1000 * 60 * 60 * 24 * 6,
    body: "AED 184.25 spent on your ADCB Card XX8891 at CARREFOUR, DUBAI-AE on 13/11/2026. Avl Bal is AED 12,400.00.",
  },
  {
    id: "demo-5",
    sender: "ADCB",
    timestampMs: Date.now() - 1000 * 60 * 60 * 24 * 5,
    body: "Your OTP for ADCB online payment is 482910. Do not share it with anyone.",
  },
  {
    id: "demo-6",
    sender: "Liv",
    timestampMs: Date.now() - 1000 * 60 * 60 * 24 * 4,
    body: "Purchase of AED 142.00 with Debit Card ending 3319 at ENOC 1042, DUBAI. Avl Bal is AED 3,890.00.",
  },
  {
    id: "demo-7",
    sender: "Liv",
    timestampMs: Date.now() - 1000 * 60 * 60 * 24 * 2,
    body: "Purchase of AED 76.00 with Debit Card ending 3319 at AL MARWA ROASTERY, SHARJAH. Avl Bal is AED 3,814.00.",
  },
];

function linksStorageKey(ownerKey?: string): string {
  return ownerKey ? `${WEB_LINKS_STORAGE_KEY}:${ownerKey}` : WEB_LINKS_STORAGE_KEY;
}

function readLocalLinks(ownerKey?: string): SmsAccountLink[] {
  try {
    const raw = window.localStorage.getItem(linksStorageKey(ownerKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SmsAccountLink[]) : [];
  } catch {
    return [];
  }
}

function writeLocalLinks(links: SmsAccountLink[], ownerKey?: string): void {
  try {
    window.localStorage.setItem(linksStorageKey(ownerKey), JSON.stringify(links));
  } catch {
    /* ignore storage quota errors */
  }
}

function summarizeSampleSenders(messages: RawNativeSms[]): DiscoveredSmsSender[] {
  const bySender = new Map<
    string,
    {
      address: string;
      count: number;
      latestTimestamp: number;
      latestBody: string;
      cards: Set<string>;
    }
  >();
  for (const m of messages) {
    const norm = normalizeSender(m.sender);
    if (!norm) continue;
    const card = extractCardLast4(m.body, null);
    const existing = bySender.get(norm);
    if (existing) {
      existing.count++;
      if (m.timestampMs > existing.latestTimestamp) {
        existing.latestTimestamp = m.timestampMs;
        existing.latestBody = m.body;
      }
      if (card) existing.cards.add(card);
    } else {
      const cards = new Set<string>();
      if (card) cards.add(card);
      bySender.set(norm, {
        address: m.sender,
        count: 1,
        latestTimestamp: m.timestampMs,
        latestBody: m.body,
        cards,
      });
    }
  }
  return [...bySender.entries()].map(([normalized, info]) => ({
    address: info.address,
    normalized,
    messageCount: info.count,
    latestTimestamp: info.latestTimestamp,
    sampleMasked: maskForDisplay(info.latestBody).slice(0, 120),
    detectedBank: detectBankForSenderOrText(info.address, info.latestBody),
    detectedCardLast4s: [...info.cards].sort(),
  }));
}

export function getPlatform(): PlatformKind {
  const p = Capacitor.getPlatform();
  if (p === "android" || p === "ios") return p;
  return "web";
}

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export const platformBridge = {
  getPlatform,
  isNativePlatform,

  async getPermissionStatus(): Promise<SmsPermissionStatus> {
    if (!isNativePlatform() || getPlatform() !== "android") {
      return {
        readSms: false,
        receiveSms: false,
        postNotifications: false,
        ignoringBatteryOptimizations: false,
        supportsDirectSms: false,
        buildFlavor: "web",
      };
    }
    try {
      return await FuloosSmsNative.getPermissionStatus();
    } catch {
      return {
        readSms: false,
        receiveSms: false,
        postNotifications: false,
        ignoringBatteryOptimizations: false,
        supportsDirectSms: false,
        buildFlavor: "play",
      };
    }
  },

  async requestSmsPermissions(): Promise<SmsPermissionStatus> {
    if (!isNativePlatform() || getPlatform() !== "android") {
      return this.getPermissionStatus();
    }
    return FuloosSmsNative.requestSmsPermissions();
  },

  async listSmsSenders(demoFallback = false): Promise<DiscoveredSmsSender[]> {
    if (isNativePlatform() && getPlatform() === "android") {
      const res = await FuloosSmsNative.listSmsSenders();
      return res.senders ?? [];
    }
    return demoFallback ? summarizeSampleSenders(DEMO_SAMPLE_SMS) : [];
  },

  async readHistoricalSms(
    senders: string[],
    options: {
      sinceTimestampMs?: number;
      limit?: number;
      offset?: number;
      demoFallback?: boolean;
    } = {},
  ): Promise<{ messages: RawNativeSms[]; total: number; hasMore: boolean }> {
    if (isNativePlatform() && getPlatform() === "android") {
      return FuloosSmsNative.readHistoricalSms({
        senders,
        sinceTimestampMs: options.sinceTimestampMs ?? 0,
        limit: options.limit ?? 500,
        offset: options.offset ?? 0,
      });
    }
    if (!options.demoFallback) {
      return { messages: [], total: 0, hasMore: false };
    }
    const norm = new Set(senders.map(normalizeSender));
    const filtered = DEMO_SAMPLE_SMS.filter(
      (m) =>
        norm.has(normalizeSender(m.sender)) &&
        (!options.sinceTimestampMs || m.timestampMs > options.sinceTimestampMs),
    );
    return { messages: filtered, total: filtered.length, hasMore: false };
  },

  async getLinks(ownerKey?: string): Promise<SmsAccountLink[]> {
    if (isNativePlatform() && getPlatform() === "android" && ownerKey !== "demo") {
      try {
        const res = await FuloosSmsNative.getLinks({ ownerKey });
        return res.links ?? [];
      } catch {
        return readLocalLinks(ownerKey);
      }
    }
    return readLocalLinks(ownerKey);
  },

  async saveLinks(links: SmsAccountLink[], ownerKey?: string): Promise<void> {
    writeLocalLinks(links, ownerKey);
    if (isNativePlatform() && getPlatform() === "android" && ownerKey !== "demo") {
      await FuloosSmsNative.saveLinks({ links, ownerKey });
    }
  },

  async syncEngineContext(ctx: SmsEngineContext, ownerKey?: string): Promise<void> {
    if (!isNativePlatform() || getPlatform() !== "android") return;
    try {
      await FuloosSmsNative.syncEngineContext({
        contextJson: JSON.stringify(ctx),
        ownerKey,
      });
    } catch {
      /* non-fatal if plugin unavailable */
    }
  },

  async syncAuthSession(
    pbUrl: string,
    token: string,
    userId: string,
  ): Promise<void> {
    if (!isNativePlatform() || getPlatform() !== "android") return;
    try {
      await FuloosSmsNative.syncAuthSession({ pbUrl, token, userId });
    } catch {
      /* ignore */
    }
  },

  async clearAuthSession(): Promise<void> {
    if (!isNativePlatform() || getPlatform() !== "android") return;
    try {
      await FuloosSmsNative.clearAuthSession();
    } catch {
      /* ignore */
    }
  },

  async markHashesProcessed(
    entries: Array<{
      smsHash: string;
      androidSmsId?: string;
      accountId?: string;
      transactionId?: string;
      status: string;
    }>,
    ownerKey?: string,
  ): Promise<void> {
    if (!isNativePlatform() || getPlatform() !== "android" || !entries.length) {
      return;
    }
    try {
      await FuloosSmsNative.markHashesProcessed({ entries, ownerKey });
    } catch {
      /* ignore */
    }
  },

  async triggerCatchUpSync(): Promise<boolean> {
    if (!isNativePlatform() || getPlatform() !== "android") return false;
    try {
      const res = await FuloosSmsNative.triggerCatchUpSync();
      return Boolean(res.enqueued);
    } catch {
      return false;
    }
  },

  async openNotificationSettings(channelId?: string): Promise<void> {
    if (!isNativePlatform() || getPlatform() !== "android") return;
    await FuloosSmsNative.openNotificationSettings({ channelId });
  },

  async openBatteryOptimizationSettings(): Promise<void> {
    if (!isNativePlatform() || getPlatform() !== "android") return;
    await FuloosSmsNative.openBatteryOptimizationSettings();
  },

  async isBiometricAvailable(): Promise<boolean> {
    if (!isNativePlatform()) return false;
    try {
      const res = await FuloosSmsNative.isBiometricAvailable();
      return Boolean(res.available);
    } catch {
      return false;
    }
  },

  async authenticateBiometric(
    title: string,
    subtitle?: string,
  ): Promise<boolean> {
    if (!isNativePlatform()) return false;
    try {
      const res = await FuloosSmsNative.authenticateBiometric({
        title,
        subtitle,
      });
      return Boolean(res.authenticated);
    } catch {
      return false;
    }
  },

  async getPendingDeepLink(): Promise<NativeDeepLinkEvent | null> {
    if (!isNativePlatform() || getPlatform() !== "android") return null;
    try {
      const res = await FuloosSmsNative.getPendingDeepLink();
      return res.event ?? null;
    } catch {
      return null;
    }
  },

  async onDeepLink(
    handler: (event: NativeDeepLinkEvent) => void,
  ): Promise<PluginListenerHandle | null> {
    if (!isNativePlatform() || getPlatform() !== "android") return null;
    return FuloosSmsNative.addListener("deepLink", handler);
  },

  async onSmsProcessed(
    handler: (event: NativeSmsProcessedEvent) => void,
  ): Promise<PluginListenerHandle | null> {
    if (!isNativePlatform() || getPlatform() !== "android") return null;
    return FuloosSmsNative.addListener("smsProcessed", handler);
  },
};
