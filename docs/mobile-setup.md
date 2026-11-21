# Fuloos Mobile App Setup (Android & iOS)

Fuloos Mobile wraps the shared React 19 + TypeScript app in **Capacitor 8**, preserving all 9 pages, dark mode, English/Arabic RTL, integer-fils arithmetic, and the warm botanical palette (`#1b4a39` / `#f7f8f5`), while adding native Android SMS automation, on-device historical backfill, interactive Android notifications, Keystore auth sync, and biometric unlock.

---

## 1. Backend

The app works with Supabase (`VITE_BACKEND=supabase`) or PocketBase (default). With Supabase,
the app keeps its sign-in in the Android Keystore and the background SMS workers share it, so
capture keeps working while the app is closed. Add `fuloos://auth-callback` to the Supabase
redirect URLs so Google sign-in and email links reopen the app. Everything the Supabase project
needs is listed in [`supabase-client-contract.md`](supabase-client-contract.md).

### PocketBase migration

Low-confidence SMS transactions are synced (with masked text only — never raw SMS content) to `fuloos_captured_alerts` with `source = "sms_native"` so you can review them from either your phone or desktop web.

Deploy the additive migration before enabling native SMS capture:

```sh
# Copy pocketbase/pb_migrations/1794860000_native_sms_capture.js to your PocketBase server
# and restart PocketBase (or run `pocketbase migrate up`).
```

---

## 2. Build & Sync Web + Headless SMS Engine

Every mobile build compiles both the React UI (`dist/`) and the zero-dependency headless SMS/ML bundle (`android/app/src/main/assets/fuloos-sms-engine.js`) executed by Android's Jetpack `JavaScriptSandbox` in the background.

```sh
npm ci
# Ensure .env has your PocketBase URL (e.g. VITE_POCKETBASE_URL=https://pb.danishali.dev)
npm run mobile:android
```

`npm run mobile:android` runs:
1. `npm run build` (`tsc -b && vite build`)
2. `npm run build:sms-engine` (bundles `src/mobile/headlessEntry.ts` → `android/app/src/main/assets/fuloos-sms-engine.js`)
3. `npx cap sync android`

---

## 3. Android Build Flavors (`direct` vs `play`)

Gradle defines two product flavors under the `distribution` dimension (`android/app/build.gradle`):

| Flavor | Purpose | SMS Permissions (`READ_SMS` / `RECEIVE_SMS`) | Build Command |
| :--- | :--- | :--- | :--- |
| **`direct`** | Sideloaded personal APK with full native SMS auto-capture & historical backfill | Included via `android/app/src/direct/AndroidManifest.xml` | `./gradlew assembleDirectDebug` or `assembleDirectRelease` |
| **`play`** | Future Google Play Store submission (uses Shortcuts / Email capture) | Completely omitted from manifest & `BuildConfig.SUPPORTS_DIRECT_SMS = false` | `./gradlew bundlePlayRelease` |

### Building & Sideloading the `direct` APK

Requires **Android Studio** (or Android SDK Platform 36 + JDK 21):

```sh
cd android
./gradlew assembleDirectDebug
```

Install the generated APK (`android/app/build/outputs/apk/direct/debug/app-direct-debug.apk`) on your phone via USB (`adb install -r ...`) or by transferring the APK file.

### Automatic GitHub Release APKs (CI)

`.github/workflows/android-release.yml` automatically builds the `direct` APK (and verifies the `play` flavor compiles) and attaches it + its `.sha256` checksum to **GitHub Releases**:
- **Every push to `main`:** updates the rolling `android-latest` pre-release with `fuloos-android-direct-latest.apk` (or `-debug-latest.apk` before release signing is configured).
- **Version tags (`v*`, e.g. `git tag v1.0.0 && git push origin v1.0.0`) or published GitHub Releases:** builds and attaches `fuloos-android-direct-<tag>.apk`.
- **Manual trigger:** run **Actions → Android APK Release → Run workflow** anytime.

#### Optional Repository Variables & Signing Secrets
Configure these under **GitHub → Settings → Secrets and variables → Actions**:

| Name | Type | Purpose |
| :--- | :--- | :--- |
| `VITE_BACKEND` | Variable | `supabase` to build the APK against Supabase; leave unset for PocketBase. |
| `VITE_SUPABASE_URL` | Variable | Supabase project URL (with `VITE_BACKEND=supabase`). |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Variable | Supabase publishable (anon) key. `VITE_SUPABASE_ANON_KEY` also works. |
| `VITE_POCKETBASE_URL` | Variable (or Secret) | Your live PocketBase URL baked into release APKs when not using Supabase. Without a backend, the APK runs in local demo mode. |
| `VITE_LEDGER_MODEL_URL` | Variable (optional) | URL for the optional on-device ML model bundle. |
| `VITE_VAPID_PUBLIC_KEY` | Variable (optional) | Public VAPID key for Web Push notifications. |
| `ANDROID_KEYSTORE_BASE64` | Secret (optional) | Base64-encoded `.jks` keystore (`base64 -w0 fuloos-release.jks`) so release APKs are signed consistently and upgrade in-place without uninstalling. |
| `ANDROID_KEYSTORE_PASSWORD` | Secret (optional) | Keystore password. |
| `ANDROID_KEY_ALIAS` | Secret (optional) | Key alias inside the keystore (e.g. `fuloos`). |
| `ANDROID_KEY_PASSWORD` | Secret (optional) | Key password. |

Generate a one-time release keystore locally with:

```sh
keytool -genkey -v -keystore fuloos-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias fuloos
base64 -w0 fuloos-release.jks
```

> **Android 13+ Sideload Note ("Allow restricted settings"):**  
> Android blocks `READ_SMS` / `RECEIVE_SMS` on sideloaded APKs until you approve restricted settings once:
> 1. Open **Settings → Apps → Fuloos**.
> 2. Tap the **⋮** menu (top right) → **Allow restricted settings** (confirm with fingerprint/PIN).
> 3. Return to Fuloos → **Accounts → SMS Auto-Capture** → tap **Grant SMS & Notification permissions**.
> 4. Tap **Battery settings** to set Fuloos to **Unrestricted** so OEM battery savers (Samsung, Xiaomi, OnePlus) do not delay incoming bank SMS capture.

---

## 4. Linking Accounts, Card Routing & Historical Backfill

1. Open **Accounts → SMS Auto-Capture** (or **More → SMS Auto-Capture** on mobile).
2. Tap **Link account** and pick a Fuloos account.
3. Choose one or more bank SMS senders discovered from your inbox (e.g. `ADCB`, `Liv`, `ENBD`, `FAB`, `Mashreq`, `ADIB`).
4. *(Optional)* Select or enter a **4-digit card suffix** (e.g. `4512` for your ADCB Debit card, `8891` for your ADCB Credit card) so messages from the same bank sender route to separate Fuloos accounts automatically.
5. Choose automation mode (**Auto-add high confidence** or **Always ask**) and confidence threshold.
6. Run the **Historical Backfill Wizard** to scan past SMSes from that sender:
   - High-confidence transactions are ready in one batch.
   - Low-confidence transactions are grouped by merchant so you categorize each new merchant once.
   - Optionally filter by your account's opening date to avoid double-counting balances.

Going forward, every incoming SMS is processed in the background by `SmsBroadcastReceiver` → `SmsProcessWorker` → `HeadlessSmsEngine`:
- **High confidence**: auto-added to your account + silent notification with **Undo**.
- **Low confidence**: synced as a masked draft (`fuloos_captured_alerts`) + interactive Android notification with **one-tap category buttons** and **Pick other…**.
- **Offline**: queued in on-device SQLite (`FuloosLocalDb`) and flushed automatically by `WorkManager` when connectivity returns.

---

## 5. Porting to iOS

The UI, mobile bottom navigation (`src/MobileNav.tsx`), safe-area CSS (`src/styles/mobile.css`), and `src/mobile/platformBridge.ts` are already iOS-ready. When building on macOS with Xcode:

```sh
npm install -D @capacitor/ios
npx cap add ios
npm run mobile:ios
npx cap open ios
```

Because iOS does not expose raw SMS inbox access to third-party apps, iOS uses Apple Shortcuts Automations ("When I get a message from `ADCB`") posting directly to your Fuloos Capture Webhook / `fuloos_captured_alerts` queue — using the exact same review UI and ML categorisation cascade.
