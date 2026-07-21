import type { PropsWithChildren } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

export function AdminLayout(props: PropsWithChildren<{ minimalHeader?: boolean }>) {
  const [me, setMe] = useState<{ email?: string; role?: string } | null>(null)
  const [loadingMe, setLoadingMe] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/me', { headers: { Accept: 'application/json' }, credentials: 'include' })
        if (!r.ok) {
          if (!cancelled) setMe(null)
          return
        }
        const j = (await r.json().catch(() => null)) as any
        const user = j?.user || {}
        if (!cancelled) setMe({ email: user.email, role: user.role })
      } catch {
        if (!cancelled) setMe(null)
      } finally {
        if (!cancelled) setLoadingMe(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const meLabel = useMemo(() => {
    const email = (me?.email || '').trim()
    if (!email) return ''
    const at = email.indexOf('@')
    if (at <= 2) return email
    return `${email.slice(0, 2)}***${email.slice(at)}`
  }, [me?.email])

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } finally {
      window.location.href = '/admin/login?next=%2Fadmin'
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          height: 64,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 18px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(15,22,33,0.65)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <Link to="/admin" style={{ display: 'flex', gap: 10, alignItems: 'center', textDecoration: 'none' }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(124,92,255,1), rgba(43,213,118,0.85))',
              boxShadow: '0 10px 25px rgba(0,0,0,0.35)',
            }}
          />
          <div>
            <div style={{ fontWeight: 800, letterSpacing: 0.4, color: 'rgba(255,255,255,0.92)' }}>CodeSprite Admin</div>
            <div style={{ fontSize: 12, opacity: 0.65 }}>后台管理</div>
          </div>
        </Link>

        <nav style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {props.minimalHeader ? (
            <Link to="/" style={{ opacity: 0.75, textDecoration: 'underline' }}>
              返回官网
            </Link>
          ) : null}

          {loadingMe ? null : me?.email ? (
            <>
              <Link
                to="/admin"
                style={{
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'rgba(255,255,255,0.03)',
                }}
              >
                后台管理
              </Link>
              <div
                title={me.email}
                style={{
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'rgba(255,255,255,0.02)',
                  color: 'rgba(255,255,255,0.85)',
                  fontSize: 13,
                }}
              >
                {meLabel}
              </div>
              <button
                type="button"
                onClick={logout}
                style={{
                  padding: '8px 12px',
                  borderRadius: 10,
                  border: '1px solid rgba(255,85,85,0.35)',
                  background: 'rgba(255,85,85,0.08)',
                  cursor: 'pointer',
                  color: 'rgba(255,255,255,0.92)',
                  fontWeight: 750,
                }}
              >
                退出登录
              </button>
            </>
          ) : (
            <Link
              to="/admin/login?next=%2Fadmin"
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid rgba(124,92,255,0.55)',
                background: 'rgba(124,92,255,0.12)',
              }}
            >
              后台登录
            </Link>
          )}
        </nav>
      </header>

      <main style={{ flex: 1, overflow: 'auto' }}>{props.children}</main>

      <footer
        style={{
          padding: '12px 18px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          color: 'rgba(255,255,255,0.45)',
          fontSize: 12,
        }}
      >
        内部后台 · 仅授权人员使用
      </footer>
    </div>
  )
}







