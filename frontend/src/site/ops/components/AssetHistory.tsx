import { useEffect, useState } from 'react'
import { Card } from '../../../ui/Card'
import { StatusPill } from '../../../ui/StatusPill'
import { Button } from '../../../ui/Button'

type SnapshotHistory = {
  id: string
  instance_id: string
  ts: number
  ok: boolean | null
  status: string
  summary: string
}

export function AssetHistory(props: { instanceId: string }) {
  const { instanceId } = props
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [history, setHistory] = useState<SnapshotHistory[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)

  async function load() {
    setErr('')
    setLoading(true)
    try {
      const resp = await fetch(`/api/aiops/components/instances/${encodeURIComponent(instanceId)}/history?page=${page}&limit=20`, { credentials: 'include' })
      const j = (await resp.json().catch(() => ({}))) as any
      if (!resp.ok) throw new Error(j?.detail || `HTTP ${resp.status}`)
      setHistory(Array.isArray(j.items) ? (j.items as SnapshotHistory[]) : [])
      setHasMore(Boolean(j.hasMore))
    } catch (e: any) {
      setErr(`加载失败：${String(e?.message || e)}`)
      setHistory([])
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, page])

  if (loading) return <div style={{ padding: 14, opacity: 0.75 }}>加载中…</div>
  if (err) return <div style={{ padding: 14, color: 'rgba(255,140,140,0.95)' }}>{err}</div>

  return (
    <div>
      {history.length === 0 ? (
        <Card style={{ padding: 14 }}>
          <div style={{ opacity: 0.8, fontSize: 13 }}>暂无历史记录</div>
        </Card>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {history.map((snap) => (
            <Card key={snap.id} style={{ padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {snap.ok === true ? (
                    <StatusPill tone="ok">正常</StatusPill>
                  ) : snap.ok === false ? (
                    <StatusPill tone="err">失败</StatusPill>
                  ) : (
                    <StatusPill tone="neutral">未知</StatusPill>
                  )}
                  <div style={{ fontSize: 12, opacity: 0.75 }}>{snap.summary || snap.status}</div>
                </div>
                <div style={{ fontSize: 11, opacity: 0.65 }}>{new Date(snap.ts * 1000).toLocaleString('zh-CN')}</div>
              </div>
            </Card>
          ))}
          {hasMore ? (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => p + 1)}>
                加载更多
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
