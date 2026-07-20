import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AdminInspectionsPage } from './AdminInspectionsPage'

type IncidentRow = {
  id: string
  status: string
  severity: string
  title: string
  fingerprint: string
  source?: string | null
  started_at?: number | null
  last_event_at?: number | null
  updated_at?: number | null
}

type IncidentsResp = { ok: boolean; items?: IncidentRow[] }

type IncidentDetailResp = {
  ok: boolean
  incident?: any
  events?: any[]
  evidence?: any[]
  actions?: any[]
}

function fmtTs(ts?: number | null) {
  if (!ts) return '-'
  try {
    return new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ')
  } catch {
    return String(ts)
  }
}

function sevBadge(sev: string) {
  const s = (sev || '').toLowerCase()
  if (s === 'critical') return { label: 'CRIT', bg: 'rgba(255,77,109,0.14)', bd: 'rgba(255,77,109,0.35)' }
  if (s === 'warn') return { label: 'WARN', bg: 'rgba(255,170,120,0.12)', bd: 'rgba(255,170,120,0.32)' }
  return { label: 'INFO', bg: 'rgba(255,255,255,0.05)', bd: 'rgba(255,255,255,0.10)' }
}

export function AdminAIOpsPage() {
  const [sp, setSp] = useSearchParams()
  const initialTab = String(sp.get('tab') || 'incidents')
  const [tab, setTab] = useState<'incidents' | 'inspections' | 'settings'>(
    initialTab === 'inspections' ? 'inspections' : initialTab === 'settings' ? 'settings' : 'incidents',
  )

  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [items, setItems] = useState<IncidentRow[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [detail, setDetail] = useState<IncidentDetailResp | null>(null)
  const [toast, setToast] = useState<string>('')
  const [metrics, setMetrics] = useState<any>(null)
  const [metricsErr, setMetricsErr] = useState<string>('')

  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsErr, setSettingsErr] = useState<string>('')
  const [gitlabUrl, setGitlabUrl] = useState('')
  const [gitlabProject, setGitlabProject] = useState('')
  const [gitlabRef, setGitlabRef] = useState('codesprite')
  const [gitlabTokenConfigured, setGitlabTokenConfigured] = useState(false)
  const [gitlabTokenMasked, setGitlabTokenMasked] = useState('')
  const [gitlabTriggerTokenInput, setGitlabTriggerTokenInput] = useState('')
  const [reportTokenConfigured, setReportTokenConfigured] = useState(false)
  const [ingestTokenConfigured, setIngestTokenConfigured] = useState(false)

  async function loadList() {
    setErr(null)
    setLoading(true)
    try {
      const r = await fetch('/api/aiops/incidents?limit=80', { credentials: 'include' })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setErr(t ? `加载失败：${t}` : '加载失败')
        return
      }
      const j = (await r.json().catch(() => null)) as IncidentsResp | null
      const rows = (j?.items || []).filter(Boolean) as IncidentRow[]
      setItems(rows)
      if (!activeId && rows[0]?.id) setActiveId(rows[0].id)
    } catch (e: any) {
      setErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setLoading(false)
    }
  }

  async function loadDetail(id: string) {
    const incId = String(id || '').trim()
    if (!incId) return
    setDetailErr(null)
    setDetailLoading(true)
    try {
      const r = await fetch(`/api/aiops/incidents/${encodeURIComponent(incId)}`, { credentials: 'include' })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setDetailErr(t ? `加载失败：${t}` : '加载失败')
        return
      }
      const j = (await r.json().catch(() => null)) as IncidentDetailResp | null
      setDetail(j)
    } catch (e: any) {
      setDetailErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setDetailLoading(false)
    }
  }

  useEffect(() => {
    if (tab === 'incidents') loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  async function loadMetrics() {
    setMetricsErr('')
    try {
      const r = await fetch('/api/aiops/metrics', { credentials: 'include' })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setMetricsErr(t ? `指标加载失败：${t}` : '指标加载失败')
        return
      }
      const j = (await r.json().catch(() => null)) as any
      setMetrics(j?.metrics || null)
    } catch (e: any) {
      setMetricsErr(`指标网络异常：${String(e?.message || e)}`)
    }
  }

  async function injectTestAlert() {
    setToast('')
    try {
      const payload = {
        source: 'admin_test',
        title: 'TestAlert:HostDown',
        severity: 'critical',
        description: 'MVP test alert injected from /admin/aiops',
        labels: { env: 'staging', service: 'nginx', scope: 'demo' },
        annotations: { runbook: '/docs/aiops/runbook' },
        startsAt: Math.floor(Date.now() / 1000),
      }
      const r = await fetch('/api/aiops/alerts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setToast(t ? `注入失败：${t}` : '注入失败')
        return
      }
      setToast('已注入测试告警')
      await loadList()
    } catch (e: any) {
      setToast(`注入异常：${String(e?.message || e)}`)
    }
  }

  useEffect(() => {
    if (!activeId) return
    loadDetail(activeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const active = useMemo(() => items.find((x) => x.id === activeId) || null, [items, activeId])

  async function loadSettings() {
    setSettingsErr('')
    setSettingsLoading(true)
    try {
      const r = await fetch('/api/aiops/settings', { credentials: 'include' })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setSettingsErr(t || '加载失败')
        return
      }
      const j = JSON.parse(t || '{}')
      setGitlabUrl(String(j?.gitlab?.url || ''))
      setGitlabProject(String(j?.gitlab?.project || ''))
      setGitlabRef(String(j?.gitlab?.ref || 'codesprite'))
      setGitlabTokenConfigured(Boolean(j?.gitlab?.triggerTokenConfigured))
      setGitlabTokenMasked(String(j?.gitlab?.triggerTokenMasked || ''))
      setReportTokenConfigured(Boolean(j?.tokens?.reportTokenConfigured))
      setIngestTokenConfigured(Boolean(j?.tokens?.ingestTokenConfigured))
    } catch (e: any) {
      setSettingsErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setSettingsLoading(false)
    }
  }

  useEffect(() => {
    if (tab !== 'settings') return
    loadSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  async function saveSettings() {
    setToast('')
    setSettingsErr('')
    setSettingsLoading(true)
    try {
      const payload = {
        gitlab: {
          url: gitlabUrl.trim(),
          project: gitlabProject.trim(),
          ref: gitlabRef.trim() || 'codesprite',
          triggerToken: gitlabTriggerTokenInput.trim(),
        },
      }
      const r = await fetch('/api/aiops/settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setSettingsErr(t || '保存失败')
        return
      }
      setToast('已保存设置')
      setGitlabTriggerTokenInput('')
      await loadSettings()
    } catch (e: any) {
      setSettingsErr(`保存异常：${String(e?.message || e)}`)
    } finally {
      setSettingsLoading(false)
    }
  }

  function setTabAndSync(next: 'incidents' | 'inspections' | 'settings') {
    setTab(next)
    const nsp = new URLSearchParams(sp)
    nsp.set('tab', next)
    setSp(nsp, { replace: true })
  }

  return (
    <div>
      <div style={{ fontWeight: 900 }}>智能运维（AIOps）</div>
      <div style={{ marginTop: 10, opacity: 0.78, lineHeight: 1.8, fontSize: 14 }}>
        V1：故障闭环 + 自动化巡检 + 执行通道（GitLab CI）配置。
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => setTabAndSync('incidents')}
          style={{
            height: 34,
            padding: '0 12px',
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.10)',
            background: tab === 'incidents' ? 'rgba(124,92,255,0.12)' : 'rgba(255,255,255,0.03)',
            cursor: 'pointer',
            fontWeight: 900,
          }}
        >
          故障
        </button>
        <button
          type="button"
          onClick={() => setTabAndSync('inspections')}
          style={{
            height: 34,
            padding: '0 12px',
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.10)',
            background: tab === 'inspections' ? 'rgba(124,92,255,0.12)' : 'rgba(255,255,255,0.03)',
            cursor: 'pointer',
            fontWeight: 900,
          }}
        >
          自动化巡检
        </button>
        <button
          type="button"
          onClick={() => setTabAndSync('settings')}
          style={{
            height: 34,
            padding: '0 12px',
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.10)',
            background: tab === 'settings' ? 'rgba(124,92,255,0.12)' : 'rgba(255,255,255,0.03)',
            cursor: 'pointer',
            fontWeight: 900,
          }}
        >
          设置
        </button>
      </div>

      {tab === 'inspections' ? (
        <div style={{ marginTop: 12 }}>
          <AdminInspectionsPage />
        </div>
      ) : null}

      {tab === 'settings' ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 900 }}>执行通道（GitLab CI）</div>
          <div style={{ marginTop: 10, opacity: 0.78, lineHeight: 1.8, fontSize: 14 }}>
            AIOps 管理巡检生命周期；CI 只负责执行并回传 report。敏感字段不会在页面回显。
          </div>

          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, background: 'rgba(0,0,0,0.14)', padding: 12 }}>
              <div style={{ fontWeight: 850, marginBottom: 10 }}>GitLab 全局配置</div>
              <div style={{ display: 'grid', gap: 10 }}>
                <Field label="GitLab URL（可选）">
                  <input value={gitlabUrl} onChange={(e) => setGitlabUrl(e.target.value)} placeholder="https://gitlab.example.com" style={inpStyle} />
                </Field>
                <Field label="Project（必填，示例：develop/copilot）">
                  <input value={gitlabProject} onChange={(e) => setGitlabProject(e.target.value)} placeholder="develop/copilot" style={inpStyle} />
                </Field>
                <Field label="Ref（分支/Tag）">
                  <input value={gitlabRef} onChange={(e) => setGitlabRef(e.target.value)} placeholder="codesprite" style={inpStyle} />
                </Field>
                <Field label={`Trigger Token（不回显，已配置：${gitlabTokenConfigured ? '是' : '否'}）`}>
                  <input
                    value={gitlabTriggerTokenInput}
                    onChange={(e) => setGitlabTriggerTokenInput(e.target.value)}
                    placeholder={gitlabTokenConfigured ? `留空表示不修改（当前：${gitlabTokenMasked || '***'}）` : '粘贴 Trigger Token（保存后不回显）'}
                    style={inpStyle}
                  />
                </Field>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button type="button" onClick={saveSettings} style={btnPrimary}>
                    保存
                  </button>
                  <button type="button" onClick={loadSettings} style={btn}>
                    重新加载
                  </button>
                </div>
              </div>

              {settingsLoading ? <div style={{ marginTop: 10, opacity: 0.75 }}>处理中…</div> : null}
              {settingsErr ? <div style={{ marginTop: 10, color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{settingsErr}</div> : null}
            </div>

            <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, background: 'rgba(0,0,0,0.14)', padding: 12 }}>
              <div style={{ fontWeight: 850, marginBottom: 10 }}>Token 状态</div>
              <div style={{ fontSize: 13, opacity: 0.78, lineHeight: 1.8 }}>
                - Report Token（CI 回传）：{reportTokenConfigured ? '已配置' : '未配置'}（环境变量 `AIOPS_REPORT_TOKEN`）\n
                - Ingest Token（外部告警）：{ingestTokenConfigured ? '已配置' : '未配置'}（环境变量 `AIOPS_INGEST_TOKEN`）\n
              </div>
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72 }}>
                说明：token 不在此页面生成/回显；请通过服务器 `/app/.env` 配置，页面只展示是否已启用。
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {tab !== 'incidents' ? null : (
        <>
          <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" onClick={loadList} style={btn}>
              刷新
            </button>
            <div style={{ opacity: 0.65, fontSize: 12 }}>Ingest webhook：`POST /api/aiops/alerts`（建议配 `AIOPS_INGEST_TOKEN`）</div>
            <button type="button" onClick={injectTestAlert} style={btnPrimary} title="用管理员会话注入一条测试告警（staging/nginx）">
              注入测试告警
            </button>
            <button type="button" onClick={loadMetrics} style={btn}>
              刷新指标
            </button>
          </div>

          {toast ? <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>{toast}</div> : null}

          {metricsErr ? <div style={{ marginTop: 10, color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{metricsErr}</div> : null}
          {metrics ? (
            <div style={{ marginTop: 10, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, background: 'rgba(0,0,0,0.14)', padding: 12 }}>
              <div style={{ fontWeight: 850, marginBottom: 8 }}>核心指标（MVP）</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.03)' }}>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>MTTD(avg)</div>
                  <div style={{ marginTop: 6, fontSize: 16, fontWeight: 900 }}>{metrics.mttd_avg_sec ? `${metrics.mttd_avg_sec}s` : '-'}</div>
                </div>
                <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.03)' }}>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>MTTR(avg)</div>
                  <div style={{ marginTop: 6, fontSize: 16, fontWeight: 900 }}>{metrics.mttr_avg_sec ? `${metrics.mttr_avg_sec}s` : '-'}</div>
                </div>
                <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.03)' }}>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>证据完整率</div>
                  <div style={{ marginTop: 6, fontSize: 16, fontWeight: 900 }}>
                    {typeof metrics.evidence_completeness === 'number' ? `${Math.round(metrics.evidence_completeness * 100)}%` : '-'}
                  </div>
                </div>
                <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.03)' }}>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>Autopilot 成功率</div>
                  <div style={{ marginTop: 6, fontSize: 16, fontWeight: 900 }}>
                    {typeof metrics.autopilot_success === 'number' ? `${Math.round(metrics.autopilot_success * 100)}%` : '-'}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {loading ? <div style={{ marginTop: 12, opacity: 0.75 }}>加载中…</div> : null}
          {err ? <div style={{ marginTop: 12, color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{err}</div> : null}

          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '340px 1fr', gap: 12, minHeight: 420 }}>
        <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', opacity: 0.75, fontSize: 12 }}>
            Incidents（{items.length}）
          </div>
          <div style={{ maxHeight: 520, overflow: 'auto' }}>
            {items.map((it) => {
              const s = sevBadge(it.severity)
              const activeRow = it.id === activeId
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setActiveId(it.id)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: 10,
                    border: 'none',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                    background: activeRow ? 'rgba(124,92,255,0.12)' : 'transparent',
                    cursor: 'pointer',
                    color: 'rgba(255,255,255,0.92)',
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '2px 8px',
                        borderRadius: 999,
                        border: `1px solid ${s.bd}`,
                        background: s.bg,
                        opacity: 0.95,
                      }}
                    >
                      {s.label}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '2px 8px',
                        borderRadius: 999,
                        border: '1px solid rgba(255,255,255,0.10)',
                        background: 'rgba(0,0,0,0.14)',
                        opacity: 0.9,
                      }}
                    >
                      {it.status}
                    </span>
                  </div>
                  <div style={{ marginTop: 6, fontWeight: 850, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.title}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.source || 'unknown'} · fp={it.fingerprint}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, opacity: 0.65 }}>
                    lastEvent: {fmtTs(it.last_event_at)} · updated: {fmtTs(it.updated_at)}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontWeight: 900, fontSize: 14 }}>{active ? active.title : '选择一个 Incident'}</div>
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
              {active ? `id=${active.id} · status=${active.status} · severity=${active.severity}` : ''}
            </div>
          </div>
          {detailLoading ? <div style={{ padding: 12, opacity: 0.75 }}>加载中…</div> : null}
          {detailErr ? <div style={{ padding: 12, color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{detailErr}</div> : null}

          {detail?.ok ? (
            <div style={{ padding: 12, display: 'grid', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 850, marginBottom: 8 }}>事件（Events）</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {(detail.events || []).slice(0, 20).map((e, idx) => (
                    <div key={String(e?.id || idx)} style={{ border: '1px solid rgba(255,255,255,0.10)', borderRadius: 12, background: 'rgba(0,0,0,0.16)', padding: 10 }}>
                      <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.95 }}>
                        {String(e?.severity || '')} · {String(e?.source || '')} · {String(e?.received_at || '')}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 13 }}>{String(e?.title || '')}</div>
                      {e?.description ? <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78, whiteSpace: 'pre-wrap' }}>{String(e.description)}</div> : null}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 850, marginBottom: 8 }}>证据（Evidence）</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {(detail.evidence || []).slice(0, 20).map((ev, idx) => (
                    <div key={String(ev?.id || idx)} style={{ border: '1px solid rgba(255,255,255,0.10)', borderRadius: 12, background: 'rgba(0,0,0,0.16)', padding: 10 }}>
                      <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.95 }}>
                        {String(ev?.kind || 'text')} · {String(ev?.created_at || '')}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 13 }}>{String(ev?.title || '')}</div>
                      {ev?.content ? (
                        <pre style={{ marginTop: 8, marginBottom: 0, fontSize: 12, opacity: 0.82, whiteSpace: 'pre-wrap' }}>
                          {String(ev.content).slice(0, 6000)}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 850, marginBottom: 8 }}>动作（Actions）</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {(detail.actions || []).slice(0, 20).map((ac, idx) => (
                    <div key={String(ac?.id || idx)} style={{ border: '1px solid rgba(255,255,255,0.10)', borderRadius: 12, background: 'rgba(0,0,0,0.16)', padding: 10 }}>
                      <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.95 }}>
                        {String(ac?.status || '')} · risk={String(ac?.risk || '')} · kind={String(ac?.kind || '')}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 13 }}>{String(ac?.title || '')}</div>
                      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          onClick={async () => {
                            const id = String(ac?.id || '').trim()
                            if (!id) return
                            await fetch(`/api/aiops/actions/${encodeURIComponent(id)}/approve`, { method: 'POST', credentials: 'include' })
                              .catch(() => null)
                            loadDetail(activeId)
                          }}
                          style={{
                            height: 34,
                            padding: '0 12px',
                            borderRadius: 12,
                            border: '1px solid rgba(255,255,255,0.10)',
                            background: 'rgba(255,255,255,0.03)',
                            cursor: 'pointer',
                            fontWeight: 800,
                          }}
                        >
                          批准
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const id = String(ac?.id || '').trim()
                            if (!id) return
                            await fetch(`/api/aiops/actions/${encodeURIComponent(id)}/execute`, { method: 'POST', credentials: 'include' })
                              .catch(() => null)
                            loadDetail(activeId)
                          }}
                          style={{
                            height: 34,
                            padding: '0 12px',
                            borderRadius: 12,
                            border: '1px solid rgba(124,92,255,0.55)',
                            background: 'rgba(124,92,255,0.12)',
                            cursor: 'pointer',
                            fontWeight: 850,
                          }}
                        >
                          执行
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!activeId) return
                      await fetch(`/api/aiops/incidents/${encodeURIComponent(activeId)}/actions/propose`, { method: 'POST', credentials: 'include' }).catch(() => null)
                      loadDetail(activeId)
                    }}
                    style={{
                      height: 34,
                      padding: '0 12px',
                      borderRadius: 12,
                      border: '1px solid rgba(124,92,255,0.55)',
                      background: 'rgba(124,92,255,0.12)',
                      cursor: 'pointer',
                      fontWeight: 850,
                    }}
                  >
                    生成动作建议
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!activeId) return
                      await fetch(`/api/aiops/incidents/${encodeURIComponent(activeId)}/transition`, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'resolved' }),
                      }).catch(() => null)
                      loadList()
                      loadDetail(activeId)
                    }}
                    style={{
                      height: 34,
                      padding: '0 12px',
                      borderRadius: 12,
                      border: '1px solid rgba(56,239,125,0.35)',
                      background: 'rgba(56,239,125,0.10)',
                      cursor: 'pointer',
                      fontWeight: 850,
                    }}
                  >
                    标记已恢复
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 12, opacity: 0.72 }}>暂无详情</div>
          )}
        </div>
          </div>
        </>
      )}
    </div>
  )
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 6 }}>{props.label}</div>
      {props.children}
    </div>
  )
}

const inpStyle: React.CSSProperties = {
  height: 36,
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  padding: '0 12px',
  outline: 'none',
  width: '100%',
  color: 'rgba(255,255,255,0.92)',
}

const btn: React.CSSProperties = {
  height: 34,
  padding: '0 12px',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.03)',
  cursor: 'pointer',
  fontWeight: 850,
}

const btnPrimary: React.CSSProperties = {
  height: 34,
  padding: '0 12px',
  borderRadius: 12,
  border: '1px solid rgba(124,92,255,0.55)',
  background: 'rgba(124,92,255,0.12)',
  cursor: 'pointer',
  fontWeight: 850,
}

