import { Card } from '../../../ui/Card'
import { StatusPill } from '../../../ui/StatusPill'

type NodeRoleSummary = {
  role: string
  total: number
  alive: number
  cpuTotal?: number
  memoryTotalGb?: number
  diskTotalGb?: number
}

type BeNode = {
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
}

type WarehouseDetail = {
  assetId: string
  name: string
  summary?: string
  status?: string
  health?: string
  observedAt?: number | null
  live?: Record<string, any>
  spec?: Record<string, any>
  capacity?: Record<string, any>
  nodeRoleSummary?: NodeRoleSummary[]
  beNodes?: BeNode[]
}

function toneOf(health: string) {
  const x = String(health || '').toLowerCase()
  if (x === 'ok') return 'ok'
  if (x === 'warn' || x === 'error') return 'err'
  return 'neutral'
}

function kvRows(title: string, obj?: Record<string, any>) {
  const rows = Object.entries(obj || {}).filter(([, value]) => value !== null && value !== '' && value !== undefined)
  if (!rows.length) return null
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ fontWeight: 900, marginBottom: 10 }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        {rows.map(([key, value]) => (
          <div key={key} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, opacity: 0.62 }}>{key}</div>
            <div style={{ marginTop: 4, fontSize: 13, fontWeight: 800, wordBreak: 'break-word' }}>{String(value)}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

export function WarehouseSpecPanel(props: { warehouse: WarehouseDetail | null; loading?: boolean }) {
  const { warehouse, loading } = props

  if (loading) {
    return <Card style={{ padding: 16 }}>计算组详情加载中…</Card>
  }
  if (!warehouse) {
    return <Card style={{ padding: 16 }}>请选择左侧计算组查看规格。</Card>
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 950, fontSize: 16 }}>{warehouse.name || warehouse.assetId}</div>
            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>assetId: {warehouse.assetId}</div>
          </div>
          <StatusPill tone={toneOf(String(warehouse.health || ''))}>{warehouse.health || warehouse.status || 'unknown'}</StatusPill>
        </div>
        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.78 }}>{warehouse.summary || '暂无摘要'}</div>
        <div style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, opacity: 0.72 }}>
          <span>{warehouse.observedAt ? `观测时间: ${new Date(warehouse.observedAt * 1000).toLocaleString('zh-CN')}` : '观测时间: -'}</span>
          <span>状态: {warehouse.status || '-'}</span>
        </div>
      </Card>

      {warehouse.nodeRoleSummary?.length ? (
        <Card style={{ padding: 16 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>节点角色汇总</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            {warehouse.nodeRoleSummary.map((row) => (
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
        </Card>
      ) : null}

      {kvRows('运行时指标', warehouse.live)}
      {kvRows('规格信息', warehouse.spec)}
      {kvRows('容量信息', warehouse.capacity)}

      <Card style={{ padding: 16 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>关联 BE 节点</div>
        {!warehouse.beNodes?.length ? (
          <div style={{ fontSize: 12, opacity: 0.72 }}>暂无 BE 节点规格明细</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {warehouse.beNodes.map((node) => (
              <div
                key={node.assetId}
                style={{
                  padding: 12,
                  borderRadius: 12,
                  border: '1px solid #e2e8f0',
                  background: '#ffffff',
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1.4fr) repeat(4, minmax(0, 1fr))',
                  gap: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 850 }}>{node.host || node.assetId}</div>
                  <div style={{ marginTop: 4, fontSize: 11, opacity: 0.62 }}>
                    {node.port ? `:${node.port}` : ''} · {node.version || '-'} · {node.az || '-'}
                  </div>
                </div>
                <div style={{ fontSize: 12, opacity: 0.78 }}>规格: {node.specDisplay || '-'}</div>
                <div style={{ fontSize: 12, opacity: 0.78 }}>CPU: {node.cpuCores || '-'}</div>
                <div style={{ fontSize: 12, opacity: 0.78 }}>内存: {node.memoryGb || '-'} GB</div>
                <div style={{ fontSize: 12, opacity: 0.78 }}>
                  {node.alive === true ? '存活' : node.alive === false ? '异常' : '-'} · {node.diskType || '-'} {node.diskSizeGb || '-'} GB
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
