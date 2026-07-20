import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getBillingPlanSpec } from '../billingCatalog'

type SubscriptionResp = {
  ok: boolean
  subscription?: {
    status: string
    plan: string
    currentPeriodStart?: number | null
    currentPeriodEnd?: number | null
    cancelAtPeriodEnd?: boolean
    trialEndsAt?: number | null
    gracePeriodEndsAt?: number | null
    suspendedAt?: number | null
    suspendReason?: string
  }
  entitlements?: {
    deviceLimit?: number
    regionLimit?: number
    supportTier?: string
  }
}

type DeliveriesResp = {
  ok: boolean
  items?: Array<{
    id: string
    status: string
    deliveryType: string
    region: string
    deviceLimit: number
    regionLimit: number
    configVersion: number
    issuedAt?: number | null
    expiresAt?: number | null
    revokedAt?: number | null
    updatedAt?: number | null
  }>
}

type SupportTicketsResp = {
  ok: boolean
  items?: Array<{
    id: string
    category: string
    subject: string
    status: string
    createdAt?: number | null
    updatedAt?: number | null
  }>
}

function fmtTs(ts?: number | null) {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}

async function apiSubscription(): Promise<SubscriptionResp> {
  const r = await fetch('/api/me/subscription', { credentials: 'include' })
  const j = (await r.json().catch(() => null)) as SubscriptionResp | null
  if (!r.ok || !j?.ok) throw new Error((j as any)?.detail || '订阅信息加载失败')
  return j
}

async function apiDeliveries(): Promise<DeliveriesResp> {
  const r = await fetch('/api/me/deliveries', { credentials: 'include' })
  const j = (await r.json().catch(() => null)) as DeliveriesResp | null
  if (!r.ok || !j?.ok) throw new Error((j as any)?.detail || '交付信息加载失败')
  return j
}

async function apiSupportTickets(): Promise<SupportTicketsResp> {
  const r = await fetch('/api/me/support/tickets', { credentials: 'include' })
  const j = (await r.json().catch(() => null)) as SupportTicketsResp | null
  if (!r.ok || !j?.ok) throw new Error((j as any)?.detail || '工单加载失败')
  return j
}

function statusLabel(status: string) {
  const s = (status || '').toLowerCase()
  if (s === 'active') return '已生效'
  if (s === 'trialing') return '试用中'
  if (s === 'suspended') return '已暂停'
  if (s === 'expired') return '已过期'
  if (s === 'revoked') return '已回收'
  if (s === 'pending') return '待交付'
  if (s === 'open') return '待处理'
  if (s === 'in_progress') return '处理中'
  if (s === 'resolved') return '已解决'
  return status || '-'
}

export function MeSubscriptionPage() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [subscription, setSubscription] = useState<SubscriptionResp | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveriesResp | null>(null)
  const [supportTickets, setSupportTickets] = useState<SupportTicketsResp | null>(null)
  const [ticketCategory, setTicketCategory] = useState('billing')
  const [ticketSubject, setTicketSubject] = useState('')
  const [ticketContent, setTicketContent] = useState('')

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const [sub, del, tickets] = await Promise.all([apiSubscription(), apiDeliveries(), apiSupportTickets()])
      setSubscription(sub)
      setDeliveries(del)
      setSupportTickets(tickets)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const sub = subscription?.subscription
  const entitlements = subscription?.entitlements
  const planSpec = getBillingPlanSpec(sub?.plan)
  const activeDeliveries = useMemo(() => (deliveries?.items || []).filter((item) => ['pending', 'active'].includes((item.status || '').toLowerCase())), [deliveries?.items])

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 18px 50px' }}>
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
          <div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>Beta 权益与交付</div>
            <div style={{ marginTop: 6, opacity: 0.72, fontSize: 12 }}>
              查看当前试运营权益、交付范围，以及 Beta 额度如何控制模型消耗。
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Link to="/me" style={linkBtnStyle(false)}>
              返回个人中心
            </Link>
            <Link to="/me/billing" style={linkBtnStyle(true)}>
              查看 Beta 额度
            </Link>
          </div>
        </div>

        <div style={{ padding: 16 }}>
          {err ? <div style={{ marginBottom: 12, color: 'rgba(255,120,120,0.95)', fontSize: 13 }}>{err}</div> : null}
          {loading ? <div style={{ opacity: 0.75 }}>加载中…</div> : null}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <Card title="当前状态" value={loading ? '—' : statusLabel(sub?.status || '')} desc={`阶段：Beta 试运营`} />
            <Card title="试用周期" value={loading ? '—' : fmtTs(sub?.currentPeriodEnd)} desc={`开始：${fmtTs(sub?.currentPeriodStart)}`} />
            <Card title="设备限制" value={String(entitlements?.deviceLimit || 0)} desc={`区域限制：${entitlements?.regionLimit || 0}`} />
            <Card title="支持等级" value={String(entitlements?.supportTier || 'ticket')} desc={`试用到期：${fmtTs(sub?.trialEndsAt)} · 模型调用走 Beta 额度`} />
          </div>

          <div
            style={{
              marginTop: 14,
              border: '1px solid #e2e8f0',
              borderRadius: 16,
              background: '#ffffff',
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 900 }}>当前交付</div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
              这里展示的是用户可见交付，不展开节点底层实现细节。
            </div>

            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              {activeDeliveries.map((item) => (
                <div
                  key={item.id}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: 14,
                    background: '#f8fafc',
                    padding: 12,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 850 }}>
                      {item.region || '未分配区域'} · {statusLabel(item.status)}
                    </div>
                    <div style={{ opacity: 0.72, fontSize: 12, color: '#64748b' }}>配置版本 v{item.configVersion || 1}</div>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 13, opacity: 0.82, color: '#334155' }}>
                    类型：{item.deliveryType || '-'} · 设备数 {item.deviceLimit || 0} · 区域数 {item.regionLimit || 0}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82, color: '#64748b' }}>
                    发放：{fmtTs(item.issuedAt)} · 到期：{fmtTs(item.expiresAt)}
                  </div>
                </div>
              ))}
              {!loading && activeDeliveries.length === 0 ? <div style={{ opacity: 0.7, fontSize: 12 }}>当前没有生效中的交付记录。</div> : null}
            </div>
          </div>

          <div
            style={{
              marginTop: 14,
              border: '1px solid #e2e8f0',
              borderRadius: 16,
              background: '#ffffff',
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 900 }}>支持请求</div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
              额度、交付、故障或试运营反馈都建议从这里提交，便于后台追踪。
            </div>
            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10 }}>
                <select value={ticketCategory} onChange={(e) => setTicketCategory(e.target.value)} style={inputStyle}>
                  <option value="billing">billing</option>
                  <option value="delivery">delivery</option>
                  <option value="incident">incident</option>
                  <option value="refund">refund</option>
                </select>
                <input value={ticketSubject} onChange={(e) => setTicketSubject(e.target.value)} placeholder="标题，例如：额度用完希望补发" style={inputStyle} />
              </div>
              <textarea value={ticketContent} onChange={(e) => setTicketContent(e.target.value)} placeholder="描述问题、订单号、交付区域和复现时间。" style={{ ...inputStyle, minHeight: 90, paddingTop: 10, resize: 'vertical' }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  disabled={busy || !ticketSubject.trim() || !ticketContent.trim()}
                  style={actionBtnStyle}
                  onClick={async () => {
                    setBusy(true)
                    setErr('')
                    try {
                      const r = await fetch('/api/me/support/tickets', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ category: ticketCategory, subject: ticketSubject.trim(), content: ticketContent.trim() }),
                      })
                      const j = await r.json().catch(() => null)
                      if (!r.ok || !j?.ok) throw new Error((j && (j.detail || j.error)) || '工单创建失败')
                      setTicketSubject('')
                      setTicketContent('')
                      await load()
                    } catch (e: any) {
                      setErr(String(e?.message || e))
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  提交支持请求
                </button>
              </div>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle}>分类</th>
                  <th style={thStyle}>标题</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {(supportTickets?.items || []).slice(0, 10).map((item) => (
                  <tr key={item.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={tdStyle}>{item.category}</td>
                    <td style={tdStyle}>{item.subject}</td>
                    <td style={tdStyle}>{statusLabel(item.status)}</td>
                    <td style={tdStyle}>{fmtTs(item.updatedAt || item.createdAt)}</td>
                  </tr>
                ))}
                {!loading && (!supportTickets?.items || supportTickets.items.length === 0) ? (
                  <tr>
                    <td colSpan={4} style={tdStyle}>
                      暂无支持请求
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div
            style={{
              marginTop: 14,
              border: '1px solid #e2e8f0',
              borderRadius: 16,
              background: '#ffffff',
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 900 }}>最近交付历史</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle}>区域</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>更新时间</th>
                  <th style={thStyle}>回收时间</th>
                </tr>
              </thead>
              <tbody>
                {(deliveries?.items || []).slice(0, 12).map((item) => (
                  <tr key={item.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={tdStyle}>{item.region || '-'}</td>
                    <td style={tdStyle}>{statusLabel(item.status)}</td>
                    <td style={tdStyle}>{fmtTs(item.updatedAt)}</td>
                    <td style={tdStyle}>{fmtTs(item.revokedAt)}</td>
                  </tr>
                ))}
                {!loading && (!deliveries?.items || deliveries.items.length === 0) ? (
                  <tr>
                    <td colSpan={4} style={tdStyle}>
                      暂无交付历史
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function Card(props: { title: string; value: string; desc: string }) {
  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 16,
        background: '#f8fafc',
        padding: 14,
      }}
    >
      <div style={{ opacity: 0.75, fontSize: 12, fontWeight: 800, color: '#64748b' }}>{props.title}</div>
      <div style={{ marginTop: 10, fontSize: 22, fontWeight: 950 }}>{props.value}</div>
      <div style={{ marginTop: 8, opacity: 0.82, fontSize: 12, color: '#64748b' }}>{props.desc}</div>
    </div>
  )
}

function linkBtnStyle(primary: boolean) {
  return {
    padding: '8px 12px',
    borderRadius: 12,
    border: primary ? '1px solid rgba(124,92,255,0.22)' : '1px solid #dbe3f0',
    background: primary ? 'rgba(124,92,255,0.08)' : '#ffffff',
    color: primary ? '#4c1d95' : '#0f172a',
    fontWeight: 850,
    textDecoration: 'none',
  } as const
}

const inputStyle = {
  width: '100%',
  minHeight: 40,
  borderRadius: 10,
  border: '1px solid #dbe3f0',
  background: '#ffffff',
  color: '#0f172a',
  padding: '0 12px',
  outline: 'none',
} as const

const actionBtnStyle = {
  height: 36,
  padding: '0 14px',
  borderRadius: 10,
  border: '1px solid rgba(124,92,255,0.22)',
  background: 'rgba(124,92,255,0.08)',
  cursor: 'pointer',
  color: '#4c1d95',
  fontWeight: 850,
} as const

const thStyle = { textAlign: 'left', padding: '10px 12px', opacity: 0.75, fontWeight: 850, color: '#64748b' } as const
const tdStyle = { padding: '10px 12px', color: '#0f172a' } as const
