import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../../ui/Button'
import { Card } from '../../../ui/Card'
import { AssetSummaryDashboard, type AssetSummary } from '../components/AssetSummaryDashboard'

type LedgerEntry = {
  key: string
  label: string
  desc: string
  path: string
  ready: boolean
}

const LEDGER_ENTRIES: LedgerEntry[] = [
  { key: 'starrocks', label: 'StarRocks 集群', desc: '集群、计算组、区域与账号维度台账。', path: '/app/assets/starrocks', ready: true },
  { key: 'flink', label: 'Flink 作业', desc: '作业、命名空间和运行状态台账。', path: '/app/assets/flink', ready: false },
  { key: 'dataworks', label: 'DataWorks', desc: '工作空间、任务编排和依赖关系台账。', path: '/app/assets/dataworks', ready: false },
  { key: 'ecs', label: 'ECS 主机', desc: '主机规格、生命周期与健康状态台账。', path: '/app/assets/ecs', ready: false },
  { key: 'oss', label: 'OSS 存储', desc: 'Bucket、容量、地域和访问属性台账。', path: '/app/assets/oss', ready: false },
]

export function AssetLedgerPage() {
  const nav = useNavigate()
  const [summary, setSummary] = useState<AssetSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/aiops/assets/summary', { credentials: 'include' })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setSummary(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div>
      <div style={{ display: 'grid', gap: 18 }}>
        <div>
          <div style={{ fontWeight: 950, fontSize: 20, letterSpacing: 0.2 }}>资产台账</div>
          <div style={{ marginTop: 8, opacity: 0.72, fontSize: 13 }}>按资源类型进入台账视图，适合承接 StarRocks、Flink、DataWorks、ECS、OSS 等统一入口。</div>
        </div>

        <AssetSummaryDashboard summary={summary} />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          {LEDGER_ENTRIES.map((entry) => (
            <Card key={entry.key} style={{ padding: 18, display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>{entry.label}</div>
                <div
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 800,
                    color: entry.ready ? '#0f9f5f' : '#64748b',
                    background: entry.ready ? 'rgba(43, 213, 118, 0.10)' : '#f8fafc',
                    border: entry.ready ? '1px solid rgba(43, 213, 118, 0.18)' : '1px solid #e2e8f0',
                  }}
                >
                  {entry.ready ? '已接入' : '待接入'}
                </div>
              </div>

              <div style={{ minHeight: 40, fontSize: 13, lineHeight: 1.6, opacity: 0.8 }}>{entry.desc}</div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant={entry.ready ? 'primary' : 'ghost'} disabled={!entry.ready} onClick={() => nav(entry.path)}>
                  {entry.ready ? '查看台账' : '规划中'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
