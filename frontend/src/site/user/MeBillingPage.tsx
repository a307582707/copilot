import { useEffect, useMemo, useState } from 'react'
import './MeBillingPage.css'
import { BILLING_TOP_UP_TIERS, formatCnyFromCents, getBillingPlanSpec } from '../billingCatalog'

type Subscription = { status: string; trialEndsAt?: number | null; currentPeriodEnd?: number | null }
type BillingResp = {
  ok: boolean
  me?: { id: number; email: string; role: string; createdAt: number }
  balanceCents?: number
  subscription?: Subscription
  plan?: string
  monthlyCreditCents?: number
  promo?: {
    kind: string
    windowDays: number
    eligible: boolean
    used: boolean
    tiers: Array<{ payCents: number; giftCents: number; creditCents: number }>
  }
  beta?: {
    enabled: boolean
    allowed: boolean
    dailyBudgetCents: number
    dailySpendCents: number
    dailyRemainingCents: number
    monthlyBudgetCents: number
    monthlySpendCents: number
    monthlyRemainingCents: number
    siteDailyBudgetCents: number
    siteDailySpendCents: number
    siteDailyRemainingCents: number
    maxOutputChars: number
  }
  orders?: Array<{
    id: string
    channel: string
    amount_cents: number
    status: string
    created_at: number
    paid_at?: number | null
    credited_at?: number | null
    note?: string | null
  }>
  ledger?: Array<{
    id: string
    entry_type: string
    amount_cents: number
    period?: string | null
    ref_id?: string | null
    created_at: number
  }>
}

function fmtCny(cents: number | undefined | null) {
  const n = Number(cents || 0) / 100
  return `¥${n.toFixed(2)}`
}

function fmtBeta(cents: number | undefined | null) {
  return fmtCny(cents).replace('.00', '')
}

function fmtTs(ts: number | undefined | null) {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function apiMeBilling(): Promise<BillingResp> {
  const r = await fetch('/api/me/billing', { credentials: 'include' })
  const j = (await r.json()) as BillingResp
  if (!r.ok || !j.ok) throw new Error((j as any)?.detail || '请求失败')
  return j
}

async function apiSubActivate(months: number) {
  const payload = { plan: 'pro', months, requestId: `sub_${Date.now()}` }
  const r = await fetch('/api/me/subscription/activate', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json()
  if (!r.ok || !j?.ok) {
    const d = j?.detail
    if (d && typeof d === 'object' && d.code === 'InsufficientBalance') {
      const bal = fmtCny(d.balanceCents)
      const need = fmtCny(d.needCents)
        throw new Error(`Beta 额度不足：当前 ${bal}，需要 ${need}。请等待补发或下一轮开放。`)
    }
    throw new Error((j && (j.detail?.code || j.detail || j.error)) || '开通失败')
  }
  return j
}

export function MeBillingPage() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string>('')
  const [data, setData] = useState<BillingResp | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedPayCents, setSelectedPayCents] = useState<number>(9900)
  const [payModalOpen, setPayModalOpen] = useState(false)
  const [payStep, setPayStep] = useState<'scan' | 'submit' | 'verifying' | 'done'>('scan')
  const [verifyCountdown, setVerifyCountdown] = useState(3)
  const [payChannel, setPayChannel] = useState<'alipay' | 'wxpay'>('alipay')
  const [qrLoadFailed, setQrLoadFailed] = useState(false)
  const [payNote, setPayNote] = useState('')
  const [payProofDataUrl, setPayProofDataUrl] = useState<string>('')
  const [submitOk, setSubmitOk] = useState<{ orderId: string } | null>(null)
  const [adminOrders, setAdminOrders] = useState<any[] | null>(null)
  const [adminBusy, setAdminBusy] = useState<string>('')
  const [tab, setTab] = useState<'orders' | 'ledger'>('orders')
  const [subConfirmOpen, setSubConfirmOpen] = useState(false)
  const [subConfirmMonths, setSubConfirmMonths] = useState<number>(1)

  const sub = data?.subscription
  const balance = data?.balanceCents || 0
  const monthlyCredit = data?.monthlyCreditCents || 0
  const promo = data?.promo
  const beta = data?.beta
  const promoEligible = false
  const isAdmin = (data?.me?.role || '').toLowerCase() === 'admin'

  const meEmail = String(data?.me?.email || '').trim()
  const planSpec = getBillingPlanSpec(data?.plan)
  const subCostCents = planSpec.monthlyPriceCents * Math.max(1, Math.min(24, Number(subConfirmMonths || 1)))
  const betaCards = [
    { label: '今日剩余额度', value: fmtBeta(beta?.dailyRemainingCents), sub: `今日已用 ${fmtBeta(beta?.dailySpendCents)}` },
    { label: '本月剩余额度', value: fmtBeta(beta?.monthlyRemainingCents), sub: `本月已用 ${fmtBeta(beta?.monthlySpendCents)}` },
    { label: '全站今日剩余', value: fmtBeta(beta?.siteDailyRemainingCents), sub: `全站已用 ${fmtBeta(beta?.siteDailySpendCents)}` },
  ]

  useEffect(() => {
    if (payStep !== 'verifying') return
    setVerifyCountdown(3)
    let n = 3
    const t = setInterval(() => {
      n -= 1
      setVerifyCountdown(Math.max(0, n))
      if (n <= 0) {
        clearInterval(t)
        setPayStep('done')
      }
    }, 1000)
    return () => clearInterval(t)
  }, [payStep])

  const subBadge = useMemo(() => {
    const s = sub?.status || 'none'
    if (s === 'active') return { text: '已开通', color: '#0f9f5f' }
    if (s === 'trialing') return { text: '试用中', color: '#7c5cff' }
    if (s === 'expired') return { text: '已到期', color: '#ea580c' }
    return { text: '未开通', color: '#64748b' }
  }, [sub?.status])

  async function refresh() {
    setLoading(true)
    setErr('')
    try {
      const j = await apiMeBilling()
      setData(j)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  useEffect(() => {
    setQrLoadFailed(false)
  }, [payChannel, payModalOpen, payStep])

  async function apiManualSubmit() {
    const payload = { channel: payChannel, amountCents: selectedPayCents, note: payNote, proofDataUrl: payProofDataUrl }
    const r = await fetch('/api/pay/manual/submit', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.ok) throw new Error((j && (j.detail || j.error)) || '提交失败')
    return j as { ok: boolean; orderId: string }
  }

  async function apiAdminListSubmitted() {
    const r = await fetch('/api/admin/recharge_orders?status=submitted', { credentials: 'include' })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.ok) throw new Error((j && (j.detail || j.error)) || '加载失败')
    return (j.orders || []) as any[]
  }

  async function apiAdminCredit(orderId: string) {
    const r = await fetch('/api/admin/pay/manual/credit', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId }),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.ok) throw new Error((j && (j.detail || j.error)) || '入账失败')
    return j
  }

  async function activate(months: number) {
    setBusy(true)
    setErr('')
    try {
      await apiSubActivate(months)
      await refresh()
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const blurred = payModalOpen || subConfirmOpen

  return (
    <div className="billingRoot">
      <div className={`billingContainer ${blurred ? 'billingBlurred' : ''}`}>
        <div className="billingPageHeader">
          <div>
            <h1 className="billingTitle">Beta 额度中心</h1>
            <p className="billingSubtitle">Covixa 当前为受控免费试运营；额度用于模型调用和资源消耗控制，不代表现金余额。</p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{meEmail ? `当前用户: ${meEmail}` : ''}</div>
            <button type="button" className="billingBtn billingBtnSec" onClick={refresh} disabled={loading || busy}>
              刷新
            </button>
          </div>
        </div>

        {err ? (
          <div style={{ marginTop: 12, color: 'rgba(255,120,120,0.95)', fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {err === 'InsufficientBalance' ? 'Beta 额度不足，请等待补发或下一轮开放。' : err}
          </div>
        ) : null}

        {/* 01-overview: promo is the hero section */}
        <div className="billingPromo">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>
              免费 Beta <span style={{ fontWeight: 400, fontSize: 13, opacity: 0.8, marginLeft: 10 }}>有限额度、硬性预算、先控成本</span>
            </div>
            <span style={{ background: 'var(--primary)', color: 'white', fontSize: 12, padding: '4px 10px', borderRadius: 6, fontWeight: 'bold' as any }}>
              当前试运营
            </span>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)' }}>
            {beta?.enabled
              ? `注册后自动发放 Beta 额度；单次输出上限 ${Number(beta.maxOutputChars || 0).toLocaleString()} 字符。`
              : '当前未开启 Beta 额度模式。'}
          </div>
          <div className="billingPricingGrid">
            {betaCards.map((t) => {
              const disabled = true
              const active = false
              return (
                <div
                  key={t.label}
                  className={`billingPriceCard ${active ? 'billingPriceCardActive' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (disabled) return
                    setSelectedPayCents(BILLING_TOP_UP_TIERS[0].payCents)
                    setPayChannel('alipay')
                    setPayNote('')
                    setPayProofDataUrl('')
                    setSubmitOk(null)
                    setPayStep('scan')
                    setPayModalOpen(true)
                  }}
                  style={{ opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
                >
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 700 }}>{t.label}</div>
                  <div style={{ fontSize: 32, fontWeight: 800, marginTop: 4 }}>{t.value}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>{t.sub}</div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 01-overview: assets overview (compact) */}
        <div className="billingTopGrid">
          <div className="billingCard" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 'bold' as any }}>可用 Beta 额度</div>
              <div className="billingBalanceAmount">{fmtCny(balance)}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', opacity: 0.7 }}>用于模型调用和试运营资源消耗；额度不足会暂停新请求</div>
            </div>
            <div />
          </div>
          <div className="billingCard" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 'bold' as any }}>试运营状态</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' }}>
                <span style={{ fontSize: 24, fontWeight: 800 }}>{planSpec.label}</span>
                <span className="billingStatusBadge">{subBadge.text}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', opacity: 0.7 }}>
                当前不公开收费；正式套餐和在线支付暂未开放
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', opacity: 0.7, marginTop: 4 }}>试用到期：{fmtTs(sub?.currentPeriodEnd || sub?.trialEndsAt || null)}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button
                className="billingBtn"
                type="button"
                disabled
                onClick={() => {
                  setSubConfirmMonths(1)
                  setSubConfirmOpen(true)
                }}
              >
                付费暂未开放
              </button>
              <button
                className="billingBtn billingBtnSec"
                type="button"
                disabled
                onClick={() => {
                  setSubConfirmMonths(12)
                  setSubConfirmOpen(true)
                }}
              >
                等待正式套餐
              </button>
            </div>
          </div>
        </div>

        {/* 01-overview: history card */}
        <div className="billingCard" style={{ paddingTop: 10 }}>
          <div className="billingTabs">
            <div className={`billingTab ${tab === 'orders' ? 'billingTabActive' : ''}`} onClick={() => setTab('orders')}>
              补发记录
            </div>
            <div className={`billingTab ${tab === 'ledger' ? 'billingTabActive' : ''}`} onClick={() => setTab('ledger')}>
              额度流水
            </div>
          </div>

          {tab === 'orders' ? (
            <div>
              {(data?.orders || []).slice(0, 12).map((it) => {
                const ok = String(it.status || '') === 'credited'
                const desc = `${it.channel === 'alipay' ? '支付宝' : it.channel === 'wxpay' ? '微信' : it.channel}人工记录 (订单号: ${String(it.id || '').slice(0, 4)}...)`
                return (
                  <div key={it.id} className="billingRow" title={`${it.channel} ${it.status} ${it.note || ''}`}>
                    <div style={{ width: 140 }}>{fmtTs(it.created_at)}</div>
                    <div style={{ flex: 1 }}>{desc}</div>
                    <div style={{ width: 100, textAlign: 'right', fontWeight: 'bold' as any }}>{fmtCny(it.amount_cents)}</div>
                    <div style={{ width: 80, textAlign: 'right', color: ok ? 'var(--success)' : 'var(--text-dim)' }}>{ok ? '已到账' : it.status}</div>
                  </div>
                )
              })}
              {!loading && (!data?.orders || data.orders.length === 0) ? <div style={{ opacity: 0.7, fontSize: 12 }}>暂无人工补发/付款记录</div> : null}
            </div>
          ) : (
            <div>
              {(data?.ledger || []).slice(0, 12).map((it) => {
                const amtOk = Number(it.amount_cents || 0) >= 0
                return (
                  <div key={it.id} className="billingRow" title={`${it.entry_type} ${it.period || ''} ${it.ref_id || ''}`}>
                    <div style={{ width: 140 }}>{fmtTs(it.created_at)}</div>
                    <div style={{ flex: 1 }}>{it.entry_type}</div>
                    <div style={{ width: 100, textAlign: 'right', fontWeight: 'bold' as any, color: amtOk ? 'var(--success)' : 'rgba(255,120,120,0.9)' }}>
                      {fmtCny(it.amount_cents)}
                    </div>
                    <div style={{ width: 80, textAlign: 'right', color: 'var(--text-dim)' }}>{it.period || ''}</div>
                  </div>
                )
              })}
              {!loading && (!data?.ledger || data.ledger.length === 0) ? <div style={{ opacity: 0.7, fontSize: 12 }}>暂无流水</div> : null}
            </div>
          )}
        </div>
        {isAdmin ? (
          <div className="billingCard">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ fontWeight: 800 }}>管理员：待入账（submitted）</div>
              <button
                type="button"
                className="billingBtn billingBtnSec"
                disabled={!!adminBusy}
                onClick={async () => {
                  setAdminBusy('list')
                  setErr('')
                  try {
                    const rows = await apiAdminListSubmitted()
                    setAdminOrders(rows)
                  } catch (e: any) {
                    setErr(String(e?.message || e))
                  } finally {
                    setAdminBusy('')
                  }
                }}
              >
                刷新列表
              </button>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)' }}>Beta 阶段建议只做人工补发额度；公开付款入口暂不开放。</div>
            <div style={{ marginTop: 10 }}>
              {(adminOrders || []).slice(0, 50).map((o) => (
                <div
                  key={o.id}
                  style={{
                    borderTop: '1px solid rgba(148,163,184,0.16)',
                    padding: '10px 0',
                    display: 'grid',
                    gridTemplateColumns: '1fr 120px 220px',
                    gap: 10,
                    alignItems: 'center',
                    fontSize: 12,
                  }}
                >
                  <div style={{ opacity: 0.9 }}>
                    <div style={{ fontWeight: 800 }}>
                      {o.id}{' '}
                      <span style={{ opacity: 0.7, fontWeight: 700 }}>
                        uid={o.user_id} · {o.channel} · {fmtCny(o.amount_cents)}
                      </span>
                    </div>
                    <div style={{ marginTop: 4, opacity: 0.7, whiteSpace: 'pre-wrap' }}>{o.note || ''}</div>
                  </div>
                  <div style={{ textAlign: 'right', opacity: 0.75 }}>{fmtTs(o.created_at)}</div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                    <a href={`/api/admin/pay/manual/proof/${o.id}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', color: '#4c1d95' }}>
                      查看截图
                    </a>
                    <button
                      type="button"
                      className="billingBtn"
                      disabled={!!adminBusy}
                      onClick={async () => {
                        setAdminBusy(o.id)
                        setErr('')
                        try {
                          await apiAdminCredit(o.id)
                          const rows = await apiAdminListSubmitted()
                          setAdminOrders(rows)
                          await refresh()
                        } catch (e: any) {
                          setErr(String(e?.message || e))
                        } finally {
                          setAdminBusy('')
                        }
                      }}
                    >
                      一键入账
                    </button>
                  </div>
                </div>
              ))}
              {adminOrders && adminOrders.length === 0 ? <div style={{ opacity: 0.7, fontSize: 12 }}>暂无待入账订单</div> : null}
              {!adminOrders ? <div style={{ opacity: 0.7, fontSize: 12 }}>点击“刷新列表”加载待入账订单</div> : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* 05-subscription-confirm */}
      {subConfirmOpen ? (
        <div className="billingModalOverlay" role="dialog" aria-modal="true" onClick={() => setSubConfirmOpen(false)}>
          <div className="billingConfirmModal" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 12 }}>确认续费？</div>
              <div style={{ color: 'var(--text-dim)', fontSize: 14, lineHeight: 1.6, marginBottom: 24 }}>
              将从您的余额中扣除 <b>{fmtCny(subCostCents)}</b> 用于续费 {subConfirmMonths} 个月 {planSpec.label}。<br />
                当前余额：{fmtCny(balance)}。SSH/工作区基础权益以订阅状态为准，余额主要用于模型调用和续费扣款。
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="button" className="billingBtn billingBtnSec" onClick={() => setSubConfirmOpen(false)} disabled={busy || loading}>
                取消
              </button>
              <button
                type="button"
                className="billingBtn"
                onClick={async () => {
                  setSubConfirmOpen(false)
                  await activate(subConfirmMonths)
                }}
                disabled={busy || loading}
              >
                确认支付
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 02/03/04-cashier */}
      {payModalOpen ? (
        <div className="billingModalOverlay" role="dialog" aria-modal="true" onClick={() => setPayModalOpen(false)}>
          <div className="billingModal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
              <div style={{ fontWeight: 800, fontSize: 18 }}>
                {payStep === 'scan' ? '人工充值' : payStep === 'submit' ? '提交付款凭证' : payStep === 'verifying' ? '正在登记凭证...' : '等待人工入账'}
              </div>
              {payStep !== 'verifying' ? (
                <div style={{ color: 'var(--text-dim)', cursor: 'pointer' }} onClick={() => setPayModalOpen(false)}>
                  ✕
                </div>
              ) : null}
            </div>

            <div className="billingStepIndicator">
              <div className={`billingStep ${payStep === 'scan' || payStep === 'submit' || payStep === 'verifying' || payStep === 'done' ? 'billingStepActive' : ''}`} />
              <div className={`billingStep ${payStep === 'submit' || payStep === 'verifying' || payStep === 'done' ? 'billingStepActive' : ''}`} />
              <div className={`billingStep ${payStep === 'done' ? 'billingStepActive' : ''}`} />
            </div>

            {payStep === 'scan' ? (
              <div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: '#b45309', fontSize: 12, marginBottom: 8 }}>
                    当前为人工充值：扫码付款后需上传截图，管理员核对后入账。
                  </div>
                  <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 8 }}>支付金额</div>
                  <div style={{ fontSize: 36, fontWeight: 800, fontFamily: 'ui-monospace, monospace' }}>{fmtCny(selectedPayCents)}</div>
                </div>

                <div className="billingQrBox">
                  {qrLoadFailed ? (
                    <div style={{ width: 160, height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 12, fontSize: 12, color: '#64748b' }}>
                      二维码未配置或不可访问
                      <br />
                      请联系管理员
                    </div>
                  ) : (
                    <img
                      alt={payChannel === 'alipay' ? '支付宝收款码' : '微信收款码'}
                      src={payChannel === 'alipay' ? '/api/pay/qr/alipay' : '/api/pay/qr/wxpay'}
                      onError={() => setQrLoadFailed(true)}
                      style={{ width: 160, height: 160, objectFit: 'contain' }}
                    />
                  )}
                </div>

                <div className="billingChannels">
                  <button type="button" className={`billingChBtn ${payChannel === 'alipay' ? 'billingChBtnActive' : ''}`} onClick={() => setPayChannel('alipay')}>
                    <span>🟦</span> 支付宝
                  </button>
                  <button type="button" className={`billingChBtn ${payChannel === 'wxpay' ? 'billingChBtnActive' : ''}`} onClick={() => setPayChannel('wxpay')}>
                    <span>🟩</span> 微信支付
                  </button>
                </div>

                <button
                  type="button"
                  className="billingBtnPrimary"
                  onClick={() => {
                    setPayProofDataUrl('')
                    setSubmitOk(null)
                    setPayStep('submit')
                  }}
                >
                  我已付款，上传截图
                </button>
              </div>
            ) : null}

            {payStep === 'submit' ? (
              <div>
                <div style={{ color: 'var(--text-dim)', fontSize: 14, lineHeight: 1.6 }}>
                  请上传付款截图以便入账（当前为手工到账：提交后状态会变为 <b>submitted</b>）。
                </div>

                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim)' }}>备注（建议：邮箱/手机号后四位 + 金额）</div>
                <textarea
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                  placeholder="例如：30***@qq.com + 99"
                  style={{
                    marginTop: 6,
                    width: '100%',
                    minHeight: 84,
                    padding: '10px 10px',
                    borderRadius: 12,
                    border: '1px solid #dbe3f0',
                    background: '#ffffff',
                    color: '#0f172a',
                    resize: 'vertical',
                  }}
                />

                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim)' }}>付款截图（≤2MB，jpg/png/webp）</div>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    setSubmitOk(null)
                    const f = e.target.files?.[0]
                    if (!f) return
                    if (f.size > 2 * 1024 * 1024) {
                      setErr('截图太大（>2MB），请压缩后再上传。')
                      return
                    }
                    const reader = new FileReader()
                    reader.onload = () => {
                      const v = String(reader.result || '')
                      setPayProofDataUrl(v)
                    }
                    reader.readAsDataURL(f)
                  }}
                  style={{ marginTop: 8 }}
                />

                {payProofDataUrl ? (
                  <img alt="付款截图预览" src={payProofDataUrl} style={{ marginTop: 10, width: '100%', maxWidth: 420, borderRadius: 12, border: '1px solid #e2e8f0' }} />
                ) : (
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>未选择截图</div>
                )}

                <div style={{ marginTop: 12, display: 'flex', gap: 12 }}>
                  <button type="button" className="billingBtn billingBtnSec" onClick={() => setPayStep('scan')}>
                    返回扫码
                  </button>
                  <button
                    type="button"
                    className="billingBtn"
                    disabled={busy || loading || !payProofDataUrl}
                    onClick={async () => {
                      setBusy(true)
                      setErr('')
                      try {
                        const r = await apiManualSubmit()
                        setSubmitOk({ orderId: r.orderId })
                        setPayStep('verifying')
                        await refresh()
                      } catch (e: any) {
                        setErr(String(e?.message || e))
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    提交
                  </button>
                </div>
              </div>
            ) : null}

            {payStep === 'verifying' ? (
              <div>
                <div className="billingSpinner" />
                <div className="billingLoadingText">正在登记凭证 ({verifyCountdown > 0 ? `${verifyCountdown}s` : '...'})...</div>
              </div>
            ) : null}

            {payStep === 'done' ? (
              <div>
                <div className="billingSuccessIcon">✓</div>
                <div style={{ textAlign: 'center', marginBottom: 30 }}>
                  <h3 style={{ margin: '0 0 10px' }}>{fmtCny(selectedPayCents)} 凭证已提交</h3>
                  <p style={{ color: 'var(--text-dim)', fontSize: 14, lineHeight: 1.5, margin: 0 }}>
                    {submitOk?.orderId ? `订单号：${submitOk.orderId}` : ''}
                    <br />
                    管理员核对后会一键入账，入账后余额/账本会自动更新。
                  </p>
                </div>
                <button
                  type="button"
                  className="billingBtnPrimary"
                  onClick={async () => {
                    setPayModalOpen(false)
                    setPayProofDataUrl('')
                    setPayNote('')
                    setSubmitOk(null)
                    setPayStep('scan')
                    await refresh()
                  }}
                >
                  完成
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

