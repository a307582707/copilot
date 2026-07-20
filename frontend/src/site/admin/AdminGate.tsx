import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

type MeResp = { ok: boolean; user?: { role?: string } }

export function AdminGate(props: { children: React.ReactNode }) {
  const loc = useLocation()
  const [state, setState] = useState<'loading' | 'ok' | 'unauth' | 'forbidden'>('loading')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/me', { headers: { Accept: 'application/json' }, credentials: 'include' })
        if (!r.ok) {
          if (!cancelled) setState('unauth')
          return
        }
        const data = (await r.json().catch(() => null)) as MeResp | null
        const role = data?.user?.role || ''
        if (!cancelled) setState(role === 'admin' ? 'ok' : 'forbidden')
      } catch {
        if (!cancelled) setState('unauth')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'loading') {
    // Keep it minimal; avoid layout shift.
    return (
      <div style={{ minHeight: '100vh', padding: 24, color: '#334155', background: 'linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)' }}>
        正在验证管理员登录态…
      </div>
    )
  }

  if (state === 'unauth') {
    const next = encodeURIComponent(loc.pathname + loc.search)
    return <Navigate to={`/admin/login?next=${next}`} replace />
  }

  if (state === 'forbidden') {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>无权限访问后台</div>
        <div style={{ marginTop: 10, opacity: 0.78, lineHeight: 1.7 }}>
          你的账号不是管理员。如需开通权限，请联系管理员。
        </div>
      </div>
    )
  }

  return <>{props.children}</>
}







