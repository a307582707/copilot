export type PrefDefaultMode = 'chat' | 'ssh' | 'plugins' | 'workspace'

export type ThemeMode = 'dark' | 'neutral' | 'light'

export type Prefs = {
  version: 1
  /** If true: restore last opened module/tab on refresh. If false: always start from defaultMode. */
  rememberLastMode: boolean
  defaultMode: PrefDefaultMode
  /** UI background theme (3 presets). */
  themeMode: ThemeMode
}

const PREFS_KEY = 'codesprite_prefs_v3'

export const DEFAULT_PREFS: Prefs = {
  version: 1,
  rememberLastMode: false,
  defaultMode: 'workspace',
  themeMode: 'light',
}

type StoredPrefs = Partial<Prefs> | null | undefined

export function normalizePrefs(input: StoredPrefs): Prefs {
  const rememberLastMode = Boolean(input?.rememberLastMode ?? DEFAULT_PREFS.rememberLastMode)
  const dm = String(input?.defaultMode ?? DEFAULT_PREFS.defaultMode)
  const defaultMode: PrefDefaultMode = dm === 'ssh' || dm === 'plugins' || dm === 'chat' || dm === 'workspace' ? (dm as PrefDefaultMode) : DEFAULT_PREFS.defaultMode
  const tm = String(input?.themeMode ?? DEFAULT_PREFS.themeMode)
  const themeMode: ThemeMode = tm === 'neutral' || tm === 'light' || tm === 'dark' ? (tm as ThemeMode) : DEFAULT_PREFS.themeMode
  return { version: 1, rememberLastMode, defaultMode, themeMode }
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY) || ''
    if (!raw) return DEFAULT_PREFS
    const j = JSON.parse(raw) as StoredPrefs
    return normalizePrefs(j)
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        version: 1,
        rememberLastMode: !!p.rememberLastMode,
        defaultMode: p.defaultMode,
        themeMode: p.themeMode,
      }),
    )
  } catch {
    // ignore
  }
}

