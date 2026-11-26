import {
  ISO_4217_CURRENCIES,
  PEGGED_AED_RATES,
  type CurrencyDecimals,
  type CurrencyMeta,
} from "./currencyData.ts";

export {
  DEFAULT_RECENT_CURRENCIES,
  ISO_4217_CURRENCIES,
  PEGGED_AED_RATES,
  USD_TO_AED_PEG,
  type CurrencyDecimals,
  type CurrencyMeta,
} from "./currencyData.ts";

export const DEFAULT_CURRENCY = "AED" as const;

export type SupportedCurrencyCode = string;

export type FxSource =
  | "same_currency"
  | "bank_sms"
  | "api_estimate"
  | "user_confirmed"
  | "statement_match"
  | "manual_rate";

export type FxStatus = "exact" | "estimated";

export const FX_SOURCES: readonly FxSource[] = [
  "same_currency",
  "bank_sms",
  "api_estimate",
  "user_confirmed",
  "statement_match",
  "manual_rate",
] as const;

export const FX_STATUSES: readonly FxStatus[] = ["exact", "estimated"] as const;

/** Full list of ISO 4217 currencies supported by Fuloos. */
export const SUPPORTED_CURRENCIES: readonly CurrencyMeta[] = ISO_4217_CURRENCIES;

const CURRENCY_MAP = new Map<string, CurrencyMeta>(
  ISO_4217_CURRENCIES.map((c) => [c.code, c]),
);

const THREE_LETTER_CODE_RE = /^[A-Z]{3}$/;
const MAX_MINOR_UNITS = 100_000_000_000;
const MAX_FX_RATE = 1_000_000;

export function normalizeCurrencyCode(code: string | null | undefined): string {
  const trimmed = (code ?? "").trim().toUpperCase();
  return trimmed || DEFAULT_CURRENCY;
}

export function isThreeLetterCurrencyCode(code: string): boolean {
  return THREE_LETTER_CODE_RE.test(code.trim().toUpperCase());
}

/** True for any active ISO 4217 currency code in the generated currency table. */
export function isSupportedCurrency(code: string): boolean {
  return CURRENCY_MAP.has(code.trim().toUpperCase());
}

export function getCurrencyMeta(code: string): CurrencyMeta | undefined {
  return CURRENCY_MAP.get(normalizeCurrencyCode(code));
}

/** Minor-unit exponent (0, 2, or 3). Unknown 3-letter codes default safely to 2. */
export function getCurrencyDecimals(code: string): CurrencyDecimals {
  return getCurrencyMeta(code)?.decimals ?? 2;
}

/**
 * Offline pegged fallback rate (`1 fromCode = X toCode`) for USD/GCC pegged currencies only.
 * Returns `null` when either currency does not have a fixed peg.
 */
export function getPeggedFallbackRate(
  fromCode: string,
  toCode: string,
): number | null {
  const from = normalizeCurrencyCode(fromCode);
  const to = normalizeCurrencyCode(toCode);
  if (from === to) return 1;
  const fromToAed = PEGGED_AED_RATES[from];
  const toToAed = PEGGED_AED_RATES[to];
  if (fromToAed === undefined || toToAed === undefined) return null;
  return fromToAed / toToAed;
}

/**
 * Rounds half away from zero (e.g. 0.5 -> 1, -0.5 -> -1).
 * Adds a tiny 1e-11 guard so IEEE-754 artefacts like `1.005 * 100 = 100.49999999999999`
 * round cleanly to 101 without shifting genuine sub-half values.
 */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const abs = Math.abs(value);
  const rounded = Math.floor(abs + 0.5 + 1e-11);
  return value < 0 ? (rounded === 0 ? 0 : -rounded) : rounded;
}

/**
 * Parses a decimal string (e.g. "100.50", "1.250", "1500") into integer minor
 * units for the given currency (0, 2, or 3 decimal places).
 */
export function parseCurrencyMinor(
  value: string,
  currency: string,
  options?: { allowUnknownCode?: boolean },
): number {
  const code = normalizeCurrencyCode(currency);
  const meta = CURRENCY_MAP.get(code);
  if (!meta) {
    if (!options?.allowUnknownCode || !THREE_LETTER_CODE_RE.test(code)) {
      throw new Error(`Unsupported currency "${code}".`);
    }
  }
  const trimmed = value.trim().replace(/,/g, "");
  const decimals = meta?.decimals ?? 2;
  const pattern =
    decimals === 0
      ? /^-?\d+$/
      : decimals === 3
        ? /^-?\d+(\.\d{1,3})?$/
        : /^-?\d+(\.\d{1,2})?$/;
  if (!pattern.test(trimmed)) {
    throw new Error(
      decimals === 0
        ? `Enter a whole number amount for ${code}.`
        : `Enter a valid ${code} amount with up to ${decimals} decimal places.`,
    );
  }
  const negative = trimmed.startsWith("-");
  const [whole, part = ""] = trimmed.replace("-", "").split(".");
  const factor = 10 ** decimals;
  const result =
    decimals === 0
      ? Number(whole)
      : Number(whole) * factor + Number(part.padEnd(decimals, "0"));
  if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_MINOR_UNITS) {
    throw new Error("Amount is too large.");
  }
  return result === 0 ? 0 : negative ? -result : result;
}

/**
 * Formats integer minor units as a plain decimal string suitable for inputs and CSV.
 */
export function formatCurrencyInput(
  minorUnits: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const decimals = getCurrencyDecimals(currency);
  const safe = Math.trunc(minorUnits);
  if (decimals === 0) return String(safe);
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const factor = 10 ** decimals;
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Converts integer minor units in `fromCode` to integer minor units in `toCode`
 * using `rate` (where 1 major unit of `fromCode` = `rate` major units of `toCode`).
 * Rounds half away from zero at the final step only.
 */
export function convertMinor(
  amountMinor: number,
  fromCode: string,
  toCode: string,
  rate: number,
): number {
  const from = normalizeCurrencyCode(fromCode);
  const to = normalizeCurrencyCode(toCode);
  if (!THREE_LETTER_CODE_RE.test(from)) {
    throw new Error(`Unsupported currency "${from}".`);
  }
  if (!THREE_LETTER_CODE_RE.test(to)) {
    throw new Error(`Unsupported currency "${to}".`);
  }
  if (
    !Number.isSafeInteger(amountMinor) ||
    Math.abs(amountMinor) > MAX_MINOR_UNITS
  ) {
    throw new Error("Amount must be an integer within the supported limit.");
  }
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_FX_RATE) {
    throw new Error("Exchange rate must be greater than zero.");
  }
  if (from === to && rate === 1) {
    return amountMinor === 0 ? 0 : amountMinor;
  }
  const fromFactor = 10 ** getCurrencyDecimals(from);
  const toFactor = 10 ** getCurrencyDecimals(to);
  const converted = roundHalfAwayFromZero(
    (amountMinor * rate * toFactor) / fromFactor,
  );
  if (
    !Number.isSafeInteger(converted) ||
    Math.abs(converted) > MAX_MINOR_UNITS
  ) {
    throw new Error(`Converted ${to} amount exceeds the supported limit.`);
  }
  return converted === 0 ? 0 : converted;
}

/**
 * Compatibility wrapper for converting non-negative minor units to AED fils.
 */
export function convertToAedFils(
  originalMinorUnits: number,
  currency: string,
  fxRate: number,
): number {
  const code = normalizeCurrencyCode(currency);
  if (!isSupportedCurrency(code)) {
    throw new Error(`Unsupported currency "${code}".`);
  }
  if (
    !Number.isSafeInteger(originalMinorUnits) ||
    originalMinorUnits < 0 ||
    originalMinorUnits > MAX_MINOR_UNITS
  ) {
    throw new Error("Original amount must be zero or greater.");
  }
  return convertMinor(originalMinorUnits, code, DEFAULT_CURRENCY, fxRate);
}

/**
 * Computes the implied FX rate (`1 originalCurrency = X accountCurrency`)
 * adjusted for the minor-unit exponents of both currencies.
 */
export function computeImpliedRate(
  originalMinor: number,
  originalCurrency: string,
  accountMinor: number,
  accountCurrency: string,
): number {
  const origCode = normalizeCurrencyCode(originalCurrency);
  const accCode = normalizeCurrencyCode(accountCurrency);
  if (origCode === accCode && originalMinor === accountMinor) return 1;
  if (originalMinor <= 0 || accountMinor < 0) return 0;
  const origMajor = originalMinor / 10 ** getCurrencyDecimals(origCode);
  const accMajor = accountMinor / 10 ** getCurrencyDecimals(accCode);
  return accMajor / origMajor;
}

function formatFallbackCurrency(
  minorUnits: number,
  code: string,
  decimals: CurrencyDecimals,
): string {
  const negative = minorUnits < 0;
  const major = Math.abs(minorUnits) / 10 ** decimals;
  const numStr = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(major);
  return `${negative ? "-" : ""}${code} ${numStr}`;
}

/**
 * Formats integer minor units for display in the specified currency.
 * Uses `Intl.NumberFormat` and falls back to `CODE 1,234.50` when the
 * runtime does not recognise a currency code.
 */
export function formatCurrency(
  minorUnits: number,
  currency: string = DEFAULT_CURRENCY,
  locale: string = "en-AE",
): string {
  const code = normalizeCurrencyCode(currency);
  const decimals = getCurrencyDecimals(code);
  if (!isSupportedCurrency(code)) {
    return formatFallbackCurrency(minorUnits, code, decimals);
  }
  const major = minorUnits / 10 ** decimals;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(major);
  } catch {
    return formatFallbackCurrency(minorUnits, code, decimals);
  }
}

export function formatFxRate(fxRate: number): string {
  if (!Number.isFinite(fxRate) || fxRate <= 0) return "";
  return Number(fxRate.toFixed(6)).toString();
}

/**
 * Formats an original-currency pill like `GBP 12.00 @ 4.675` or `≈ GBP 12.00`.
 */
export function formatOriginalCurrencyPill(
  originalMinorUnits: number,
  currency: string,
  fxRate?: number,
): string {
  const code = normalizeCurrencyCode(currency);
  const amountStr = formatCurrencyInput(originalMinorUnits, code);
  if (fxRate !== undefined && Number.isFinite(fxRate) && fxRate > 0) {
    return `${code} ${amountStr} @ ${formatFxRate(fxRate)}`;
  }
  return `${code} ${amountStr}`;
}

export function isValidFxSource(value: unknown): value is FxSource {
  return typeof value === "string" && (FX_SOURCES as readonly string[]).includes(value);
}

export function isValidFxStatus(value: unknown): value is FxStatus {
  return typeof value === "string" && (FX_STATUSES as readonly string[]).includes(value);
}

export function validateForeignCurrencyFields(
  fields: {
    original_amount?: number;
    original_currency?: string;
    fx_rate?: number;
    fx_rate_date?: string | null;
    fx_source?: FxSource | string;
    fx_status?: FxStatus | string;
  },
  options?: {
    accountCurrency?: string;
    allowUnknownCode?: boolean;
  },
): void {
  const rawCode = fields.original_currency;
  if (rawCode === undefined || rawCode === null || rawCode === "") return;
  const code = rawCode.trim().toUpperCase();
  const accountCurrency = normalizeCurrencyCode(options?.accountCurrency);

  if (!isSupportedCurrency(code)) {
    if (!options?.allowUnknownCode || !THREE_LETTER_CODE_RE.test(code)) {
      throw new Error(`Unsupported currency "${rawCode}".`);
    }
  }

  if (fields.fx_source !== undefined && !isValidFxSource(fields.fx_source)) {
    throw new Error(`Invalid FX source "${String(fields.fx_source)}".`);
  }
  if (fields.fx_status !== undefined && !isValidFxStatus(fields.fx_status)) {
    throw new Error(`Invalid FX status "${String(fields.fx_status)}".`);
  }
  if (
    fields.fx_rate_date !== undefined &&
    fields.fx_rate_date !== null &&
    fields.fx_rate_date !== "" &&
    !/^\d{4}-\d{2}-\d{2}$/.test(fields.fx_rate_date)
  ) {
    throw new Error("FX rate date must be YYYY-MM-DD.");
  }

  const sameCurrency = code === accountCurrency;
  if (fields.original_amount !== undefined) {
    if (
      !Number.isSafeInteger(fields.original_amount) ||
      fields.original_amount < 0 ||
      fields.original_amount > MAX_MINOR_UNITS
    ) {
      throw new Error(
        "Original amount must be zero or greater in the currency's minor units.",
      );
    }
  } else if (!sameCurrency) {
    throw new Error(
      "Original amount must be zero or greater in the currency's minor units.",
    );
  }

  // Estimated transactions awaiting a rate lookup may omit fx_rate temporarily.
  const rateOptional = sameCurrency || fields.fx_status === "estimated";
  if (fields.fx_rate !== undefined && fields.fx_rate !== null) {
    if (
      typeof fields.fx_rate !== "number" ||
      !Number.isFinite(fields.fx_rate) ||
      fields.fx_rate <= 0 ||
      fields.fx_rate > MAX_FX_RATE
    ) {
      throw new Error("Exchange rate must be greater than zero.");
    }
  } else if (!rateOptional) {
    throw new Error("Exchange rate must be greater than zero.");
  }
}
