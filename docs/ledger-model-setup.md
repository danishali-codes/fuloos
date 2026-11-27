# Turning on the Ledger model

Fuloos suggests a category for every SMS, CSV and PDF expense. Without a model it uses the public brand and keyword
rules plus your own corrections. With the Ledger model (MAAI902, `ledger-uae-banks`) it also scores merchants the rules
don't know, with a calibrated confidence. This page switches it on for the web app (Vercel) and the Android app.

Nothing here puts personal data in a repository or in the cloud:

- The model file is never committed to this repository. Only its URL is configured.
- Fuloos loads only the **hashed** model. Every n-gram becomes a 24-bit number, the converter fails if any vocabulary
  string survives, and the app refuses plain exports.
- Personal corrections stay in your own Supabase rows (owner-only RLS) and only when you tick "Learn from my
  categorisations". Raw SMS text never leaves the phone.

## 1. Build the hashed model (on your PC)

You need Node 22 and a checkout of this repository. The input is the plain export from
`ledger-uae-banks/export_web_model.ipynb` (`ledger_web_model.json`).

```bash
# from the fuloos folder; write the output OUTSIDE the repository
node --experimental-strip-types scripts/ledger/hash-model.ts \
  ../ledger-uae-banks/site/try/ledger_web_model.json \
  ~/Downloads/ledger-model-v1.json 1
```

It prints something like `Wrote …: 1137 KB, 9519 features, 1 collisions dropped, max probability difference vs plain
7e-8`. A difference above `1e-4` or a "Vocabulary leaked" error means stop and don't upload.

The last argument is the model version shown in the app ("Ledger model v1"). Use a new number and a new file name
each time you retrain.

## 2. Host the file

The file must be reachable with a cross-origin `GET` from the app, and the host must be allowed by the app's
Content-Security-Policy (`connect-src` in `vercel.json`, which already allows `https://*.danishali.dev`).

Recommended: a public bucket in the self-hosted Supabase Storage.

1. Supabase Studio → Storage → **New bucket** → name `ledger-models`, **Public bucket** on.
2. Upload `ledger-model-v1.json` into it.
3. The URL is `https://<supabase host>/storage/v1/object/public/ledger-models/ledger-model-v1.json`.
4. Check it from a terminal. You want `200`, `content-type: application/json` and an
   `access-control-allow-origin` header:

   ```bash
   curl -sI -H "Origin: https://<your fuloos domain>" "<model URL>"
   ```

The bucket is public because every Fuloos user downloads the same base model; it holds only the hashed numbers.
Any other HTTPS host under `*.danishali.dev` that sends CORS headers works too. A host outside that domain also needs
adding to `connect-src` in `vercel.json`.

## 3. Web app: set the Vercel variable

Vercel → the Fuloos project → Settings → Environment Variables → add

| Name | Value | Environments |
| --- | --- | --- |
| `VITE_LEDGER_MODEL_URL` | the URL from step 2 | Production (and Preview if you test there) |

Then **redeploy** (Deployments → latest → Redeploy). Vite bakes `VITE_*` values in at build time, so an existing
deployment does not pick the variable up.

## 4. Android app: set the GitHub variable

GitHub → repository → Settings → Secrets and variables → Actions → **Variables** → New repository variable
`VITE_LEDGER_MODEL_URL` with the same URL. The next push to `main` (or a `v*` tag) runs the Android release
workflow; install the new APK from GitHub Releases. For a local build put the line in `.env.local` before `npm run mobile:android`.

The app downloads the model when it opens and copies it to the phone's local database, so background SMS capture can
use it offline. Background capture needs the APK from this change or later; older APKs ignore the model.

## 5. Supabase: learning tables

Apply `supabase/migrations/20261127000000_ml_learning.sql` (SQL editor or your migration runner). It creates
`fuloos_ml_settings` and `fuloos_ml_examples` with owner-only RLS if they are missing, and is safe to run again if they
exist. Without these tables suggestions still work, but "Learn from my categorisations" only lasts for the browser
session.

## 6. Check it in the app

1. Transactions → **Import SMS**. Under the paste box the status reads
   "Category suggestions use the Ledger model v1 plus brand rules, running on this device." If it says
   "Suggestion model unavailable (…)", the message says why (usually CORS, CSP or a wrong URL).
2. Open **Match suggestions to your categories** and map each of the 12 model groups to one of your categories.
   Rows the model can't place with 60% confidence are marked "Check category".
3. Optional: tick **Learn from my categorisations**. Your corrections then outrank the base model for merchants you
   have filed before, on the web and in the Android background capture.

## Updating the model later

Build with a new version (`… ledger-model-v2.json 2`), upload it next to the old one, change `VITE_LEDGER_MODEL_URL`,
redeploy and rebuild the APK. Personal corrections are stored separately from the base model, so they carry over.
Remove the old file once both apps use the new one.
