import { translateText as uiText } from "./i18n";
import React, { useState } from "react";
import { Leaf, Lock, LogOut } from "lucide-react";
import {
  MAX_PIN_ATTEMPTS,
  getFailedAttempts,
  recordFailedAttempt,
  resetFailedAttempts,
  verifyPin,
  type AppLockConfig,
  type StorageLike,
} from "./appLock";

export function AppLockScreen({
  email,
  config,
  storage,
  onUnlock,
  onSignOut,
  onLockout,
}: {
  email: string;
  config: AppLockConfig;
  storage: StorageLike | undefined;
  onUnlock: () => void;
  onSignOut: () => void;
  onLockout: () => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(() =>
    getFailedAttempts(storage, config.userId),
  );
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const ok = await verifyPin(pin, config);
      if (ok) {
        resetFailedAttempts(storage, config.userId);
        setPin("");
        onUnlock();
        return;
      }
      const next = recordFailedAttempt(storage, config.userId);
      setAttempts(next.attempts);
      setPin("");
      if (next.lockedOut) {
        onLockout();
        return;
      }
      const remaining = MAX_PIN_ATTEMPTS - next.attempts;
      setError(
        `Incorrect PIN. ${remaining} ${remaining === 1 ? "attempt" : "attempts"} remaining before sign-out.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="applock-screen" role="main" aria-labelledby="applock-title">
      <div className="applock-card">
        <div className="applock-brand">
          <span className="brand-icon">
            <Leaf size={22} />
          </span>
          <span>fuloos.</span>
        </div>
        <div className="applock-icon" aria-hidden="true">
          <Lock size={24} />
        </div>
        <h1 id="applock-title">{uiText("Fuloos is locked")}</h1>
        <p className="muted small"> {uiText("Signed in as")} <b>{email}</b>{uiText(". Enter your PIN to view your workspace.")} </p>
        <form onSubmit={submit} className="applock-form">
          <label> {uiText("PIN")} <input
              autoFocus
              required
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              minLength={4}
              maxLength={8}
              autoComplete="off"
              value={pin}
              disabled={busy}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              placeholder={uiText("4–8 digits")}
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="primary" disabled={busy || pin.length < 4}>
            {busy ? uiText("Checking…") : uiText("Unlock")}
          </button>
        </form>
        <div className="applock-footer">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onSignOut}
          >
            <LogOut size={15} /> {uiText("Sign out")} </button>
          {attempts > 0 && (
            <span className="muted small"> {uiText("Failed attempts:")} {attempts} / {MAX_PIN_ATTEMPTS}
            </span>
          )}
        </div>
        <p className="applock-note muted small"> {uiText("Privacy screen only — hides financial data in this browser when idle or reopened; does not encrypt local storage.")} </p>
      </div>
    </div>
  );
}
