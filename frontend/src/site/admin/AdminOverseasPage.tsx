import { useEffect, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { AdminLayout } from './AdminLayout'

type OverviewResp = {
  ok: boolean
  summary?: {
    usersTotal: number
    subscriptionsActive: number
    trialingUsers: number
    pendingOrders: number
    refundsPending: number
    abuseOpen: number
    healthyNodes: number
    nodesTotal: number
    incidentsOpen: number
  }
}

type SubscriptionItem = {
  userId: number
  email: string
  userStatus: string
  status: string
  trialEndsAt?: number | null
  currentPeriodEnd?: number | null
  updatedAt?: number | null
  activeDeliveryId: string
  activeDeliveryRegion: string
}

type SubscriptionsResp = {
  ok: boolean
  items?: SubscriptionItem[]
  total?: number
}

type AbuseItem = {
  id: string
  userId?: number | null
  category: string
  severity: string
  status: string
  actionTaken: string
  createdAt?: number | null
}

type NodesItem = {
  id: string
  region: string
  provider: string
  status: string
  capacityLimit: number
  activeUsers: number
  costMonthlyCents: number
  latencyP50Ms: number
  onlineRate: number
  updatedAt?: number | null
}

type IncidentItem = {
  id: string
  status: string
  title: string
  severity: string
  messageMd: string
  updatedAt?: number | null
}

type SupportTicketItem = {
  id: string
  userId: number
  email: string
  category: string
  subject: string
  content: string
  status: string
  adminNote: string
  updatedAt?: number | null
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

function fmtMoney(cents: number) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`
}

function StatCard(props: { label: string; value: string; sub?: string }) {
  return (
    <div
      style={{
        borderRadius: 14,
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(255,255,255,0.03)',
        padding: 14,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.72 }}>{props.label}</div>
      <div style={{ marginTop: 6, fontSize: 24, fontWeight: 900 }}>{props.value}</div>
      {props.sub ? <div style={{ marginTop: 6, fontSize: 12, opacity: 0.62 }}>{props.sub}</div> : null}
    </div>
  )
}

function TableCard(props: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
        background: 'rgba(15,22,33,0.55)',
        padding: 16,
      }}
    >
      <div style={{ fontWeight: 850 }}>{props.title}</div>
      {props.subtitle ? <div style={{ marginTop: 6, fontSize: 13, opacity: 0.72 }}>{props.subtitle}</div> : null}
      <div style={{ marginTop: 12 }}>{props.children}</div>
    </div>
  )
}

export function AdminOverseasPage() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string>('')
  const [overview, setOverview] = useState<OverviewResp | null>(null)
  const [subscriptions, setSubscriptions] = useState<SubscriptionsResp | null>(null)
  const [abuseItems, setAbuseItems] = useState<AbuseItem[]>([])
  const [nodes, setNodes] = useState<NodesItem[]>([])
  const [incidents, setIncidents] = useState<IncidentItem[]>([])
  const [tickets, setTickets] = useState<SupportTicketItem[]>([])
  const [incidentTitle, setIncidentTitle] = useState('')
  const [incidentSeverity, setIncidentSeverity] = useState('minor')
  const [incidentStatus, setIncidentStatus] = useState('investigating')
  const [incidentMessage, setIncidentMessage] = useState('')
  const [assignUserId, setAssignUserId] = useState('')
  const [assignRegion, setAssignRegion] = useState('')
  const [assignDeviceLimit, setAssignDeviceLimit] = useState('3')
  const [assignRegionLimit, setAssignRegionLimit] = useState('2')

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const [overviewResp, subscriptionsResp, abuseResp, nodesResp, incidentsResp, ticketsResp] = await Promise.all([
        fetch('/api/admin/overseas/overview', { credentials: 'include' }),
        fetch('/api/admin/subscriptions?page=1&pageSize=12', { credentials: 'include' }),
        fetch('/api/admin/abuse-events', { credentials: 'include' }),
        fetch('/api/admin/nodes', { credentials: 'include' }),
        fetch('/api/admin/status/incidents', { credentials: 'include' }),
        fetch('/api/admin/support/tickets', { credentials: 'include' }),
      ])

      const payloads = await Promise.all([
        overviewResp.json().catch(() => null),
        subscriptionsResp.json().catch(() => null),
        abuseResp.json().catch(() => null),
        nodesResp.json().catch(() => null),
        incidentsResp.json().catch(() => null),
        ticketsResp.json().catch(() => null),
      ])

      if (!overviewResp.ok || !subscriptionsResp.ok || !abuseResp.ok || !nodesResp.ok || !incidentsResp.ok || !ticketsResp.ok) {
        throw new Error('海外订阅运营数据加载失败')
      }

      setOverview(payloads[0] as OverviewResp)
      setSubscriptions(payloads[1] as SubscriptionsResp)
      setAbuseItems(((payloads[2] as any)?.items || []) as AbuseItem[])
      setNodes(((payloads[3] as any)?.items || []) as NodesItem[])
      setIncidents(((payloads[4] as any)?.items || []) as IncidentItem[])
      setTickets(((payloads[5] as any)?.items || []) as SupportTicketItem[])
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const summary = overview?.summary

  async function postJson(url: string, body: Record<string, unknown>, busyKey: string) {
    setActionBusy(busyKey)
    setErr(null)
    try {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j?.ok) throw new Error((j && (j.detail || j.error)) || '操作失败')
      await load()
      return j
    } catch (e: any) {
      setErr(String(e?.message || e))
      throw e
    } finally {
      setActionBusy('')
    }
  }

  return (
    <AdminLayout>
      <div style={{ maxWidth: 1220, margin: '0 auto', padding: '32px 18px 50px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 850 }}>海外订阅运营</div>
            <div style={{ marginTop: 10, opacity: 0.75 }}>
              这里先承接最小运营闭环：订阅状态、风控事件、节点库存和事故公告。
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Link to="/admin" style={{ opacity: 0.8, textDecoration: 'underline' }}>
              返回后台首页
            </Link>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              style={{
                height: 36,
                padding: '0 14px',
                borderRadius: 12,
                border: '1px solid rgba(124,92,255,0.55)',
                background: 'rgba(124,92,255,0.12)',
                cursor: 'pointer',
                fontWeight: 850,
              }}
            >
              刷新
            </button>
          </div>
        </div>

        {err ? <div style={{ marginTop: 12, color: 'rgba(255,140,140,0.95)' }}>{err}</div> : null}
        {loading ? <div style={{ marginTop: 12, opacity: 0.75 }}>加载中…</div> : null}

        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          <StatCard label="活跃订阅" value={String(summary?.subscriptionsActive ?? 0)} sub={`试用中 ${summary?.trialingUsers ?? 0}`} />
          <StatCard label="待处理订单" value={String(summary?.pendingOrders ?? 0)} sub={`退款待处理 ${summary?.refundsPending ?? 0}`} />
          <StatCard label="风控事件" value={String(summary?.abuseOpen ?? 0)} sub={`用户总数 ${summary?.usersTotal ?? 0}`} />
          <StatCard label="节点健康" value={`${summary?.healthyNodes ?? 0}/${summary?.nodesTotal ?? 0}`} sub={`未解决事故 ${summary?.incidentsOpen ?? 0}`} />
        </div>

        <div
          style={{
            marginTop: 16,
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 16,
            background: 'rgba(15,22,33,0.55)',
            padding: 16,
          }}
        >
          <div style={{ fontWeight: 850 }}>快速发放交付</div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.72 }}>
            用于给已开通或试用中的用户分配区域和设备上限；如果已有生效交付，会先自动回收旧记录。
          </div>
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '160px 1fr 140px 140px 120px', gap: 10 }}>
            <input value={assignUserId} onChange={(e) => setAssignUserId(e.target.value)} placeholder="用户 ID" style={inputStyle} />
            <input value={assignRegion} onChange={(e) => setAssignRegion(e.target.value)} placeholder="区域，例如 us-west" style={inputStyle} />
            <input value={assignDeviceLimit} onChange={(e) => setAssignDeviceLimit(e.target.value)} placeholder="设备数" style={inputStyle} />
            <input value={assignRegionLimit} onChange={(e) => setAssignRegionLimit(e.target.value)} placeholder="区域数" style={inputStyle} />
            <button
              type="button"
              disabled={!!actionBusy || !assignUserId.trim() || !assignRegion.trim()}
              style={miniBtnStyle(true)}
              onClick={async () => {
                await postJson(
                  '/api/admin/deliveries/assign',
                  {
                    userId: Number(assignUserId),
                    region: assignRegion.trim(),
                    deviceLimit: Number(assignDeviceLimit || 3),
                    regionLimit: Number(assignRegionLimit || 2),
                  },
                  'delivery-assign',
                )
                setAssignUserId('')
                setAssignRegion('')
              }}
            >
              发放
            </button>
          </div>
        </div>

        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 14 }}>
          <TableCard title="订阅列表" subtitle={`展示前 12 条，当前共 ${subscriptions?.total ?? 0} 条`}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle}>用户</th>
                  <th style={thStyle}>账号</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>试用到期</th>
                  <th style={thStyle}>正式到期</th>
                  <th style={thStyle}>交付</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {(subscriptions?.items || []).map((item) => (
                  <tr key={`${item.userId}-${item.updatedAt || 0}`} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={tdStyle}>{item.email}</td>
                    <td style={tdStyle}>{item.userStatus}</td>
                    <td style={tdStyle}>{item.status}</td>
                    <td style={tdStyle}>{fmtTs(item.trialEndsAt)}</td>
                    <td style={tdStyle}>{fmtTs(item.currentPeriodEnd)}</td>
                    <td style={tdStyle}>{item.activeDeliveryRegion || '-'}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          disabled={!!actionBusy}
                          style={miniBtnStyle(item.status === 'suspended')}
                          onClick={() =>
                            void postJson(
                              item.status === 'suspended' ? `/api/admin/subscriptions/${item.userId}/resume` : `/api/admin/subscriptions/${item.userId}/suspend`,
                              { reason: item.status === 'suspended' ? 'admin_resume' : 'admin_suspend' },
                              `sub-${item.userId}`,
                            )
                          }
                        >
                          {item.status === 'suspended' ? '恢复订阅' : '暂停订阅'}
                        </button>
                        <button
                          type="button"
                          disabled={!!actionBusy}
                          style={miniDangerBtnStyle(item.userStatus !== 'disabled')}
                          onClick={() =>
                            void postJson(
                              item.userStatus === 'disabled' ? `/api/admin/users/${item.userId}/unban` : `/api/admin/users/${item.userId}/ban`,
                              { reason: item.userStatus === 'disabled' ? 'admin_unban' : 'abuse_detected' },
                              `user-${item.userId}`,
                            )
                          }
                        >
                          {item.userStatus === 'disabled' ? '解除封禁' : '封禁账号'}
                        </button>
                        <button
                          type="button"
                          disabled={!!actionBusy || (!item.activeDeliveryId && !(item.status === 'active' || item.status === 'trialing'))}
                          style={miniBtnStyle(!!item.activeDeliveryId)}
                          onClick={() =>
                            void postJson(
                              item.activeDeliveryId ? `/api/admin/deliveries/${item.activeDeliveryId}/revoke` : '/api/admin/deliveries/assign',
                              item.activeDeliveryId
                                ? { reason: 'admin_revoke' }
                                : { userId: item.userId, region: item.activeDeliveryRegion || 'us-west', deviceLimit: 3, regionLimit: 2 },
                              `delivery-${item.userId}`,
                            )
                          }
                        >
                          {item.activeDeliveryId ? '回收交付' : '发放交付'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && (!subscriptions?.items || subscriptions.items.length === 0) ? (
                  <tr>
                    <td style={tdStyle} colSpan={7}>
                      暂无订阅数据
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableCard>

          <TableCard title="风控事件" subtitle="注册滥用、异常流量、投诉和封禁记录入口">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle}>分类</th>
                  <th style={thStyle}>严重度</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>时间</th>
                </tr>
              </thead>
              <tbody>
                {abuseItems.slice(0, 8).map((item) => (
                  <tr key={item.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={tdStyle}>{item.category || '-'}</td>
                    <td style={tdStyle}>{item.severity || '-'}</td>
                    <td style={tdStyle}>{item.status || '-'}</td>
                    <td style={tdStyle}>{fmtTs(item.createdAt)}</td>
                  </tr>
                ))}
                {!loading && abuseItems.length === 0 ? (
                  <tr>
                    <td style={tdStyle} colSpan={4}>
                      暂无风控事件
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableCard>
        </div>

        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <TableCard title="支持工单" subtitle="支付、交付、退款和故障请求统一入口">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle}>用户</th>
                  <th style={thStyle}>分类</th>
                  <th style={thStyle}>标题</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {tickets.slice(0, 8).map((item) => (
                  <tr key={item.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} title={item.content}>
                    <td style={tdStyle}>{item.email}</td>
                    <td style={tdStyle}>{item.category}</td>
                    <td style={tdStyle}>{item.subject}</td>
                    <td style={tdStyle}>{item.status}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          disabled={!!actionBusy}
                          style={miniBtnStyle(item.status === 'in_progress')}
                          onClick={() =>
                            void postJson(
                              `/api/admin/support/tickets/${item.id}/status`,
                              {
                                status: item.status === 'open' ? 'in_progress' : 'resolved',
                                adminNote: item.status === 'open' ? '已受理，正在排查。' : '已处理完成，请用户确认。',
                              },
                              `ticket-${item.id}`,
                            )
                          }
                        >
                          {item.status === 'open' ? '开始处理' : '标记解决'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && tickets.length === 0 ? (
                  <tr>
                    <td style={tdStyle} colSpan={5}>
                      暂无支持工单
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableCard>

          <TableCard title="节点库存" subtitle="这里只看库存和健康，不放用户配置细节">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle}>区域</th>
                  <th style={thStyle}>供应商</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>承载</th>
                  <th style={thStyle}>成本</th>
                </tr>
              </thead>
              <tbody>
                {nodes.slice(0, 10).map((item) => (
                  <tr key={item.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={tdStyle}>{item.region || '-'}</td>
                    <td style={tdStyle}>{item.provider || '-'}</td>
                    <td style={tdStyle}>{item.status || '-'}</td>
                    <td style={tdStyle}>
                      {item.activeUsers}/{item.capacityLimit}
                    </td>
                    <td style={tdStyle}>{fmtMoney(item.costMonthlyCents)}</td>
                  </tr>
                ))}
                {!loading && nodes.length === 0 ? (
                  <tr>
                    <td style={tdStyle} colSpan={5}>
                      暂无节点库存数据
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableCard>

          <TableCard title="事故公告" subtitle="面向运营和平台的公告索引，可继续接状态页">
            <div
              style={{
                marginBottom: 14,
                padding: 12,
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.03)',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 850 }}>新建公告</div>
              <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                <input
                  value={incidentTitle}
                  onChange={(e) => setIncidentTitle(e.target.value)}
                  placeholder="标题，例如：US-West 区域交付抖动"
                  style={inputStyle}
                />
                <div style={{ display: 'grid', gridTemplateColumns: '140px 160px 1fr', gap: 10 }}>
                  <select value={incidentSeverity} onChange={(e) => setIncidentSeverity(e.target.value)} style={inputStyle}>
                    <option value="minor">minor</option>
                    <option value="major">major</option>
                    <option value="critical">critical</option>
                  </select>
                  <select value={incidentStatus} onChange={(e) => setIncidentStatus(e.target.value)} style={inputStyle}>
                    <option value="investigating">investigating</option>
                    <option value="identified">identified</option>
                    <option value="monitoring">monitoring</option>
                    <option value="resolved">resolved</option>
                  </select>
                  <button
                    type="button"
                    disabled={!!actionBusy || !incidentTitle.trim()}
                    style={miniBtnStyle(true)}
                    onClick={async () => {
                      await postJson(
                        '/api/admin/status/incidents',
                        {
                          title: incidentTitle.trim(),
                          severity: incidentSeverity,
                          status: incidentStatus,
                          messageMd: incidentMessage.trim(),
                          scope: { audience: 'public-status' },
                        },
                        'incident-create',
                      )
                      setIncidentTitle('')
                      setIncidentMessage('')
                      setIncidentSeverity('minor')
                      setIncidentStatus('investigating')
                    }}
                  >
                    创建公告
                  </button>
                </div>
                <textarea
                  value={incidentMessage}
                  onChange={(e) => setIncidentMessage(e.target.value)}
                  placeholder="补充影响范围、已知症状和下一次更新时间。"
                  style={{ ...inputStyle, minHeight: 90, paddingTop: 10, resize: 'vertical' }}
                />
              </div>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle}>标题</th>
                  <th style={thStyle}>严重度</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {incidents.slice(0, 8).map((item) => (
                  <tr key={item.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={tdStyle}>{item.title || '-'}</td>
                    <td style={tdStyle}>{item.severity || '-'}</td>
                    <td style={tdStyle}>{item.status || '-'}</td>
                    <td style={tdStyle}>{fmtTs(item.updatedAt)}</td>
                  </tr>
                ))}
                {!loading && incidents.length === 0 ? (
                  <tr>
                    <td style={tdStyle} colSpan={4}>
                      暂无事故公告
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableCard>
        </div>
      </div>
    </AdminLayout>
  )
}

const thStyle: CSSProperties = { textAlign: 'left', padding: '10px 12px', opacity: 0.75, fontWeight: 850 }
const tdStyle: CSSProperties = { padding: '10px 12px', color: 'rgba(255,255,255,0.9)' }
const inputStyle: CSSProperties = {
  width: '100%',
  minHeight: 40,
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  color: 'rgba(255,255,255,0.92)',
  padding: '0 12px',
  outline: 'none',
}
function miniBtnStyle(active: boolean): CSSProperties {
  return {
    height: 30,
    padding: '0 10px',
    borderRadius: 10,
    border: active ? '1px solid rgba(124,92,255,0.55)' : '1px solid rgba(255,255,255,0.12)',
    background: active ? 'rgba(124,92,255,0.14)' : 'rgba(255,255,255,0.04)',
    cursor: 'pointer',
    color: 'rgba(255,255,255,0.92)',
    fontSize: 12,
    fontWeight: 800,
  }
}
function miniDangerBtnStyle(active: boolean): CSSProperties {
  return {
    height: 30,
    padding: '0 10px',
    borderRadius: 10,
    border: active ? '1px solid rgba(255,120,120,0.28)' : '1px solid rgba(255,255,255,0.12)',
    background: active ? 'rgba(255,120,120,0.08)' : 'rgba(255,255,255,0.04)',
    cursor: 'pointer',
    color: 'rgba(255,255,255,0.92)',
    fontSize: 12,
    fontWeight: 800,
  }
}
