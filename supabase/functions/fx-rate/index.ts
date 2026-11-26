// Supabase Edge Function: fx-rate
// Returns an approximate historical FX rate for (from, to, date), backed by
// the shared `public.fuloos_fx_rates` cache table.
//
// Privacy contract: this function accepts ONLY `from`, `to`, and `date`.
// Never pass amounts, merchants, accounts, SMS text, or user data.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const USD_TO_AED_PEG = 3.6725;
const CODE_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function shiftIsoDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fetchFawaz(
  from: string,
  to: string,
  date: string,
): Promise<{ rate: number; rateDate: string; provider: string } | null> {
  const baseLower = from.toLowerCase();
  const quoteLower = to.toLowerCase();
  const today = todayIso();
  const clamped = date > today ? today : date;

  const versions = clamped === today ? [clamped, "latest"] : [clamped];
  for (let i = 1; i <= 5; i++) {
    versions.push(shiftIsoDate(clamped, -i));
  }

  const seen = new Set<string>();
  for (const ver of versions) {
    if (seen.has(ver)) continue;
    seen.add(ver);
    const urls = [
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${ver}/v1/currencies/${baseLower}.json`,
      `https://${ver}.currency-api.pages.dev/v1/currencies/${baseLower}.json`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;
        const data = (await res.json()) as Record<string, unknown>;
        const map = data[baseLower] as Record<string, unknown> | undefined;
        const rate = map?.[quoteLower];
        if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
          const rateDate =
            typeof data.date === "string" && DATE_RE.test(data.date)
              ? data.date
              : ver === "latest"
                ? today
                : ver;
          return { rate, rateDate, provider: "fawazahmed0" };
        }
      } catch {
        // Try fallback host or previous day
      }
    }
  }
  return null;
}

async function fetchFrankfurterDirect(
  from: string,
  to: string,
  date: string,
): Promise<{ rate: number; rateDate: string } | null> {
  const today = todayIso();
  const clamped = date > today ? today : date;
  const url = `https://api.frankfurter.app/${encodeURIComponent(clamped)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      date?: string;
      rates?: Record<string, number>;
    };
    const rate = data.rates?.[to];
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      return {
        rate,
        rateDate:
          typeof data.date === "string" && DATE_RE.test(data.date)
            ? data.date
            : clamped,
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchFrankfurter(
  from: string,
  to: string,
  date: string,
): Promise<{ rate: number; rateDate: string; provider: string } | null> {
  if (from === "USD" && to === "AED") {
    return { rate: USD_TO_AED_PEG, rateDate: date, provider: "frankfurter+peg" };
  }
  if (from === "AED" && to === "USD") {
    return {
      rate: 1 / USD_TO_AED_PEG,
      rateDate: date,
      provider: "frankfurter+peg",
    };
  }
  if (to === "AED") {
    const viaUsd = await fetchFrankfurterDirect(from, "USD", date);
    if (!viaUsd) return null;
    return {
      rate: viaUsd.rate * USD_TO_AED_PEG,
      rateDate: viaUsd.rateDate,
      provider: "frankfurter+peg",
    };
  }
  if (from === "AED") {
    const viaUsd = await fetchFrankfurterDirect("USD", to, date);
    if (!viaUsd) return null;
    return {
      rate: viaUsd.rate / USD_TO_AED_PEG,
      rateDate: viaUsd.rateDate,
      provider: "frankfurter+peg",
    };
  }
  const direct = await fetchFrankfurterDirect(from, to, date);
  if (!direct) return null;
  return { ...direct, provider: "frankfurter" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  let rawFrom = "";
  let rawTo = "";
  let rawDate = "";

  if (req.method === "GET") {
    const url = new URL(req.url);
    rawFrom = url.searchParams.get("from") ?? "";
    rawTo = url.searchParams.get("to") ?? "";
    rawDate = url.searchParams.get("date") ?? todayIso();
  } else if (req.method === "POST") {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      // Only read the three allowed public parameters; ignore anything else.
      rawFrom = String(body.from ?? "");
      rawTo = String(body.to ?? "");
      rawDate = String(body.date ?? todayIso());
    } catch {
      return jsonResponse({ error: "Invalid JSON body." }, 400);
    }
  } else {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const from = rawFrom.trim().toUpperCase();
  const to = rawTo.trim().toUpperCase();
  const date = rawDate.trim().slice(0, 10);

  if (!CODE_RE.test(from) || !CODE_RE.test(to)) {
    return jsonResponse(
      { error: "from and to must be 3-letter uppercase ISO 4217 currency codes." },
      400,
    );
  }
  if (!DATE_RE.test(date)) {
    return jsonResponse({ error: "date must be YYYY-MM-DD." }, 400);
  }

  if (from === to) {
    return jsonResponse({
      from,
      to,
      rate: 1,
      rate_date: date,
      provider: "identity",
      cached: true,
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const admin =
    supabaseUrl && serviceKey
      ? createClient(supabaseUrl, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  // 1. Check shared DB cache for exact date first
  if (admin) {
    const { data: exact } = await admin
      .from("fuloos_fx_rates")
      .select("rate, rate_date, provider")
      .eq("base", from)
      .eq("quote", to)
      .eq("rate_date", date)
      .maybeSingle();

    if (exact && Number(exact.rate) > 0) {
      return jsonResponse({
        from,
        to,
        rate: Number(exact.rate),
        rate_date: exact.rate_date,
        provider: exact.provider,
        cached: true,
      });
    }
  }

  // 2. Fetch from primary (fawazahmed0) then fallback (Frankfurter)
  const fetched =
    (await fetchFawaz(from, to, date)) ??
    (await fetchFrankfurter(from, to, date));

  if (fetched) {
    if (admin) {
      await admin.from("fuloos_fx_rates").upsert(
        {
          base: from,
          quote: to,
          rate_date: fetched.rateDate,
          rate: fetched.rate,
          provider: fetched.provider,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "base,quote,rate_date" },
      );
    }
    return jsonResponse({
      from,
      to,
      rate: fetched.rate,
      rate_date: fetched.rateDate,
      provider: fetched.provider,
      cached: false,
    });
  }

  // 3. Fallback to latest cached rate on or before `date` if upstream APIs failed
  if (admin) {
    const { data: latest } = await admin
      .from("fuloos_fx_rates")
      .select("rate, rate_date, provider")
      .eq("base", from)
      .eq("quote", to)
      .lte("rate_date", date)
      .order("rate_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest && Number(latest.rate) > 0) {
      return jsonResponse({
        from,
        to,
        rate: Number(latest.rate),
        rate_date: latest.rate_date,
        provider: latest.provider,
        cached: true,
      });
    }
  }

  return jsonResponse({ error: "Exchange rate unavailable." }, 503);
});
