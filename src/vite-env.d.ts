/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_BACKEND?: string;
  readonly VITE_POCKETBASE_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_CAPTURE_WEBHOOK_URL?: string;
  readonly VITE_LEDGER_MODEL_URL?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}
