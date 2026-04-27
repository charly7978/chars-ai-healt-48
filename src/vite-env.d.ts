/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_PPG_APP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
