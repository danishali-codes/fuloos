# Reliable SMS Parsing Plan (`fuloos.sms/1` — Phases 1 to 3)

## Overview

This plan replaces fragile bank-gated SMS regexes with a layered, validated parsing pipeline (`src/sms/`) that outputs one canonical schema (`fuloos.sms/1`) and keeps all raw SMS text strictly on the device.

Every parser layer returns `ParsedSmsV1` (validated by `src/sms/validate.ts`). Downstream code (FX conversion, de-duplication, rules, ML categorisation, review drafts, and Android notifications) reads only structured fields from `ParsedSmsV1`, never raw SMS text.

### Hard Invariants
- **Privacy:** Raw SMS bodies never leave the device. `buildCapturedAlertDraft` for `source = "sms_native"` never sends SMS text (or substrings of the message) to Supabase. Local tables (`processed_sms`, `unparsed_sms`, `learned_templates`) stay on-device in SQLite (`FuloosLocalDb`) or browser IndexedDB.
- **Sandbox purity:** `src/sms/*`, `src/ledger/sms.ts`, `src/mobile/smsPipeline.ts`, and `src/mobile/headlessEntry.ts` remain pure TypeScript with zero DOM, React, `i18n.ts`, Node, or network dependencies so `android/app/src/main/assets/fuloos-sms-engine.js` evaluates cleanly inside Jetpack `JavaScriptSandbox` and Node `vm.runInNewContext`.
- **Generated rules untouched:** `src/ledger/rules.generated.ts` is never hand-edited. All new hand-written bank templates live in `src/sms/bankTemplates.ts`.
- **Multi-currency compatibility:** All ISO 4217 currency handling, 0/2/3-decimal exponents, labelled balance/limit exclusion, `billed_amount`, and FX metadata from PR #65 remain intact.

---

## Core Foundation: `fuloos.sms/1` Schema, Validator & Golden Fixtures

### New files
- `src/sms/types.ts` — `ParsedSmsV1`, `SmsKind`, `SmsTxnType`, `Money`, `ParseContext`, `LearnedTemplate` (`template_version: 1`), and `mapLegacySmsType` mapping all 17 legacy `SmsType` values to `SmsTxnType`.
- `src/sms/validate.ts` — Strict validator (`validateParsedSmsV1`):
  - Verifies `amount`, `billed_amount`, and `balance_after` correspond to literal numbers present in the normalised SMS text (thousands separators, Arabic-Indic digits `٠-٩`/`۰-۹`, decimal forms).
  - Rejects any `amount` located inside a balance or credit-limit clause (`Avl Bal`, `Available balance`, `Avl Cr. limit`, `credit limit`, `Balance`, `Bal`, `رصيد`, `الحد`).
  - Validates calendar dates (must be real dates within `[received - 400d, received + 2d]`, else falls back to received date with `date_out_of_range`).
  - Requires non-null `direction` when `kind === "transaction"`.
  - Computes `confidence.overall = min(field confidences) * layerFactor` (`learned: 1.0`, `template: 0.95`, `universal: <= 0.9`).
- `docs/fuloos-sms-v1.schema.json` — JSON Schema Draft 2020-12 contract for `fuloos.sms/1`.
- `tests/smsSchemaValidate.test.ts` — Validates sample `ParsedSmsV1` payloads against `docs/fuloos-sms-v1.schema.json` and exercises every validator rule.
- `tests/fixtures/sms-golden.json` — 65+ synthetic messages covering Liv, ADCB, DIB, FAB, and ENBD across debit card, credit card, account debit/credit, salary, transfers, ATM, refund, bill payment, fee, OTP, declined, promo, balance-only notices, foreign currencies (GBP, EUR, INR, JPY, KWD), and credit-limit-only AED figures.
- `tests/smsGolden.test.ts` — Runs every golden fixture through `parseSmsV1` and `processSingleSms`, printing a per-bank accuracy table on failure.

---

## Phase 1: Stop the Bleeding

### Goals
1. **Bank identity from link or sender only** — Never guess bank from message body during parsing decisions. Extend `bankFromSender` with `DIB` (`/\bDIB\b|dubai ?islamic/i`, non-colliding with `ADIB`) and `ENBD` (`/enbd|emirates ?nbd/i`). Keep `bankForMessage` / `detectBankForSenderOrText` only as onboarding sender-discovery hints. Add `DIB` and `ENBD` to link picker UI.
2. **Hand-written bank templates (`src/sms/bankTemplates.ts`)** — Tolerant templates for DIB (account debit/credit, salary, transfer, card payment, finance repayment, ATM), ENBD (card purchase, refund, account debit/credit), and ADCB debit-card purchases (`XXX1234` and `****1234` masks).
3. **Cascade (`src/sms/parse.ts`)** — `parseSmsV1(text, ctx)` runs Learned Templates → Bank Templates (only when bank is known from link or sender) → Universal Extractor, returning the first validator-accepted `transaction` or best non-transaction kind.
4. **No silent skips & local "Couldn't read" list** — Only `otp`, `declined`, and `promo` skip silently. Messages with a money figure + debit/credit verb that fail full parsing route to `needs_review` with `low_confidence_parse`. Other unrecognised messages from linked senders emit `action: "unparsed"` (`kind: "unknown"`), stored locally on-device in SQLite table `unparsed_sms` (`FuloosLocalDb` DB v4, non-destructive upgrade) and surfaced via `FuloosSmsPlugin.kt` + `platformBridge.ts` + `UnparsedSmsModal` / `MobileMore.tsx` (with Dismiss and Teach Fuloos actions).
5. **De-duplicate by SMS identity** — Primary de-duplication is `smsHash` (sender + body + timestamp to the minute) in `processed_sms`. `transactionKey` checks only non-SMS (manual/CSV) ledger transactions and flags matches as `needs_review` with warning `possible_duplicate` instead of silently skipping. Two identical SMS arriving at different minutes create two transactions.
6. **Better payees** — Extract counterparties from `towards / to / from / by / for` phrases cleaned via `cleanName` before falling back to generic labels (`Transfer out`, `Bank debit`).
7. **Zero SMS text in Supabase** — For `source = "sms_native"`, `buildCapturedAlertDraft` sets `raw_text` to `""` (empty string) and keeps all parsed fields (`parsed_amount`, `parsed_payee`, etc.). Local device retains the SMS body in `processed_sms` / `unparsed_sms` for on-device review. Email and Shortcut alerts remain untouched. Verified by an automated test checking no substring > 6 chars of the SMS body appears in the draft payload.
8. **Debug-only on-device dry run** — "Test parser on my inbox" action in APK Settings (gated to debug/demo or APK settings debug tools): reads up to 500 SMS from linked senders on device, runs `parseSmsV1` locally, shows per-sender counts (parsed, review, couldn't read) with zero message text shown, zero writes, and zero network calls.

### Files touched in Phase 1
- `src/sms/bankTemplates.ts`, `src/sms/parse.ts`
- `src/ledger/sms.ts` (extend `bankFromSender` with DIB/ENBD; export helpers cleanly)
- `src/mobile/smsLinks.ts`, `src/mobile/smsPipeline.ts`, `src/mobile/headlessEntry.ts`, `src/mobile/platformBridge.ts`, `src/mobile/useNativeMobile.ts`
- `src/SmsAutoCaptureModal.tsx`, `src/CaptureAlertsModal.tsx`, `src/mobile-ui/MobileMore.tsx`, `src/mobile-ui/MobileAppShell.tsx`, `src/Settings.tsx`, `src/AppModals.tsx`, `src/main.tsx`
- `android/app/src/main/java/dev/danishali/fuloos/sms/FuloosLocalDb.kt` (DB v4: `unparsed_sms` + optional local body column on `processed_sms`)
- `android/app/src/main/java/dev/danishali/fuloos/sms/SmsProcessWorker.kt` (persist `unparsed_sms` locally when `action == "unparsed"`)
- `android/app/src/main/java/dev/danishali/fuloos/sms/FuloosSmsPlugin.kt` (expose `getUnparsedSms`, `dismissUnparsedSms`, `runInboxDryRun`)
- `android/app/src/main/assets/fuloos-sms-engine.js` (rebuilt)
- `tests/smsGolden.test.ts`, `tests/smsSchemaValidate.test.ts`, `tests/mobileSms.test.ts`, `tests/sms.test.ts`

---

## Phase 2: Universal Field Extractor

### Goals
Add `src/sms/universal.ts` extracting every field independently from arbitrary bank wording (English and Arabic) with zero bank-template dependency:
- Normalise whitespace, newlines, dashes, and Arabic-Indic digits (`٠-٩`, `۰-۹`) while preserving original offsets for highlighting.
- Detect OTP, declined, and promo messages first (promo = marketing/offer/% off/win with no transaction verb).
- Extract all money candidates (`CODE amount`, `amount CODE`, `CODEamount`, symbols `€`/`£`/`₹`, and `$` only when no other ISO code is present) using `currencyData.ts` exponents; label each by a ~25-char preceding context window (`balance`, `limit`, `billed`, `amount`); pick transaction amount (first unlabelled after debit/credit verb, else first unlabelled) and parenthetical/inline second currency as `billed_amount`.
- Determine direction & `txn_type` from English + Arabic lexicons; lower confidence on conflicting signals instead of guessing.
- Extract UAE day-first dates (`DD/MM/YYYY`, `DD/MM/YY`, `DD-MMM-YYYY`, `DD MMM YYYY`, `YYYY-MM-DD`, `DD.MM.YYYY`) + optional `HH:mm(:ss)`, preferring dates nearest the amount or after `on`.
- Extract card last 4 (`[X*]*(\d{4})`) and account masks (`A/C|acct|account`), plus credit/debit kind from nearby words.
- Extract counterparty after `at|to|from|towards|by|for|@` up to boundary tokens, strip trailing `-CC` / `, CITY`, and apply `cleanName`.
- Score per-field confidence based on ambiguity.

### Acceptance bar
With bank templates disabled, `universal.ts` alone achieves **≥ 95%** accuracy on amount and direction and **≥ 85%** accuracy on counterparty across the golden transaction fixtures (verified by automated test in `tests/smsGolden.test.ts`).

### Files touched in Phase 2
- `src/sms/universal.ts`
- `src/sms/parse.ts` (wire universal layer as final cascade fallback)
- `tests/smsGolden.test.ts` (add universal-only benchmark & assertions)
- `android/app/src/main/assets/fuloos-sms-engine.js` (rebuilt)

---

## Phase 3: Teach It Once (Learned On-Device Templates)

### Goals
Allow users to teach Fuloos any unfamiliar bank SMS wording once on-device without ever storing user amounts, merchant names, or account/card digits in the template.

- **Pure module (`src/sms/learned.ts`):**
  - Tokenises an SMS into interactive chips (amounts, currencies, dates, times, card masks, balance figures, numbers, and merchant/text spans).
  - Builds a wording-only skeleton replacing dynamic spans with typed slot markers (`{AMOUNT}`, `{CUR}`, `{DATE}`, `{TIME}`, `{CARD}`, `{MERCHANT}`, `{BAL}`, `{NUM}`), hashes the slotted skeleton (`skeleton_hash`), and compiles a tolerant regex matcher (flexible whitespace, optional punctuation, lazy `{MERCHANT}` up to the next fixed token).
  - Matches on normalised sender first, then skeleton. Validated through `validateParsedSmsV1` with confidence `1.0` for taught fields.
  - Self-contained versioned JSON format (`template_version: 1`).
- **On-device storage (`src/sms/learnedStore.ts` + `FuloosLocalDb.kt`):**
  - Android: `learned_templates` table in `FuloosLocalDb.kt` (included in DB v4 schema alongside `unparsed_sms`) exposed via `FuloosSmsPlugin.kt` (`getLearnedTemplates`, `saveLearnedTemplate`, `deleteLearnedTemplate`, `recordTemplateHit`) and injected into `buildEffectiveEngineContextJson`.
  - Web: IndexedDB store (`fuloos-sms-learned-v1`, with in-memory/localStorage fallback) for web SMS import & demo mode.
  - **Not synced to Supabase.**
- **Teach UI & Corrections:**
  - `src/TeachSmsModal.tsx` — Tappable-chip UI pre-filled from `universal.ts` best guess so most messages are confirmed in one tap ("Looks right" / "Save format"). Saves template, re-parses the message and any other matching "Couldn't read" messages with the same skeleton, and routes them according to the link's settings.
  - Accessible from the "Couldn't read" list (`UnparsedSmsModal`), `SmsAutoCaptureModal`, and `CaptureAlertsModal` (including offering "Remember this for similar messages?" when the user corrects amount, direction, or payee on an SMS-sourced item).
  - Settings → SMS → "Learned message formats" lists saved templates (bank, sender, skeleton preview with slots, hit count, last used) with delete.

### Future-Proofing Note (No Sharing Built Yet)
Learned templates intentionally use a self-contained, versioned JSON schema (`template_version: 1`) that stores only normalised bank wording, slot placeholders (`{AMOUNT}`, `{CUR}`, `{MERCHANT}`, etc.), `field_map`, `direction`, `txn_type`, and optional `bank_id` — zero personal values, amounts, card digits, or merchant names. This allows a future opt-in community template library or cross-device sync to exchange wording-only templates without changing the local format or leaking private data.

### Files touched in Phase 3
- `src/sms/learned.ts`, `src/sms/learnedStore.ts`, `src/sms/parse.ts`
- `src/TeachSmsModal.tsx`, `src/UnparsedSmsModal.tsx`, `src/Settings.tsx`, `src/SmsAutoCaptureModal.tsx`, `src/CaptureAlertsModal.tsx`, `src/mobile-ui/MobileMore.tsx`, `src/mobile-ui/MobileAppShell.tsx`, `src/AppModals.tsx`, `src/main.tsx`, `src/demo.ts`
- `src/mobile/platformBridge.ts`, `src/mobile/useNativeMobile.ts`, `src/mobile/smsPipeline.ts`
- `android/app/src/main/java/dev/danishali/fuloos/sms/FuloosLocalDb.kt`, `FuloosSmsPlugin.kt`, `SmsProcessWorker.kt`
- `android/app/src/main/assets/fuloos-sms-engine.js` (rebuilt)
- `tests/smsLearned.test.ts` (verifies zero PII/values in stored templates and "SAMPLE BANK" 1-teach → 3-messages full-confidence parsing)
