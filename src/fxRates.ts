import {
  getPeggedFallbackRate,
  isThreeLetterCurrencyCode,
  normalizeCurrencyCode,
  USD_TO_AED_PEG,
  type FxSource,
  type FxStatus,
} from "./currency.ts";
import { addDaysIso, uaeToday } from "./domain.ts";

export interface RateResult {
  from: string;
  to: string;
  rate: number;
  /** Effective YYYY-MM-DD rate date actually returned (may precede weekends/holidays). */
  rateDate: string;
  provider: string;
}

export interface RateProvider {
  readonly name: string;
  getRate(from: string, to: string, date: string): Promise<RateResult | null>;
  getRatesForBase?(
    base: string,
    date: string,
  ): Promise<{ rateDate: string; rates: Record<string, number>; provider: string } | null>;
}

export interface CachedFxRateEntry {
  base: string;
  quote: string;
  rateDate: string;
  rate: number;
  provider: string;
  fetchedAt: number;
}

export interface ResolvedRate {
  from: string;
  to: string;
  rate: number | null;
  rateDate: string;
  source: FxSource | null;
  status: FxStatus;
  provider: string | null;
  warning?: "rate_unavailable";
}

export interface FxRateStore {
  getAll(): Promise<CachedFxRateEntry[]>;
  putMany(entries: CachedFxRateEntry[]): Promise<void>;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDateOrToday(date: string | null | undefined): string {
  const trimmed = (date ?? "").trim().slice(0, 10);
  return ISO_DATE_RE.test(trimmed) ? trimmed : uaeToday();
}

function clampFutureDate(date: string, todayIso: string): { target: string; isFuture: boolean } {
  if (date > todayIso) return { target: todayIso, isFuture: true };
  return { target: date, isFuture: false };
}

/**
 * Primary FX provider: fawazahmed0/exchange-api (open-source, 200+ currencies including AED, daily history).
 * Uses jsDelivr CDN first and falls back to the documented Cloudflare Pages host.
 * Privacy: sends ONLY the lowercase base currency code and YYYY-MM-DD date.
 */
export class FawazAhmedProvider implements RateProvider {
  readonly name = "fawazahmed0";
  private readonly fetcher: typeof fetch;
  private readonly todayFn: () => string;

  constructor(
    fetcher: typeof fetch = (input, init) => fetch(input, init),
    todayFn: () => string = uaeToday,
  ) {
    this.fetcher = fetcher;
    this.todayFn = todayFn;
  }

  private async fetchSnapshot(
    baseLower: string,
    version: string,
  ): Promise<{ rateDate: string; rates: Record<string, number> } | null> {
    const urls = [
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${version}/v1/currencies/${baseLower}.json`,
      `https://${version}.currency-api.pages.dev/v1/currencies/${baseLower}.json`,
    ];
    for (const url of urls) {
      try {
        const res = await this.fetcher(url, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        if (!res.ok) continue;
        const json = (await res.json()) as Record<string, unknown>;
        const rateMap = json[baseLower];
        if (!rateMap || typeof rateMap !== "object" || Array.isArray(rateMap)) {
          continue;
        }
        const rates: Record<string, number> = {};
        for (const [k, v] of Object.entries(rateMap as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v) && v > 0) {
            rates[k.toUpperCase()] = v;
          }
        }
        const reportedDate =
          typeof json.date === "string" && ISO_DATE_RE.test(json.date)
            ? json.date
            : version === "latest"
              ? this.todayFn()
              : version;
        return { rateDate: reportedDate, rates };
      } catch {
        // Try fallback host
      }
    }
    return null;
  }

  async getRatesForBase(
    base: string,
    date: string,
  ): Promise<{ rateDate: string; rates: Record<string, number>; provider: string } | null> {
    const baseCode = normalizeCurrencyCode(base);
    if (!isThreeLetterCurrencyCode(baseCode)) return null;
    const baseLower = baseCode.toLowerCase();
    const todayIso = this.todayFn();
    const { target, isFuture } = clampFutureDate(validDateOrToday(date), todayIso);

    // For today or future dates, try the requested date then @latest, then step back up to 5 days.
    const versions: string[] = isFuture
      ? ["latest", target]
      : target === todayIso
        ? [target, "latest"]
        : [target];
    for (let d = 1; d <= 5; d++) {
      versions.push(addDaysIso(target, -d));
    }

    const tried = new Set<string>();
    for (const ver of versions) {
      if (tried.has(ver)) continue;
      tried.add(ver);
      const snap = await this.fetchSnapshot(baseLower, ver);
      if (snap && Object.keys(snap.rates).length > 0) {
        return { ...snap, provider: this.name };
      }
    }
    return null;
  }

  async getRate(from: string, to: string, date: string): Promise<RateResult | null> {
    const fromCode = normalizeCurrencyCode(from);
    const toCode = normalizeCurrencyCode(to);
    if (fromCode === toCode) {
      return {
        from: fromCode,
        to: toCode,
        rate: 1,
        rateDate: validDateOrToday(date),
        provider: this.name,
      };
    }
    const snap = await this.getRatesForBase(fromCode, date);
    if (!snap) return null;
    const rate = snap.rates[toCode];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
    return {
      from: fromCode,
      to: toCode,
      rate,
      rateDate: snap.rateDate,
      provider: this.name,
    };
  }
}

/**
 * Fallback FX provider: Frankfurter (ECB historical daily rates).
 * Because ECB does not publish AED, any pair involving AED is converted through USD
 * using the fixed 3.6725 AED/USD peg.
 * Privacy: sends ONLY currency codes and date.
 */
export class FrankfurterProvider implements RateProvider {
  readonly name = "frankfurter";
  private readonly fetcher: typeof fetch;
  private readonly todayFn: () => string;

  constructor(
    fetcher: typeof fetch = (input, init) => fetch(input, init),
    todayFn: () => string = uaeToday,
  ) {
    this.fetcher = fetcher;
    this.todayFn = todayFn;
  }

  private async fetchDirect(
    fromCode: string,
    toCode: string,
    date: string,
  ): Promise<{ rate: number; rateDate: string } | null> {
    const todayIso = this.todayFn();
    const { target } = clampFutureDate(validDateOrToday(date), todayIso);
    const url = `https://api.frankfurter.app/${encodeURIComponent(target)}?from=${encodeURIComponent(fromCode)}&to=${encodeURIComponent(toCode)}`;
    try {
      const res = await this.fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        date?: string;
        rates?: Record<string, number>;
      };
      const rate = json.rates?.[toCode];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
      const rateDate =
        typeof json.date === "string" && ISO_DATE_RE.test(json.date)
          ? json.date
          : target;
      return { rate, rateDate };
    } catch {
      return null;
    }
  }

  async getRate(from: string, to: string, date: string): Promise<RateResult | null> {
    const fromCode = normalizeCurrencyCode(from);
    const toCode = normalizeCurrencyCode(to);
    const cleanDate = validDateOrToday(date);
    if (fromCode === toCode) {
      return { from: fromCode, to: toCode, rate: 1, rateDate: cleanDate, provider: this.name };
    }
    if (
      (fromCode === "USD" && toCode === "AED") ||
      (fromCode === "AED" && toCode === "USD")
    ) {
      // ECB does not publish AED; let FxRateService fall through to pegged fallback (manual_rate).
      return null;
    }
    if (toCode === "AED") {
      const viaUsd = await this.fetchDirect(fromCode, "USD", cleanDate);
      if (!viaUsd) return null;
      return {
        from: fromCode,
        to: toCode,
        rate: viaUsd.rate * USD_TO_AED_PEG,
        rateDate: viaUsd.rateDate,
        provider: `${this.name}+peg`,
      };
    }
    if (fromCode === "AED") {
      const viaUsd = await this.fetchDirect("USD", toCode, cleanDate);
      if (!viaUsd) return null;
      return {
        from: fromCode,
        to: toCode,
        rate: viaUsd.rate / USD_TO_AED_PEG,
        rateDate: viaUsd.rateDate,
        provider: `${this.name}+peg`,
      };
    }
    const direct = await this.fetchDirect(fromCode, toCode, cleanDate);
    if (!direct) return null;
    return {
      from: fromCode,
      to: toCode,
      rate: direct.rate,
      rateDate: direct.rateDate,
      provider: this.name,
    };
  }
}

/**
 * Tries providers in priority order (e.g. Edge Function -> FawazAhmed -> Frankfurter).
 */
export class CompositeRateProvider implements RateProvider {
  readonly name = "composite";
  private readonly providers: readonly RateProvider[];

  constructor(providers: readonly RateProvider[]) {
    this.providers = providers;
  }

  async getRatesForBase(
    base: string,
    date: string,
  ): Promise<{ rateDate: string; rates: Record<string, number>; provider: string } | null> {
    for (const p of this.providers) {
      if (!p.getRatesForBase) continue;
      const res = await p.getRatesForBase(base, date);
      if (res) return res;
    }
    return null;
  }

  async getRate(from: string, to: string, date: string): Promise<RateResult | null> {
    for (const p of this.providers) {
      const res = await p.getRate(from, to, date);
      if (res) return res;
    }
    return null;
  }
}

/**
 * Calls the Supabase `fx-rate` Edge Function via a backend callback.
 * Privacy: sends ONLY `{ from, to, date }`.
 */
export class EdgeFunctionRateProvider implements RateProvider {
  readonly name = "supabase-edge";
  private readonly invoke: (
    from: string,
    to: string,
    date: string,
  ) => Promise<{ rate: number; rate_date: string; provider: string } | null>;

  constructor(
    invoke: (
      from: string,
      to: string,
      date: string,
    ) => Promise<{ rate: number; rate_date: string; provider: string } | null>,
  ) {
    this.invoke = invoke;
  }

  async getRate(from: string, to: string, date: string): Promise<RateResult | null> {
    const fromCode = normalizeCurrencyCode(from);
    const toCode = normalizeCurrencyCode(to);
    const cleanDate = validDateOrToday(date);
    if (fromCode === toCode) {
      return { from: fromCode, to: toCode, rate: 1, rateDate: cleanDate, provider: this.name };
    }
    try {
      const res = await this.invoke(fromCode, toCode, cleanDate);
      if (!res || !Number.isFinite(res.rate) || res.rate <= 0) return null;
      return {
        from: fromCode,
        to: toCode,
        rate: res.rate,
        rateDate: ISO_DATE_RE.test(res.rate_date) ? res.rate_date : cleanDate,
        provider: res.provider || this.name,
      };
    } catch {
      return null;
    }
  }
}

/** In-memory store (used in Node tests or when IndexedDB is unavailable). */
export class MemoryFxRateStore implements FxRateStore {
  private entries = new Map<string, CachedFxRateEntry>();

  async getAll(): Promise<CachedFxRateEntry[]> {
    return [...this.entries.values()];
  }

  async putMany(entries: CachedFxRateEntry[]): Promise<void> {
    for (const e of entries) {
      this.entries.set(rateKey(e.base, e.quote, e.rateDate), e);
    }
  }
}

/** IndexedDB persistent FX rate cache for web / Capacitor WebView. */
export class IndexedDbFxRateStore implements FxRateStore {
  private readonly dbName: string;
  private readonly storeName = "fx_rates";

  constructor(dbName = "fuloos_fx_rates_v1") {
    this.dbName = dbName;
  }

  private open(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: "key" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async getAll(): Promise<CachedFxRateEntry[]> {
    const db = await this.open();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readonly");
        const req = tx.objectStore(this.storeName).getAll();
        req.onsuccess = () => {
          const rows = Array.isArray(req.result) ? req.result : [];
          resolve(
            rows
              .filter(
                (r): r is CachedFxRateEntry & { key: string } =>
                  Boolean(r) &&
                  typeof r.base === "string" &&
                  typeof r.quote === "string" &&
                  typeof r.rateDate === "string" &&
                  typeof r.rate === "number" &&
                  r.rate > 0,
              )
              .map(({ base, quote, rateDate, rate, provider, fetchedAt }) => ({
                base,
                quote,
                rateDate,
                rate,
                provider: String(provider ?? "cache"),
                fetchedAt: Number(fetchedAt ?? 0),
              })),
          );
        };
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async putMany(entries: CachedFxRateEntry[]): Promise<void> {
    if (!entries.length) return;
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);
        for (const e of entries) {
          store.put({ ...e, key: rateKey(e.base, e.quote, e.rateDate) });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

export function rateKey(base: string, quote: string, date: string): string {
  return `${normalizeCurrencyCode(base)}|${normalizeCurrencyCode(quote)}|${date}`;
}

/**
 * Client FX rate service with:
 * - Synchronous read access to the in-memory cache (for UI rendering & SMS engine snapshots)
 * - Persistent local cache (IndexedDB on web, SQLite on Android)
 * - Request batching by `(base, date)` and deduplication by `(pair, date)`
 * - Offline fallback chain: exact cache -> remote provider -> latest cached on/before date -> pegged fallback -> `rate_unavailable`
 */
export class FxRateService {
  private provider: RateProvider | null;
  private readonly store: FxRateStore;
  private readonly todayFn: () => string;
  private readonly cache = new Map<string, CachedFxRateEntry>();
  /** Tracks `(base|quote|requestedDate) -> effectiveRateDate` so weekends/holidays aren't re-fetched. */
  private readonly resolvedDateAlias = new Map<string, string>();
  /** In-flight deduplication for `(base|date)` batch fetches. */
  private readonly inFlightBase = new Map<
    string,
    Promise<{ rateDate: string; rates: Record<string, number>; provider: string } | null>
  >();
  /** In-flight deduplication for `(base|quote|date)` single-pair fetches. */
  private readonly inFlightPair = new Map<string, Promise<RateResult | null>>();
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(options?: {
    provider?: RateProvider | null;
    store?: FxRateStore;
    todayFn?: () => string;
  }) {
    this.provider = options?.provider ?? null;
    this.store =
      options?.store ??
      (typeof indexedDB !== "undefined"
        ? new IndexedDbFxRateStore()
        : new MemoryFxRateStore());
    this.todayFn = options?.todayFn ?? uaeToday;
  }

  setProvider(provider: RateProvider | null): void {
    this.provider = provider;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    if (!this.hydratePromise) {
      this.hydratePromise = this.store
        .getAll()
        .then((rows) => {
          for (const row of rows) {
            this.cache.set(rateKey(row.base, row.quote, row.rateDate), row);
          }
          this.hydrated = true;
          if (rows.length) this.notify();
        })
        .catch(() => {
          this.hydrated = true;
        });
    }
    await this.hydratePromise;
  }

  /** Seed rates directly into the cache (e.g. from Android SQLite or tests). */
  seed(entries: ReadonlyArray<Omit<CachedFxRateEntry, "fetchedAt"> & { fetchedAt?: number }>): void {
    const now = Date.now();
    const toPersist: CachedFxRateEntry[] = [];
    for (const e of entries) {
      if (!Number.isFinite(e.rate) || e.rate <= 0) continue;
      const item: CachedFxRateEntry = {
        base: normalizeCurrencyCode(e.base),
        quote: normalizeCurrencyCode(e.quote),
        rateDate: validDateOrToday(e.rateDate),
        rate: e.rate,
        provider: e.provider || "cache",
        fetchedAt: e.fetchedAt ?? now,
      };
      this.cache.set(rateKey(item.base, item.quote, item.rateDate), item);
      toPersist.push(item);
    }
    if (toPersist.length) {
      void this.store.putMany(toPersist).catch(() => {});
      this.notify();
    }
  }

  /** Export a compact map `"BASE|QUOTE|YYYY-MM-DD" -> { rate, rateDate }` for headless SMS engine context. */
  exportCacheSnapshot(): Record<string, { rate: number; rateDate: string; provider: string }> {
    const out: Record<string, { rate: number; rateDate: string; provider: string }> = {};
    for (const [key, entry] of this.cache.entries()) {
      out[key] = {
        rate: entry.rate,
        rateDate: entry.rateDate,
        provider: entry.provider,
      };
    }
    return out;
  }

  /**
   * Synchronous cache lookup for a pair on or before `date` (or latest cached if none on/before).
   * Falls back to inverse cached pair (`quote -> base`), then pegged fallback.
   */
  getCachedRateSync(
    from: string,
    to: string,
    date: string = this.todayFn(),
  ): ResolvedRate {
    const fromCode = normalizeCurrencyCode(from);
    const toCode = normalizeCurrencyCode(to);
    const cleanDate = validDateOrToday(date);
    if (fromCode === toCode) {
      return {
        from: fromCode,
        to: toCode,
        rate: 1,
        rateDate: cleanDate,
        source: "same_currency",
        status: "exact",
        provider: "identity",
      };
    }

    const aliasedDate = this.resolvedDateAlias.get(rateKey(fromCode, toCode, cleanDate));
    if (aliasedDate) {
      const hit = this.cache.get(rateKey(fromCode, toCode, aliasedDate));
      if (hit) {
        return {
          from: fromCode,
          to: toCode,
          rate: hit.rate,
          rateDate: hit.rateDate,
          source: "api_estimate",
          status: "estimated",
          provider: hit.provider,
        };
      }
    }

    const exact = this.cache.get(rateKey(fromCode, toCode, cleanDate));
    if (exact) {
      return {
        from: fromCode,
        to: toCode,
        rate: exact.rate,
        rateDate: exact.rateDate,
        source: "api_estimate",
        status: "estimated",
        provider: exact.provider,
      };
    }

    // Latest cached on or before `cleanDate`, or overall latest cached for this pair
    let bestOnOrBefore: CachedFxRateEntry | null = null;
    let bestOverall: CachedFxRateEntry | null = null;
    let bestInverseOnOrBefore: CachedFxRateEntry | null = null;
    let bestInverseOverall: CachedFxRateEntry | null = null;

    for (const entry of this.cache.values()) {
      if (entry.base === fromCode && entry.quote === toCode) {
        if (!bestOverall || entry.rateDate > bestOverall.rateDate) {
          bestOverall = entry;
        }
        if (
          entry.rateDate <= cleanDate &&
          (!bestOnOrBefore || entry.rateDate > bestOnOrBefore.rateDate)
        ) {
          bestOnOrBefore = entry;
        }
      } else if (entry.base === toCode && entry.quote === fromCode) {
        if (!bestInverseOverall || entry.rateDate > bestInverseOverall.rateDate) {
          bestInverseOverall = entry;
        }
        if (
          entry.rateDate <= cleanDate &&
          (!bestInverseOnOrBefore || entry.rateDate > bestInverseOnOrBefore.rateDate)
        ) {
          bestInverseOnOrBefore = entry;
        }
      }
    }

    const directHit = bestOnOrBefore ?? bestOverall;
    if (directHit) {
      return {
        from: fromCode,
        to: toCode,
        rate: directHit.rate,
        rateDate: directHit.rateDate,
        source: "api_estimate",
        status: "estimated",
        provider: directHit.provider,
      };
    }

    const inverseHit = bestInverseOnOrBefore ?? bestInverseOverall;
    if (inverseHit && inverseHit.rate > 0) {
      return {
        from: fromCode,
        to: toCode,
        rate: 1 / inverseHit.rate,
        rateDate: inverseHit.rateDate,
        source: "api_estimate",
        status: "estimated",
        provider: inverseHit.provider,
      };
    }

    const pegged = getPeggedFallbackRate(fromCode, toCode);
    if (pegged !== null) {
      return {
        from: fromCode,
        to: toCode,
        rate: pegged,
        rateDate: cleanDate,
        source: "manual_rate",
        status: "estimated",
        provider: "pegged",
      };
    }

    return {
      from: fromCode,
      to: toCode,
      rate: null,
      rateDate: cleanDate,
      source: null,
      status: "estimated",
      provider: null,
      warning: "rate_unavailable",
    };
  }

  /**
   * Resolves a historical rate for `(from, to, date)` with batching, deduplication,
   * local cache, remote lookup, and graceful offline fallback. Never throws.
   */
  async getRate(
    from: string,
    to: string,
    date: string = this.todayFn(),
  ): Promise<ResolvedRate> {
    await this.hydrate();
    const fromCode = normalizeCurrencyCode(from);
    const toCode = normalizeCurrencyCode(to);
    const cleanDate = validDateOrToday(date);

    if (fromCode === toCode) {
      return {
        from: fromCode,
        to: toCode,
        rate: 1,
        rateDate: cleanDate,
        source: "same_currency",
        status: "exact",
        provider: "identity",
      };
    }

    // 1. Exact cache or previously resolved weekend/holiday alias -> never fetch twice
    const reqKey = rateKey(fromCode, toCode, cleanDate);
    const aliasedDate = this.resolvedDateAlias.get(reqKey);
    const exactEntry =
      this.cache.get(reqKey) ??
      (aliasedDate ? this.cache.get(rateKey(fromCode, toCode, aliasedDate)) : undefined);
    if (exactEntry) {
      return {
        from: fromCode,
        to: toCode,
        rate: exactEntry.rate,
        rateDate: exactEntry.rateDate,
        source: "api_estimate",
        status: "estimated",
        provider: exactEntry.provider,
      };
    }

    // 2. Fetch remotely if provider is configured (and date isn't in the future)
    const todayIso = this.todayFn();
    const isFuture = cleanDate > todayIso;
    if (this.provider && !isFuture) {
      const fetched = await this.fetchDeduped(fromCode, toCode, cleanDate);
      if (fetched) {
        this.resolvedDateAlias.set(reqKey, fetched.rateDate);
        return {
          from: fromCode,
          to: toCode,
          rate: fetched.rate,
          rateDate: fetched.rateDate,
          source: "api_estimate",
          status: "estimated",
          provider: fetched.provider,
        };
      }
    }

    // 3. Offline / future / failure fallback: latest cached -> pegged -> rate_unavailable
    return this.getCachedRateSync(fromCode, toCode, cleanDate);
  }

  /**
   * Batch prefetch multiple `(from, to, date)` requests, grouping by `(from, date)`
   * so providers supporting base snapshots execute only one network request per `(base, date)`.
   */
  async prefetchPairs(
    requests: ReadonlyArray<{ from: string; to: string; date: string }>,
  ): Promise<void> {
    await this.hydrate();
    const unique = new Map<string, { from: string; to: string; date: string }>();
    for (const r of requests) {
      const from = normalizeCurrencyCode(r.from);
      const to = normalizeCurrencyCode(r.to);
      const date = validDateOrToday(r.date);
      if (from === to) continue;
      unique.set(rateKey(from, to, date), { from, to, date });
    }
    await Promise.all(
      [...unique.values()].map((r) => this.getRate(r.from, r.to, r.date)),
    );
  }

  private async fetchDeduped(
    fromCode: string,
    toCode: string,
    cleanDate: string,
  ): Promise<RateResult | null> {
    const provider = this.provider;
    if (!provider) return null;

    // Prefer batch `(base, date)` fetch when provider supports it so multiple quotes share 1 request
    if (provider.getRatesForBase) {
      const baseKey = `${fromCode}|${cleanDate}`;
      let basePromise = this.inFlightBase.get(baseKey);
      if (!basePromise) {
        basePromise = provider
          .getRatesForBase(fromCode, cleanDate)
          .then((snap) => {
            if (snap) {
              const now = Date.now();
              const toPersist: CachedFxRateEntry[] = [];
              for (const [quote, rate] of Object.entries(snap.rates)) {
                if (!isThreeLetterCurrencyCode(quote)) continue;
                const entry: CachedFxRateEntry = {
                  base: fromCode,
                  quote,
                  rateDate: snap.rateDate,
                  rate,
                  provider: snap.provider,
                  fetchedAt: now,
                };
                this.cache.set(rateKey(fromCode, quote, snap.rateDate), entry);
                this.resolvedDateAlias.set(
                  rateKey(fromCode, quote, cleanDate),
                  snap.rateDate,
                );
                toPersist.push(entry);
              }
              if (toPersist.length) {
                void this.store.putMany(toPersist).catch(() => {});
                this.notify();
              }
            }
            return snap;
          })
          .catch(() => null)
          .finally(() => {
            this.inFlightBase.delete(baseKey);
          });
        this.inFlightBase.set(baseKey, basePromise);
      }

      const snap = await basePromise;
      if (snap && snap.rates[toCode] && snap.rates[toCode] > 0) {
        return {
          from: fromCode,
          to: toCode,
          rate: snap.rates[toCode],
          rateDate: snap.rateDate,
          provider: snap.provider,
        };
      }
    }

    // Fallback to single-pair fetch deduplicated by `(from, to, date)`
    const pairKey = rateKey(fromCode, toCode, cleanDate);
    let pairPromise = this.inFlightPair.get(pairKey);
    if (!pairPromise) {
      pairPromise = provider
        .getRate(fromCode, toCode, cleanDate)
        .then((res) => {
          if (res && Number.isFinite(res.rate) && res.rate > 0) {
            const entry: CachedFxRateEntry = {
              base: fromCode,
              quote: toCode,
              rateDate: res.rateDate,
              rate: res.rate,
              provider: res.provider,
              fetchedAt: Date.now(),
            };
            this.cache.set(rateKey(fromCode, toCode, res.rateDate), entry);
            this.resolvedDateAlias.set(pairKey, res.rateDate);
            void this.store.putMany([entry]).catch(() => {});
            this.notify();
          }
          return res;
        })
        .catch(() => null)
        .finally(() => {
          this.inFlightPair.delete(pairKey);
        });
      this.inFlightPair.set(pairKey, pairPromise);
    }

    return pairPromise;
  }
}

/** Shared singleton FX rate service for the web/Capacitor app. */
export const fxRateService = new FxRateService({
  provider: new CompositeRateProvider([
    new FawazAhmedProvider(),
    new FrankfurterProvider(),
  ]),
});
