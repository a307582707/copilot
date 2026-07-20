function envBool(name: string, defaultValue: boolean): boolean {
  const raw = String((import.meta.env as any)?.[name] ?? '').trim().toLowerCase()
  if (!raw) return defaultValue
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'n' || raw === 'off') return false
  return defaultValue
}

// Feature flags (build-time via Vite env)
// - VITE_DASHBOARD_ENABLED=0  -> hide "控制台" tab and default /app to "资产管理"
// Default to OFF for production safety (avoid accidental redeploy showing the dashboard again).
export const DASHBOARD_ENABLED = envBool('VITE_DASHBOARD_ENABLED', false)

// Windows SSH onboarding (HostEditor)
// - VITE_WINDOWS_SSH_GUIDE_ENABLED=0 -> hide Windows OpenSSH guide UI
export const WINDOWS_SSH_GUIDE_ENABLED = envBool('VITE_WINDOWS_SSH_GUIDE_ENABLED', true)

