import { useEffect, useState } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import { AdminLayout } from './AdminLayout'
import './AdminHome.css'

export function AdminHome() {
  return (
    <AdminLayout>
      <div className="adminHome">
        <div style={{ fontSize: 28, fontWeight: 850 }}>后台管理</div>
        <div style={{ marginTop: 10, opacity: 0.75 }}>
          目标：统计用户数量、查看 Beta 额度消耗、处理人工补发和异常用户。
        </div>

        <div className="adminHomeGrid">
          <aside
            className="adminHomeSide"
            style={{
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 16,
              background: 'rgba(15,22,33,0.55)',
              padding: 12,
            }}
          >
            <Nav to="/admin" label="总览（统计）" />
            <Nav to="/admin/users" label="用户列表" />
            <Nav to="/admin/beta" label="Beta 费用闸门" />
            <Nav to="/admin/orders" label="人工入账记录" />
            <Nav to="/admin/ledger" label="额度流水" />
            <Nav to="/admin/overseas" label="海外订阅运营" />
          </aside>

          <section
            className="adminHomeMain"
            style={{
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 16,
              background: 'rgba(15,22,33,0.55)',
              padding: 16,
              minHeight: 360,
            }}
          >
            <Routes>
              <Route
                path="/"
                element={
                  <AdminDashboard />
                }
              />
              <Route path="/users" element={<AdminUsers />} />
              <Route path="/beta" element={<AdminBetaOps />} />
              <Route path="/orders" element={<AdminRechargeOrders />} />
              <Route path="/ledger" element={<AdminLedger />} />
            </Routes>
          </section>
        </div>
      </div>
    </AdminLayout>
  )
}

type AdminStatsResp = {
  ok: boolean
  users_total?: number
  subscriptions_active?: number
  trial_expiring?: number
  note?: string
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
      <div style={{ marginTop: 6, fontSize: 22, fontWeight: 900, letterSpacing: 0.2 }}>{props.value}</div>
      {props.sub ? <div style={{ marginTop: 6, fontSize: 12, opacity: 0.62 }}>{props.sub}</div> : null}
    </div>
  )
}

function AdminDashboard() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<AdminStatsResp | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/admin/stats', { headers: { Accept: 'application/json' }, credentials: 'include' })
        if (!r.ok) {
          const t = await r.text().catch(() => '')
          if (!cancelled) setErr(t ? `加载失败：${t}` : '加载失败')
          return
        }
        const j = (await r.json().catch(() => null)) as AdminStatsResp | null
        if (!cancelled) setData(j)
      } catch (e: any) {
        if (!cancelled) setErr(`网络异常：${String(e?.message || e)}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div>
      <div style={{ fontWeight: 900 }}>总览（统计）</div>
      <div style={{ marginTop: 10, opacity: 0.78, lineHeight: 1.8, fontSize: 14 }}>
        内测阶段先做最小统计：用户总数等；后续接入订单/流水后再补收入与转化。
      </div>

      {loading ? <div style={{ marginTop: 12, opacity: 0.75 }}>加载中…</div> : null}
      {err ? (
        <div style={{ marginTop: 12, color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{err}</div>
      ) : null}

      {data?.ok ? (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <StatCard label="用户总数" value={String(data.users_total ?? 0)} sub={data.note ? `备注：${data.note}` : ''} />
          <StatCard label="活跃试用/订阅" value={String(data.subscriptions_active ?? 0)} />
          <StatCard label="试用即将到期" value={String(data.trial_expiring ?? 0)} sub="（可后续按 T-1 统计）" />
        </div>
      ) : null}
    </div>
  )
}

type AdminUsersResp = {
  ok: boolean
  items?: Array<{ id: number; identifier: string; role: string; disabled: boolean; trial_end_at?: string | null }>
  page?: number
  page_size?: number
  total?: number
  note?: string
}

type RechargeOrder = {
  id: string
  user_id: number
  channel: string
  amount_cents: number
  status: string
  note?: string | null
  created_at: number
  submitted_at?: number | null
  credited_at?: number | null
}

type AdminRechargeOrdersResp = { ok: boolean; orders?: RechargeOrder[] }

type LedgerItem = {
  id: string
  user_id: number
  email?: string
  entry_type: string
  amount_cents: number
  period?: string | null
  ref_id?: string | null
  created_at: number
}

type AdminLedgerResp = { ok: boolean; items?: LedgerItem[] }

type AdminBetaOverviewResp = {
  ok: boolean
  enabled: boolean
  initialCreditCents: number
  usersTotal: number
  betaUsers: number
  activeUsersToday: number
  siteDailyBudgetCents: number
  siteDailySpendCents: number
  siteDailyRemainingCents: number
  topUsersToday?: Array<{ userId: number; email: string; spendCents: number }>
}

function fmtCny(cents: number | undefined | null) {
  return `¥${(Number(cents || 0) / 100).toFixed(2)}`
}

function fmtTs(ts: number | undefined | null) {
  if (!ts) return '-'
  const d = new Date(Number(ts) * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function AdminUsers() {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<AdminUsersResp | null>(null)

  async function setUserDisabled(userId: number, disabled: boolean) {
    setErr(null)
    try {
      const action = disabled ? 'ban' : 'unban'
      const r = await fetch(`/api/admin/users/${userId}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: disabled ? 'beta_cost_control' : 'beta_resume' }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j?.ok) throw new Error((j && (j.detail || j.error)) || '操作失败')
      await load(page, q)
    } catch (e: any) {
      setErr(`操作失败：${String(e?.message || e)}`)
    }
  }

  async function load(p: number, query: string) {
    setErr(null)
    setLoading(true)
    try {
      const sp = new URLSearchParams()
      if (query.trim()) sp.set('q', query.trim())
      sp.set('page', String(p))
      sp.set('page_size', '20')
      const r = await fetch(`/api/admin/users?${sp.toString()}`, { headers: { Accept: 'application/json' }, credentials: 'include' })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setErr(t ? `加载失败：${t}` : '加载失败')
        return
      }
      const j = (await r.json().catch(() => null)) as AdminUsersResp | null
      setData(j)
    } catch (e: any) {
      setErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(page, q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  return (
    <div>
      <div style={{ fontWeight: 900 }}>用户列表</div>
      <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索：手机号/邮箱/用户名"
          style={{
            height: 36,
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.04)',
            padding: '0 12px',
            outline: 'none',
            minWidth: 260,
            color: 'rgba(255,255,255,0.92)',
          }}
        />
        <button
          type="button"
          onClick={() => {
            setPage(1)
            load(1, q)
          }}
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
          搜索
        </button>
        <Link to="/admin" style={{ opacity: 0.8, textDecoration: 'underline' }}>
          返回总览
        </Link>
      </div>

      {loading ? <div style={{ marginTop: 12, opacity: 0.75 }}>加载中…</div> : null}
      {err ? <div style={{ marginTop: 12, color: 'rgba(255,140,140,0.95)' }}>{err}</div> : null}

      {data?.ok ? (
        <>
          <div style={{ marginTop: 12, opacity: 0.72, fontSize: 13 }}>
            共 {data.total ?? 0} 条{data.note ? `（${data.note}）` : ''}
          </div>
          <div style={{ marginTop: 10, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle}>ID</th>
                  <th style={thStyle}>账号</th>
                  <th style={thStyle}>角色</th>
                  <th style={thStyle}>禁用</th>
                  <th style={thStyle}>试用到期</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {(data.items || []).map((u) => (
                  <tr key={u.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={tdStyle}>{String(u.id)}</td>
                    <td style={tdStyle}>{u.identifier}</td>
                    <td style={tdStyle}>{u.role}</td>
                    <td style={tdStyle}>{u.disabled ? '是' : '否'}</td>
                    <td style={tdStyle}>{u.trial_end_at ? u.trial_end_at.slice(0, 19).replace('T', ' ') : '-'}</td>
                    <td style={tdStyle}>
                      <button type="button" onClick={() => setUserDisabled(u.id, !u.disabled)} style={pagerBtn(false)}>
                        {u.disabled ? '恢复' : '暂停'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              style={pagerBtn(page <= 1)}
            >
              上一页
            </button>
            <div style={{ opacity: 0.75, fontSize: 13 }}>
              第 {page} 页
            </div>
            <button
              type="button"
              disabled={(page * 20) >= (data.total ?? 0)}
              onClick={() => setPage((p) => p + 1)}
              style={pagerBtn((page * 20) >= (data.total ?? 0))}
            >
              下一页
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

const thStyle: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', opacity: 0.75, fontWeight: 850 }
const tdStyle: React.CSSProperties = { padding: '10px 12px', color: 'rgba(255,255,255,0.9)' }

function AdminBetaOps() {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [data, setData] = useState<AdminBetaOverviewResp | null>(null)
  const [grantUserId, setGrantUserId] = useState('')
  const [grantAmount, setGrantAmount] = useState('3000')

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const r = await fetch('/api/admin/beta/overview', { headers: { Accept: 'application/json' }, credentials: 'include' })
      const j = (await r.json().catch(() => null)) as AdminBetaOverviewResp | null
      if (!r.ok || !j?.ok) throw new Error((j as any)?.detail || '加载失败')
      setData(j)
      if (j.initialCreditCents && grantAmount === '3000') setGrantAmount(String(j.initialCreditCents))
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  async function grant() {
    const uid = Number(grantUserId)
    const amount = Number(grantAmount)
    if (!uid || !amount) {
      setErr('请输入用户 ID 和补发额度')
      return
    }
    setLoading(true)
    setErr('')
    try {
      const r = await fetch('/api/admin/beta/grant', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: uid, amountCents: amount, reason: 'beta_manual_grant' }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j?.ok) throw new Error((j && (j.detail || j.error)) || '补发失败')
      setGrantUserId('')
      await load()
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div>
      <div style={{ fontWeight: 900 }}>Beta 费用闸门</div>
      <div style={{ marginTop: 10, opacity: 0.78, lineHeight: 1.8, fontSize: 14 }}>
        用于每天值守：看全站预算、活跃用户和 Top 消耗用户；必要时补发额度或在用户列表暂停账号。
      </div>
      <button type="button" onClick={load} style={{ ...pagerBtn(false), marginTop: 12 }}>刷新</button>
      {loading ? <div style={{ marginTop: 12, opacity: 0.75 }}>加载中…</div> : null}
      {err ? <div style={{ marginTop: 12, color: 'rgba(255,140,140,0.95)' }}>{err}</div> : null}
      {data?.ok ? (
        <>
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <StatCard label="Beta 模式" value={data.enabled ? '已开启' : '未开启'} sub={`初始额度 ${fmtCny(data.initialCreditCents)}`} />
            <StatCard label="今日全站预算" value={fmtCny(data.siteDailyBudgetCents)} sub={`已用 ${fmtCny(data.siteDailySpendCents)}，剩余 ${fmtCny(data.siteDailyRemainingCents)}`} />
            <StatCard label="今日活跃用户" value={String(data.activeUsersToday)} sub={`Beta 用户 ${data.betaUsers}/${data.usersTotal}`} />
          </div>

          <div style={{ marginTop: 16, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: 12 }}>
            <div style={{ fontWeight: 850 }}>人工补发 Beta 额度</div>
            <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={grantUserId}
                onChange={(e) => setGrantUserId(e.target.value)}
                placeholder="用户 ID"
                style={{ height: 34, borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: 'white', padding: '0 10px' }}
              />
              <input
                value={grantAmount}
                onChange={(e) => setGrantAmount(e.target.value)}
                placeholder="额度（分）"
                style={{ height: 34, borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: 'white', padding: '0 10px' }}
              />
              <button type="button" onClick={grant} disabled={loading} style={pagerBtn(loading)}>补发</button>
            </div>
          </div>

          <div style={{ marginTop: 16, fontWeight: 850 }}>今日 Top 消耗用户</div>
          <div style={{ marginTop: 10, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle}>用户</th>
                  <th style={thStyle}>邮箱</th>
                  <th style={thStyle}>今日消耗</th>
                </tr>
              </thead>
              <tbody>
                {(data.topUsersToday || []).map((u) => (
                  <tr key={u.userId} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={tdStyle}>{u.userId}</td>
                    <td style={tdStyle}>{u.email || '-'}</td>
                    <td style={tdStyle}>{fmtCny(u.spendCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(data.topUsersToday || []).length === 0 ? <div style={{ marginTop: 12, opacity: 0.72 }}>今日暂无模型消耗</div> : null}
        </>
      ) : null}
    </div>
  )
}

function AdminRechargeOrders() {
  const [status, setStatus] = useState('submitted')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [orders, setOrders] = useState<RechargeOrder[]>([])

  async function load(nextStatus = status) {
    setLoading(true)
    setErr('')
    try {
      const sp = new URLSearchParams()
      if (nextStatus) sp.set('status', nextStatus)
      const r = await fetch(`/api/admin/recharge_orders?${sp.toString()}`, { headers: { Accept: 'application/json' }, credentials: 'include' })
      const j = (await r.json().catch(() => null)) as AdminRechargeOrdersResp | null
      if (!r.ok || !j?.ok) throw new Error((j as any)?.detail || '加载失败')
      setOrders(j.orders || [])
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  async function credit(orderId: string) {
    setErr('')
    try {
      const r = await fetch('/api/admin/pay/manual/credit', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j?.ok) throw new Error((j && (j.detail || j.error)) || '入账失败')
      await load(status)
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  useEffect(() => {
    load(status)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div>
      <div style={{ fontWeight: 900 }}>人工入账记录</div>
      <div style={{ marginTop: 10, opacity: 0.78, lineHeight: 1.8, fontSize: 14 }}>
        Beta 阶段不公开收费；这里仅保留历史人工入账记录和内部核对能力。
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            load(e.target.value)
          }}
          style={{ height: 36, borderRadius: 12, padding: '0 10px' }}
        >
          <option value="">全部</option>
          <option value="submitted">待入账</option>
          <option value="credited">已入账</option>
          <option value="rejected">已拒绝</option>
        </select>
        <button type="button" onClick={() => load(status)} style={pagerBtn(false)}>刷新</button>
      </div>
      {loading ? <div style={{ marginTop: 12, opacity: 0.75 }}>加载中…</div> : null}
      {err ? <div style={{ marginTop: 12, color: 'rgba(255,140,140,0.95)' }}>{err}</div> : null}
      <div style={{ marginTop: 10, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 760 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
              <th style={thStyle}>订单</th>
              <th style={thStyle}>用户</th>
              <th style={thStyle}>渠道</th>
              <th style={thStyle}>金额</th>
              <th style={thStyle}>状态</th>
              <th style={thStyle}>创建时间</th>
              <th style={thStyle}>操作</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <td style={tdStyle}>{o.id}</td>
                <td style={tdStyle}>{o.user_id}</td>
                <td style={tdStyle}>{o.channel}</td>
                <td style={tdStyle}>{fmtCny(o.amount_cents)}</td>
                <td style={tdStyle}>{o.status}</td>
                <td style={tdStyle}>{fmtTs(o.created_at)}</td>
                <td style={tdStyle}>
                  <a href={`/api/admin/pay/manual/proof/${o.id}`} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>查看凭证</a>
                  {o.status === 'submitted' ? <button type="button" onClick={() => credit(o.id)} style={pagerBtn(false)}>入账</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && orders.length === 0 ? <div style={{ marginTop: 12, opacity: 0.72 }}>暂无订单</div> : null}
    </div>
  )
}

function AdminLedger() {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [items, setItems] = useState<LedgerItem[]>([])

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const r = await fetch('/api/admin/ledger', { headers: { Accept: 'application/json' }, credentials: 'include' })
      const j = (await r.json().catch(() => null)) as AdminLedgerResp | null
      if (!r.ok || !j?.ok) throw new Error((j as any)?.detail || '加载失败')
      setItems(j.items || [])
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <div>
      <div style={{ fontWeight: 900 }}>额度流水</div>
      <div style={{ marginTop: 10, opacity: 0.78, lineHeight: 1.8, fontSize: 14 }}>
        展示最近的 Beta 额度发放、人工补发和模型额度扣减记录，便于每日值守。
      </div>
      <button type="button" onClick={load} style={{ ...pagerBtn(false), marginTop: 12 }}>刷新</button>
      {loading ? <div style={{ marginTop: 12, opacity: 0.75 }}>加载中…</div> : null}
      {err ? <div style={{ marginTop: 12, color: 'rgba(255,140,140,0.95)' }}>{err}</div> : null}
      <div style={{ marginTop: 10, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 760 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
              <th style={thStyle}>时间</th>
              <th style={thStyle}>用户</th>
              <th style={thStyle}>类型</th>
              <th style={thStyle}>金额</th>
              <th style={thStyle}>周期</th>
              <th style={thStyle}>引用</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <td style={tdStyle}>{fmtTs(it.created_at)}</td>
                <td style={tdStyle}>{it.email || it.user_id}</td>
                <td style={tdStyle}>{it.entry_type}</td>
                <td style={tdStyle}>{fmtCny(it.amount_cents)}</td>
                <td style={tdStyle}>{it.period || '-'}</td>
                <td style={tdStyle}>{it.ref_id || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && items.length === 0 ? <div style={{ marginTop: 12, opacity: 0.72 }}>暂无流水</div> : null}
    </div>
  )
}

function pagerBtn(disabled: boolean): React.CSSProperties {
  return {
    height: 34,
    padding: '0 12px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.03)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontWeight: 800,
  }
}

function Nav(props: { to: string; label: string }) {
  return (
    <Link
      to={props.to}
      style={{
        display: 'block',
        padding: '10px 10px',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(255,255,255,0.03)',
        marginBottom: 10,
      }}
    >
      {props.label}
    </Link>
  )
}

