import { Link, Route, Routes } from 'react-router-dom'
import { PublicLayout } from '../public/layout'
import { MeBillingPage } from './MeBillingPage'
import { MeSubscriptionPage } from './MeSubscriptionPage'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { WechatQrCard } from '../auth/WechatQrCard'
import { getBillingPlanSpec } from '../billingCatalog'
import { DASHBOARD_ENABLED } from '../../flags'

export function MeHome() {
  return (
    <PublicLayout>
      <Routes>
        <Route path="/" element={<MeOverview />} />
        <Route path="/billing" element={<MeBillingPage />} />
        <Route path="/subscription" element={<MeSubscriptionPage />} />
      </Routes>
    </PublicLayout>
  )
}

type MeResp = {
  ok: boolean
  user?: {
    id?: number
    email?: string
    role?: string
    createdAt?: number
    phone?: string
    displayName?: string
    avatarUrl?: string
    phoneVerifiedAt?: number | null
    wechatBoundAt?: number | null
    wechatBound?: boolean
  }
  subscription?: { status: string; trialEndsAt?: number | null; currentPeriodEnd?: number | null }
  balanceCents?: number
  plan?: string
}

function fmtCny(cents: number | undefined | null) {
  const n = Number(cents || 0) / 100
  return `¥${n.toFixed(2)}`
}

function fmtTs(ts: number | undefined | null) {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function apiMe(): Promise<MeResp> {
  const r = await fetch('/api/me', { credentials: 'include' })
  const j = (await r.json()) as any
  if (!r.ok || !j?.ok) throw new Error(j?.detail || '请求失败')
  return j as MeResp
}

function maskEmail(email: string) {
  const s = (email || '').trim()
  if (!s) return ''
  const at = s.indexOf('@')
  if (at <= 2) return s
  return `${s.slice(0, 2)}***${s.slice(at)}`
}

function maskPhone(phone: string) {
  const s = (phone || '').trim()
  if (!/^1[3-9]\d{9}$/.test(s)) return s || '-'
  return `${s.slice(0, 3)}****${s.slice(-4)}`
}

function isValidCnMobile(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test((phone || '').trim())
}

function friendlyErr(bodyText: string): string {
  try {
    const obj = JSON.parse(bodyText)
    const detail = typeof obj?.detail === 'string' ? obj.detail : ''
    const detailObj = typeof obj?.detail === 'object' && obj?.detail ? obj.detail : null
    if (detailObj?.code === 'Cooldown' && typeof detailObj?.retryAfter === 'number') {
      const ra = Math.max(1, Math.min(60, Math.floor(detailObj.retryAfter)))
      return `操作太频繁，请 ${ra} 秒后再试`
    }
    if (detail === 'Invalid phone') return '手机号格式不正确。'
    if (detail === 'Missing code') return '请输入短信验证码。'
    if (detail === 'Invalid code') return '验证码不正确或已过期。'
    if (detail === 'Too many attempts') return '验证码错误次数过多，请稍后再试。'
    if (detail === 'Phone already bound') return '该手机号已被其他账号绑定。'
    if (detail === 'WeChat bind disabled') return '当前环境未开启微信绑定。'
    if (detail === 'WeChat login disabled') return '当前环境未开启微信登录。'
    if (detail === 'Bind a phone before unbinding WeChat') return '请先绑定手机号，再解绑微信。'
    if (detail === 'Challenge not found') return '绑定会话不存在，请重新发起。'
    if (detail === 'Challenge expired') return '绑定二维码已过期，请重新发起。'
    if (detail === 'WeChat binding not supported') return '当前环境暂不支持微信绑定。'
    if (detail.includes('AliyunSmsError: NoPermission')) return '短信服务未授权，请联系管理员处理。'
    if (detail.includes('AliyunSmsError: isv.SMS_TEMPLATE_ILLEGAL')) return '短信模板未通过审核或模板码不正确。'
    if (detail) return detail
  } catch {
    // ignore
  }
  return bodyText || '请求失败，请稍后再试。'
}

function MeOverview() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string>('')
  const [me, setMe] = useState<MeResp | null>(null)
  const [actionErr, setActionErr] = useState<string>('')
  const [phoneModalOpen, setPhoneModalOpen] = useState(false)
  const [phone, setPhone] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [sendingPhoneCode, setSendingPhoneCode] = useState(false)
  const [confirmingPhone, setConfirmingPhone] = useState(false)
  const [phoneCooldownSec, setPhoneCooldownSec] = useState(0)
  const [wechatDialogOpen, setWechatDialogOpen] = useState(false)
  const [wechatBusy, setWechatBusy] = useState(false)
  const [wechatStatus, setWechatStatus] = useState<'idle' | 'pending' | 'confirmed' | 'expired' | 'failed'>('idle')
  const [wechatHint, setWechatHint] = useState('')
  const [wechatChallenge, setWechatChallenge] = useState<{ challengeId: string; qrUrl: string; expiresAt: number } | null>(null)
  const wechatPopupRef = useRef<Window | null>(null)

  const sub = me?.subscription
  const subStatus = sub?.status || 'none'
  const planSpec = getBillingPlanSpec(me?.plan)
  const subBadge = useMemo(() => {
    if (subStatus === 'active') return { text: '已开通', color: '#0f9f5f', dot: '#0f9f5f' }
    if (subStatus === 'trialing') return { text: '试用中', color: '#7c5cff', dot: '#7c5cff' }
    if (subStatus === 'expired') return { text: '已到期', color: '#ea580c', dot: '#ea580c' }
    return { text: '未开通', color: '#64748b', dot: '#94a3b8' }
  }, [subStatus])

  const planLabel = useMemo(() => {
    const p = String(me?.plan || '').trim().toLowerCase()
    if (!p) return 'Free'
    if (p.includes('pro')) return 'Pro'
    return (me?.plan || 'Free').toString()
  }, [me?.plan])

  const isPro = useMemo(() => {
    const p = String(me?.plan || '').trim().toLowerCase()
    return p.includes('pro')
  }, [me?.plan])

  async function reloadMe(opts?: { silent?: boolean }) {
    if (!opts?.silent) {
      setLoading(true)
      setErr('')
    }
    try {
      const j = await apiMe()
      setMe(j)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }

  useEffect(() => {
    void reloadMe()
  }, [])

  useEffect(() => {
    if (phoneCooldownSec <= 0) return
    const timer = window.setInterval(() => {
      setPhoneCooldownSec((s) => (s > 1 ? s - 1 : 0))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [phoneCooldownSec])

  useEffect(() => {
    if (!wechatDialogOpen || !wechatChallenge) return
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
          setWechatHint('微信已绑定成功，正在刷新账号信息...')
          try {
            wechatPopupRef.current?.close()
          } catch {
            // ignore
          }
          await reloadMe({ silent: true })
          return
        }
        if (status === 'expired') {
          setWechatStatus('expired')
          setWechatHint('二维码已过期，请重新生成。')
          return
        }
        if (status === 'failed') {
          setWechatStatus('failed')
          setWechatHint(j?.reason ? `绑定失败：${String(j.reason)}` : '绑定失败，请重新发起。')
          return
        }
        setWechatStatus('pending')
        setWechatHint('请使用微信扫码，并在弹出页面完成绑定确认。')
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
  }, [wechatDialogOpen, wechatChallenge])

  function closeWechatDialog() {
    setWechatDialogOpen(false)
    setWechatChallenge(null)
    try {
      wechatPopupRef.current?.close()
    } catch {
      // ignore
    }
  }

  function openWechatWindow() {
    if (!wechatChallenge?.qrUrl) return
    try {
      wechatPopupRef.current = window.open(wechatChallenge.qrUrl, 'codesprite-wechat-bind', 'width=520,height=720')
    } catch {
      wechatPopupRef.current = null
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } finally {
      window.location.href = '/'
    }
  }

  const email = maskEmail(String(me?.user?.email || ''))
  const displayName = String(me?.user?.displayName || '').trim()
  const phoneMasked = maskPhone(String(me?.user?.phone || ''))
  const phoneVerified = Boolean(me?.user?.phoneVerifiedAt)
  const wechatBound = Boolean(me?.user?.wechatBound)
  const balance = fmtCny(me?.balanceCents)
  const exp = fmtTs(sub?.currentPeriodEnd || null)

  async function sendPhoneCode() {
    setActionErr('')
    const p = phone.trim()
    if (!p) {
      setActionErr('请输入手机号。')
      return
    }
    if (!isValidCnMobile(p)) {
      setActionErr('手机号格式不正确。')
      return
    }
    if (phoneCooldownSec > 0) {
      setActionErr(`操作太频繁，请 ${phoneCooldownSec} 秒后再试`)
      return
    }
    setSendingPhoneCode(true)
    try {
      const r = await fetch('/api/me/phone/bind/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ phone: p }),
        credentials: 'include',
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setActionErr(friendlyErr(t))
        return
      }
      setPhoneCooldownSec(60)
    } catch (e: any) {
      setActionErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setSendingPhoneCode(false)
    }
  }

  async function confirmPhoneBind() {
    setActionErr('')
    const p = phone.trim()
    const c = phoneCode.trim()
    if (!isValidCnMobile(p)) {
      setActionErr('手机号格式不正确。')
      return
    }
    if (!c) {
      setActionErr('请输入短信验证码。')
      return
    }
    setConfirmingPhone(true)
    try {
      const r = await fetch('/api/me/phone/bind/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ phone: p, code: c }),
        credentials: 'include',
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setActionErr(friendlyErr(t))
        return
      }
      setPhoneModalOpen(false)
      setPhoneCode('')
      await reloadMe({ silent: true })
    } catch (e: any) {
      setActionErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setConfirmingPhone(false)
    }
  }

  async function startWechatBind() {
    setActionErr('')
    setWechatHint('')
    setWechatDialogOpen(true)
    setWechatBusy(true)
    setWechatStatus('pending')
    try {
      const r = await fetch('/api/me/wechat/bind/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ redirectUri: '/me' }),
        credentials: 'include',
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setWechatStatus('failed')
        setWechatHint(friendlyErr(t))
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
        setWechatHint('微信绑定初始化失败，请稍后再试。')
        return
      }
      setWechatChallenge(challenge)
      setWechatHint('请使用微信扫码完成绑定；若当前环境不便扫码，可在新窗口打开作为兜底。')
    } catch (e: any) {
      setWechatStatus('failed')
      setWechatHint(`网络异常：${String(e?.message || e)}`)
    } finally {
      setWechatBusy(false)
    }
  }

  async function unbindWechat() {
    setActionErr('')
    setWechatBusy(true)
    try {
      const r = await fetch('/api/me/wechat/unbind', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setActionErr(friendlyErr(t))
        return
      }
      await reloadMe({ silent: true })
    } catch (e: any) {
      setActionErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setWechatBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 580, margin: '0 auto', padding: '32px 18px 50px' }}>
      <div
        style={{
          border: '1px solid #e2e8f0',
          borderRadius: 18,
          background: 'rgba(255,255,255,0.96)',
          boxShadow: '0 18px 60px rgba(15, 23, 42, 0.08)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '16px 16px 12px',
            borderBottom: '1px solid #e2e8f0',
            background: 'linear-gradient(180deg, #f8fafc, #f1f5f9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 'var(--w-black)' as any }}>个人中心</div>
            <div style={{ marginTop: 6, opacity: 0.78, fontSize: 12, lineHeight: 1.6 }}>
              {loading ? '加载中…' : err ? '加载失败' : '账号信息、安全状态与混合计费概览。'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Link
              to="/app"
              style={{
                padding: '8px 12px',
                borderRadius: 12,
                border: '1px solid #dbe3f0',
                background: '#ffffff',
                color: '#0f172a',
                fontWeight: 850,
                textDecoration: 'none',
              }}
            >
              {DASHBOARD_ENABLED ? '返回控制台' : '返回工作区'}
            </Link>
            <Link
              to="/me/subscription"
              style={{
                padding: '8px 12px',
                borderRadius: 12,
                border: '1px solid #dbe3f0',
                background: '#ffffff',
                color: '#0f172a',
                fontWeight: 850,
                textDecoration: 'none',
              }}
            >
              Beta 详情
            </Link>
            <Link
              to="/me/billing"
              style={{
                padding: '8px 12px',
                borderRadius: 12,
                border: '1px solid rgba(124,92,255,0.22)',
                background: 'rgba(124,92,255,0.08)',
                color: '#4c1d95',
                fontWeight: 900,
                textDecoration: 'none',
              }}
            >
              Beta 额度
            </Link>
          </div>
        </div>

        <div style={{ padding: 16 }}>
          {err ? (
            <div style={{ marginBottom: 12, color: 'rgba(255,120,120,0.95)', fontSize: 13, whiteSpace: 'pre-wrap' }}>{err}</div>
          ) : null}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 12px',
              borderRadius: 14,
              border: '1px solid #e2e8f0',
              background: '#f8fafc',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>账号</div>
              <div style={{ marginTop: 6, fontSize: 13, fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {displayName || email || (loading ? '—' : '未登录')}
              </div>
              {displayName && email ? <div style={{ marginTop: 4, fontSize: 12, opacity: 0.68 }}>{email}</div> : null}
            </div>
            <span
              style={{
                flex: '0 0 auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 10px',
                borderRadius: 999,
                border: `1px solid ${isPro ? 'rgba(124,92,255,0.22)' : '#dbe3f0'}`,
                background: isPro ? 'rgba(124,92,255,0.08)' : '#ffffff',
                fontSize: 12,
                fontWeight: 950,
                color: isPro ? '#4c1d95' : '#0f172a',
              }}
              title={planLabel}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: isPro ? '#7c5cff' : '#cbd5e1',
                  boxShadow: `0 0 0 3px ${isPro ? 'rgba(124,92,255,0.12)' : 'rgba(148,163,184,0.18)'}`,
                }}
              />
              {isPro ? 'Pro' : 'Free'}
            </span>
          </div>

          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            <InfoBox title="Beta 额度" value={loading ? '—' : balance} desc="模型调用会扣减额度 · 暂不公开充值" dotColor="#0f9f5f" />
            <InfoBox
              title="试运营状态"
              value={
                loading ? (
                  '—'
                ) : (
                  <span>
                    {planSpec.label}{' '}
                    <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 900, color: subBadge.color }}>{subBadge.text}</span>
                  </span>
                )
              }
              desc={`试用到期：${loading ? '—' : exp} · 额度不足会暂停新请求`}
              dotColor={subBadge.dot}
            />
          </div>

          <div
            style={{
              marginTop: 12,
              border: '1px solid #e2e8f0',
              borderRadius: 16,
              background: '#ffffff',
              padding: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 900 }}>账号安全</div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                  建议至少绑定手机号。若要解绑微信，后端当前要求账号先具备已验证手机号。
                </div>
              </div>
              <button type="button" style={ghostBtnStyle} onClick={() => void reloadMe()} disabled={loading}>
                刷新状态
              </button>
            </div>

            {actionErr ? (
              <div style={{ marginTop: 12, color: 'rgba(255,120,120,0.95)', fontSize: 13, whiteSpace: 'pre-wrap' }}>{actionErr}</div>
            ) : null}

            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              <SecurityRow
                title="手机号"
                value={phoneVerified ? phoneMasked : '未绑定'}
                desc={phoneVerified ? `已验证 · 绑定时间 ${fmtTs(me?.user?.phoneVerifiedAt || null)}` : '可用于短信登录、找回密码、解绑微信前置校验。'}
                actions={
                  <button
                    type="button"
                    style={primaryBtnStyle}
                    onClick={() => {
                      setActionErr('')
                      setPhone(phoneVerified ? String(me?.user?.phone || '') : '')
                      setPhoneCode('')
                      setPhoneModalOpen(true)
                    }}
                  >
                    {phoneVerified ? '更换手机号' : '绑定手机号'}
                  </button>
                }
              />

              <SecurityRow
                title="微信"
                value={wechatBound ? '已绑定' : '未绑定'}
                desc={wechatBound ? `绑定时间 ${fmtTs(me?.user?.wechatBoundAt || null)}` : '绑定后可直接通过微信扫码登录当前账号。'}
                actions={
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {wechatBound ? (
                      <button type="button" style={dangerBtnStyle} onClick={() => void unbindWechat()} disabled={wechatBusy}>
                        {wechatBusy ? '处理中…' : '解绑微信'}
                      </button>
                    ) : (
                      <button type="button" style={primaryBtnStyle} onClick={() => void startWechatBind()} disabled={wechatBusy}>
                        {wechatBusy ? '处理中…' : '绑定微信'}
                      </button>
                    )}
                  </div>
                }
              />
            </div>
          </div>

          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => void logout()}
              disabled={loading}
              style={{
                border: '1px solid rgba(239,68,68,0.2)',
                background: 'rgba(239,68,68,0.06)',
                color: '#dc2626',
                padding: '8px 12px',
                borderRadius: 12,
                fontWeight: 900,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.6 : 1,
              }}
            >
              退出登录
            </button>
          </div>
        </div>
      </div>

      {phoneModalOpen ? (
        <ModalShell title={phoneVerified ? '更换手机号' : '绑定手机号'} onClose={() => setPhoneModalOpen(false)}>
          <div style={{ display: 'grid', gap: 10 }}>
            <input
              placeholder="手机号"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              style={inputStyle}
              inputMode="numeric"
              autoComplete="tel"
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                placeholder="短信验证码"
                value={phoneCode}
                onChange={(e) => setPhoneCode(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
                inputMode="numeric"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirmPhoneBind()
                }}
              />
              <button
                type="button"
                style={{ ...ghostBtnStyle, width: 132 }}
                onClick={() => void sendPhoneCode()}
                disabled={sendingPhoneCode || phoneCooldownSec > 0}
              >
                {sendingPhoneCode ? '发送中…' : phoneCooldownSec > 0 ? `重新获取(${phoneCooldownSec}s)` : '发送验证码'}
              </button>
            </div>
            <div style={{ fontSize: 12, opacity: 0.68, lineHeight: 1.6 }}>验证码有效期 5 分钟。绑定后可用于短信登录与找回密码。</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" style={ghostBtnStyle} onClick={() => setPhoneModalOpen(false)}>
                取消
              </button>
              <button type="button" style={primaryBtnStyle} onClick={() => void confirmPhoneBind()} disabled={confirmingPhone}>
                {confirmingPhone ? '绑定中…' : '确认绑定'}
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}

      {wechatDialogOpen ? (
        <ModalShell title="微信绑定" onClose={closeWechatDialog}>
          <WechatQrCard
            qrUrl={wechatChallenge?.qrUrl}
            hint={wechatHint || '请使用微信扫码完成绑定。'}
            statusLabel={
              wechatStatus === 'pending'
                ? '等待扫码/确认'
                : wechatStatus === 'confirmed'
                  ? '已绑定成功'
                  : wechatStatus === 'expired'
                    ? '二维码已过期'
                    : wechatStatus === 'failed'
                      ? '绑定失败'
                      : '准备中'
            }
            expiresAt={wechatChallenge?.expiresAt}
            onRefresh={() => void startWechatBind()}
            onOpenWindow={openWechatWindow}
            onFocusWindow={() => {
              try {
                wechatPopupRef.current?.focus()
              } catch {
                // ignore
              }
            }}
          />
        </ModalShell>
      ) : null}
    </div>
  )
}

function SecurityRow(props: { title: string; value: string; desc: string; actions: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 14,
        border: '1px solid #e2e8f0',
        background: '#f8fafc',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, opacity: 0.75, color: '#64748b' }}>{props.title}</div>
        <div style={{ marginTop: 6, fontSize: 14, fontWeight: 900 }}>{props.value}</div>
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82, lineHeight: 1.6, color: '#64748b' }}>{props.desc}</div>
      </div>
      <div>{props.actions}</div>
    </div>
  )
}

function InfoBox(props: { title: string; value: any; desc: string; dotColor?: string }) {
  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 16,
        background: '#ffffff',
        padding: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ opacity: 0.75, fontSize: 12, fontWeight: 800 }}>{props.title}</div>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: props.dotColor || 'rgba(255,255,255,0.28)',
            boxShadow: '0 0 0 3px rgba(148,163,184,0.18)',
            flex: '0 0 auto',
          }}
        />
      </div>
      <div style={{ marginTop: 10, fontSize: 22, fontWeight: 950, fontVariantNumeric: 'tabular-nums' }}>{props.value}</div>
      <div style={{ marginTop: 8, opacity: 0.72, fontSize: 12, lineHeight: 1.6 }}>{props.desc}</div>
    </div>
  )
}

function ModalShell(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.24)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 18,
        zIndex: 9999,
      }}
      onClick={props.onClose}
    >
      <div
        style={{
          width: 'min(520px, 96vw)',
          borderRadius: 16,
          border: '1px solid #e2e8f0',
          background: 'rgba(255,255,255,0.98)',
          boxShadow: '0 18px 60px rgba(15, 23, 42, 0.16)',
          padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontWeight: 850, fontSize: 16 }}>{props.title}</div>
          <button type="button" onClick={props.onClose} style={iconBtnStyle}>
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

const inputStyle: CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: '1px solid #dbe3f0',
  background: '#ffffff',
  padding: '0 12px',
  outline: 'none',
  color: '#0f172a',
}

const primaryBtnStyle: CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: '1px solid rgba(124,92,255,0.22)',
  background: 'rgba(124,92,255,0.08)',
  cursor: 'pointer',
  fontWeight: 750,
  color: '#4c1d95',
  padding: '0 14px',
}

const ghostBtnStyle: CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: '1px solid #dbe3f0',
  background: '#ffffff',
  cursor: 'pointer',
  fontWeight: 700,
  color: '#0f172a',
  padding: '0 14px',
}

const dangerBtnStyle: CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: '1px solid rgba(239,68,68,0.2)',
  background: 'rgba(239,68,68,0.06)',
  color: '#dc2626',
  cursor: 'pointer',
  fontWeight: 800,
  padding: '0 14px',
}

const iconBtnStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 10,
  border: '1px solid #dbe3f0',
  background: '#ffffff',
  cursor: 'pointer',
  color: '#0f172a',
}



