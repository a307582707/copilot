import { DEFAULT_PREFS, type ThemeMode } from '../prefs'

function safeThemeMode(raw: any): ThemeMode {
  const v = String(raw || '').trim()
  return v === 'neutral' || v === 'light' || v === 'dark' ? (v as ThemeMode) : DEFAULT_PREFS.themeMode
}

/**
 * Apply theme early (before React renders) to avoid a background flash.
 * Source of truth is `codesprite_prefs_v1` (see `frontend/src/prefs.ts`).
 */
export function bootTheme(): void {
  try {
    const html = document.documentElement
    const raw = localStorage.getItem('codesprite_prefs_v1') || ''
    if (!raw) {
      html.dataset.theme = DEFAULT_PREFS.themeMode
      return
    }
    const j = JSON.parse(raw) as any
    html.dataset.theme = safeThemeMode(j?.themeMode)
  } catch {
    try {
      document.documentElement.dataset.theme = DEFAULT_PREFS.themeMode
    } catch {
      // ignore
    }
  }
}

