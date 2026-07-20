import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../../ui/Button'
import { Card } from '../../../ui/Card'
import { StatusPill } from '../../../ui/StatusPill'

type NodeRoleSummary = {
  role: string
  total: number
  alive: number
}

type StarRocksClusterItem = {
  assetId: string
  resourceId: string
  name: string
  accountName?: string
  region: string
  env: string
  lifecycleStatus: string
  observedAt?: number | null
  status: string
  health: string
  alert24h: number
  summary: string
  warehouseCount: number
  nodeRoleSummary: NodeRoleSummary[]
}

type StarRocksFilterOptions = {
  regions: string[]
  accounts: string[]
}

function healthTone(health: string): 'ok' | 'err' | 'neutral' {
  const x = String(health || '').toLowerCase()
  if (x === 'ok') return 'ok'
  if (x === 'warn' || x === 'error') return 'err'
  return 'neutral'
}

function summarizeRoles(rows: NodeRoleSummary[]) {
  if (!rows.length) return '暂无节点明细'
  return rows
    .map((row) => {
      const role = String(row.role || '').toUpperCase() || 'NODE'
      return `${role} ${row.alive}/${row.total}`
    })
    .join(' · ')
}

export function StarRocksClustersPage() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [query, setQuery] = useState('')
  const [input, setInput] = useState('')
  const [regionFilter, setRegionFilter] = useState('')
  const [accountFilter, setAccountFilter] = useState('')
  const [filterOptions, setFilterOptions] = useState<StarRocksFilterOptions>({ regions: [], accounts: [] })
  const [items, setItems] = useState<StarRocksClusterItem[]>([])

  async function load(keyword = query, region = regionFilter, account = accountFilter) {
    setErr('')
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (keyword.trim()) params.set('q', keyword.trim())
      if (region.trim()) params.set('region', region.trim())
      if (account.trim()) params.set('account', account.trim())
      const qs = params.toString() ? `?${params.toString()}` : ''
      const resp = await fetch(`/api/aiops/starrocks/clusters${qs}`, { credentials: 'include' })
      const j = (await resp.json().catch(() => ({}))) as any
      if (!resp.ok) throw new Error(j?.detail || `HTTP ${resp.status}`)
      setItems(Array.isArray(j.items) ? (j.items as StarRocksClusterItem[]) : [])
    } catch (e: any) {
      setErr(`加载失败：${String(e?.message || e)}`)
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    async function loadFilters() {
      try {
        const resp = await fetch('/api/aiops/starrocks/filters', { credentials: 'include' })
        const j = (await resp.json().catch(() => ({}))) as any
        if (!resp.ok) throw new Error(j?.detail || `HTTP ${resp.status}`)
        if (!cancelled) {
          setFilterOptions({
            regions: Array.isArray(j.regions) ? (j.regions as string[]) : [],
            accounts: Array.isArray(j.accounts) ? (j.accounts as string[]) : [],
          })
        }
      } catch {
        if (!cancelled) {
          setFilterOptions({ regions: [], accounts: [] })
        }
      }
    }

    void loadFilters()
    void load('')
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const summary = useMemo(() => {
    const total = items.length
    const healthy = items.filter((it) => String(it.health || '').toLowerCase() === 'ok').length
    const warned = items.filter((it) => ['warn', 'error'].includes(String(it.health || '').toLowerCase())).length
    const warehouses = items.reduce((sum, it) => sum + Number(it.warehouseCount || 0), 0)
    return { total, healthy, warned, warehouses }
  }, [items])

  const cards = [
    { title: '集群总数', value: summary.total, hint: `计算组 ${summary.warehouses}` },
    { title: '健康集群', value: summary.healthy, hint: `异常/告警 ${summary.warned}` },
    { title: '计算组总数', value: summary.warehouses, hint: '来自 StarRocks_Warehouse 资产' },
    {
      title: '当前筛选',
      value: query.trim() || regionFilter || accountFilter || '全部',
      hint: `区域 ${regionFilter || '全部'} · 账号 ${accountFilter || '全部'}`,
    },
  ]

  const selectStyle: CSSProperties = {
    height: 38,
    minWidth: 160,
    borderRadius: 10,
    border: '1px solid #e2e8f0',
    background: '#ffffff',
    padding: '0 12px',
    outline: 'none',
    color: '#0f172a',
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <div style={{ fontWeight: 950, fontSize: 20, letterSpacing: 0.2 }}>StarRocks 集群</div>
          <div style={{ marginTop: 8, opacity: 0.72, fontSize: 13 }}>只展示 `StarRocks_Cluster` 资产，避免把 FE/BE/计算组混进列表。</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} style={selectStyle}>
            <option value="">全部区域</option>
            {filterOptions.regions.map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
          </select>
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)} style={selectStyle}>
            <option value="">全部账号</option>
            {filterOptions.accounts.map((account) => (
              <option key={account} value={account}>
                {account}
              </option>
            ))}
          </select>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="搜索集群名称 / resourceId"
            style={{
              height: 38,
              minWidth: 240,
              borderRadius: 10,
              border: '1px solid #e2e8f0',
              background: '#ffffff',
              padding: '0 12px',
              outline: 'none',
              color: '#0f172a',
            }}
          />
          <Button
            variant="ghost"
            onClick={() => {
              setQuery(input.trim())
              void load(input.trim(), regionFilter, accountFilter)
            }}
          >
            查询
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setInput('')
              setQuery('')
              setRegionFilter('')
              setAccountFilter('')
              void load('', '', '')
            }}
          >
            重置
          </Button>
          <Button variant="ghost" onClick={() => void load(query, regionFilter, accountFilter)} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </Button>
          <Link to="/app/assets" style={{ textDecoration: 'none' }}>
            <Button variant="ghost">返回资产台账</Button>
          </Link>
        </div>
      </div>

      {err ? <div style={{ marginTop: 12, color: 'rgba(255,140,140,0.95)' }}>{err}</div> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 18 }}>
        {cards.map((card) => (
          <Card key={card.title} style={{ padding: 16 }}>
            <div style={{ fontSize: 12, opacity: 0.72 }}>{card.title}</div>
            <div style={{ marginTop: 8, fontSize: 24, fontWeight: 950 }}>{card.value}</div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.68 }}>{card.hint}</div>
          </Card>
        ))}
      </div>

      {loading ? (
        <div style={{ opacity: 0.75 }}>加载中…</div>
      ) : items.length === 0 ? (
        <Card style={{ padding: 18 }}>
          <div style={{ fontWeight: 900 }}>暂无 StarRocks 集群</div>
          <div style={{ marginTop: 8, opacity: 0.72, fontSize: 13 }}>当前页面只读取 `StarRocks_Cluster` 资产。如果发现链路还没把集群写进资产域模型，这里会是空的。</div>
        </Card>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {items.map((item) => (
            <Card key={item.assetId} style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 950, fontSize: 16 }}>{item.name || item.resourceId}</div>
                    <StatusPill tone={healthTone(item.health)}>{item.health || 'unknown'}</StatusPill>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.64 }}>
                    assetId: {item.assetId} · resourceId: {item.resourceId} · 账号 {item.accountName || '-'} · {item.region || '-'} · {item.env || '-'}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 13, opacity: 0.82 }}>{item.summary || '暂无摘要'}</div>
                  <div style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, opacity: 0.74 }}>
                    <span>计算组: {item.warehouseCount}</span>
                    <span>24h 告警: {item.alert24h}</span>
                    <span>节点: {summarizeRoles(item.nodeRoleSummary || [])}</span>
                    <span>{item.observedAt ? `观测时间: ${new Date(item.observedAt * 1000).toLocaleString('zh-CN')}` : '观测时间: -'}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Link to={`/app/assets/console/${item.assetId}`} style={{ textDecoration: 'none' }}>
                    <Button variant="primary">查看详情</Button>
                  </Link>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
