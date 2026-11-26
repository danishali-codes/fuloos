import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import {
  DEFAULT_CURRENCY,
  DEFAULT_RECENT_CURRENCIES,
  getCurrencyMeta,
  normalizeCurrencyCode,
  SUPPORTED_CURRENCIES,
  type CurrencyMeta,
} from "./currency";
import { translateText as uiText } from "./i18n";

const RECENT_STORAGE_KEY = "fuloos.recent_currencies";
const MAX_RECENT = 8;

export function loadRecentCurrencies(): string[] {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(RECENT_STORAGE_KEY)
        : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const clean = parsed
          .filter((c): c is string => typeof c === "string" && /^[A-Z]{3}$/.test(c))
          .slice(0, MAX_RECENT);
        if (clean.length > 0) return clean;
      }
    }
  } catch {
    // Ignore storage errors in restricted environments.
  }
  return [...DEFAULT_RECENT_CURRENCIES];
}

export function recordRecentCurrency(code: string): string[] {
  const norm = normalizeCurrencyCode(code);
  const current = loadRecentCurrencies();
  const next = [norm, ...current.filter((c) => c !== norm)].slice(0, MAX_RECENT);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Ignore storage errors.
  }
  return next;
}

export function CurrencyPicker({
  value,
  onChange,
  disabled = false,
  id,
  name,
  ariaLabel,
  compact = false,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  ariaLabel?: string;
  compact?: boolean;
}) {
  const code = normalizeCurrencyCode(value || DEFAULT_CURRENCY);
  const selectedMeta = getCurrencyMeta(code);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(() => loadRecentCurrencies());
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const timer = setTimeout(() => searchRef.current?.focus(), 20);
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SUPPORTED_CURRENCIES;
    return SUPPORTED_CURRENCIES.filter(
      (c) =>
        c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    );
  }, [query]);

  const recentMetas = useMemo(() => {
    if (query.trim()) return [];
    return recents
      .map((c) => getCurrencyMeta(c))
      .filter((m): m is CurrencyMeta => Boolean(m));
  }, [recents, query]);

  const recentCodeSet = useMemo(
    () => new Set(recentMetas.map((m) => m.code)),
    [recentMetas],
  );

  const otherMetas = useMemo(
    () =>
      query.trim()
        ? filtered
        : filtered.filter((c) => !recentCodeSet.has(c.code)),
    [filtered, recentCodeSet, query],
  );

  function pick(nextCode: string) {
    setRecents(recordRecentCurrency(nextCode));
    onChange(nextCode);
    setOpen(false);
  }

  return (
    <div
      ref={wrapRef}
      className={`currency-picker${compact ? " currency-picker-compact" : ""}`}
      style={{ position: "relative" }}
    >
      {name && <input type="hidden" name={name} value={code} />}
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-label={ariaLabel ?? uiText("Currency")}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="currency-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          width: "100%",
          padding: compact ? "7px 10px" : "9px 12px",
          borderRadius: "10px",
          border: "1px solid var(--border, #d8d3c8)",
          background: "var(--surface, #fff)",
          color: "var(--ink, #1f2421)",
          fontSize: compact ? "0.875rem" : "0.95rem",
          cursor: disabled ? "not-allowed" : "pointer",
          textAlign: "start",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
          <strong style={{ fontWeight: 650, letterSpacing: "0.02em" }}>{code}</strong>
          {!compact && selectedMeta && (
            <span
              className="muted"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "0.85em",
              }}
            >
              — {selectedMeta.name}
            </span>
          )}
        </span>
        <ChevronDown size={15} style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>

      {open && (
        <div
          className="currency-picker-popover"
          role="listbox"
          aria-label={uiText("Currency")}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            insetInlineStart: 0,
            minWidth: compact ? "250px" : "100%",
            width: "100%",
            maxWidth: "340px",
            zIndex: 60,
            background: "var(--surface, #fff)",
            border: "1px solid var(--border, #d8d3c8)",
            borderRadius: "12px",
            boxShadow: "0 12px 28px rgba(0, 0, 0, 0.14)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 10px",
              borderBottom: "1px solid var(--border, #e8e3d9)",
            }}
          >
            <Search size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={uiText("Search currency code or name…")}
              style={{
                border: "none",
                outline: "none",
                background: "transparent",
                width: "100%",
                fontSize: "0.875rem",
                padding: 0,
                color: "var(--ink, #1f2421)",
              }}
            />
            {query && (
              <button
                type="button"
                aria-label={uiText("Clear selection")}
                onClick={() => setQuery("")}
                style={{
                  border: "none",
                  background: "transparent",
                  padding: "2px",
                  cursor: "pointer",
                  color: "var(--muted, #6b726e)",
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div style={{ maxHeight: "230px", overflowY: "auto", padding: "4px" }}>
            {recentMetas.length > 0 && (
              <>
                <div
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--muted, #6b726e)",
                    padding: "6px 8px 4px",
                  }}
                >
                  {uiText("Recent")}
                </div>
                {recentMetas.map((c) => (
                  <CurrencyOptionRow
                    key={`recent-${c.code}`}
                    meta={c}
                    selected={c.code === code}
                    onSelect={pick}
                  />
                ))}
                <div
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--muted, #6b726e)",
                    padding: "8px 8px 4px",
                    borderTop: "1px solid var(--border, #ece7dd)",
                    marginTop: "4px",
                  }}
                >
                  {uiText("All currencies")}
                </div>
              </>
            )}

            {otherMetas.length === 0 && recentMetas.length === 0 ? (
              <div
                className="muted small"
                style={{ padding: "14px 10px", textAlign: "center" }}
              >
                No matching currencies
              </div>
            ) : (
              otherMetas.map((c) => (
                <CurrencyOptionRow
                  key={c.code}
                  meta={c}
                  selected={c.code === code}
                  onSelect={pick}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CurrencyOptionRow({
  meta,
  selected,
  onSelect,
}: {
  meta: CurrencyMeta;
  selected: boolean;
  onSelect: (code: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(meta.code)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        width: "100%",
        padding: "7px 8px",
        border: "none",
        borderRadius: "8px",
        background: selected ? "rgba(29, 91, 72, 0.1)" : "transparent",
        color: "var(--ink, #1f2421)",
        cursor: "pointer",
        textAlign: "start",
        fontSize: "0.875rem",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
        <strong style={{ width: "38px", flexShrink: 0, fontWeight: 650 }}>
          {meta.code}
        </strong>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            opacity: 0.85,
          }}
        >
          {meta.name}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
        {meta.decimals !== 2 && (
          <span
            style={{
              fontSize: "0.7rem",
              padding: "1px 5px",
              borderRadius: "999px",
              background: "var(--surface-2, #f2efe9)",
              color: "var(--muted, #5c635e)",
            }}
          >
            {meta.decimals}d
          </span>
        )}
        {selected && <Check size={14} style={{ color: "var(--accent, #1d5b48)" }} />}
      </span>
    </button>
  );
}
