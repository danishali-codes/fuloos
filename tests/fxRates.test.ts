import assert from "node:assert/strict";
import test from "node:test";
import {
  CompositeRateProvider,
  EdgeFunctionRateProvider,
  FawazAhmedProvider,
  FrankfurterProvider,
  FxRateService,
  MemoryFxRateStore,
} from "../src/fxRates.ts";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("FawazAhmedProvider fetches from jsDelivr primary and falls back to pages.dev host", async () => {
  const seenUrls: string[] = [];
  const provider = new FawazAhmedProvider(async (input) => {
    const url = String(input);
    seenUrls.push(url);
    if (url.includes("cdn.jsdelivr.net")) {
      return mockResponse({ error: "unavailable" }, 503);
    }
    if (url === "https://2026-03-10.currency-api.pages.dev/v1/currencies/gbp.json") {
      return mockResponse({
        date: "2026-03-10",
        gbp: { aed: 4.65, usd: 1.266 },
      });
    }
    return mockResponse({}, 404);
  }, () => "2026-03-15");

  const res = await provider.getRate("GBP", "AED", "2026-03-10");
  assert.ok(res);
  assert.equal(res.rate, 4.65);
  assert.equal(res.rateDate, "2026-03-10");
  assert.equal(res.provider, "fawazahmed0");
  assert.equal(seenUrls.length, 2);
  assert.ok(seenUrls[0].includes("cdn.jsdelivr.net"));
  assert.ok(seenUrls[1].includes("currency-api.pages.dev"));
});

test("FawazAhmedProvider steps back on weekend/missing date and returns actual effective rateDate", async () => {
  const provider = new FawazAhmedProvider(async (input) => {
    const url = String(input);
    // Suppose Sunday 2026-03-08 and Saturday 2026-03-07 are 404, Friday 2026-03-06 exists
    if (url.includes("@2026-03-06/v1/currencies/eur.json")) {
      return mockResponse({
        date: "2026-03-06",
        eur: { aed: 4.01 },
      });
    }
    return mockResponse({}, 404);
  }, () => "2026-03-15");

  const res = await provider.getRate("EUR", "AED", "2026-03-08");
  assert.ok(res);
  assert.equal(res.rate, 4.01);
  assert.equal(res.rateDate, "2026-03-06");
});

test("FrankfurterProvider converts AED through USD with the fixed 3.6725 peg", async () => {
  const seenUrls: string[] = [];
  const provider = new FrankfurterProvider(async (input) => {
    const url = String(input);
    seenUrls.push(url);
    if (url === "https://api.frankfurter.app/2026-03-08?from=GBP&to=USD") {
      // ECB returns Friday's date for a Sunday query
      return mockResponse({
        amount: 1,
        base: "GBP",
        date: "2026-03-06",
        rates: { USD: 1.28 },
      });
    }
    if (url === "https://api.frankfurter.app/2026-03-08?from=USD&to=EUR") {
      return mockResponse({
        amount: 1,
        base: "USD",
        date: "2026-03-06",
        rates: { EUR: 0.92 },
      });
    }
    return mockResponse({}, 404);
  }, () => "2026-03-15");

  const gbpToAed = await provider.getRate("GBP", "AED", "2026-03-08");
  assert.ok(gbpToAed);
  assert.ok(Math.abs(gbpToAed.rate - 1.28 * 3.6725) < 1e-9);
  assert.equal(gbpToAed.rateDate, "2026-03-06");
  assert.equal(gbpToAed.provider, "frankfurter+peg");

  const aedToEur = await provider.getRate("AED", "EUR", "2026-03-08");
  assert.ok(aedToEur);
  assert.ok(Math.abs(aedToEur.rate - 0.92 / 3.6725) < 1e-9);
  assert.equal(aedToEur.rateDate, "2026-03-06");
});

test("FxRateService batches by (base, date), deduplicates requests, and persists cache", async () => {
  let networkCalls = 0;
  const store = new MemoryFxRateStore();
  const fawaz = new FawazAhmedProvider(async (input) => {
    networkCalls++;
    const url = String(input);
    if (url.includes("@2026-03-10/v1/currencies/gbp.json")) {
      return mockResponse({
        date: "2026-03-10",
        gbp: { aed: 4.65, usd: 1.266, eur: 1.17 },
      });
    }
    return mockResponse({}, 404);
  }, () => "2026-03-15");

  const service = new FxRateService({
    provider: fawaz,
    store,
    todayFn: () => "2026-03-15",
  });

  // Concurrent requests for multiple quotes of the same (base, date) trigger ONE fetch
  const [r1, r2, r3] = await Promise.all([
    service.getRate("GBP", "AED", "2026-03-10"),
    service.getRate("GBP", "USD", "2026-03-10"),
    service.getRate("GBP", "EUR", "2026-03-10"),
  ]);
  assert.equal(networkCalls, 1);
  assert.equal(r1.rate, 4.65);
  assert.equal(r1.source, "api_estimate");
  assert.equal(r1.status, "estimated");
  assert.equal(r2.rate, 1.266);
  assert.equal(r3.rate, 1.17);

  // Subsequent lookup for same pair & date hits cache with 0 network calls
  const again = await service.getRate("GBP", "AED", "2026-03-10");
  assert.equal(networkCalls, 1);
  assert.equal(again.rate, 4.65);

  // New service instance hydrating from the same persistent store works completely offline
  const offlineService = new FxRateService({
    provider: null,
    store,
    todayFn: () => "2026-03-15",
  });
  const fromStore = await offlineService.getRate("GBP", "AED", "2026-03-10");
  assert.equal(fromStore.rate, 4.65);
  assert.equal(fromStore.status, "estimated");
});

test("FxRateService offline, future date, pegged fallback, and rate_unavailable chain", async () => {
  let providerCalls = 0;
  const failingProvider = new CompositeRateProvider([
    new FawazAhmedProvider(async () => {
      providerCalls++;
      throw new Error("offline");
    }, () => "2026-03-15"),
    new FrankfurterProvider(async () => {
      providerCalls++;
      throw new Error("offline");
    }, () => "2026-03-15"),
  ]);

  const service = new FxRateService({
    provider: failingProvider,
    store: new MemoryFxRateStore(),
    todayFn: () => "2026-03-15",
  });

  // Same currency -> exact, no network
  const same = await service.getRate("AED", "AED", "2026-03-10");
  assert.equal(same.rate, 1);
  assert.equal(same.source, "same_currency");
  assert.equal(same.status, "exact");
  assert.equal(providerCalls, 0);

  // Offline pegged fallback (USD -> AED) -> manual_rate + estimated
  const pegged = await service.getRate("USD", "AED", "2026-03-10");
  assert.equal(pegged.rate, 3.6725);
  assert.equal(pegged.source, "manual_rate");
  assert.equal(pegged.status, "estimated");

  // Offline unpegged with no cache -> rate_unavailable, never throws
  const unavailable = await service.getRate("THB", "AED", "2026-03-10");
  assert.equal(unavailable.rate, null);
  assert.equal(unavailable.status, "estimated");
  assert.equal(unavailable.warning, "rate_unavailable");

  // Seed an older rate; future date skips live fetch and returns latest cached rate
  service.seed([
    { base: "GBP", quote: "AED", rateDate: "2026-03-12", rate: 4.64, provider: "fawazahmed0" },
  ]);
  const callsBeforeFuture = providerCalls;
  const future = await service.getRate("GBP", "AED", "2026-04-01");
  assert.equal(providerCalls, callsBeforeFuture);
  assert.equal(future.rate, 4.64);
  assert.equal(future.rateDate, "2026-03-12");
  assert.equal(future.status, "estimated");
});

test("EdgeFunctionRateProvider sends only from, to, and date", async () => {
  let receivedArgs: [string, string, string] | null = null;
  const edge = new EdgeFunctionRateProvider(async (from, to, date) => {
    receivedArgs = [from, to, date];
    return { rate: 4.67, rate_date: "2026-03-10", provider: "fawazahmed0" };
  });

  const res = await edge.getRate("gbp", "aed", "2026-03-10");
  assert.deepEqual(receivedArgs, ["GBP", "AED", "2026-03-10"]);
  assert.equal(res?.rate, 4.67);
  assert.equal(res?.rateDate, "2026-03-10");
});
