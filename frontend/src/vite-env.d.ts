/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DASHBOARD_ENABLED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

