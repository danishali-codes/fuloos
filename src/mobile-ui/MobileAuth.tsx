import React, { useEffect, useState } from "react";
import { ArrowRight, Eye, EyeOff, Leaf, Moon, Sun } from "lucide-react";
import { BackendError, MfaRequiredError } from "../backend";
import { AUTH_REDIRECT_ERROR_EVENT, backend } from "../client";
import { errorMessage } from "../domain";
import { translateText as uiText, useLocale } from "../i18n";
import type { PendingMfaChallenge } from "../Auth";
import { useThemeMode } from "./useThemeMode";

export function MobileAuth({
  onDemo,
  externalError,
  initialMfa,
  onClearInitialMfa,
}: {
  onDemo: () => void;
  externalError: string;
  initialMfa?: PendingMfaChallenge | null;
  onClearInitialMfa?: () => void;
}) {
  const { locale, toggleLocale, t } = useLocale();
  const { theme, toggleTheme } = useThemeMode();

  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mfa, setMfa] = useState<PendingMfaChallenge | null>(
    () => initialMfa ?? null,
  );
  const [otpCode, setOtpCode] = useState("");
  const [resetMode, setResetMode] = useState<"none" | "request" | "confirm">(
    "none",
  );
  const [resetToken, setResetToken] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState("");
  const [googleAvailable, setGoogleAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (initialMfa) {
      setMfa(initialMfa);
      setOtpCode("");
    }
  }, [initialMfa]);

  useEffect(() => {
    let active = true;
    if (backend) {
      backend
        .googleEnabled()
        .then((enabled) => {
          if (active) setGoogleAvailable(enabled);
        })
        .catch(() => {
          if (active) setGoogleAvailable(false);
        });
    } else {
      setGoogleAvailable(false);
    }
    return () => {
      active = false;
    };
  }, []);

  function handleGoogleError(e: unknown) {
    if (e instanceof MfaRequiredError) {
      if (e.method === "totp" && e.factorId && e.challengeId) {
        setMfa({
          method: "totp",
          mfaId: e.mfaId,
          otpId: "",
          factorId: e.factorId,
          challengeId: e.challengeId,
          email: e.email || email,
        });
        setOtpCode("");
        return;
      }
      setError(
        "Multi-factor authentication is required for this account. Please sign in with email and password.",
      );
      return;
    }
    setError(errorMessage(e));
  }

  useEffect(() => {
    const onRedirectError = (ev: Event) => {
      setBusy(false);
      handleGoogleError((ev as CustomEvent<unknown>).detail);
    };
    window.addEventListener(AUTH_REDIRECT_ERROR_EVENT, onRedirectError);
    return () =>
      window.removeEventListener(AUTH_REDIRECT_ERROR_EVENT, onRedirectError);
  });

  function googleSignIn() {
    if (!backend || busy) return;
    setError("");
    setNotice("");
    setBusy(true);
    backend
      .signInWithGoogle()
      .catch((e) => handleGoogleError(e))
      .finally(() => setBusy(false));
  }

  async function startMfaOtp(mfaId: string, targetEmail: string) {
    if (!backend) return;
    try {
      const { otpId } = await backend.requestOtp(targetEmail);
      setMfa({ method: "email_otp", mfaId, otpId, email: targetEmail });
      setOtpCode("");
      setNotice(`We sent a verification code to ${targetEmail.trim()}.`);
    } catch (e) {
      setMfa({ method: "email_otp", mfaId, otpId: "", email: targetEmail });
      setError(
        errorMessage(e) ||
          "Could not send the email verification code. Try resending.",
      );
    }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    if (!backend || !mfa) return;
    setError("");
    setNotice("");
    if (mfa.method === "totp") {
      if (!mfa.factorId || !mfa.challengeId || !backend.verifyMfaTotp) {
        setError("Authenticator verification is unavailable.");
        return;
      }
      setBusy(true);
      try {
        await backend.verifyMfaTotp(mfa.factorId, mfa.challengeId, otpCode);
        onClearInitialMfa?.();
      } catch (err) {
        if (err instanceof BackendError && err.status === 401) {
          setMfa(null);
          setOtpCode("");
          onClearInitialMfa?.();
          backend.signOut();
          setError("Your sign-in session expired. Please sign in again.");
        } else {
          setError(errorMessage(err));
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!mfa.otpId) {
      setError("Request a verification code first.");
      return;
    }
    setBusy(true);
    try {
      await backend.verifyMfaOtp(mfa.mfaId, mfa.otpId, otpCode);
      onClearInitialMfa?.();
    } catch (err) {
      if (err instanceof BackendError && err.status === 401) {
        setMfa(null);
        setOtpCode("");
        onClearInitialMfa?.();
        setError("Your sign-in session expired. Please sign in again.");
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function resendOtp() {
    if (!backend || !mfa || mfa.method !== "email_otp" || busy) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const { otpId } = await backend.requestOtp(mfa.email);
      setMfa({ ...mfa, otpId });
      setNotice(`Sent a new verification code to ${mfa.email.trim()}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitResetRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!backend) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await backend.requestPasswordReset(email);
      setNotice(
        "If an account exists for that email, a reset link and token have been sent.",
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitResetConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!backend) return;
    setError("");
    setNotice("");
    if (resetPassword !== resetPasswordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await backend.confirmPasswordReset(
        resetToken,
        resetPassword,
        resetPasswordConfirm,
      );
      setResetMode("none");
      setResetToken("");
      setResetPassword("");
      setResetPasswordConfirm("");
      setPassword("");
      setNotice("Your password has been updated. Sign in to continue.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    if (!backend) {
      setError("Live authentication is not connected yet. Explore the demo below.");
      return;
    }
    setBusy(true);
    try {
      if (signup) {
        const result = await backend.signUp(email, password);
        if (result.verificationRequired) {
          setNotice("Check your email to confirm your account, then sign in.");
        } else if (!result.session) {
          setSignup(false);
          setNotice("Your account is ready. Sign in to continue.");
        }
      } else {
        await backend.signIn(email, password);
      }
    } catch (e) {
      if (e instanceof MfaRequiredError) {
        if (e.method === "totp" && e.factorId && e.challengeId) {
          setMfa({
            method: "totp",
            mfaId: e.mfaId,
            otpId: "",
            factorId: e.factorId,
            challengeId: e.challengeId,
            email: e.email || email,
          });
          setOtpCode("");
        } else {
          await startMfaOtp(e.mfaId, email);
        }
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const activeError = error || externalError;

  return (
    <div className="m-auth">
      <div className="m-auth-glow" aria-hidden />

      {/* Top utility row */}
      <div className="m-auth-topbar">
        <span className="m-auth-badge">{t("brand.name")}</span>
        <div className="m-auth-utils">
          <button
            type="button"
            className="m-pill-btn"
            onClick={toggleLocale}
            aria-label={t("lang.switchLabel")}
          >
            {locale === "en" ? t("lang.shortAr") : t("lang.shortEn")}
          </button>
          <button
            type="button"
            className="m-icon-circle"
            onClick={toggleTheme}
            aria-label={
              theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
            }
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
      </div>

      {/* Centered brand + focused form (no marketing hero, zero scroll) */}
      <div className="m-auth-center">
        <div className="m-auth-brand">
          <div className="m-auth-logo" aria-hidden>
            <Leaf size={30} />
          </div>
          <div className="m-auth-wordmark">
            {t("brand.name").toLowerCase()}
            <span>.</span>
          </div>
          <p className="m-auth-sub">
            {mfa
              ? uiText("Two-factor verification")
              : resetMode !== "none"
                ? uiText("Reset your password")
                : signup
                  ? t("auth.signUpSubtitle")
                  : t("auth.signInSubtitle")}
          </p>
        </div>

        {mfa ? (
          <form className="m-auth-form" onSubmit={submitMfa}>
            <p className="m-auth-sub" style={{ textAlign: "center" }}>
              {mfa.method === "totp"
                ? uiText("Enter the 6-digit code from your authenticator app.")
                : uiText("Enter the verification code sent to your email.")}
            </p>
            <div className="m-field">
              <div className="m-field-head">
                <label className="m-field-label" htmlFor="m-otp">
                  {uiText("Verification code")}
                </label>
              </div>
              <input
                id="m-otp"
                className="m-input"
                required
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={mfa.method === "totp" ? 6 : undefined}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value)}
                placeholder={mfa.method === "totp" ? "000000" : uiText("Code")}
              />
            </div>

            {activeError && (
              <div className="m-alert-box is-error" role="alert">
                {activeError}
              </div>
            )}
            {notice && (
              <div className="m-alert-box is-notice" role="status">
                {notice}
              </div>
            )}

            <button className="m-primary-btn" type="submit" disabled={busy}>
              {busy ? uiText("Verifying…") : uiText("Verify and sign in")}
              <ArrowRight size={17} className="rtl-flip" />
            </button>

            <div className="m-auth-aux">
              {mfa.method === "email_otp" && (
                <button
                  type="button"
                  className="m-link-btn"
                  disabled={busy}
                  onClick={resendOtp}
                >
                  {uiText("Resend code")}
                </button>
              )}
              <button
                type="button"
                className="m-link-btn"
                disabled={busy}
                onClick={() => {
                  const wasTotp = mfa.method === "totp";
                  setMfa(null);
                  setOtpCode("");
                  setError("");
                  setNotice("");
                  onClearInitialMfa?.();
                  if (wasTotp) backend?.signOut();
                }}
              >
                {uiText("Back to sign in")}
              </button>
            </div>
          </form>
        ) : resetMode === "request" ? (
          <form className="m-auth-form" onSubmit={submitResetRequest}>
            <div className="m-field">
              <div className="m-field-head">
                <label className="m-field-label" htmlFor="m-reset-email">
                  {t("auth.email")}
                </label>
              </div>
              <input
                id="m-reset-email"
                className="m-input"
                required
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            {activeError && (
              <div className="m-alert-box is-error" role="alert">
                {activeError}
              </div>
            )}
            {notice && (
              <div className="m-alert-box is-notice" role="status">
                {notice}
              </div>
            )}

            <button className="m-primary-btn" type="submit" disabled={busy}>
              {busy ? uiText("Sending…") : uiText("Send reset email")}
              <ArrowRight size={17} className="rtl-flip" />
            </button>

            <div className="m-auth-aux">
              <button
                type="button"
                className="m-link-btn"
                disabled={busy}
                onClick={() => {
                  setResetMode("confirm");
                  setError("");
                  setNotice("");
                }}
              >
                {uiText("I have a reset token")}
              </button>
              <button
                type="button"
                className="m-link-btn"
                disabled={busy}
                onClick={() => {
                  setResetMode("none");
                  setError("");
                  setNotice("");
                }}
              >
                {uiText("Back to sign in")}
              </button>
            </div>
          </form>
        ) : resetMode === "confirm" ? (
          <form className="m-auth-form" onSubmit={submitResetConfirm}>
            <div className="m-field">
              <div className="m-field-head">
                <label className="m-field-label" htmlFor="m-reset-token">
                  {uiText("Reset token")}
                </label>
              </div>
              <input
                id="m-reset-token"
                className="m-input"
                required
                autoComplete="off"
                value={resetToken}
                onChange={(e) => setResetToken(e.target.value)}
                placeholder={uiText("Paste token from email")}
              />
            </div>
            <div className="m-field">
              <div className="m-field-head">
                <label className="m-field-label" htmlFor="m-reset-pw">
                  {uiText("New password")}
                </label>
              </div>
              <input
                id="m-reset-pw"
                className="m-input"
                required
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder={uiText("At least 8 characters")}
              />
            </div>
            <div className="m-field">
              <div className="m-field-head">
                <label className="m-field-label" htmlFor="m-reset-pw2">
                  {uiText("Confirm new password")}
                </label>
              </div>
              <input
                id="m-reset-pw2"
                className="m-input"
                required
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={resetPasswordConfirm}
                onChange={(e) => setResetPasswordConfirm(e.target.value)}
                placeholder={uiText("Repeat new password")}
              />
            </div>

            {activeError && (
              <div className="m-alert-box is-error" role="alert">
                {activeError}
              </div>
            )}
            {notice && (
              <div className="m-alert-box is-notice" role="status">
                {notice}
              </div>
            )}

            <button className="m-primary-btn" type="submit" disabled={busy}>
              {busy ? uiText("Updating…") : uiText("Update password")}
            </button>

            <div className="m-auth-aux">
              <button
                type="button"
                className="m-link-btn"
                disabled={busy}
                onClick={() => {
                  setResetMode("none");
                  setError("");
                  setNotice("");
                }}
              >
                {uiText("Back to sign in")}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="m-seg" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={!signup}
                className={!signup ? "is-active" : ""}
                onClick={() => {
                  setSignup(false);
                  setError("");
                  setNotice("");
                }}
              >
                {t("auth.signIn")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={signup}
                className={signup ? "is-active" : ""}
                onClick={() => {
                  setSignup(true);
                  setError("");
                  setNotice("");
                }}
              >
                {t("auth.signUp")}
              </button>
            </div>

            <form className="m-auth-form" onSubmit={submit}>
              <div className="m-field">
                <div className="m-field-head">
                  <label className="m-field-label" htmlFor="m-email">
                    {t("auth.email")}
                  </label>
                </div>
                <input
                  id="m-email"
                  className="m-input"
                  required
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>

              <div className="m-field">
                <div className="m-field-head">
                  <label className="m-field-label" htmlFor="m-password">
                    {t("auth.password")}
                  </label>
                  {!signup && backend && (
                    <button
                      type="button"
                      className="m-link-btn"
                      disabled={busy}
                      onClick={() => {
                        setResetMode("request");
                        setError("");
                        setNotice("");
                      }}
                    >
                      {uiText("Forgot?")}
                    </button>
                  )}
                </div>
                <div className="m-input-wrap">
                  <input
                    id="m-password"
                    className="m-input has-suffix"
                    required
                    type={showPassword ? "text" : "password"}
                    minLength={8}
                    autoComplete={signup ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      signup
                        ? t("auth.passwordPlaceholderSignUp")
                        : t("auth.passwordPlaceholderSignIn")
                    }
                  />
                  <button
                    type="button"
                    className="m-input-eye"
                    aria-label={
                      showPassword
                        ? uiText("Hide password")
                        : uiText("Show password")
                    }
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>

              {activeError && (
                <div className="m-alert-box is-error" role="alert">
                  {activeError}
                </div>
              )}
              {notice && (
                <div className="m-alert-box is-notice" role="status">
                  {notice}
                </div>
              )}

              <button className="m-primary-btn" type="submit" disabled={busy}>
                {busy
                  ? t("auth.pleaseWait")
                  : signup
                    ? t("auth.createAccount")
                    : t("auth.signIn")}
              </button>
            </form>

            {googleAvailable !== false && (
              <>
                <div className="m-or-divider">{t("auth.orDivider")}</div>
                <button
                  type="button"
                  className="m-google-btn"
                  disabled={busy || !googleAvailable}
                  onClick={googleSignIn}
                >
                  <svg
                    aria-hidden="true"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                  >
                    <path
                      fill="#4285F4"
                      d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.4Z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 22c2.7 0 5-.9 6.6-2.4L15.4 17c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9l3.3-2.6Z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.9 5.5l3.3 2.6A6 6 0 0 1 12 6Z"
                    />
                  </svg>
                  <span>
                    {busy ? t("auth.pleaseWait") : t("auth.continueGoogle")}
                  </span>
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* Compact footer demo action */}
      <div className="m-auth-footer">
        <button type="button" className="m-demo-pill" onClick={onDemo}>
          <span>{t("auth.exploreDemo")}</span>
          <ArrowRight size={14} className="rtl-flip" />
        </button>
      </div>
    </div>
  );
}
