# Supabase backend: what the Fuloos client expects

The web app, the Android app and the Android background SMS workers all talk to Supabase
when the build sets `VITE_BACKEND=supabase`. This file lists everything the client code
calls, so the database, policies and functions can be built to match. Nothing here has
been created on a Supabase project yet.

Client code: `src/supabaseBackend.ts` (web + app UI), `android/app/src/main/java/dev/danishali/fuloos/sms/BackgroundSyncClient.kt` (background SMS sync).

## Build settings

| Variable | Value |
| --- | --- |
| `VITE_BACKEND` | `supabase` |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` (or `VITE_SUPABASE_ANON_KEY`) | the project's publishable key |
| `VITE_CAPTURE_WEBHOOK_URL` | optional override for the inbound-capture URL shown in Settings |

Set them in Vercel for the web app and as GitHub Actions variables for the Android APK
(`.github/workflows/android-release.yml` passes them to the build).

## Auth settings

- Email/password sign-up with email confirmation, password recovery and email change.
- Google provider (the sign-in button only shows when `/auth/v1/settings` reports `external.google`).
- TOTP MFA enabled (the app enrolls, challenges and unenrolls TOTP factors).
- PKCE flow. **Redirect URLs allow-list must include**:
  - the web app origin (e.g. `https://fuloos.danishali.dev/`), and
  - `fuloos://auth-callback` (the Android app; Google sign-in and email links open the app through it).
- Refresh-token rotation stays on with the default reuse interval (10 s). The Android app and
  its background workers share one session (see below); the reuse interval absorbs the rare
  case where both refresh at the same moment.

## Tables

All tables live in `public`, are named `fuloos_<name>`, have RLS enabled, and are scoped to
the signed-in user (`user_id = auth.uid()`), except where household sharing widens reads
(accounts, categories and budgets with a `household_id` the user is an active member of).

The client:

- reads every row it is allowed to see (`select *`, ordered by `id`, 500 per page), so RLS is the
  only thing that keeps users apart;
- sends `user_id` on insert and never on update, so policies need `WITH CHECK (user_id = auth.uid())`
  on insert and must stop `user_id` from changing on update;
- sends `NULL` (never `""`) for empty foreign keys, dates and optional text;
- generates the `id` itself for rows the Android workers create, so `id` must be `uuid` with
  `default gen_random_uuid()` **and** accept a client-supplied value. A duplicate id must fail with
  a unique violation (HTTP 409); the workers treat that as "already saved" when replaying a queued write.

Each table also needs `user_id uuid not null references auth.users on delete cascade` and
`created`/`updated` timestamps. Fields the client reads and writes, taken from the TypeScript types:

| Table | Fields |
| --- | --- |
| `fuloos_accounts` | `id`: string, `name`: string, `type`: AccountType, `opening_balance`: number, `opening_date`: string, `color`: string, `emoji?`: string, `currency`: string (not null, default `'AED'`, `^[A-Z]{3}$`), `credit_limit?`: number, `statement_day?`: number, `payment_due_day?`: number, `apr_bps?`: number, `minimum_payment?`: number, `household_id?`: string |
| `fuloos_categories` | `id`: string, `household_id?`: string, `user_id?`: string, `name`: string, `description`: string, `color`: string, `emoji?`: string |
| `fuloos_transactions` | `id`: string, `type`: Kind, `amount`: number (account currency minor units), `to_amount?`: number (destination account currency minor units for cross-currency transfers), `account_id`: string, `to_account_id`: string, `category_id`: string, `date`: string, `payee`: string, `notes`: string, `tags?`: string[], `splits?`: TransactionSplit[], `receipt?`: string, `original_amount`: number (merchant-charged minor units), `original_currency`: string (ISO 4217 uppercase), `fx_rate?`: numeric(20,10), `fx_rate_date?`: date, `fx_source?`: `"same_currency" \| "bank_sms" \| "api_estimate" \| "user_confirmed" \| "statement_match" \| "manual_rate"`, `fx_status`: `"exact" \| "estimated"` (default `'exact'`) |
| `fuloos_recurring` | `id`: string, `name`: string, `type`: RecurringKind, `amount`: number, `currency?`: string (ISO 4217, defaults to account currency), `amount_type`: RecurringAmountType, `account_id`: string, `category_id`: string, `frequency`: RecurringFrequency, `start_date`: string, `end_date`: string, `status`: RecurringStatus, `notes`: string |
| `fuloos_recurring_occurrences` | `id`: string, `recurring_id`: string, `occurrence_date`: string, `transaction_id`: string, `match_source?`: OccurrenceMatchSource, `match_reason?`: string |
| `fuloos_recurring_prefs` | `id`: string, `auto_detect`: AutoDetectSetting, `auto_match`: AutoMatchSetting, `dismissed_keys`: string[] |
| `fuloos_user_settings` | `id`: string, `user_id`: uuid (unique, owner-only RLS), `reporting_currency`: string (default `'AED'`, `^[A-Z]{3}$`), `confirm_foreign_mode`: `"always" \| "above_threshold" \| "never"` (default `'always'`), `confirm_foreign_threshold`: bigint (default `5000`) |
| `fuloos_fx_rates` | Shared public FX cache (no `user_id`, RLS enabled: `SELECT` for `authenticated`, write only via Edge Function `service_role`): `base`: string, `quote`: string, `rate_date`: date, `rate`: numeric(20,10), `provider`: string, `fetched_at`: timestamptz, primary key `(base, quote, rate_date)` |
| `fuloos_csv_presets` | `id`: string, `name`: string, `name_key`: string, `config`: unknown |
| `fuloos_budgets` | `id`: string, `category_id`: string, `amount`: number (reporting currency minor units), `start_month`: string, `end_month`: string, `household_id?`: string |
| `fuloos_goals` | `id`: string, `name`: string, `target_amount`: number, `current_amount`: number, `target_date`: string, `account_id`: string, `color`: string, `emoji?`: string, `kind`: GoalKind, `status`: GoalStatus, `notes`: string |
| `fuloos_goal_contributions` | `id`: string, `goal_id`: string, `amount`: number, `date`: string, `transaction_id`: string, `notes`: string |
| `fuloos_ml_settings` | `id`: string, `learn_consent`: boolean, `share_consent?`: boolean, `consent_version`: string, `consent_at`: string, `category_map`: unknown |
| `fuloos_ml_examples` | `id`: string, `merchant_text`: string, `payee`: string, `amount`: number, `category_id`: string, `source`: "manual" \| "sms" \| "csv", `model_version`: string, `suggested_category`: string, `accepted`: boolean, `created?`: string |
| `fuloos_rules` | `id`: string, `name`: string, `enabled`: boolean, `priority`: number, `match_field`: RuleMatchField, `match_type`: RuleMatchType, `pattern`: string, `min_amount?`: number, `max_amount?`: number, `set_category_id?`: string, `add_tags?`: string[], `set_payee?`: string |
| `fuloos_notification_prefs` | `id`: string, `email_enabled`: boolean, `upcoming_bill_enabled`: boolean, `upcoming_bill_days`: number, `overdue_enabled`: boolean, `budget_80_enabled`: boolean, `budget_100_enabled`: boolean, `weekly_digest_enabled`: boolean, `digest_day`: DigestDay, `timezone`: string, `channels?`: Record<string, boolean> |
| `fuloos_notification_log` | `id`: string, `dedup_key`: string, `channel`: string, `event_type`: string, `period_key`: string, `subject?`: string, `sent_at?`: string |
| `fuloos_capture_tokens` | `id`: string, `token_preview`: string, `enabled`: boolean, `default_account_id`: string |
| `fuloos_captured_alerts` | `id`: string, `source`: CaptureAlertSource, `subject`: string, `raw_text`: string, `parsed_type`: CaptureAlertType, `parsed_amount`: number, `parsed_date`: string, `parsed_payee`: string, `parsed_notes`: string, `account_hint`: string, `status`: CaptureAlertStatus, `created_at_iso`: string, `account_id?`: string, `suggested_category_id?`: string, `confidence?`: number, `top_suggestions?`: CaptureCategorySuggestion[], `sms_sender?`: string, `card_last4?`: string, `parsed_currency?`: string, `parsed_original_amount?`: number, `parsed_fx_rate?`: number, `parsed_fx_rate_date?`: date, `parsed_fx_source?`: string, `parsed_fx_status?`: string, `warnings?`: string[] |
| `fuloos_net_worth_items` | `id`: string, `name`: string, `kind`: NetWorthKind, `category`: NetWorthCategory, `current_value`: number, `as_of_date`: string, `notes`: string, `color`: string, `emoji?`: string |
| `fuloos_net_worth_snapshots` | `id`: string, `item_id`: string, `value`: number, `date`: string, `notes`: string, `revision?`: number |
| `fuloos_push_subscriptions` | `id`: string, `endpoint`: string, `p256dh`: string, `auth`: string, `user_agent?`: string, `created_at_iso?`: string |
| `fuloos_households` | `id`: string, `name`: string, `owner_id`: string |
| `fuloos_household_members` | `id`: string, `household_id`: string, `user_id`: string, `role`: HouseholdRole, `status`: HouseholdMemberStatus, `invite_code?`: string, `member_email?`: string |

Server-side rules that PocketBase enforces today with hooks in `pocketbase/pb_migrations`
and must become triggers or RPC logic:

- deleting a transaction clears its recurring occurrences and goal contributions;
- deleting an account or category is refused while transactions use it, and clears budgets/recurring links;
- deleting a goal, recurring schedule or net-worth item removes its contributions, occurrences or snapshots;
- the recurring type guard on transactions;
- household insert/update guards on accounts, budgets and members (a user can't add themselves to a household they weren't invited to, or make themselves owner);
- `balance_as_of` on accounts;
- idempotency for the `operation_key` RPCs (PocketBase uses `fuloos_operations`).

## RPCs (`/rest/v1/rpc/...`)

| Function | Arguments | Returns |
| --- | --- | --- |
| `fuloos_household_invite` | `household_id`, `role` | household member |
| `fuloos_household_join` | `code` | `{ household, member }` |
| `fuloos_share_account` | `account_id`, `household_id` | account |
| `fuloos_share_budget` | `budget_id`, `household_id` | budget |
| `fuloos_contribute_goal` | `goal_id`, `payload` | `{ goal, contribution, transaction }` |
| `fuloos_remove_goal_contribution` | `contribution_id` | goal |
| `fuloos_import_captured_alert` | `alert_id`, `transaction` | transaction |
| `fuloos_save_net_worth_item` | `draft`, `item_id`, `operation_key` | `{ item, snapshots }` |
| `fuloos_save_net_worth_valuation` | `item_id`, `value`, `date`, `notes`, `operation_key` | `{ item, snapshots }` |
| `fuloos_delete_net_worth_snapshot` | `snapshot_id` | `{ item, snapshots }` |
| `fuloos_rotate_capture_token` | none | `{ id, token, token_preview, enabled, default_account_id }` |
| `fuloos_update_transactions` | `rows` | transactions |
| `fuloos_delete_account` | none | nothing; deletes the auth user, all `fuloos_*` rows and the user's receipt files |

`fuloos_import_captured_alert` must set `user_id` from `auth.uid()`, only import an alert that is
still `pending`, and be safe to call twice (the Android workers retry it after network errors).

## Edge Functions

| Function | Auth | Purpose |
| --- | --- | --- |
| `notify-test` | user JWT | send a test notification email, returns `{ ok, message }` |
| `push-test` | user JWT | send a test Web Push, returns `{ ok, message }` |
| `inbound-capture` | capture token in the body | email/Shortcut/Tasker alerts into `fuloos_captured_alerts` |
| `fx-rate` | user JWT | lookup/cache historical FX rate for `{ from, to, date }` (never accepts amounts, merchants, accounts, or user data); reads/writes `fuloos_fx_rates` via service role and returns `{ rate, rate_date, provider }` |

## Storage

Private bucket `receipts`, object key `<transaction_id>/<filename>`. Policies must check that the
transaction in the first path segment belongs to `auth.uid()` (the path has no user id in it).
Deleting a transaction or the account should also delete its receipt objects; the client only
removes them when a receipt is explicitly removed from a transaction.

## Android background SMS sync

The Android app keeps the supabase-js session in the Android Keystore
(`SecureAuthStore.kt`, storage key `fuloos-supabase-auth`) instead of `localStorage`. The
background workers read the same session, refresh it through
`POST /auth/v1/token?grant_type=refresh_token` when it expires within 45 seconds, and write the
rotated tokens back; the app picks them up on its next request or when it resumes. So SMS capture
keeps working after the app is closed, as long as the refresh token is valid.

Requests the workers send (all with `apikey` and `Authorization: Bearer <access token>`):

| What | Request |
| --- | --- |
| Auto-added transaction | `POST /rest/v1/fuloos_transactions` (`Prefer: return=minimal`), client uuid `id`, `user_id`, `type`, `amount`, `date`, `account_id`, `to_account_id`, `category_id`, `payee`, `notes`, `tags`, `splits`, `original_currency`, `original_amount`, `fx_rate`, `fx_rate_date`, `fx_source`, `fx_status` |
| Confirm foreign amount from notification | `PATCH /rest/v1/fuloos_transactions?id=eq.<id>` with `{ amount, fx_rate, fx_source: "user_confirmed", fx_status: "exact" }` (queued offline on network errors) |
| FX rate lookup | `POST /functions/v1/fx-rate` with `{ from, to, date }` only (never SMS text, merchant, amount, or account) |
| Undo from the notification | `DELETE /rest/v1/fuloos_transactions?id=eq.<id>` |
| Low-confidence draft | `POST /rest/v1/fuloos_captured_alerts`, client uuid `id`, `source = "sms_native"`, masked `raw_text`, parsed fields (including foreign-currency fields), `sms_sender`, `card_last4`, `confidence`, `top_suggestions` |
| Categorize from the notification | `POST /rest/v1/rpc/fuloos_import_captured_alert` with `{ alert_id, transaction }` |
| Dismiss from the notification | `PATCH /rest/v1/fuloos_captured_alerts?id=eq.<id>` with `{ status }` |
| Consented learning example | `POST /rest/v1/fuloos_ml_examples` (only when the user turned learning on) |

Raw SMS text never leaves the phone; drafts carry the masked preview only.

A 401 makes the worker refresh once and retry; a refused refresh means the user must open the
app and sign in again. A 403 (RLS refusal) is treated as permanent and the queued write is dropped.
