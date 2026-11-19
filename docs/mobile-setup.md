# Fuloos Mobile App Setup (Android & iOS)

Fuloos Mobile wraps the shared React 19 + TypeScript app in **Capacitor 8**, preserving all 9 pages, dark mode, English/Arabic RTL, integer-fils arithmetic, and the warm botanical palette (`#1b4a39` / `#f7f8f5`), while adding native Android SMS automation, on-device historical backfill, interactive Android notifications, Keystore auth sync, and biometric unlock.

---

## 1. PocketBase Migration (Required for Web + Mobile Review Sync)

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

Requires **Android Studio** (or Android SDK Platform 36 + JDK 17):

```sh
cd android
./gradlew assembleDirectDebug
```

Install the generated APK (`android/app/build/outputs/apk/direct/debug/app-direct-debug.apk`) on your phone via USB (`adb install -r ...`) or by transferring the APK file.

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
- **High confidence**: auto-added to PocketBase + silent notification with **Undo**.
- **Low confidence**: synced as a masked draft to PocketBase (`fuloos_captured_alerts`) + interactive Android notification with **one-tap category buttons** and **Pick other…**.
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
