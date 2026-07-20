import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '../../../ui/Button'
import { Card } from '../../../ui/Card'
import { StatusPill } from '../../../ui/StatusPill'
import { Tabs, type TabItem } from '../../../ui/Tabs'
import { AssetDrawer } from '../components/AssetDrawer'
import { AssetHistory } from '../components/AssetHistory'
import { WarehouseSpecPanel } from '../components/WarehouseSpecPanel'
import { ToastContainer, type ToastOptions } from '../../../ui/Toast'

type BigDataItem = {
  instance: {
    id: string
    component_key: string
    component_label?: string
    name: string
    env?: string
    region?: string
    enabled?: boolean
    created_at?: number
    updated_at?: number
    role_arn?: string
    config_json?: string
    source?: string
    resource_type?: string
    lifecycle_status?: string
    spec_json?: string
    capacity_json?: string
    network_json?: string
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

type StarRocksNodeRoleSummary = {
  role: string
  total: number
  alive: number
  cpuTotal?: number
  memoryTotalGb?: number
  diskTotalGb?: number
}

type StarRocksWarehouseSummary = {
  assetId: string
  name: string
  summary?: string
  status?: string
  health?: string
  observedAt?: number | null
  spec?: Record<string, any>
  capacity?: Record<string, any>
  live?: Record<string, any>
  nodeRoleSummary?: StarRocksNodeRoleSummary[]
  beNodeCount?: number
  nodeCount?: number | string | null
  diskIoPeakPct?: number | string | null
  diskIoAvgPct?: number | string | null
}

type StarRocksClusterDetail = {
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
  spec?: Record<string, any>
  capacity?: Record<string, any>
  network?: Record<string, any>
  nodeRoleSummary?: StarRocksNodeRoleSummary[]
  warehouses?: StarRocksWarehouseSummary[]
  warehouseCount?: number
}

type StarRocksWarehouseDetail = {
  assetId: string
  name: string
  summary?: string
  status?: string
  health?: string
  observedAt?: number | null
  spec?: Record<string, any>
  capacity?: Record<string, any>
  live?: Record<string, any>
  nodeRoleSummary?: StarRocksNodeRoleSummary[]
  beNodes?: Array<{
    assetId: string
    host: string
    port?: number | string | null
    version?: string
    specDisplay?: string
    cpuCores?: number | string | null
    memoryGb?: number | string | null
    diskType?: string
    diskSizeGb?: number | string | null
    az?: string
    alive?: boolean | null
    status?: string
  }>
}

function typeLabel(key: string) {
  const m: Record<string, string> = {
    dataworks: 'DataWorks',
    starrocks: 'StarRocks',
    flink: 'Flink',
    host: '主机',
    cms_rule: 'CMS 规则',
    dlf: 'DLF',
    actiontrail: 'ActionTrail',
    network: 'Network',
  }
  return m[key] || key
}

function healthTone(health: string): 'ok' | 'err' | 'neutral' {
  const x = String(health || '').toLowerCase()
  if (x === 'ok') return 'ok'
  if (x === 'warn' || x === 'error') return 'err'
  return 'neutral'
}

function metricEntries(obj?: Record<string, any>) {
  return Object.entries(obj || {}).filter(([, value]) => value !== null && value !== '' && value !== undefined)
}

export function BigDataConsole() {
  const { instanceId } = useParams()
  const iid = String(instanceId || '').trim()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [item, setItem] = useState<BigDataItem | null>(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [starrocksCluster, setStarrocksCluster] = useState<StarRocksClusterDetail | null>(null)
  const [starrocksLoading, setStarrocksLoading] = useState(false)
  const [selectedWarehouseId, setSelectedWarehouseId] = useState('')
  const [selectedWarehouse, setSelectedWarehouse] = useState<StarRocksWarehouseDetail | null>(null)
  const [warehouseLoading, setWarehouseLoading] = useState(false)
  const [toasts, setToasts] = useState<ToastOptions[]>([])

  function addToast(message: string, tone: 'success' | 'error' | 'warning' | 'info' = 'info') {
    const id = `toast-${Date.now()}`
    setToasts((prev) => [...prev, { id, message, tone, duration: 3000 }])
  }

  function removeToast(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  async function load() {
    if (!iid) return
    setErr('')
    setLoading(true)
    try {
      const resp = await fetch('/api/aiops/components_public', { credentials: 'include' })
      const j = (await resp.json().catch(() => ({}))) as any
      if (!resp.ok) throw new Error(j?.detail || `HTTP ${resp.status}`)
      const rows = Array.isArray(j.items) ? (j.items as BigDataItem[]) : []
      const found = rows.find((x) => String(x?.instance?.id || '').trim() === iid) || null
      if (!found) {
        setErr('未找到该组件实例（可能被删除或无权限）')
        setItem(null)
        return
      }
      setItem(found)
    } catch (e: any) {
      setErr(`加载失败：${String(e?.message || e)}`)
      setItem(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iid])

  useEffect(() => {
    let cancelled = false

    async function loadStarRocksCluster() {
      if (!iid || item?.instance?.resource_type !== 'StarRocks_Cluster') {
        setStarrocksCluster(null)
        setSelectedWarehouse(null)
        setSelectedWarehouseId('')
        return
      }
      setStarrocksLoading(true)
      try {
        const resp = await fetch(`/api/aiops/starrocks/clusters/${encodeURIComponent(iid)}`, { credentials: 'include' })
        const j = (await resp.json().catch(() => ({}))) as any
        if (!resp.ok) throw new Error(j?.detail || `HTTP ${resp.status}`)
        if (cancelled) return
        const cluster = (j?.cluster || null) as StarRocksClusterDetail | null
        setStarrocksCluster(cluster)
        const firstWarehouseId = String(cluster?.warehouses?.[0]?.assetId || '')
        setSelectedWarehouseId((prev) => (prev && cluster?.warehouses?.some((w) => w.assetId === prev) ? prev : firstWarehouseId))
      } catch (e: any) {
        if (!cancelled) {
          setStarrocksCluster(null)
          setSelectedWarehouseId('')
          addToast(`StarRocks 详情加载失败：${String(e?.message || e)}`, 'error')
        }
      } finally {
        if (!cancelled) setStarrocksLoading(false)
      }
    }

    void loadStarRocksCluster()
    return () => {
      cancelled = true
    }
  }, [iid, item?.instance?.resource_type])

  useEffect(() => {
    let cancelled = false

    async function loadWarehouseDetail() {
      if (!selectedWarehouseId) {
        setSelectedWarehouse(null)
        return
      }
      setWarehouseLoading(true)
      try {
        const resp = await fetch(`/api/aiops/starrocks/warehouses/${encodeURIComponent(selectedWarehouseId)}`, { credentials: 'include' })
        const j = (await resp.json().catch(() => ({}))) as any
        if (!resp.ok) throw new Error(j?.detail || `HTTP ${resp.status}`)
        if (!cancelled) setSelectedWarehouse((j?.warehouse || null) as StarRocksWarehouseDetail | null)
      } catch (e: any) {
        if (!cancelled) {
          setSelectedWarehouse(null)
          addToast(`计算组详情加载失败：${String(e?.message || e)}`, 'error')
        }
      } finally {
        if (!cancelled) setWarehouseLoading(false)
      }
    }

    void loadWarehouseDetail()
    return () => {
      cancelled = true
    }
  }, [selectedWarehouseId])

  const meta = useMemo(() => {
    const inst = item?.instance
    if (!inst) return null
    return {
      id: String(inst.id || ''),
      key: String(inst.component_key || ''),
      source: String(inst.source || 'manual'),
      name: String(inst.name || ''),
      env: String(inst.env || ''),
      region: String(inst.region || ''),
      enabled: Boolean(inst.enabled ?? true),
      updatedAt: inst.updated_at ? new Date(Number(inst.updated_at) * 1000).toLocaleString('zh-CN') : '',
      roleArn: String(inst.role_arn || ''),
      configJson: String(inst.config_json || '{}'),
      lifecycleStatus: String(inst.lifecycle_status || ''),
      resourceType: String(inst.resource_type || ''),
      readonly: String(inst.source || '') === 'asset_domain',
    }
  }, [item])

  async function handleTestConnectivity() {
    if (!iid) return
    setTesting(true)
    try {
      const resp = await fetch(`/api/aiops/components/instances/${iid}/test`, {
        method: 'POST',
        credentials: 'include',
      })
      const j = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(j?.detail || `HTTP ${resp.status}`)
      addToast('连通性测试已触发，请刷新查看结果', 'success')
      setTimeout(() => void load(), 2000)
    } catch (e: any) {
      addToast(`测试失败：${String(e?.message || e)}`, 'error')
    } finally {
      setTesting(false)
    }
  }

  async function handleDelete() {
    if (!iid) return
    const confirmed = window.confirm(`确定删除资产"${item?.instance.name || iid}"吗？此操作不可撤销。`)
    if (!confirmed) return
    addToast('删除功能需要后端API支持（DELETE /api/aiops/components/instances/:id），当前为演示模式。', 'warning')
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
      addToast('资产更新成功', 'success')
      setDrawerOpen(false)
      void load()
    } catch (e: any) {
      addToast(`操作失败：${String(e?.message || e)}`, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const tabs: TabItem[] = [
    { id: 'overview', label: '概览' },
    { id: 'history', label: '历史记录' },
  ]

  const isStarRocksCluster = meta?.resourceType === 'StarRocks_Cluster'

  function renderStarRocksClusterOverview() {
    const cluster = starrocksCluster
    if (starrocksLoading && !cluster) {
      return <div style={{ opacity: 0.75 }}>StarRocks 详情加载中…</div>
    }
    if (!cluster) {
      return <Card style={{ padding: 16 }}>未取到 StarRocks 集群详情，可能该资产还没有完整入库。</Card>
    }
    const specRows = metricEntries(cluster.spec)
    const capacityRows = metricEntries(cluster.capacity)
    const networkRows = metricEntries(cluster.network)
    const warehouses = cluster.warehouses || []
    return (
      <div style={{ marginTop: 14, display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 14, alignItems: 'start' }}>
          <div>
            <Card>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>集群概览</div>
              <div style={{ fontSize: 12, opacity: 0.82, lineHeight: 1.8 }}>
                <div>
                  <span style={{ opacity: 0.7 }}>resourceId：</span>
                  {cluster.resourceId || '-'}
                </div>
                <div>
                  <span style={{ opacity: 0.7 }}>账号：</span>
                  {cluster.accountName || '-'}
                </div>
                <div>
                  <span style={{ opacity: 0.7 }}>区域：</span>
                  {cluster.region || '-'}
                </div>
                <div>
                  <span style={{ opacity: 0.7 }}>环境：</span>
                  {cluster.env || '-'}
                </div>
                <div>
                  <span style={{ opacity: 0.7 }}>健康度：</span>
                  <StatusPill tone={healthTone(cluster.health)}>{cluster.health || cluster.status || 'unknown'}</StatusPill>
                </div>
                <div>
                  <span style={{ opacity: 0.7 }}>生命周期：</span>
                  {cluster.lifecycleStatus || '-'}
                </div>
                <div>
                  <span style={{ opacity: 0.7 }}>24h 告警：</span>
                  {cluster.alert24h}
                </div>
                <div>
                  <span style={{ opacity: 0.7 }}>观测时间：</span>
                  {cluster.observedAt ? new Date(cluster.observedAt * 1000).toLocaleString('zh-CN') : '-'}
                </div>
                <div>
                  <span style={{ opacity: 0.7 }}>计算组：</span>
                  {cluster.warehouseCount || warehouses.length}
                </div>
              </div>
              <div style={{ marginTop: 12, fontSize: 12, opacity: 0.74 }}>{cluster.summary || '暂无摘要'}</div>
            </Card>

            <Card style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>节点角色汇总</div>
              {!cluster.nodeRoleSummary?.length ? (
                <div style={{ fontSize: 12, opacity: 0.72 }}>暂无节点数据</div>
              ) : (
                <div style={{ display: 'grid', gap: 10 }}>
                  {cluster.nodeRoleSummary.map((row) => (
                    <div key={row.role} style={{ padding: 12, borderRadius: 12, border: '1px solid #e2e8f0', background: '#ffffff' }}>
                      <div style={{ fontSize: 12, opacity: 0.68 }}>{row.role}</div>
                      <div style={{ marginTop: 6, fontWeight: 950, fontSize: 20 }}>
                        {row.alive}/{row.total}
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
                        CPU {row.cpuTotal || 0} · 内存 {row.memoryTotalGb || 0} GB · 磁盘 {row.diskTotalGb || 0} GB
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div style={{ display: 'grid', gap: 12 }}>
            <Card>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>集群配置摘要</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, opacity: 0.68, marginBottom: 6 }}>规格</div>
                  {!specRows.length ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无</div> : specRows.map(([k, v]) => <div key={k} style={{ fontSize: 12, lineHeight: 1.8 }}>{k}: {String(v)}</div>)}
                </div>
                <div>
                  <div style={{ fontSize: 12, opacity: 0.68, marginBottom: 6 }}>容量</div>
                  {!capacityRows.length ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无</div> : capacityRows.map(([k, v]) => <div key={k} style={{ fontSize: 12, lineHeight: 1.8 }}>{k}: {String(v)}</div>)}
                </div>
                <div>
                  <div style={{ fontSize: 12, opacity: 0.68, marginBottom: 6 }}>网络</div>
                  {!networkRows.length ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无</div> : networkRows.map(([k, v]) => <div key={k} style={{ fontSize: 12, lineHeight: 1.8 }}>{k}: {String(v)}</div>)}
                </div>
              </div>
            </Card>

            <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12, alignItems: 'start' }}>
              <Card>
                <div style={{ fontWeight: 900, marginBottom: 10 }}>计算组列表</div>
                {!warehouses.length ? (
                  <div style={{ fontSize: 12, opacity: 0.72 }}>暂无计算组</div>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {warehouses.map((warehouse) => {
                      const active = warehouse.assetId === selectedWarehouseId
                      return (
                        <button
                          key={warehouse.assetId}
                          type="button"
                          onClick={() => setSelectedWarehouseId(warehouse.assetId)}
                          style={{
                            textAlign: 'left',
                            padding: 12,
                            borderRadius: 12,
                            border: active ? '1px solid rgba(124,92,255,0.16)' : '1px solid #e2e8f0',
                            background: active ? 'rgba(124,92,255,0.05)' : '#ffffff',
                            cursor: 'pointer',
                            color: 'inherit',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <div style={{ fontWeight: 850 }}>{warehouse.name || warehouse.assetId}</div>
                            <StatusPill tone={healthTone(String(warehouse.health || ''))}>{warehouse.health || warehouse.status || 'unknown'}</StatusPill>
                          </div>
                          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.64 }}>
                            node_count {warehouse.nodeCount ?? '-'} · BE {warehouse.beNodeCount ?? 0}
                          </div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.72 }}>
                            RunningSQL {warehouse.live?.runningSql ?? '-'} · QueuedSQL {warehouse.live?.queuedSql ?? '-'}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </Card>

              <WarehouseSpecPanel warehouse={selectedWarehouse} loading={warehouseLoading} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 950, fontSize: 18 }}>组件控制台</div>
          <div style={{ marginTop: 6, opacity: 0.72, fontSize: 13 }}>
            {meta ? (
              <>
                {typeLabel(meta.key)} · {meta.name} · {meta.region || '-'} · {meta.env || '-'}
              </>
            ) : (
              '—'
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isStarRocksCluster ? (
            <Link to="/app/assets/starrocks" style={{ opacity: 0.85, textDecoration: 'underline' }}>
              返回 StarRocks 集群
            </Link>
          ) : null}
          <Link to="/app/assets" style={{ opacity: 0.85, textDecoration: 'underline' }}>
            返回资产台账
          </Link>
          <Button variant="ghost" onClick={load} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </Button>
        </div>
      </div>

      {err ? <div style={{ marginTop: 12, color: 'rgba(255,140,140,0.95)' }}>{err}</div> : null}

      {loading ? <div style={{ marginTop: 12, opacity: 0.75 }}>加载中…</div> : null}

      {meta ? (
        <>
          <div style={{ marginTop: 14 }}>
            <Tabs items={tabs} value={activeTab} onChange={setActiveTab} />
          </div>

          {activeTab === 'overview' ? (
            isStarRocksCluster ? (
              renderStarRocksClusterOverview()
            ) : (
              <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '360px 1fr', gap: 14, alignItems: 'start' }}>
                <div>
                  <Card>
                    <div style={{ fontWeight: 900, marginBottom: 10 }}>实例信息</div>
                    <div style={{ fontSize: 12, opacity: 0.82, lineHeight: 1.8 }}>
                      <div>
                        <span style={{ opacity: 0.7 }}>ID：</span>
                        {meta.id}
                      </div>
                      <div>
                        <span style={{ opacity: 0.7 }}>类型：</span>
                        {typeLabel(meta.key)}
                      </div>
                      <div>
                        <span style={{ opacity: 0.7 }}>区域：</span>
                        {meta.region || '-'}
                      </div>
                      <div>
                        <span style={{ opacity: 0.7 }}>环境：</span>
                        {meta.env || '-'}
                      </div>
                      <div>
                        <span style={{ opacity: 0.7 }}>启用：</span>
                        {meta.enabled ? '是' : '否'}
                      </div>
                      <div>
                        <span style={{ opacity: 0.7 }}>来源：</span>
                        {meta.readonly ? '动态资产域模型（只读）' : 'SaaS 手工维护实例'}
                      </div>
                      {meta.lifecycleStatus ? (
                        <div>
                          <span style={{ opacity: 0.7 }}>生命周期：</span>
                          {meta.lifecycleStatus}
                        </div>
                      ) : null}
                      <div>
                        <span style={{ opacity: 0.7 }}>最后更新：</span>
                        {meta.updatedAt || '-'}
                      </div>
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {!meta.readonly ? (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(true)}>
                            编辑
                          </Button>
                          <Button variant="danger" size="sm" onClick={handleDelete}>
                            删除
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </Card>

                  <Card style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 900, marginBottom: 10 }}>连通性快照</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {(() => {
                        const ok = item?.snapshot?.ok
                        if (ok === true) return <StatusPill tone="ok">正常</StatusPill>
                        if (ok === false) return <StatusPill tone="err">失败</StatusPill>
                        return <StatusPill tone="neutral">未测试</StatusPill>
                      })()}
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        {item?.snapshot?.summary ? String(item.snapshot.summary) : item?.snapshot?.status ? String(item.snapshot.status) : '—'}
                      </div>
                    </div>
                    {!meta.readonly ? (
                      <div style={{ marginTop: 10 }}>
                        <Button variant="primary" size="sm" onClick={handleTestConnectivity} disabled={testing}>
                          {testing ? '测试中…' : '测试连通性'}
                        </Button>
                      </div>
                    ) : null}
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72 }}>
                      {meta.readonly
                        ? '说明：该资产来自 Jenkins 定时发现 + MySQL 资产域模型，当前页面展示最近一次观测结果，不直接在页面内改发现链路。'
                        : '说明：本页先提供统一入口与资产信息；下一步会接入各组件的“列表/指标/受控操作”。'}
                    </div>
                  </Card>
                </div>

                <Card>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>功能区（规划）</div>
                  <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.8 }}>
                    <div>- DataWorks：任务实例、资源组 CU/并发水位</div>
                    <div>- Flink：作业/Deployment 列表与状态、受控启停/Savepoint</div>
                    <div>- StarRocks：SQL 控制台（只读/管理，后端代理+审计）</div>
                  </div>
                </Card>
              </div>
            )
          ) : null}

          {activeTab === 'history' ? (
            <div style={{ marginTop: 14 }}>
              <AssetHistory instanceId={iid} />
            </div>
          ) : null}
        </>
      ) : null}

      <AssetDrawer
        open={drawerOpen}
        initialData={
          meta
            ? {
                id: meta.id,
                component_key: meta.key,
                name: meta.name,
                env: meta.env,
                region: meta.region,
                role_arn: meta.roleArn,
                config: meta.configJson,
                enabled: meta.enabled,
              }
            : undefined
        }
        onClose={() => setDrawerOpen(false)}
        onSubmit={handleSubmitAsset}
        submitting={submitting}
      />

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  )
}
