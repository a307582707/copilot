import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { PublicLayout } from '../public/layout'

export function RegisterPage() {
  const nav = useNavigate()
  const loc = useLocation()
  const next = useMemo(() => {
    try {
      const sp = new URLSearchParams(loc.search)
      const n = (sp.get('next') || '').trim()
      // Default: return to homepage after a normal "register" entry from the website.
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

  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [showSlider, setShowSlider] = useState(false)
  const [cooldownSec, setCooldownSec] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [sliderKey, setSliderKey] = useState(0)
  const phoneInputRef = useRef<HTMLInputElement | null>(null)

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
      if (detail === 'Invalid phone') return '手机号格式不正确。'
      if (detail === 'Password too short') return '密码至少 8 位。'
      if (detail === 'Phone already registered') return '该手机号已注册，请直接登录。'
      if (detail === 'Invalid code') return '验证码不正确或已过期。'
      if (detail === 'Missing code') return '请输入短信验证码。'
      if (detail === 'Too many requests') return '发送太频繁，请稍后再试。'
      if (detail.includes('AliyunSmsError: NoPermission')) return '短信服务未授权（RAM 权限不足）。请联系管理员处理。'
      if (detail.includes('AliyunSmsError: isv.SMS_TEMPLATE_ILLEGAL'))
        return '短信模板未生效/未通过审核（该账号下找不到对应模板）。请联系管理员确认模板状态与模板码。'
      if (detail) return `注册失败：${detail}`
    } catch {
      // ignore
    }
    if (bodyText.includes('Phone already registered')) return '该手机号已注册，请直接登录。'
    return bodyText ? `注册失败：${bodyText}` : '注册失败，请稍后再试。'
  }

  // Cooldown ticker
  useEffect(() => {
    if (cooldownSec <= 0) return
    const t = window.setInterval(() => {
      setCooldownSec((s) => (s > 1 ? s - 1 : 0))
    }, 1000)
    return () => window.clearInterval(t)
  }, [cooldownSec])

  async function doSendCode(p: string) {
    setErr(null)
    if (cooldownSec > 0) {
      setErr(`操作太频繁，请 ${cooldownSec} 秒后再试`)
      return
    }
    setSendingCode(true)
    try {
      const r = await fetch('/api/auth/register_sms/request', {
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

  async function sendCode() {
    const p = phone.trim()
    if (!p) {
      setErr('请输入手机号')
      setShowSlider(false)
      setSliderKey((k) => k + 1)
      phoneInputRef.current?.focus?.()
      return
    }
    if (!isValidCnMobile(p)) {
      setErr('手机号格式不正确。')
      setShowSlider(false)
      setSliderKey((k) => k + 1)
      phoneInputRef.current?.focus?.()
      return
    }
    if (cooldownSec > 0) {
      setErr(`操作太频繁，请 ${cooldownSec} 秒后再试`)
      return
    }
    // Always require verification for EACH request.
    setErr(null)
    setSliderKey((k) => k + 1)
    setShowSlider(true)
  }

  async function onSubmit() {
    setErr(null)
    const p = phone.trim()
    const c = code.trim()
    const pw = password
    if (!p) {
      setErr('请输入手机号')
      return
    }
    if (!c) {
      setErr('请输入短信验证码')
      return
    }
    if (!pw) {
      setErr('请输入密码')
      return
    }
    if (pw.length < 8) {
      setErr('密码至少 8 位。')
      return
    }
    if (pw !== password2) {
      setErr('两次输入的密码不一致。')
      return
    }
    setLoading(true)
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ phone: p, code: c, password: pw }),
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

  // Reset slider when phone changes to avoid reusing a past verification.
  useEffect(() => {
    setShowSlider(false)
    setSliderKey((k) => k + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone])

  return (
    <PublicLayout>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '32px 18px 50px' }}>
        <div style={{ fontSize: 28, fontWeight: 850, color: '#0f172a' }}>注册</div>
        {/* removed per request */}

        <div style={formCardStyle}>
          <input
            placeholder="手机号"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            style={inputStyle}
            autoComplete="username"
            ref={phoneInputRef}
          />
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              placeholder="短信验证码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
              inputMode="numeric"
            />
            <button
              type="button"
              onClick={sendCode}
              disabled={sendingCode || cooldownSec > 0}
              title={
                !phone.trim()
                  ? '请输入手机号'
                  : !isValidCnMobile(phone.trim())
                    ? '手机号格式不正确'
                    : cooldownSec > 0
                      ? `请 ${cooldownSec}s 后再试`
                      : ''
              }
              style={{
                ...btnSecondary,
                cursor: sendingCode || cooldownSec > 0 ? 'not-allowed' : 'pointer',
                opacity: sendingCode || cooldownSec > 0 ? 0.7 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {sendingCode ? '发送中…' : cooldownSec > 0 ? `重新获取(${cooldownSec}s)` : '获取验证码'}
            </button>
          </div>
          <input
            placeholder="密码（至少 8 位）"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
            autoComplete="new-password"
          />
          <input
            placeholder="确认密码"
            type="password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            style={inputStyle}
            autoComplete="new-password"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSubmit()
            }}
          />
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
            onClick={onSubmit}
          >
            {loading ? '注册中…' : '注册并开始试用'}
          </button>
        </div>

        <div style={{ marginTop: 12, fontSize: 13, color: '#64748b' }}>
          已有账号？<Link to={`/auth/login?next=${encodeURIComponent(next)}`}>去登录</Link>
        </div>
      </div>
      {showSlider ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,0.42)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 18,
            zIndex: 9999,
          }}
          onClick={() => setShowSlider(false)}
        >
          <div
            style={{
              width: 'min(380px, 92vw)',
              borderRadius: 16,
              border: '1px solid #e2e8f0',
              background: '#ffffff',
              boxShadow: '0 24px 80px rgba(15,23,42,0.18)',
              padding: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 15, color: '#0f172a' }}>安全验证</div>
              <button
                type="button"
                onClick={() => setShowSlider(false)}
                style={{
                  border: '1px solid #dbe3ef',
                  background: '#f8fafc',
                  color: '#475569',
                  borderRadius: 8,
                  width: 26,
                  height: 26,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  lineHeight: 1,
                  fontSize: 14,
                }}
                title="关闭"
              >
                ✕
              </button>
            </div>
            <DragConfirmVerify
              key={sliderKey}
              disabled={!isValidCnMobile(phone.trim())}
              onVerified={async () => {
                setShowSlider(false)
                await doSendCode(phone.trim())
              }}
            />
          </div>
        </div>
      ) : null}
    </PublicLayout>
  )
}

type DragConfirmVerifyProps = { disabled?: boolean; onVerified: () => void }

function isValidCnMobile(phone: string): boolean {
  // Basic CN mobile validation: 11 digits, starts with 1, second digit 3-9.
  return /^1[3-9]\d{9}$/.test(phone)
}

function DragConfirmVerify(props: DragConfirmVerifyProps) {
  const { disabled, onVerified } = props
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [ok, setOk] = useState(false)
  const [failed, setFailed] = useState(false)
  const [x, setX] = useState(0)
  const [failHint, setFailHint] = useState<string | null>(null)
  const [trackWidth, setTrackWidth] = useState(0)

  const handleW = 58
  const railPad = 6
  const maxX = Math.max(0, trackWidth - railPad * 2 - handleW)
  const successX = Math.max(0, maxX - 6)
  const progressWidth = ok ? undefined : Math.max(handleW, Math.min(Math.max(0, trackWidth - railPad * 2), x + handleW))

  useEffect(() => {
    const measure = () => setTrackWidth(trackRef.current?.clientWidth || 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    setDragging(false)
    setOk(false)
    setFailed(false)
    setFailHint(null)
    setX(0)
  }, [disabled, trackWidth])

  function onDown(e: React.PointerEvent) {
    if (disabled || ok) return
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    setDragging(true)
    setFailed(false)
    setFailHint(null)
  }

  function onMove(e: React.PointerEvent) {
    if (!dragging || disabled || ok) return
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    const next = Math.max(0, Math.min(maxX, e.clientX - rect.left - railPad - handleW / 2))
    setX(next)
  }

  function onUp() {
    if (!dragging) return
    setDragging(false)
    if (x >= successX && maxX > 0) {
      setOk(true)
      setFailed(false)
      setFailHint(null)
      setX(maxX)
      window.setTimeout(() => onVerified(), 180)
      return
    }
    setX(0)
    setFailed(true)
    setFailHint('请拖到最右侧完成验证')
    window.setTimeout(() => setFailed(false), 900)
    window.setTimeout(() => setFailHint(null), 900)
  }

  const progress = maxX > 0 ? Math.min(1, Math.max(0, x / maxX)) : 0
  const label = disabled
    ? '请先输入正确手机号'
    : ok
      ? '验证通过，正在发送...'
      : failed
        ? failHint || '请拖到最右侧完成验证'
        : dragging
          ? progress > 0.72
            ? '继续拖动即可发送'
            : '拖动滑块发送验证码'
          : '拖动滑块发送验证码'

  return (
    <div
      ref={trackRef}
      style={{
        height: 56,
        borderRadius: 14,
        border: failed ? '1px solid #fecaca' : ok ? '1px solid #86efac' : '1px solid #dbe3ef',
        background: '#f8fafc',
        position: 'relative',
        overflow: 'hidden',
        opacity: disabled ? 0.7 : 1,
        userSelect: 'none',
        padding: railPad,
        boxShadow: 'inset 0 1px 2px rgba(15,23,42,0.04)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: railPad,
          borderRadius: 14,
          background: ok
            ? 'linear-gradient(90deg, rgba(34,197,94,0.14), rgba(16,185,129,0.22))'
            : failed
              ? 'linear-gradient(90deg, rgba(248,113,113,0.08), rgba(254,226,226,0.12))'
              : 'linear-gradient(90deg, rgba(124,58,237,0.08), rgba(37,99,235,0.10))',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: railPad,
          top: railPad,
          bottom: railPad,
          width: ok ? `calc(100% - ${railPad * 2}px)` : `${progressWidth}px`,
          minWidth: ok ? undefined : handleW,
          borderRadius: 14,
          background: ok
            ? 'linear-gradient(90deg, rgba(34,197,94,0.24), rgba(16,185,129,0.34))'
            : 'linear-gradient(90deg, rgba(124,58,237,0.18), rgba(37,99,235,0.22))',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: 0.2,
          opacity: ok ? 0.94 : 1,
          textAlign: 'center',
          color: failed ? '#dc2626' : ok ? '#047857' : '#475569',
          transition: 'opacity 0.2s',
          pointerEvents: 'none',
        }}
      >
        {label}
      </div>
      <div
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{
          position: 'absolute',
          left: railPad,
          top: railPad,
          width: handleW,
          height: 44,
          transform: `translateX(${ok ? maxX : x}px)`,
          transition: dragging ? 'none' : failed ? 'transform 120ms ease' : 'transform 180ms ease',
          cursor: disabled || ok ? 'not-allowed' : 'grab',
          zIndex: 2,
          borderRadius: 16,
          background: ok ? 'linear-gradient(135deg, #10b981, #22c55e)' : 'linear-gradient(135deg, #7c3aed, #2563eb)',
          border: '1px solid rgba(255,255,255,0.65)',
          boxShadow: failed
            ? '0 0 0 2px rgba(248,113,113,0.18), 0 8px 22px rgba(15,23,42,0.16)'
            : ok
              ? '0 0 0 2px rgba(16,185,129,0.18), 0 12px 24px rgba(16,185,129,0.18)'
              : '0 12px 24px rgba(37,99,235,0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#ffffff',
          fontSize: 22,
          fontWeight: 900,
          touchAction: 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 16,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.45)',
          }}
        />
        <span style={{ position: 'relative', zIndex: 1 }}>{ok ? '✓' : '→'}</span>
      </div>
    </div>
  )
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

const btnSecondary: CSSProperties = {
  height: 42,
  padding: '0 12px',
  borderRadius: 12,
  border: '1px solid #dbe3ef',
  background: '#f8fafc',
  color: '#334155',
  fontWeight: 750,
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



