import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AdminLayout } from './AdminLayout'

type LoginResp = { ok: boolean; role?: string }

function getNext(locSearch: string): string {
  try {
    const sp = new URLSearchParams(locSearch)
    const next = (sp.get('next') || '').trim()
    if (!next) return '/admin'
    // basic safety: only allow same-origin paths
    if (!next.startsWith('/')) return '/admin'
    if (next.startsWith('//')) return '/admin'
    return next
  } catch {
    return '/admin'
  }
}

export function AdminLoginPage() {
  const nav = useNavigate()
  const loc = useLocation()
  const next = useMemo(() => getNext(loc.search), [loc.search])

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function friendlyErr(bodyText: string): string {
    // Try parse JSON {detail:"..."} from FastAPI.
    try {
      const obj = JSON.parse(bodyText)
      const detail = typeof obj?.detail === 'string' ? obj.detail : ''
      if (detail === 'Missing identifier or password') return '请输入管理员邮箱和密码。'
      if (detail === 'Invalid credentials') return '账号或密码错误。'
      if (detail === 'Invalid email or password') return '账号或密码错误。'
      if (detail === 'Invalid email') return '邮箱格式不正确。'
      if (detail === 'Password too short') return '密码至少 8 位。'
      if (detail) return `登录失败：${detail}`
    } catch {
      // ignore
    }
    if (bodyText.includes('Missing identifier or password')) return '请输入管理员邮箱和密码。'
    if (bodyText.includes('Invalid credentials')) return '账号或密码错误。'
    if (bodyText.includes('Invalid email or password')) return '账号或密码错误。'
    return bodyText ? `登录失败：${bodyText}` : '登录失败，请检查账号/密码。'
  }

  async function onSubmit() {
    setErr(null)
    const em = email.trim().toLowerCase()
    const pw = password
    if (!em || !pw) {
      setErr('请输入管理员邮箱和密码。')
      return
    }
    setLoading(true)
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        // Backend expects identifier/password; keep email for backward compatibility.
        body: JSON.stringify({ identifier: em, email: em, password: pw }),
        credentials: 'include',
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setErr(friendlyErr(t))
        return
      }
      const data = (await r.json().catch(() => null)) as LoginResp | null
      if (!data?.ok) {
        setErr('登录失败，请稍后再试。')
        return
      }
      nav(next, { replace: true })
    } catch (e: any) {
      setErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AdminLayout minimalHeader>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '36px 18px 56px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 0.4 }}>后台管理登录</div>
          </div>
          <Link to="/" style={{ opacity: 0.85, textDecoration: 'underline' }}>
            返回官网
          </Link>
        </div>

        <div
          style={{
            marginTop: 16,
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(15,22,33,0.55)',
            padding: 16,
          }}
        >
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={labelStyle}>
              管理员邮箱
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="例如：admin@codesprite.example.com"
                style={inputStyle}
                autoComplete="username"
              />
            </label>
            <label style={labelStyle}>
              密码
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                type="password"
                style={inputStyle}
                autoComplete="current-password"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSubmit()
                }}
              />
            </label>

            {err ? (
              <div
                style={{
                  borderRadius: 12,
                  border: '1px solid rgba(255,85,85,0.35)',
                  background: 'rgba(255,85,85,0.08)',
                  padding: '10px 12px',
                  color: 'rgba(255,255,255,0.92)',
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {err}
              </div>
            ) : null}

            <button
              style={{
                ...btnPrimary,
                opacity: loading ? 0.7 : 1,
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
              disabled={loading}
              onClick={onSubmit}
            >
              {loading ? '登录中…' : '登录'}
            </button>

            <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
              忘记密码？请联系管理员或查看 <Link to="/docs" style={{ textDecoration: 'underline' }}>使用手册</Link>。
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  fontSize: 13,
  opacity: 0.92,
}

const inputStyle: React.CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  padding: '0 12px',
  outline: 'none',
  color: 'rgba(255,255,255,0.92)',
}

const btnPrimary: React.CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: '1px solid rgba(124,92,255,0.55)',
  background: 'rgba(124,92,255,0.14)',
  fontWeight: 850,
}


