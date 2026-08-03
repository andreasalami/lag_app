/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EVENTBRITE_EVENT_ID?: string;
  readonly VITE_INSTAGRAM_HANDLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
