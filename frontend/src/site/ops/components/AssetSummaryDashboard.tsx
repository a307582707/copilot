import { Card } from '../../../ui/Card'

export type AssetSummary = {
  resources?: {
    total?: number
    healthy?: number
    warning?: number
    error?: number
    unknown?: number
    missing?: number
  }
  domains?: {
    bigdata?: number
    host?: number
    network?: number
    other?: number
  }
  byType?: Array<{ key: string; componentKey?: string; label?: string; count: number }>
  byRegion?: Array<{ key: string; count: number }>
  byEnv?: Array<{ key: string; count: number }>
  lastSyncAt?: number | null
  refreshStrategy?: {
    mode?: string
    source?: string
    writable?: boolean
    note?: string
  }
}

export function AssetSummaryDashboard({ summary, fallbackTotal = 0 }: { summary: AssetSummary | null; fallbackTotal?: number }) {
  const cards = [
    { title: '总资产', value: summary?.resources?.total ?? fallbackTotal, hint: `大数据 ${summary?.domains?.bigdata ?? 0} · 主机 ${summary?.domains?.host ?? 0}` },
    { title: '健康', value: summary?.resources?.healthy ?? 0, hint: `异常 ${((summary?.resources?.warning ?? 0) || 0) + ((summary?.resources?.error ?? 0) || 0)}` },
    { title: '缺失/漂移', value: summary?.resources?.missing ?? 0, hint: `未知 ${summary?.resources?.unknown ?? 0}` },
    {
      title: '最近同步',
      value: summary?.lastSyncAt ? new Date(summary.lastSyncAt * 1000).toLocaleString('zh-CN') : '-',
      hint: summary?.refreshStrategy?.mode === 'jenkins_to_mysql_readonly' ? 'Jenkins 定时写库，页面只读消费' : '当前回退到 SaaS 内置组件实例表',
    },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 18 }}>
      {cards.map((card) => (
        <Card key={card.title} style={{ padding: 16 }}>
          <div style={{ fontSize: 12, opacity: 0.72 }}>{card.title}</div>
          <div style={{ marginTop: 8, fontSize: card.title === '最近同步' ? 14 : 24, fontWeight: 950, lineHeight: 1.3 }}>{card.value}</div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7, lineHeight: 1.6 }}>{card.hint}</div>
        </Card>
      ))}
    </div>
  )
}
