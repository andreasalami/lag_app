/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EVENTBRITE_EVENT_ID?: string;
  readonly VITE_INSTAGRAM_HANDLE?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_WEB_PUSH_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
