# Multi-Currency Transactions Implementation Plan

This document outlines the architecture and file-by-file plan for adding full ISO 4217 multi-currency support to Fuloos across the web app, Supabase backend/migrations, shared headless SMS engine, and Android native app.

## Core Money Model

Three currencies are tracked and kept strictly separate:
1. **Transaction currency** (`original_currency`, `original_amount`): what the merchant charged, in integer minor units of `original_currency`. Always populated on transactions and never overwritten by FX conversion.
2. **Account currency** (`Account.currency`, default `AED`): what the account is held in. `Transaction.amount` is stored in integer minor units of the account's currency. Account balances, credit limits, and running balances use the account's own currency.
3. **Reporting currency** (`UserSettings.reporting_currency`, default `AED`): one per user. Cross-account totals, net worth, budgets, and reports convert account-currency amounts into the reporting currency using the transaction-date rate (or latest rate for balances/forecasts).

New fields on `Transaction`:
- `original_amount`: integer minor units of `original_currency` (always set)
- `original_currency`: 3-letter uppercase ISO 4217 code (always set)
- `amount`: integer minor units of account currency
- `to_amount?`: integer minor units of `to_account_id`'s currency for cross-currency transfers
- `fx_rate`: decimal (`1 original_currency = fx_rate account_currency`, `1` when same currency)
- `fx_rate_date`: `YYYY-MM-DD` date the rate applies to (effective rate date used, including weekend/holiday fallback)
- `fx_source`: `"same_currency" | "bank_sms" | "api_estimate" | "user_confirmed" | "statement_match" | "manual_rate"`
- `fx_status`: `"exact" | "estimated"`

New user settings (`UserSettings`, persisted in `fuloos_user_settings` and local storage):
- `reporting_currency`: ISO 4217 code (default `"AED"`)
- `confirm_foreign_mode`: `"always" | "above_threshold" | "never"` (default `"always"`)
- `confirm_foreign_threshold`: integer minor units of `reporting_currency` (used when `above_threshold`)

## Work Order & Files to Touch

### Step 1 — Implementation Plan
- `docs/multi-currency-plan.md` (this file)

### Step 2 — Full ISO 4217 Currency Support
- **Create** `src/currencyData.ts` — generated ISO 4217 table (`code`, `name`, `decimals`) from ICU/CLDR via Node `Intl` (documented in file header), plus offline GCC/USD peg table (`PEGGED_AED_RATES`).
- **Update** `src/currency.ts` — replace 18-currency hard-coded list with full ISO 4217 lookup, add `roundHalfAwayFromZero`, general `convertMinor(amountMinor, fromCode, toCode, rate)`, `computeImpliedRate`, `formatCurrency` with `Intl.NumberFormat` + fallback `CODE 1,234.50`, `parseCurrencyMinor` / `formatCurrencyInput` for 0/2/3/4 decimals, and updated `validateForeignCurrencyFields` + `fx_source`/`fx_status` helpers. Keep `convertToAedFils` as a thin compatibility wrapper over `convertMinor`.
- **Update** `tests/currency.test.ts` — test ISO 4217 coverage, exponents 0/2/3, unknown codes, `convertMinor`, rounding half away from zero, and property-style round-trip tests (parse -> format -> parse).

### Step 3 — Domain Types, Backend Normalisation, Migration SQL & Contract
- **Update** `src/domain.ts` — add `FxSource`, `FxStatus`, `ConfirmForeignMode`, `UserSettings`, `defaultUserSettings`; extend `Transaction` with `fx_rate_date`, `fx_source`, `fx_status`, `to_amount`; extend `RecurringSchedule` with `currency?`; update `accountDelta` for cross-currency transfers (`to_amount`), `validateTransaction` for multi-currency fields and account-currency minor units, and `moneyForCurrency` helper.
- **Update** `src/backendTypes.ts` — add `user_settings` table type, `UserSettings` normalization, and preserve `original_currency`, `original_amount`, `fx_rate`, `fx_rate_date`, `fx_source`, `fx_status`, `to_amount`, `RecurringSchedule.currency` in `normalizeRecord` (no longer stripping AED `original_currency` when present; backfilling sensible defaults on read).
- **Update** `src/supabaseBackend.ts` & `src/backend.ts` — add new nullable columns (`fx_rate_date`, `fx_source`, `fx_status`, `to_amount`), add `loadUserSettings` / `saveUserSettings` (graceful fallback on missing table), and expose `fetchFxRate` Edge Function caller.
- **Create** `supabase/migrations/20261126000000_multi_currency.sql` — idempotent migration updating `fuloos_transactions`, `fuloos_accounts`, `fuloos_recurring`, creating `fuloos_user_settings` (owner-only RLS) and `fuloos_fx_rates` (authenticated read, service-role write, RLS on), with backfill SQL for existing AED and foreign rows. (Not applied to live DB.)
- **Update** `docs/supabase-client-contract.md` — document new columns, `fuloos_user_settings`, `fuloos_fx_rates`, `fx-rate` Edge Function, and updated Android background sync PATCH/fx-rate requests.
- **Update** `tests/domain.test.ts`, `tests/supabaseBackend.test.ts` — test new fields, normalization, and migration SQL invariants.

### Step 4 — Exchange-Rate Service & Edge Function
- **Create** `src/fxRates.ts` — `RateProvider` interface (`getRate(from, to, date)`), `FawazAhmedProvider` (primary jsDelivr + pages.dev fallback), `FrankfurterProvider` (ECB fallback with USD→AED 3.6725 peg), `EdgeFunctionRateProvider`, `PeggedFallbackProvider`, request batching/deduplication by `(base, date)`, weekend/holiday lookback storing effective `rateDate`, local cache (in-memory + IndexedDB on web + pluggable storage), and `FxRateService` with offline fallback chain (cache → pegged → `rate_unavailable`).
- **Create** `supabase/functions/fx-rate/index.ts` — Deno Edge Function accepting ONLY `{ from, to, date }` (or batch `{ base, quotes, date }`), reading/writing `fuloos_fx_rates` via service role, calling fawazahmed0 (primary + fallback host) then Frankfurter (via USD peg for AED), returning `{ rate, rate_date, provider }`. Never accepts user/merchant/amount data.
- **Create** `tests/fxRates.test.ts` — mocked provider tests for primary, fallback host, Frankfurter USD-peg cross-rate, weekend/holiday effective date, batching/deduplication, offline cache fallback, pegged fallback, and `rate_unavailable`. No live network calls.

### Step 5 — SMS Parser & Pipeline
- **Update** `src/ledger/sms.ts` — remove `amount_aed` conversion from parsing; add Arabic-Indic digit normalisation, currency symbol mapping (`€`, `£`, `$`, `₹`, `﷼`), code-before/after number extraction (`GBP 12.00`, `12.00 GBP`, `GBP12`), 0/3 decimal support, balance/credit-limit context exclusion (`Avl Bal`, `Available balance`, `Avl Cr. limit`, `credit limit`, `Balance`, `Bal`), and dual-amount extraction (`billed_amount` + `billed_currency` when SMS prints both foreign and billed amounts). Return `original_amount_minor` + `currency` + optional `billed_amount_minor`/`billed_currency` + `warnings`.
- **Update** `src/mobile/smsPipeline.ts` — delete `EXTRA_AED_RATES`, update `parseGenericUaeFallback` to keep any currency and never grab balance/credit limit, extend `SmsEngineContext` with `account.currency` and `fxRates` cache map, price into account currency using `billed_amount` (`bank_sms`, `exact`) → cached rate (`api_estimate`, `estimated`) → pegged fallback (`manual_rate`, `estimated`) → empty/0 with `rate_unavailable` warning + `needs_review`. Unknown 3-letter codes keep transaction, assume 2 decimals, add `unknown_currency_code` warning, route to `needs_review`. Feed AED-equivalent amount to `categorise`/`suggestCategory`.
- **Update** `src/ledger/smsImport.ts` — remove "Currency X is not supported yet" error; populate full multi-currency fields using account currency and rate resolver.
- **Update** `src/mobile/headlessEntry.ts` & `src/mobile/useNativeMobile.ts` — pass account currencies and cached FX rates into `SmsEngineContext`.
- **Update** `tests/sms.test.ts` & `tests/mobileSms.test.ts` — add synthetic golden tests covering GBP + credit limit (must NOT become AED 7,000), EUR, INR, JPY (0 decimals), KWD (3 decimals), unknown 3-letter code, dual foreign + billed AED SMS, balance-only non-transaction SMS, Arabic-Indic digits, and offline rate-unavailable behavior.

### Step 6 — Balances, Reports, Budgets, Recurring, Transfers, Import/Export/Backup & Learning
- **Create** `src/multiCurrency.ts` — shared reporting-currency conversion helpers (`convertTransactionToReporting`, `convertAccountBalanceToReporting`, `sumBalancesInReporting`, `reportingTotals`, `estimateFlags`) using synchronous rate-cache lookup with `estimatedCount` tracking.
- **Update** `src/budgets.ts` — convert expense amounts from account currency to reporting currency per transaction date; include `estimatedCount` in `BudgetReport`.
- **Update** `src/reportsAnalytics.ts` — convert transaction amounts to reporting currency across YoY, payee breakdown, and category trends; track estimated counts.
- **Update** `src/netWorth.ts` — convert account balances to reporting currency in `computeNetWorthSummary` and `buildNetWorthSeries`.
- **Update** `src/recurring.ts` & `src/recurringForecast.ts` — support `RecurringSchedule.currency` (defaulting to account currency), convert forecast totals to reporting currency with latest rate, flag estimated conversions.
- **Update** `src/register.ts` — account-scoped register uses account currency; all-accounts register converts running total into reporting currency; handle cross-currency transfer `to_amount`.
- **Update** `src/transferMatch.ts` — preserve existing same-currency matching and add statement-match auto-confirm helper (`findEstimatedStatementMatches`: same account, date within ±3 days, similar merchant, amount within ±5% of estimate → `fx_source = "statement_match"`, `fx_status = "exact"`).
- **Update** `src/csv.ts`, `src/csvPresets.ts`, `src/CsvImport.tsx`, `src/CsvReviewSection.tsx` — add optional `currency` column mapping (defaulting to account currency), parse amounts with currency's decimals, support auto-confirming estimated transactions on CSV import.
- **Update** `src/export.ts` — export account-currency amounts with proper decimals, `fx_rate_date`, `fx_source`, `fx_status`, and reporting currency headers on reports.
- **Update** `src/backup.ts` — remove `"Only AED is supported"` error, accept any ISO 4217 currency in backups, preserve new FX fields and `user_settings`, keep v1/v2 AED-only backups 100% importable.
- **Update** `src/ledger/learning.ts` & `src/ledger/categoriser.ts` — add helper to convert transaction amount to AED-equivalent major units for ML feature extraction.
- **Update** `src/i18n.ts` & `src/arabicUi.ts` — add `formatLocalizedCurrency(minorUnits, currency, locale)` (keeping `formatLocalizedAed` as wrapper) and Arabic translations for all new multi-currency UI strings.
- **Update / add tests** — `tests/backup.test.ts`, `tests/export.test.ts`, `tests/csv.test.ts`, `tests/budgets.test.ts`, `tests/reportsAnalytics.test.ts`, `tests/netWorth.test.ts`, `tests/recurring.test.ts`, `tests/transferMatch.test.ts`, `tests/multiCurrency.test.ts`.

### Step 7 — Web & Mobile UI
- **Create** `src/CurrencyPicker.tsx` — searchable ISO 4217 currency picker showing recent currencies first (persisted in localStorage), code + name + decimals.
- **Create** `src/ConfirmAmountsModal.tsx` — "Confirm amounts" list + inline/sheet editor showing original amount, estimated account amount, input for real charged amount, live implied FX rate, and "Looks right" one-tap confirmation. Works on both web and mobile UI.
- **Update** `src/EditorModal.tsx` — use `CurrencyPicker` on account & transaction forms, allow any currency, fetch live historical estimate for date via `FxRateService`, support cross-currency transfers (both sides editable + implied rate shown), show `fx_status` / `fx_source`.
- **Update** `src/QuickAdd.tsx`, `src/quickAdd.ts` & `src/mobile-ui/MobileQuickAddSheet.tsx` — currency selector with search/recent currencies, live estimate into account currency, proper decimal formatting.
- **Update** `src/TransactionTable.tsx` & `src/mobile-ui/MobileTxRow.tsx` — display amounts in account currency, original currency pill when foreign, and `≈` badge on `fx_status === "estimated"` rows with click-to-confirm.
- **Update** `src/AccountsPage.tsx`, `src/mobile-ui/MobileAccounts.tsx` — show each account's balance in its own currency (remove `"AED balance / X purchases"`), show total net balance in reporting currency.
- **Update** `src/OverviewPage.tsx`, `src/ReportsPage.tsx`, `src/BudgetsView.tsx`, `src/NetWorthView.tsx`, `src/RecurringView.tsx`, `src/RecurringModals.tsx`, `src/mobile-ui/MobileHome.tsx`, `src/mobile-ui/MobileBudgets.tsx`, `src/mobile-ui/MobileTransactions.tsx` — display totals in reporting currency, show estimated-amount flag ("includes N estimated amounts"), surface "Confirm amounts" banner/button when estimated transactions exist.
- **Update** `src/Settings.tsx`, `src/mobile-ui/MobileMore.tsx`, `src/mobile-ui/MobileAppShell.tsx`, `src/AppModals.tsx`, `src/main.tsx`, `src/demo.ts` — add Reporting Currency & "Ask me to confirm foreign amounts" (Always / Above threshold / Never) settings, wire `ConfirmAmountsModal`, load/cache FX rates, and include multi-currency sample transactions in demo mode.

### Step 8 — Android Native Notifications, FX Cache & Bundle Rebuild
- **Update** `android/app/src/main/java/dev/danishali/fuloos/sms/FuloosLocalDb.kt` — add `fx_rates` SQLite table (`base`, `quote`, `rate_date`, `rate`, `provider`, `fetched_at`) and local transaction metadata cache for pending confirmation notifications; bump DB version with non-destructive upgrade.
- **Update** `android/app/src/main/java/dev/danishali/fuloos/sms/BackgroundSyncClient.kt` — add `fetchFxRate(from, to, date)` calling Supabase Edge Function `/functions/v1/fx-rate` (sending only `from`, `to`, `date`), add `patchTransaction(transactionId, patchJson)` through offline queue, send all new multi-currency fields (`original_amount`, `original_currency`, `fx_rate`, `fx_rate_date`, `fx_source`, `fx_status`) in `buildTransactionPayload`.
- **Update** `android/app/src/main/java/dev/danishali/fuloos/sms/SmsProcessWorker.kt` — resolve FX rates for foreign transactions via local cache + `fx-rate` Edge Function, save transaction/draft, and post foreign-confirmation notification when `fx_status == "estimated"` (respecting user's confirm-foreign setting).
- **Update** `android/app/src/main/java/dev/danishali/fuloos/sms/SmsNotificationHelper.kt` — format amounts in any currency (0/2/3 decimals); add `postConfirmForeignAmountNotification` with `RemoteInput` numeric reply action ("Enter {CODE} amount") and "Looks right" confirmation action, respecting existing channels and Android 13+ `POST_NOTIFICATIONS`.
- **Update** `android/app/src/main/java/dev/danishali/fuloos/sms/NotificationActionReceiver.kt` — handle `ACTION_CONFIRM_FX_REPLY` (`RemoteInput` validation, minor-unit conversion, implied rate recomputation, local update + queued Supabase PATCH, dismiss notification) and `ACTION_CONFIRM_FX_ESTIMATE` ("Looks right" -> `fx_source = "user_confirmed"`, `fx_status = "exact"`).
- **Rebuild** `android/app/src/main/assets/fuloos-sms-engine.js` via `npm run build:sms-engine`.

### Step 9 — Verification & Pull Request
- Run `npm test`, `npm run build`, and `npm run build:sms-engine`.
- Verify all acceptance checks and capture screenshots of the new screens in demo mode.
- Push feature branch `feat/multi-currency` and open PR with summary, owner migration checklist, and screenshots.
