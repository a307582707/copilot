// Force cache bust - v20260213-002
import { useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Tabs, type TabItem } from '../../ui/Tabs'
import { BigDataConsole } from './core/BigDataConsole'
import { AssetLedgerPage } from './core/AssetLedgerPage'
import { AssetOverviewPage } from './core/AssetOverviewPage'
import { StarRocksClustersPage } from './core/StarRocksClustersPage'
import { AssetTable } from './components/AssetTable'
import { AssetFilter, applyAssetFilter, defaultFilterState, type AssetFilterState } from './components/AssetFilter'
import { BatchOperations } from './components/BatchOperations'
import { AssetDrawer } from './components/AssetDrawer'
import { AssetSummaryDashboard, type AssetSummary } from './components/AssetSummaryDashboard'
import { ImportDialog } from './components/ImportDialog'
import { ToastContainer, type ToastOptions } from '../../ui/Toast'

type OpsWorkspaceProps = {
  embedded?: boolean
}

type BigDataItem = {
  instance: {
    id: string
    component_key: string
    component_label?: string
    name: string
    env?: string
    region?: string
    enabled?: boolean
    updated_at?: number
    source?: string
    resource_type?: string
    lifecycle_status?: string
    alert_24h?: number
  }
  snapshot?: {
    ts?: number
    ok?: boolean | null
    status?: string
    summary?: string
  } | null
}

type AssetFormData = {
  id?: string
  component_key: string
  name: string
  env: string
  region: string
  role_arn: string
  config: string
  enabled: boolean
}

type AssetChange = {
  id: string | number
  assetId: string
  assetName: string
  resourceType: string
  componentKey?: string
  eventType: string
  eventTime?: number | null
  region?: string
  env?: string
  source?: string
  remark?: string
}

function OpsAssets() {
  const nav = useNavigate()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [items, setItems] = useState<BigDataItem[]>([])
  const [summary, setSummary] = useState<AssetSummary | null>(null)
  const [recentChanges, setRecentChanges] = useState<AssetChange[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<AssetFilterState>(defaultFilterState)
  const [showFilter, setShowFilter] = useState(false)
  const [activeCategory, setActiveCategory] = useState<'all' | 'host' | 'bigdata'>('all')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerData, setDrawerData] = useState<Partial<AssetFormData> | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastOptions[]>([])

  function addToast(message: string, tone: 'success' | 'error' | 'warning' | 'info' = 'info') {
    const id = `toast-${Date.now()}`
    setToasts((prev) => [...prev, { id, message, tone, duration: 3000 }])
  }

  function removeToast(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  async function load() {
    setErr('')
    setLoading(true)
    try {
      const [itemsResp, summaryResp, changesResp] = await Promise.all([
        fetch('/api/aiops/components_public', { credentials: 'include' }),
        fetch('/api/aiops/assets/summary', { credentials: 'include' }),
        fetch('/api/aiops/assets/changes?limit=8', { credentials: 'include' }),
      ])
      const itemsJson = (await itemsResp.json().catch(() => ({}))) as any
      const summaryJson = (await summaryResp.json().catch(() => ({}))) as any
      const changesJson = (await changesResp.json().catch(() => ({}))) as any
      if (!itemsResp.ok) throw new Error(itemsJson?.detail || `HTTP ${itemsResp.status}`)
      if (!summaryResp.ok) throw new Error(summaryJson?.detail || `HTTP ${summaryResp.status}`)
      if (!changesResp.ok) throw new Error(changesJson?.detail || `HTTP ${changesResp.status}`)
      const rows = Array.isArray(itemsJson.items) ? (itemsJson.items as BigDataItem[]) : []
      setItems(rows)
      setSummary(summaryJson as AssetSummary)
      setRecentChanges(Array.isArray(changesJson.items) ? (changesJson.items as AssetChange[]) : [])
    } catch (e: any) {
      setErr(`加载失败：${String(e?.message || e)}`)
      setItems([])
      setSummary(null)
      setRecentChanges([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function filterByCategory(items: BigDataItem[], category: 'all' | 'host' | 'bigdata'): BigDataItem[] {
    if (category === 'all') return items

    const categoryMap = {
      host: ['ecs', 'host', 'server'],
      bigdata: ['flink', 'starrocks', 'dataworks', 'dlf', 'actiontrail', 'cms_rule', 'network'],
    }

    const keys = categoryMap[category] || []
    return items.filter((it) => keys.includes(it.instance.component_key))
  }

  const categoryFiltered = useMemo(() => filterByCategory(items, activeCategory), [items, activeCategory])
  const filteredItems = useMemo(() => applyAssetFilter(categoryFiltered, filter), [categoryFiltered, filter])

  const categoryCounts = useMemo(
    () => ({
      all: items.length,
      host: filterByCategory(items, 'host').length,
      bigdata: filterByCategory(items, 'bigdata').length,
    }),
    [items],
  )

  const categoryTabs: TabItem[] = useMemo(
    () => [
      { id: 'all', label: `全部 (${categoryCounts.all})` },
      { id: 'host', label: `主机 (${categoryCounts.host})` },
      { id: 'bigdata', label: `大数据 (${categoryCounts.bigdata})` },
    ],
    [categoryCounts],
  )

  const moduleTabs: TabItem[] = useMemo(
    () => [
      { id: 'assets', label: '平台组件' },
      { id: 'ledger', label: '资产台账' },
    ],
    [],
  )

  const topTypes = useMemo(() => (summary?.byType || []).slice(0, 5), [summary])
  const topRegions = useMemo(() => (summary?.byRegion || []).slice(0, 5), [summary])

  function handleCategoryChange(newCategory: string) {
    setActiveCategory(newCategory as 'all' | 'host' | 'bigdata')
    setSelectedIds(new Set()) // 切换分类时清空选择，避免混乱
  }

  async function handleSubmitAsset(data: AssetFormData) {
    setSubmitting(true)
    try {
      const payload = {
        id: data.id || undefined,
        componentKey: data.component_key,
        name: data.name,
        env: data.env,
        region: data.region,
        roleArn: data.role_arn,
        config: JSON.parse(data.config || '{}'),
        enabled: data.enabled,
      }
      const resp = await fetch('/api/aiops/components/instances/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      const j = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(j?.detail || `HTTP ${resp.status}`)
      addToast(data.id ? '资产更新成功' : '资产创建成功', 'success')
      setDrawerOpen(false)
      void load()
    } catch (e: any) {
      addToast(`操作失败：${String(e?.message || e)}`, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleImportAssets(assets: any[]) {
    let success = 0
    let failed = 0
    for (const a of assets) {
      try {
        const payload = {
          componentKey: a.component_key,
          name: a.name,
          env: a.env,
          region: a.region,
          roleArn: a.role_arn || '',
          config: {},
          enabled: a.enabled,
        }
        const resp = await fetch('/api/aiops/components/instances/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        success++
      } catch {
        failed++
      }
    }
    addToast(`导入完成：成功 ${success} 项，失败 ${failed} 项`, failed > 0 ? 'warning' : 'success')
    void load()
  }

  function handleBatchDelete() {
    if (selectedIds.size === 0) return
    const confirmed = window.confirm(`确定删除选中的 ${selectedIds.size} 项资产吗？此操作不可撤销。`)
    if (!confirmed) return
    addToast('批量删除功能需要后端API支持（POST /api/aiops/components/instances/batch_delete），当前为演示模式。', 'warning')
    setSelectedIds(new Set())
  }

  function handleBatchEnableDisable() {
    if (selectedIds.size === 0) return
    addToast('批量启用/禁用功能需要后端API支持，当前为演示模式。', 'warning')
  }

  function handleExport() {
    if (selectedIds.size === 0) {
      addToast('请先选择要导出的资产', 'warning')
      return
    }
    const selected = items.filter((it) => selectedIds.has(it.instance.id))
    const csv = [
      'id,component_key,name,env,region,enabled',
      ...selected.map((it) =>
        [it.instance.id, it.instance.component_key, it.instance.name, it.instance.env || '', it.instance.region || '', it.instance.enabled ? 'true' : 'false'].join(
          ',',
        ),
      ),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `assets_export_${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    addToast(`已导出 ${selected.length} 项资产`, 'success')
  }

  return (
    <div>
      <div
        style={{
          padding: 12,
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: 14,
          marginBottom: 18,
          boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)',
        }}
      >
        <Tabs
          items={moduleTabs}
          value="assets"
          onChange={(id) => {
            if (id === 'ledger') nav('/app/assets/ledger')
          }}
          ariaLabel="资产模块"
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <div style={{ fontWeight: 950, fontSize: 20, letterSpacing: 0.2 }}>资产管理（平台组件）</div>
          <div style={{ marginTop: 8, opacity: 0.72, fontSize: 13 }}>展示已接入的平台组件清单与最新快照。</div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button variant="ghost" onClick={() => setShowFilter(!showFilter)}>
            {showFilter ? '隐藏过滤器' : '高级过滤'}
          </Button>
          <Button variant="ghost" onClick={load} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </Button>
          <Button variant="ghost" onClick={() => setImportOpen(true)}>
            批量导入
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setDrawerData(undefined)
              setDrawerOpen(true)
            }}
          >
            新建资产
          </Button>
        </div>
      </div>

      <div
        style={{
          padding: 12,
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: 14,
          marginBottom: 18,
          boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)',
        }}
      >
        <Tabs items={categoryTabs} value={activeCategory} onChange={handleCategoryChange} ariaLabel="资产分类" />
      </div>

      {err ? <div style={{ marginTop: 12, color: 'rgba(255,140,140,0.95)' }}>{err}</div> : null}

      <AssetSummaryDashboard summary={summary} fallbackTotal={items.length} />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12, marginBottom: 18 }}>
        <Card style={{ padding: 16 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>类型分布</div>
          {topTypes.length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.72 }}>暂无类型统计</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {topTypes.map((row) => (
                <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 800 }}>{row.label || row.componentKey || row.key}</div>
                    <div style={{ fontSize: 11, opacity: 0.62, marginTop: 2 }}>{row.key}</div>
                  </div>
                  <div style={{ fontWeight: 900 }}>{row.count}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card style={{ padding: 16 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>最近变化</div>
          {recentChanges.length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.72 }}>暂无变化记录</div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {recentChanges.map((row) => (
                <div key={String(row.id)} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 800 }}>{row.assetName || row.assetId}</div>
                    <div style={{ marginTop: 2, fontSize: 11, opacity: 0.62 }}>
                      {row.eventType} · {row.resourceType || '-'} · {row.region || '-'}
                    </div>
                    {row.remark ? <div style={{ marginTop: 4, fontSize: 12, opacity: 0.74 }}>{row.remark}</div> : null}
                  </div>
                  <div style={{ flexShrink: 0, fontSize: 11, opacity: 0.62 }}>
                    {row.eventTime ? new Date(row.eventTime * 1000).toLocaleString('zh-CN') : '-'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: -6, marginBottom: 18, fontSize: 12, opacity: 0.68 }}>
        刷新策略：{summary?.refreshStrategy?.note || '优先读取资产域模型；若未接入，则回退到 SaaS 内置组件实例表。'}
        {topRegions.length > 0 ? ` 当前主要区域：${topRegions.map((row) => `${row.key}(${row.count})`).join('，')}` : ''}
      </div>

      {showFilter ? (
        <Card style={{ marginTop: 0, marginBottom: 18, padding: 16, boxShadow: '0 12px 28px rgba(15, 23, 42, 0.07)' }}>
          <AssetFilter items={items} filter={filter} onChange={setFilter} onReset={() => setFilter(defaultFilterState)} />
        </Card>
      ) : null}

      {loading ? (
        <div style={{ marginTop: showFilter ? 0 : 18, opacity: 0.75 }}>加载中…</div>
      ) : (
        <div style={{ marginTop: showFilter ? 0 : 18 }}>
          <AssetTable items={filteredItems} selectedIds={selectedIds} onSelectIds={setSelectedIds} />
        </div>
      )}

      <BatchOperations
        selectedCount={selectedIds.size}
        onEnableDisable={handleBatchEnableDisable}
        onDelete={handleBatchDelete}
        onExport={handleExport}
        onClearSelection={() => setSelectedIds(new Set())}
      />

      <AssetDrawer open={drawerOpen} initialData={drawerData} onClose={() => setDrawerOpen(false)} onSubmit={handleSubmitAsset} submitting={submitting} />

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={handleImportAssets} />

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  )
}

export function OpsWorkspace(props: OpsWorkspaceProps) {
  // embedded prop is kept for backward compatibility; layout handled by outer shell.
  void props
  return (
    <Routes>
      <Route path="assets" element={<OpsAssets />} />
      <Route path="assets/ledger" element={<AssetLedgerPage />} />
      <Route path="assets/overview" element={<AssetOverviewPage />} />
      <Route path="assets/starrocks" element={<StarRocksClustersPage />} />
      <Route path="assets/console/:instanceId" element={<BigDataConsole />} />

      <Route path="ops" element={<Navigate to="/app/assets" replace />} />
      <Route path="ops/assets" element={<Navigate to="/app/assets" replace />} />
      <Route path="ops/ledger" element={<Navigate to="/app/assets/ledger" replace />} />
      <Route path="ops/starrocks" element={<Navigate to="/app/assets/starrocks" replace />} />
      <Route path="ops/console/:instanceId" element={<BigDataConsole />} />

      <Route path="*" element={<Navigate to="/app/assets" replace />} />
    </Routes>
  )
}


