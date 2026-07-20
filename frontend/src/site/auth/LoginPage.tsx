import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { PublicLayout } from '../public/layout'
import { WechatQrCard } from './WechatQrCard'

export function LoginPage() {
  const nav = useNavigate()
  const loc = useLocation()
  const next = useMemo(() => {
    try {
      const sp = new URLSearchParams(loc.search)
      const n = (sp.get('next') || '').trim()
      // Default: return to homepage after a normal "login/register" entry from the website header.
      // If caller explicitly provides ?next=/app (login interception), we will honor it after sanitization.
      if (!n) return '/'
      if (!n.startsWith('/')) return '/'
      if (n.startsWith('//')) return '/'
      return n
    } catch {
      return '/'
    }
  }, [loc.search])

  // If already logged in, do not show login/register pages; redirect to next/home.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/me', { headers: { Accept: 'application/json' }, credentials: 'include' })
        if (!r.ok) return
        if (!cancelled) nav(next, { replace: true })
      } catch {
        // ignore
      }
    })()
    return () => {
      cancelled = true
    }
  }, [nav, next])

  const [mode, setMode] = useState<'phone' | 'password'>('phone')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [cooldownSec, setCooldownSec] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [wechatLoading, setWechatLoading] = useState(false)
  const [wechatOpen, setWechatOpen] = useState(false)
  const [wechatStatus, setWechatStatus] = useState<'idle' | 'pending' | 'confirmed' | 'expired' | 'failed'>('idle')
  const [wechatHint, setWechatHint] = useState<string>('')
  const [wechatChallenge, setWechatChallenge] = useState<{ challengeId: string; qrUrl: string; expiresAt: number } | null>(null)
  const wechatPopupRef = useRef<Window | null>(null)

  function closeWechatDialog() {
    setWechatOpen(false)
    setWechatChallenge(null)
    try {
      wechatPopupRef.current?.close()
    } catch {
      // ignore
    }
  }

  function openWechatWindow(qrUrl?: string) {
    const targetUrl = String(qrUrl || wechatChallenge?.qrUrl || '').trim()
    if (!targetUrl) return false
    try {
      wechatPopupRef.current = window.open(targetUrl, 'codesprite-wechat-login', 'width=520,height=720')
      return Boolean(wechatPopupRef.current)
    } catch {
      wechatPopupRef.current = null
      return false
    }
  }

  function friendlyErr(bodyText: string): string {
    try {
      const obj = JSON.parse(bodyText)
      const detail = typeof obj?.detail === 'string' ? obj.detail : ''
      const detailObj = typeof obj?.detail === 'object' && obj?.detail ? obj.detail : null
      if (detailObj?.code === 'Cooldown' && typeof detailObj?.retryAfter === 'number') {
        const ra = Math.max(1, Math.min(60, Math.floor(detailObj.retryAfter)))
        setCooldownSec(ra)
        return `操作太频繁，请 ${ra} 秒后再试`
      }
      if (detail === 'Missing identifier or password') return '请输入手机号/邮箱和密码。'
      if (detail === 'Invalid credentials') return '账号或密码错误。'
      if (detail === 'Invalid email or password') return '账号或密码错误。'
      if (detail === 'Invalid email') return '邮箱格式不正确。'
      if (detail === 'Invalid phone') return '手机号格式不正确。'
      if (detail === 'Missing code') return '请输入短信验证码。'
      if (detail === 'Invalid code') return '验证码不正确或已过期。'
      if (detail === 'Too many attempts') return '验证码错误次数过多，请稍后再试。'
      if (detail === 'Too many requests') return '发送太频繁，请稍后再试。'
      if (detail === 'SMS login disabled') return '当前环境未开启短信登录。'
      if (detail === 'WeChat login disabled') return '当前环境未开启微信登录。'
      if (detail === 'Password too short') return '密码至少 8 位。'
      if (detail === 'Database temporarily unavailable') return '登录服务暂时不可用（数据库异常），请稍后重试或联系管理员。'
      if (detail === 'Auth schema is incompatible') return '登录服务配置异常（用户表结构不匹配），请联系管理员检查数据库迁移。'
      if (detail === 'Login service error') return '登录服务异常，请稍后重试；若持续出现请联系管理员并提供服务端日志。'
      if (detail.includes('AliyunSmsError: NoPermission')) return '短信服务未授权，请联系管理员处理。'
      if (detail.includes('AliyunSmsError: isv.SMS_TEMPLATE_ILLEGAL')) return '短信模板未通过审核或模板码不正确。'
      if (detail) return `登录失败：${detail}`
    } catch {
      // ignore
    }
    if (bodyText.includes('Missing identifier or password')) return '请输入手机号/邮箱和密码。'
    if (bodyText.includes('Invalid credentials')) return '账号或密码错误。'
    if (bodyText.includes('Invalid email or password')) return '账号或密码错误。'
    if (bodyText.includes('Invalid phone')) return '手机号格式不正确。'
    if (bodyText.includes('Invalid code')) return '验证码不正确或已过期。'
    return bodyText ? `登录失败：${bodyText}` : '登录失败，请检查账号/密码。'
  }

  useEffect(() => {
    if (cooldownSec <= 0) return
    const timer = window.setInterval(() => {
      setCooldownSec((s) => (s > 1 ? s - 1 : 0))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [cooldownSec])

  useEffect(() => {
    if (!wechatChallenge) return
    let stopped = false
    const poll = async () => {
      try {
        const r = await fetch(`/api/auth/wechat/web/challenge/${encodeURIComponent(wechatChallenge.challengeId)}`, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        })
        if (!r.ok) {
          const t = await r.text().catch(() => '')
          setWechatStatus('failed')
          setWechatHint(friendlyErr(t))
          return
        }
        const j = (await r.json().catch(() => null)) as any
        const status = String(j?.status || 'pending') as 'pending' | 'confirmed' | 'expired' | 'failed'
        if (stopped) return
        if (status === 'confirmed') {
          setWechatStatus('confirmed')
          setWechatHint('已确认登录，正在完成会话写入...')
          const ex = await fetch('/api/auth/wechat/web/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ challengeId: wechatChallenge.challengeId }),
            credentials: 'include',
          })
          if (!ex.ok) {
            const t = await ex.text().catch(() => '')
            setWechatStatus('failed')
            setWechatHint(friendlyErr(t))
            return
          }
          try {
            wechatPopupRef.current?.close()
          } catch {
            // ignore
          }
          nav(next, { replace: true })
          return
        }
        if (status === 'expired') {
          setWechatStatus('expired')
          setWechatHint('二维码已过期，请重新发起微信扫码登录。')
          return
        }
        setWechatStatus('pending')
        setWechatHint('请使用微信扫码并在弹出的页面完成确认。')
      } catch (e: any) {
        if (stopped) return
        setWechatStatus('failed')
        setWechatHint(`网络异常：${String(e?.message || e)}`)
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [wechatChallenge, nav, next])

  async function onPasswordSubmit() {
    setErr(null)
    const em = identifier.trim()
    const pw = password
    if (!em || !pw) {
      setErr('请输入手机号/邮箱和密码。')
      return
    }
    setLoading(true)
    try {
      const payload: any = { identifier: em, password: pw }
      // Backward compatibility: some older backends accept email/password only.
      // Only include email when it looks like an email; avoid sending phone as "email".
      if (em.includes('@')) payload.email = em
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setErr(friendlyErr(t))
        return
      }
      nav(next, { replace: true })
    } catch (e: any) {
      setErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setLoading(false)
    }
  }

  async function onSendCode() {
    setErr(null)
    const p = phone.trim()
    if (!p) {
      setErr('请输入手机号。')
      return
    }
    if (!isValidCnMobile(p)) {
      setErr('手机号格式不正确。')
      return
    }
    if (cooldownSec > 0) {
      setErr(`操作太频繁，请 ${cooldownSec} 秒后再试`)
      return
    }
    setSendingCode(true)
    try {
      const r = await fetch('/api/auth/login_sms/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ phone: p }),
        credentials: 'include',
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setErr(friendlyErr(t))
        return
      }
      setCooldownSec(60)
    } catch (e: any) {
      setErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setSendingCode(false)
    }
  }

  async function onPhoneSubmit() {
    setErr(null)
    const p = phone.trim()
    const c = code.trim()
    if (!p) {
      setErr('请输入手机号。')
      return
    }
    if (!isValidCnMobile(p)) {
      setErr('手机号格式不正确。')
      return
    }
    if (!c) {
      setErr('请输入短信验证码。')
      return
    }
    setLoading(true)
    try {
      const r = await fetch('/api/auth/login_sms/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ phone: p, code: c, rememberMe: true }),
        credentials: 'include',
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setErr(friendlyErr(t))
        return
      }
      nav(next, { replace: true })
    } catch (e: any) {
      setErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setLoading(false)
    }
  }

  async function startWechatLogin() {
    setErr(null)
    setWechatChallenge(null)
    setWechatHint('')
    setWechatOpen(false)
    setWechatLoading(true)
    setWechatStatus('pending')
    try {
      const r = await fetch('/api/auth/wechat/web/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ redirectUri: next }),
        credentials: 'include',
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setWechatStatus('failed')
        setErr(friendlyErr(t))
        return
      }
      const j = (await r.json().catch(() => null)) as any
      const challenge = {
        challengeId: String(j?.challengeId || ''),
        qrUrl: String(j?.qrUrl || ''),
        expiresAt: Number(j?.expiresAt || 0),
      }
      if (!challenge.challengeId || !challenge.qrUrl) {
        setWechatStatus('failed')
        setErr('微信扫码初始化失败，请稍后再试。')
        return
      }
      setWechatChallenge(challenge)
      const popupOpened = openWechatWindow(challenge.qrUrl)
      if (popupOpened) {
        setWechatHint('微信二维码已在新窗口打开，请完成扫码确认。')
        return
      }
      setWechatOpen(true)
      setWechatHint('浏览器拦截了弹窗，请直接扫描当前页面二维码，或允许弹窗后重试。')
    } catch (e: any) {
      setWechatStatus('failed')
      setErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setWechatLoading(false)
    }
  }

  return (
    <PublicLayout>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '32px 18px 50px' }}>
        <div style={{ fontSize: 28, fontWeight: 850, color: '#0f172a' }}>登录</div>
        <div style={{ marginTop: 10, color: '#64748b' }}>登录后可继续进入网页版工作区。</div>

        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setMode('phone')} style={mode === 'phone' ? tabActiveStyle : tabStyle}>
            手机登录
          </button>
          <button type="button" onClick={() => setMode('password')} style={mode === 'password' ? tabActiveStyle : tabStyle}>
            账号密码
          </button>
        </div>

        <div style={formCardStyle}>
          {mode === 'phone' ? (
            <>
              <input
                placeholder="手机号"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                style={inputStyle}
                autoComplete="username"
                inputMode="numeric"
              />
              <div style={{ display: 'flex', gap: 10 }}>
                <input
                  placeholder="短信验证码"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  style={{ ...inputStyle, flex: 1 }}
                  inputMode="numeric"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onPhoneSubmit()
                  }}
                />
                <button
                  type="button"
                  onClick={() => void onSendCode()}
                  disabled={sendingCode || cooldownSec > 0}
                  style={{
                    ...btnGhost,
                    width: 132,
                    opacity: sendingCode || cooldownSec > 0 ? 0.7 : 1,
                    cursor: sendingCode || cooldownSec > 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {sendingCode ? '发送中…' : cooldownSec > 0 ? `重新获取(${cooldownSec}s)` : '发送验证码'}
                </button>
              </div>
            </>
          ) : (
            <>
              <input
                placeholder="手机号 / 邮箱"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                style={inputStyle}
                autoComplete="username"
              />
              <input
                placeholder="密码"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
                autoComplete="current-password"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onPasswordSubmit()
                }}
              />
            </>
          )}
          {err ? (
            <div
              style={{
                borderRadius: 12,
                border: '1px solid #fecaca',
                background: '#fef2f2',
                padding: '10px 12px',
                color: '#b91c1c',
                fontSize: 13,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
              }}
            >
              {err}
            </div>
          ) : null}
          <button
            style={{ ...btnPrimary, opacity: loading ? 0.7 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
            disabled={loading}
            onClick={() => void (mode === 'phone' ? onPhoneSubmit() : onPasswordSubmit())}
          >
            {loading ? '登录中…' : mode === 'phone' ? '短信登录' : '登录'}
          </button>
        </div>

        <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 10, color: '#94a3b8' }}>
          <div style={{ height: 1, flex: 1, background: '#e2e8f0' }} />
          <div style={{ fontSize: 12 }}>或使用以下方式继续</div>
          <div style={{ height: 1, flex: 1, background: '#e2e8f0' }} />
        </div>

        <button
          type="button"
          style={{ ...btnGhost, marginTop: 14, width: '100%', height: 46 }}
          onClick={() => void startWechatLogin()}
          disabled={wechatLoading}
        >
          {wechatLoading ? '微信初始化中…' : '使用微信扫码继续'}
        </button>

        <div style={{ marginTop: 12, fontSize: 13, color: '#64748b' }}>
          还没有账号？<Link to={`/auth/register?next=${encodeURIComponent(next)}`}>去注册</Link>
        </div>

        {wechatOpen ? (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.55)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 18,
              zIndex: 9999,
            }}
            onClick={closeWechatDialog}
          >
            <div
              style={{
                width: 'min(520px, 96vw)',
                borderRadius: 16,
                border: '1px solid rgba(255,255,255,0.10)',
                background: 'rgba(15,22,33,0.96)',
                boxShadow: '0 18px 60px rgba(0,0,0,0.60)',
                padding: 20,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ fontWeight: 850, fontSize: 16 }}>微信扫码登录</div>
                <button type="button" onClick={closeWechatDialog} style={iconBtnStyle}>
                  ✕
                </button>
              </div>

              <WechatQrCard
                qrUrl={wechatChallenge?.qrUrl}
                hint={wechatHint || '请使用微信扫码完成登录。'}
                statusLabel={
                  wechatStatus === 'pending'
                    ? '等待扫码/确认'
                    : wechatStatus === 'confirmed'
                      ? '已确认，正在登录'
                      : wechatStatus === 'expired'
                        ? '二维码已过期'
                        : wechatStatus === 'failed'
                          ? '登录失败'
                          : '准备中'
                }
                expiresAt={wechatChallenge?.expiresAt}
                onRefresh={() => void startWechatLogin()}
                onOpenWindow={openWechatWindow}
                onFocusWindow={() => {
                  try {
                    wechatPopupRef.current?.focus()
                  } catch {
                    // ignore
                  }
                }}
              />
            </div>
          </div>
        ) : null}
      </div>
    </PublicLayout>
  )
}

function isValidCnMobile(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone.trim())
}

const inputStyle: CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: '1px solid #dbe3ef',
  background: '#ffffff',
  padding: '0 12px',
  outline: 'none',
  color: '#0f172a',
  boxShadow: 'inset 0 1px 2px rgba(15,23,42,0.04)',
}

const btnPrimary: CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: '1px solid #0f172a',
  background: '#0f172a',
  color: '#ffffff',
  cursor: 'pointer',
  fontWeight: 750,
}

const btnGhost: CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: '1px solid #dbe3ef',
  background: '#f8fafc',
  cursor: 'pointer',
  fontWeight: 700,
  color: '#334155',
}

const tabStyle: CSSProperties = {
  flex: 1,
  height: 42,
  borderRadius: 12,
  border: '1px solid #dbe3ef',
  background: '#f8fafc',
  cursor: 'pointer',
  fontWeight: 700,
  color: '#475569',
}

const tabActiveStyle: CSSProperties = {
  ...tabStyle,
  border: '1px solid #c7d2fe',
  background: '#eef2ff',
  color: '#4338ca',
}

const iconBtnStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 10,
  border: '1px solid #dbe3ef',
  background: '#f8fafc',
  cursor: 'pointer',
  color: '#475569',
}

const formCardStyle: CSSProperties = {
  marginTop: 14,
  display: 'grid',
  gap: 10,
  padding: 16,
  borderRadius: 16,
  border: '1px solid #e2e8f0',
  background: '#ffffff',
  boxShadow: '0 8px 24px rgba(15,23,42,0.06)',
}



