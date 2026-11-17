# Fuloos app review — 17 November 2026

Reviewed application source, PocketBase migrations/hooks, existing tests, open PRs, CI results, production deployment history, and production HTML/JavaScript. Code references below use the reviewed merge commit, `500e7f0303a373e07a5e4eff5b1ca6b0016a4405`.

## Completed

- Resolved conflicts in PR [#47](https://github.com/danishali-codes/fuloos/pull/47), preserving the changes already merged into main.
- Aligned React/React DOM at 19.3.1 and their type packages at 19.3.0.
- Updated @vitejs/plugin-react from 4.3.4 to 6.3.0: the previous plugin declared compatibility only through Vite 6 while main had Vite 8.3.8.
- Merged PR #47 after all checks passed. No open PRs remained after the merge.
- Confirmed the merged commit passes typechecking, 305 unit tests, the build, 11 Playwright demo browser tests, and the PocketBase integration job.
- Confirmed Vercel production deployment `dpl_4HDhuXu7LppfccyTKa9tmkUQxNTr` is READY and https://fuloos.danishali.dev returns HTTP 200 with the new application bundle.
- The production bundle points to https://pb.danishali.dev.

Recent production builds had been failing at dependency installation with ERESOLVE. The working production deployment now includes the dependency repair.

## Current repair status

The defects below were addressed in PR #50 after this initial review. The implementation adds retry-safe atomic server operations; a v2 backup with new feature data, receipt bytes, privacy exclusions and owned household-group restoration; shared categories and bulk ownership preservation; split-aware paginated notification calculations; stable valuation ordering and recalculation; notification deep-link handling; explicit AED-accounting labels; expanded Arabic UI strings and money formatting; and additional browser/integration regression coverage. Browser testing also found and repaired the missing Net Worth page mount.

[Deploy the matching PocketBase files using this checklist](../pocketbase/UPGRADE_2026-11-17.md). These server changes must be installed on the actual server; passing integration tests against a temporary instance does not install them in production.

Foreign-currency support continues to use an AED ledger with explicit foreign-purchase conversion, now clearly labeled. The missing-capabilities section below distinguishes new product features and externally configured integrations from the repaired defects.

## Original findings (addressed in PR #50)

### 1. High — “Full backup” does not cover the current product

Source: [backup.ts](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/src/backup.ts#L76), [DataBackup.tsx](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/src/DataBackup.tsx#L73).

The backup data structure exports accounts, categories, transactions, recurring schedules/occurrences/preferences, budgets and CSV presets. It omits goals/contributions, net-worth items/history, transaction rules, captured alerts, notification settings and household configuration. Receipt file bytes are not exported. Account validation during restore also drops newer credit-card fields such as credit limit, statement day, payment due day, APR and minimum payment.

Impact: restoring the advertised full backup cannot reproduce a current workspace. ML data is intentionally excluded for privacy; the newer omissions are additional to that documented exclusion.

Fix: version the backup schema, explicitly list exclusions, support the newer data with reference remapping, and add an attachment export/restore strategy. Verify a round trip containing every supported feature.

### 2. High — Savings contributions can partially save or lose concurrent updates

Source: [main.tsx](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/src/main.tsx#L714).

A contribution can create a transaction, create a contribution record, and then update the goal total in separate requests. Deleting a contribution and updating the total also use separate requests. Totals are calculated from the currently loaded goal.

Impact: failure between requests leaves inconsistent data; retrying can duplicate an earlier successful write. Two devices contributing concurrently can overwrite each other's totals.

Fix: use a server transaction that computes the total from current data, or derive the total from contribution records. Atomic batching handles partial writes but still needs concurrency protection for a stored total.

### 3. High — Captured bank-alert import is not atomic

Source: [main.tsx](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/src/main.tsx#L584).

Import creates the ledger transaction first, then marks the alert imported in another request.

Impact: if the second request fails, the alert stays pending despite its transaction already existing; retrying can create a duplicate.

Fix: an atomic import operation with a unique link/idempotency key tied to the captured alert. Test failure after transaction creation and concurrent import from two devices.

### 4. High — Household editing is inconsistent

Sources: [backend.ts](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/src/backend.ts#L1139), [household migration](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/pocketbase/pb_migrations/1794680000_households.js).

Ordinary updates preserve ownership, but bulk transaction PATCH requests explicitly submit the signed-in user's user_id. Editing a transaction belonging to another household member therefore attempts an ownership change, which the server rules reject.

Shared accounts/transactions/budgets are exposed to members, while categories remain private. Members can receive transactions/budgets referencing categories absent from their loaded ledger. Category displays, editing and budget calculations need a defined shared-category policy.

Existing integration coverage verifies non-member isolation, joining, shared reads, private-account isolation and an editor creating a transaction. It does not establish a complete owner/editor/viewer matrix.

Fix: preserve ownership in bulk updates, define category sharing, and test viewer write denial, editor updates to another member's records, role changes, member removal, invite reuse and shared budget behavior.

### 5. High — Budget notifications disagree with split-aware reports

Sources: [notifications.pb.js](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/pocketbase/pb_hooks/notifications.pb.js#L164), [notifications_lib.js](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/pocketbase/pb_hooks/notifications_lib.js#L303).

The server's transaction mapper drops splits, and its budget alert calculation allocates each entire expense to the parent category. The UI allocates amounts using transaction splits.

Impact: 80%/100% email or push alerts can be missing or wrong for split transactions.

The notification loader also reads at most 2,000 records per collection without pagination or a date filter; larger ledgers can produce incomplete calculations.

Fix: use the same split allocation semantics on the server, paginate/filter the necessary records, and add parity tests with splits and more than 2,000 transactions.

### 6. Medium — Net-worth history and current values can diverge

Source: [main.tsx](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/src/main.tsx#L833).

Creating an item and its initial snapshot, or adding a valuation and updating current value, use separate requests. Deleting a snapshot removes history without recalculating the item's stored current_value/as_of_date.

Impact: deleting the latest valuation leaves the summary showing the deleted value; interrupted writes can leave history and current state inconsistent.

Fix: define current value as the latest valid snapshot or update both atomically. Test deleting the latest snapshot and adding backdated valuations.

### 7. Medium — Notification settings links do not open settings

Sources: [main.tsx](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/src/main.tsx#L146), [service worker](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/public/sw.js).

Notifications point to /?settings=notifications, but the app initializes settings closed and does not consume this query parameter. Its URL parsing covers quick-add instead.

Fix: preserve the requested destination through authentication, open Settings → Notifications, and add a browser test.

### 8. Medium — Foreign-currency support is partial

Sources: [currency.ts](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/src/currency.ts), [domain.ts](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/src/domain.ts#L310), [EditorModal.tsx](https://github.com/danishali-codes/fuloos/blob/500e7f0303a373e07a5e4eff5b1ca6b0016a4405/src/EditorModal.tsx).

Foreign transaction metadata and manual conversion to AED exist. However, account balances, opening balances, transaction arithmetic and transfer values remain AED-based even when an account has a different currency label. This is foreign-purchase annotation, not a complete native-currency account ledger.

Reference exchange rates are hard-coded, not live bank rates. The account form does label balances AED, so a currency label alone should not be interpreted as native-currency accounting.

Fix: either make that limitation explicit throughout the product or implement native-currency balances, opening values and two-sided FX transfers.

### 9. Medium — Arabic coverage is incomplete

The navigation/settings translation infrastructure exists, but many editor, goals, household, backup and notification strings remain hard-coded English. Selecting Arabic does not translate the full workflow.

Fix: cover every user-facing string and test RTL forms, dates and money formatting.

### 10. Medium — Test coverage does not validate every new screen

The 11 browser tests cover accounts, categories, transaction CRUD, month navigation, CSV, SMS, recurring, budgets, reports, theme and mobile smoke. They do not cover the full newer workflows for PDF extraction, backups/restore, goals, net worth, receipts, alert capture, households, notification delivery and live authentication.

Existing unit and integration tests are useful but do not replace those browser and production checks.

## Missing capabilities or deployment-dependent features

- Native Android background SMS capture is not implemented. Manual SMS import and externally configured Tasker/Shortcut forwarding exist.
- Offline financial editing/sync is not implemented. The service worker caches the application shell and static assets, not the authenticated ledger.
- Authenticator-app TOTP and passkeys are not implemented; the implemented second factor is email OTP.
- Scanned PDF OCR and an in-app password-unlock flow are absent. Current PDF import extracts text and tells users to unlock protected PDFs first.
- Shared household categories and a complete role-aware editing experience need completion as described above.
- Push delivery needs an external relay and VAPID configuration. The repository contains a relay client, not a standalone deployed delivery service.
- Base ML categorization needs a separately hosted hashed model and VITE_LEDGER_MODEL_URL. Without it, rule-based categorization and available personal-learning behavior remain; do not assume a configured production model.
- Automatic incoming bank email/SMS capture requires an external email worker or phone automation. Installing PocketBase hooks alone does not connect bank messages.
- README scope/setup sections are stale: several features still described as deferred now have implementation files. Documentation should distinguish implemented, configured, verified and planned.

## PocketBase operator checklist

Current production migration state could not be verified from this session. Do not treat the historical November 7 notes as evidence of what is installed now.

1. Back up pb_data and the existing hook/migration directories.
2. From the merged main branch, copy **all** files in [pocketbase/pb_migrations](../../pocketbase/pb_migrations) into the running instance's mounted migration directory, preserving existing files. Run pending migrations using the existing container's normal startup/deployment process. Do not roll back or edit previously applied migrations.
3. Copy **all** files in [pocketbase/pb_hooks](../../pocketbase/pb_hooks), including the helper .js files, into the instance's mounted hook directory; restart the existing container.
4. Confirm pending migrations through 1794700000_web_push.js are installed. This includes hardening, account security, notifications, enrichment/receipts/rules, goals, captured alerts, FX metadata, net worth, credit-card tools and households.
5. Enable Batch requests with at least 100 operations per batch and bounded body/time limits.
6. Configure SMTP and test delivery before opting into email MFA or notifications.
7. Set APP_URL=https://fuloos.danishali.dev on PocketBase.
8. Keep Google OAuth configured on fuloos_users with redirect https://pb.danishali.dev/api/oauth2-redirect.
9. If enabling automatic capture, configure the email worker/phone automation and protect each user's capture token.
10. If enabling push, configure PUSH_RELAY_URL and any relay authentication, VAPID keys/subject, plus VITE_VAPID_PUBLIC_KEY on Vercel, then rebuild.
11. If enabling the base ML model, host the hashed model, set VITE_LEDGER_MODEL_URL on Vercel, and ensure its origin is allowed by the frontend CSP and its server permits CORS.
12. Verify two-user isolation, an owner/editor/viewer household, receipt upload/download, password reset/MFA, alerts, notification delivery, and batch imports against the actual server.

The remaining data-consistency bugs require application/server code changes; dashboard configuration alone will not fix them. Any server-side fixes should be shipped as new migrations or hook updates.

## Verification limits

No local executor or interactive browser was available in this session. Verification used hosted GitHub Actions, Vercel deployment records, and HTTP retrieval of the production HTML/JavaScript. Attempts to inspect the live PocketBase public endpoints through the available web reader did not succeed; that reader failure is not evidence of a PocketBase outage. Production login, Google consent, SMTP delivery, actual installed migrations and push delivery were not end-to-end verified.
