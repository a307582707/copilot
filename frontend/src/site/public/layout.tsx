import type { PropsWithChildren } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { DASHBOARD_ENABLED } from '../../flags'

function NavLink(props: { to: string; label: string }) {
  const loc = useLocation()
  const active = loc.pathname === props.to || (props.to !== '/' && loc.pathname.startsWith(props.to + '/'))
  return (
    <Link
      to={props.to}
      style={{
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: active ? 'rgba(15,23,42,0.06)' : 'transparent',
        color: active ? '#0f172a' : '#64748b',
        fontSize: 14,
        fontWeight: 500,
        transition: 'color 120ms ease, background 120ms ease',
      }}
    >
      {props.label}
    </Link>
  )
}

function CovixaBrandMark() {
  return (
    <span className="pubBrandMark" aria-hidden="true">
      <svg viewBox="0 0 64 64" className="pubBrandMarkSvg">
        <defs>
          <linearGradient id="covixaBrandGlow" x1="10" y1="10" x2="54" y2="54" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#7c3aed" />
            <stop offset="1" stopColor="#2563eb" />
          </linearGradient>
        </defs>
        <rect x="4" y="4" width="56" height="56" rx="18" fill="#0f172a" />
        <path
          d="M39.5 20.5a13.9 13.9 0 0 0-8.7-3.1c-7.8 0-13.9 6.4-13.9 14.6s6.1 14.6 13.9 14.6c3.2 0 6.2-1 8.7-3.1"
          fill="none"
          stroke="url(#covixaBrandGlow)"
          strokeLinecap="round"
          strokeWidth="5.2"
        />
        <path d="M34.8 25.2 42.6 38.8" fill="none" stroke="#f8fafc" strokeLinecap="round" strokeWidth="4.2" />
        <path d="M42.6 25.2 34.8 38.8" fill="none" stroke="#cbd5e1" strokeLinecap="round" strokeWidth="4.2" />
      </svg>
    </span>
  )
}

export function PublicLayout(props: PropsWithChildren) {
  const [me, setMe] = useState<{
    email?: string
    role?: string
    displayName?: string
    phone?: string
    phoneVerifiedAt?: number | null
    wechatBound?: boolean
  } | null>(null)
  const [loadingMe, setLoadingMe] = useState(true)
  const [billing, setBilling] = useState<{ plan?: string; expiresAt?: number | null } | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)
  const [scrolled, setScrolled] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement | null>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const mobileNavRef = useRef<HTMLDivElement | null>(null)

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
        if (!cancelled) {
          setMe({
            email: user.email,
            role: user.role,
            displayName: user.displayName,
            phone: user.phone,
            phoneVerifiedAt: user.phoneVerifiedAt,
            wechatBound: !!user.wechatBound,
          })
        }
        try {
          const b = await fetch('/api/me/billing', { headers: { Accept: 'application/json' }, credentials: 'include' })
          const bj = (await b.json().catch(() => null)) as any
          const plan = (bj?.plan || bj?.billing?.plan || '').toString()
          const expiresAtRaw = bj?.expires_at ?? bj?.billing?.expires_at ?? null
          const expiresAt = typeof expiresAtRaw === 'number' ? expiresAtRaw : null
          if (!cancelled) setBilling({ plan, expiresAt })
        } catch {
          if (!cancelled) setBilling(null)
        }
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
    const displayName = (me?.displayName || '').trim()
    if (displayName) return displayName
    const email = (me?.email || '').trim()
    if (!email) return ''
    const at = email.indexOf('@')
    if (at <= 2) return email
    return `${email.slice(0, 2)}***${email.slice(at)}`
  }, [me?.displayName, me?.email])

  const isPro = useMemo(() => {
    const p = (billing?.plan || '').toLowerCase()
    return p.includes('pro')
  }, [billing?.plan])

  const phoneBound = useMemo(() => Boolean(me?.phoneVerifiedAt), [me?.phoneVerifiedAt])
  const wechatBound = useMemo(() => Boolean(me?.wechatBound), [me?.wechatBound])
  const phoneLabel = useMemo(() => {
    const raw = (me?.phone || '').trim()
    if (!phoneBound || !raw) return '未绑定'
    if (/^1[3-9]\d{9}$/.test(raw)) return `${raw.slice(0, 3)}****${raw.slice(-4)}`
    return raw
  }, [me?.phone, phoneBound])

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const onScroll = () => {
      setScrolled(el.scrollTop > 4)
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!userMenuOpen) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const root = userMenuRef.current
      const target = e.target as Node | null
      if (!root || !target) return
      if (root.contains(target)) return
      setUserMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUserMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [userMenuOpen])

  useEffect(() => {
    if (!mobileNavOpen) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const root = mobileNavRef.current
      const target = e.target as Node | null
      if (!root || !target) return
      if (root.contains(target)) return
      setMobileNavOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [mobileNavOpen])

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } finally {
      window.location.href = '/'
    }
  }

  return (
    <div className="pubSite">
      {/* ── Navigation bar ── */}
      <header
        className="pubHeader"
        style={{
          height: 58,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 28px',
          position: 'sticky',
          top: 0,
          zIndex: 80,
          background: scrolled ? 'rgba(255,255,255,0.95)' : '#ffffff',
          borderBottom: '1px solid #e2e8f0',
          backdropFilter: scrolled ? 'blur(16px)' : 'none',
        }}
      >
        {/* Brand */}
        <Link to="/" className="pubBrand" style={{ display: 'flex', gap: 9, alignItems: 'center', textDecoration: 'none' }}>
          <CovixaBrandMark />
          <div className="pubBrandText">
            <div style={{ fontWeight: 700, fontSize: 15, color: '#0f172a', letterSpacing: -0.3 }}>Covixa</div>
            <div className="pubBrandSub" style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1 }}>
              多模型 AI 免费 Beta
            </div>
          </div>
        </Link>

        <nav className="pubNav" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div className="pubNavLinks">
            <NavLink to="/product" label="产品" />
            <NavLink to="/pricing" label="Beta 规则" />
            <NavLink to="/download" label="下载" />
            <NavLink to="/docs" label="文档" />
          </div>

          <button
            type="button"
            className="pubHamburger"
            aria-label="打开菜单"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((v) => !v)}
            style={{ color: '#475569' }}
          >
            ☰
          </button>

          {loadingMe ? null : me?.email ? (
            <div ref={userMenuRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setUserMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                style={{
                  cursor: 'pointer',
                  padding: 0,
                  borderRadius: 999,
                  border: 'none',
                  background: 'transparent',
                }}
                title={me.email}
              >
                <span
                  style={{
                    position: 'relative',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 38,
                    height: 38,
                    borderRadius: 999,
                    border: '1px solid #e2e8f0',
                    background: '#f8fafc',
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 12a4.2 4.2 0 1 0 0-8.4A4.2 4.2 0 0 0 12 12Z" stroke="#475569" strokeWidth="1.6" />
                    <path d="M4.2 20.4c1.8-3.2 4.6-4.8 7.8-4.8s6 1.6 7.8 4.8" stroke="#475569" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  <span
                    style={{
                      position: 'absolute',
                      right: 1,
                      bottom: 1,
                      fontSize: 9,
                      fontWeight: 700,
                      padding: '1px 4px',
                      borderRadius: 999,
                      border: `1px solid ${isPro ? '#c7d2fe' : '#e2e8f0'}`,
                      background: isPro ? '#eef2ff' : '#f8fafc',
                      color: isPro ? '#4f46e5' : '#64748b',
                      lineHeight: 1.3,
                      userSelect: 'none',
                    }}
                  >
                    {isPro ? 'Pro' : 'Free'}
                  </span>
                </span>
              </button>

              {userMenuOpen ? (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 46,
                    minWidth: 210,
                    borderRadius: 12,
                    border: '1px solid #e2e8f0',
                    background: '#ffffff',
                    boxShadow: '0 10px 40px rgba(0,0,0,0.12)',
                    padding: 8,
                    zIndex: 60,
                  }}
                >
                  {/* menu header */}
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 10px 8px' }}>
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 999,
                        border: '1px solid #e2e8f0',
                        background: '#f8fafc',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M12 12a4.2 4.2 0 1 0 0-8.4A4.2 4.2 0 0 0 12 12Z" stroke="#475569" strokeWidth="1.6" />
                        <path d="M4.2 20.4c1.8-3.2 4.6-4.8 7.8-4.8s6 1.6 7.8 4.8" stroke="#475569" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 14 }}>
                        {meLabel}
                      </div>
                      <div style={{ marginTop: 2, fontSize: 12, color: '#94a3b8' }}>
                        {isPro ? 'Pro 会员' : 'Free 计划'}
                        {billing?.expiresAt ? ` · 到期：${new Date(billing.expiresAt * 1000).toISOString().slice(0, 10)}` : ''}
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      margin: '2px 8px',
                      padding: '10px',
                      borderRadius: 8,
                      border: '1px solid #f1f5f9',
                      background: '#f8fafc',
                    }}
                  >
                    <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>账号安全</div>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ fontSize: 13, color: '#64748b' }}>手机号</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: phoneBound ? '#16a34a' : '#d97706' }}>
                          {phoneBound ? phoneLabel : '未绑定'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ fontSize: 13, color: '#64748b' }}>微信</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: wechatBound ? '#16a34a' : '#d97706' }}>
                          {wechatBound ? '已绑定' : '未绑定'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div style={{ height: 1, background: '#f1f5f9', margin: '6px 6px' }} />
                  <Link
                    to="/app"
                    onClick={() => setUserMenuOpen(false)}
                    style={{
                      display: 'block',
                      padding: '8px 10px',
                      borderRadius: 8,
                      textDecoration: 'none',
                      color: '#0f172a',
                      fontWeight: 600,
                      fontSize: 14,
                      background: '#f1f5f9',
                      border: '1px solid #e2e8f0',
                    }}
                  >
                    {DASHBOARD_ENABLED ? '进入控制台' : '进入工作区'}
                  </Link>
                  <Link
                    to="/me"
                    onClick={() => setUserMenuOpen(false)}
                    style={{
                      display: 'block',
                      padding: '8px 10px',
                      borderRadius: 8,
                      textDecoration: 'none',
                      color: '#475569',
                      fontSize: 14,
                      marginTop: 2,
                    }}
                  >
                    账号设置
                  </Link>
                  <Link
                    to="/pricing"
                    onClick={() => setUserMenuOpen(false)}
                    style={{
                      display: 'block',
                      padding: '8px 10px',
                      borderRadius: 8,
                      textDecoration: 'none',
                      color: '#475569',
                      fontSize: 14,
                    }}
                  >
                    Beta 额度
                  </Link>
                  <div style={{ height: 1, background: '#f1f5f9', margin: '6px 6px' }} />
                  <button
                    type="button"
                    onClick={logout}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      color: '#ef4444',
                      fontWeight: 500,
                      fontSize: 14,
                    }}
                  >
                    退出登录
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="pubAuthLinks" style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 4 }}>
              <Link
                to="/auth/login"
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  border: '1px solid transparent',
                  background: 'transparent',
                  color: '#475569',
                  fontSize: 14,
                  fontWeight: 500,
                  textDecoration: 'none',
                }}
              >
                登录
              </Link>
              <Link
                to="/auth/register"
                style={{
                  padding: '7px 16px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#0f172a',
                  color: '#ffffff',
                  fontWeight: 600,
                  fontSize: 14,
                  textDecoration: 'none',
                }}
              >
                申请试用
              </Link>
            </div>
          )}
        </nav>
      </header>

      {/* ── Mobile nav overlay ── */}
      {mobileNavOpen ? (
        <div className="pubMobileNavOverlay" aria-hidden="true">
          <div
            className="pubMobileNavSheet"
            ref={mobileNavRef}
            role="dialog"
            aria-modal="true"
            aria-label="导航菜单"
            style={{ background: '#ffffff', borderColor: '#e2e8f0', color: '#0f172a' }}
          >
            <div className="pubMobileNavTitleRow">
              <div style={{ fontWeight: 600, color: '#0f172a' }}>导航</div>
              <button
                type="button"
                className="pubMobileNavClose"
                onClick={() => setMobileNavOpen(false)}
                aria-label="关闭"
                style={{ borderColor: '#e2e8f0', background: 'transparent', color: '#475569' }}
              >
                ✕
              </button>
            </div>

            <div className="pubMobileNavList">
              <Link to="/product" className="pubMobileNavItem" onClick={() => setMobileNavOpen(false)}
                style={{ borderColor: '#f1f5f9', background: '#f8fafc', color: '#0f172a' }}>
                产品
              </Link>
              <Link to="/pricing" className="pubMobileNavItem" onClick={() => setMobileNavOpen(false)}
                style={{ borderColor: '#f1f5f9', background: '#f8fafc', color: '#0f172a' }}>
                Beta 规则
              </Link>
              <Link to="/download" className="pubMobileNavItem" onClick={() => setMobileNavOpen(false)}
                style={{ borderColor: '#f1f5f9', background: '#f8fafc', color: '#0f172a' }}>
                下载
              </Link>
              <Link to="/docs" className="pubMobileNavItem" onClick={() => setMobileNavOpen(false)}
                style={{ borderColor: '#f1f5f9', background: '#f8fafc', color: '#0f172a' }}>
                文档
              </Link>
            </div>

            {me?.email ? null : (
              <div className="pubMobileAuthRow">
                <Link to="/auth/login" className="lpBtn lpBtnGhost" onClick={() => setMobileNavOpen(false)}>
                  登录
                </Link>
                <Link to="/auth/register" className="lpBtn lpBtnPrimary" onClick={() => setMobileNavOpen(false)}>
                  申请试用
                </Link>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* ── Page content ── */}
      <main
        ref={(el) => {
          mainRef.current = el
        }}
        className="publicScroll"
        style={{ flex: 1, overflow: 'auto', background: '#ffffff' }}
      >
        {props.children}
      </main>

      {/* ── Footer ── */}
      <footer
        style={{
          padding: '20px 28px',
          borderTop: '1px solid #e2e8f0',
          background: '#ffffff',
          color: '#94a3b8',
          fontSize: 13,
        }}
      >
        <div style={{ maxWidth: 1180, margin: '0 auto', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ color: '#94a3b8' }}>© {new Date().getFullYear()} Covixa contributors</div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <a href="/docs" style={{ color: '#64748b', textDecoration: 'none' }}>
              使用手册
            </a>
            <a href="/docs/security" style={{ color: '#64748b', textDecoration: 'none' }}>
              安全与隐私
            </a>
            <a href="/docs/contact" style={{ color: '#64748b', textDecoration: 'none' }}>
              联系我们
            </a>
            <a href="/docs/terms" style={{ color: '#64748b', textDecoration: 'none' }}>
              服务条款
            </a>
          </div>
          <div style={{ fontSize: 12, color: '#cbd5e1', maxWidth: 480, lineHeight: 1.6 }}>
            GPT、Claude、Gemini 等模型名称及相关商标归各品牌所有方所有，与本平台无从属关系。
          </div>
        </div>
      </footer>
    </div>
  )
}
