import { useEffect, useMemo, useState } from 'react'

type DefRow = {
  id: string
  name: string
  kind: string
  env_id: string
  enabled: number
  updated_at?: number
}

type RunRow = {
  id: string
  def_id: string
  env_id: string
  status: string
  correlation_id?: string | null
  created_at?: number | null
  started_at?: number | null
  finished_at?: number | null
  ok?: number | null
  summary?: string | null
  error?: string | null
}

function fmtTs(ts?: number | null) {
  if (!ts) return '-'
  try {
    return new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ')
  } catch {
    return String(ts)
  }
}

export function AdminInspectionsPage() {
  const [toast, setToast] = useState<string>('')
  const [hint, setHint] = useState<string>('')
  const [compErr, setCompErr] = useState<string>('')
  const [compLoading, setCompLoading] = useState(false)
  const [instances, setInstances] = useState<any[]>([])
  const [activeInstId, setActiveInstId] = useState<string>('')

  const [instEditing, setInstEditing] = useState(false)
  const [instId, setInstId] = useState<string>('')
  const [instKey, setInstKey] = useState<string>('starrocks')
  const [instName, setInstName] = useState<string>('')
  const [instEnv, setInstEnv] = useState<string>('staging')
  const [instRegion, setInstRegion] = useState<string>('cn-shenzhen')
  const [instRoleArn, setInstRoleArn] = useState<string>('')
  const [instCfg, setInstCfg] = useState<string>('{}')

  const [defs, setDefs] = useState<DefRow[]>([])
  const [defsErr, setDefsErr] = useState<string>('')
  const [defsLoading, setDefsLoading] = useState(false)
  const [activeDefId, setActiveDefId] = useState<string>('')

  const [templateJson, setTemplateJson] = useState<any>(null)
  const [envJsonText, setEnvJsonText] = useState<string>('')

  const [runs, setRuns] = useState<RunRow[]>([])
  const [runsErr, setRunsErr] = useState<string>('')
  const [runsLoading, setRunsLoading] = useState(false)
  const [activeRunId, setActiveRunId] = useState<string>('')
  const [activeRun, setActiveRun] = useState<any>(null)
  const [runDetailErr, setRunDetailErr] = useState<string>('')

  const activeDef = useMemo(() => defs.find((d) => d.id === activeDefId) || null, [defs, activeDefId])

  async function loadComponents() {
    setCompErr('')
    setCompLoading(true)
    try {
      const r = await fetch('/api/aiops/components', { credentials: 'include' })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setCompErr(t || '加载失败')
        return
      }
      const j = JSON.parse(t || '{}')
      const rows = (j?.instances || []).filter(Boolean)
      setInstances(rows)
      if (!activeInstId && rows[0]?.id) setActiveInstId(String(rows[0].id))
    } catch (e: any) {
      setCompErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setCompLoading(false)
    }
  }

  async function loadSettingsHint() {
    setHint('')
    try {
      const r = await fetch('/api/aiops/settings', { credentials: 'include' })
      if (!r.ok) return
      const j = await r.json().catch(() => null)
      const gl = j?.gitlab
      const ok = Boolean(gl?.project) && Boolean(gl?.triggerTokenConfigured)
      if (!ok) {
        setHint('提示：先在“智能运维 → 设置”里配置 GitLab（project/ref/trigger token），才能一键触发 CI 连通性测试。')
      }
    } catch {
      // ignore
    }
  }

  async function loadTemplate() {
    try {
      const r = await fetch('/api/aiops/inspections/templates/example', { credentials: 'include' })
      if (!r.ok) return
      const j = await r.json().catch(() => null)
      const envJson = j?.envJson
      setTemplateJson(envJson || null)
      if (!envJsonText && envJson) setEnvJsonText(JSON.stringify(envJson, null, 2))
    } catch {
      // ignore
    }
  }

  async function loadDefs() {
    setDefsErr('')
    setDefsLoading(true)
    try {
      const r = await fetch('/api/aiops/inspections/defs?limit=80', { credentials: 'include' })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setDefsErr(t || '加载失败')
        return
      }
      const j = JSON.parse(t || '{}')
      const items = (j?.items || []).filter(Boolean) as DefRow[]
      setDefs(items)
      if (!activeDefId && items[0]?.id) setActiveDefId(items[0].id)
    } catch (e: any) {
      setDefsErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setDefsLoading(false)
    }
  }

  async function loadRuns(envId?: string) {
    setRunsErr('')
    setRunsLoading(true)
    try {
      const sp = new URLSearchParams()
      sp.set('limit', '80')
      if (envId) sp.set('envId', envId)
      const r = await fetch(`/api/aiops/inspections/runs?${sp.toString()}`, { credentials: 'include' })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setRunsErr(t || '加载失败')
        return
      }
      const j = JSON.parse(t || '{}')
      const items = (j?.items || []).filter(Boolean) as RunRow[]
      setRuns(items)
      if (!activeRunId && items[0]?.id) setActiveRunId(items[0].id)
    } catch (e: any) {
      setRunsErr(`网络异常：${String(e?.message || e)}`)
    } finally {
      setRunsLoading(false)
    }
  }

  async function loadRunDetail(id: string) {
    const rid = String(id || '').trim()
    if (!rid) return
    setRunDetailErr('')
    try {
      const r = await fetch(`/api/aiops/inspections/runs/${encodeURIComponent(rid)}`, { credentials: 'include' })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setRunDetailErr(t || '加载失败')
        return
      }
      const j = JSON.parse(t || '{}')
      setActiveRun(j?.run || null)
    } catch (e: any) {
      setRunDetailErr(`网络异常：${String(e?.message || e)}`)
    }
  }

  useEffect(() => {
    loadTemplate()
    loadSettingsHint()
    loadDefs()
    loadRuns('staging')
    loadComponents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openNewInstance() {
    setInstEditing(true)
    setInstId('')
    setInstKey('starrocks')
    setInstName('')
    setInstEnv('staging')
    setInstRegion('cn-shenzhen')
    setInstRoleArn('')
    setInstCfg('{}')
  }

  function openEditInstance(it: any) {
    setInstEditing(true)
    setInstId(String(it?.id || ''))
    setInstKey(String(it?.component_key || 'starrocks'))
    setInstName(String(it?.name || ''))
    setInstEnv(String(it?.env || ''))
    setInstRegion(String(it?.region || ''))
    setInstRoleArn(String(it?.role_arn || ''))
    setInstCfg('{}')
  }

  async function saveInstance() {
    setToast('')
    try {
      let cfg: any = {}
      try {
        cfg = JSON.parse(instCfg || '{}')
      } catch {
        setToast('配置不是合法 JSON（先用 {} 也可以）')
        return
      }
      const payload = {
        id: instId || '',
        componentKey: instKey,
        name: instName.trim(),
        env: instEnv.trim(),
        region: instRegion.trim(),
        roleArn: instRoleArn.trim(),
        enabled: true,
        config: cfg,
      }
      const r = await fetch('/api/aiops/components/instances/upsert', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setToast(t || '保存失败')
        return
      }
      setToast('已保存组件实例')
      setInstEditing(false)
      await loadComponents()
    } catch (e: any) {
      setToast(`保存异常：${String(e?.message || e)}`)
    }
  }

  async function testInstance(id: string) {
    setToast('')
    const iid = String(id || '').trim()
    if (!iid) return
    try {
      const r = await fetch(`/api/aiops/components/instances/${encodeURIComponent(iid)}/test`, { method: 'POST', credentials: 'include' })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setToast(t || '测试失败')
        return
      }
      const j = JSON.parse(t || '{}')
      setToast(`连通性测试结果：${String(j?.result?.summary || '')}`)
    } catch (e: any) {
      setToast(`测试异常：${String(e?.message || e)}`)
    }
  }

  useEffect(() => {
    if (!activeRunId) return
    loadRunDetail(activeRunId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId])

  async function upsertDefaultDef() {
    setToast('')
    try {
      let envJson: any = null
      try {
        envJson = JSON.parse(envJsonText || '{}')
      } catch {
        setToast('envJson 不是合法 JSON')
        return
      }
      const payload = {
        id: activeDef?.id || '',
        name: '大数据巡检（示例环境 cn-shenzhen）',
        kind: 'bigdata_aliyun',
        envId: 'staging',
        envJson,
        runner: { channel: 'gitlab_ci', job: 'aiops_bigdata_staging' },
        enabled: true,
      }
      const r = await fetch('/api/aiops/inspections/defs/upsert', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setToast(t || '保存失败')
        return
      }
      setToast('已保存巡检定义')
      await loadDefs()
    } catch (e: any) {
      setToast(`保存异常：${String(e?.message || e)}`)
    }
  }

  async function createRun() {
    setToast('')
    const did = String(activeDefId || '').trim()
    if (!did) {
      setToast('请先选择一个巡检定义')
      return
    }
    try {
      const r = await fetch('/api/aiops/inspections/run', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defId: did }),
      })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setToast(t || '创建 run 失败')
        return
      }
      const j = JSON.parse(t || '{}')
      const runId = String(j?.runId || '').trim()
      setToast(runId ? `已创建 run：${runId}（请触发 GitLab CI 执行回传）` : '已创建 run')
      await loadRuns('staging')
      if (runId) setActiveRunId(runId)
    } catch (e: any) {
      setToast(`创建异常：${String(e?.message || e)}`)
    }
  }

  async function testConnectivity() {
    setToast('')
    const did = String(activeDefId || '').trim()
    if (!did) {
      setToast('请先选择一个巡检定义')
      return
    }
    try {
      const r = await fetch('/api/aiops/inspections/run_trigger', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defId: did, mode: 'connectivity' }),
      })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setToast(t || '触发失败')
        return
      }
      const j = JSON.parse(t || '{}')
      const runId = String(j?.runId || '').trim()
      const webUrl = String(j?.trigger?.webUrl || '')
      if (j?.ok) {
        setToast(`已触发连通性测试：runId=${runId}${webUrl ? `\nGitLab: ${webUrl}` : ''}`)
      } else {
        setToast(`触发失败：${String(j?.error || j?.trigger?.error || '').slice(0, 300)}`)
      }
      await loadRuns('staging')
      if (runId) setActiveRunId(runId)
    } catch (e: any) {
      setToast(`触发异常：${String(e?.message || e)}`)
    }
  }

  return (
    <div>
      <div style={{ fontWeight: 900 }}>自动化巡检</div>
      <div style={{ marginTop: 10, opacity: 0.78, lineHeight: 1.8, fontSize: 14 }}>
        V1：AIOps 管理巡检生命周期；GitLab CI 作为执行通道回传报告（report），失败项会自动归并成 incident + evidence。
      </div>

      <div style={{ marginTop: 14, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, background: 'rgba(0,0,0,0.14)', padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 900 }}>大数据组件</div>
          <button type="button" onClick={loadComponents} style={btnSmall}>
            刷新组件
          </button>
          <button type="button" onClick={openNewInstance} style={btnSmallPrimary}>
            添加组件
          </button>
          <div style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.72 }}>（V1：表单配置；底层以 JSON 存储）</div>
        </div>

        {compLoading ? <div style={{ marginTop: 10, opacity: 0.75 }}>加载中…</div> : null}
        {compErr ? <div style={{ marginTop: 10, color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{compErr}</div> : null}

        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '360px 1fr', gap: 12 }}>
          <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', opacity: 0.75, fontSize: 12 }}>
              实例（{instances.length}）
            </div>
            <div style={{ maxHeight: 240, overflow: 'auto' }}>
              {instances.map((it: any) => (
                <button
                  key={String(it?.id || '')}
                  type="button"
                  onClick={() => setActiveInstId(String(it?.id || ''))}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: 10,
                    border: 'none',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                    background: String(it?.id || '') === activeInstId ? 'rgba(124,92,255,0.12)' : 'transparent',
                    cursor: 'pointer',
                    color: 'rgba(255,255,255,0.92)',
                  }}
                >
                  <div style={{ fontWeight: 900, fontSize: 13 }}>{String(it?.name || '')}</div>
                  <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
                    {String(it?.component_key || '')} · env={String(it?.env || '')} · region={String(it?.region || '')}
                  </div>
                </button>
              ))}
              {!instances.length ? <div style={{ padding: 10, opacity: 0.75 }}>暂无组件实例（先点“添加组件”）</div> : null}
            </div>
          </div>

          <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', opacity: 0.75, fontSize: 12 }}>
              操作
            </div>
            <div style={{ padding: 10, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" disabled={!activeInstId} onClick={() => testInstance(activeInstId)} style={{ ...btnGreen, opacity: activeInstId ? 1 : 0.5, cursor: activeInstId ? 'pointer' : 'not-allowed' }}>
                测试连通性
              </button>
              <button
                type="button"
                disabled={!activeInstId}
                onClick={() => {
                  const it = instances.find((x) => String(x?.id || '') === activeInstId)
                  if (it) openEditInstance(it)
                }}
                style={{ ...btn, opacity: activeInstId ? 1 : 0.5, cursor: activeInstId ? 'pointer' : 'not-allowed' }}
              >
                编辑
              </button>
              <div style={{ width: '100%', fontSize: 12, opacity: 0.72, marginTop: 6 }}>
                说明：StarRocks 会在服务器侧做端口探活；其他组件 V1 先做“配置校验”，后续接入 CI/SDK 做真实 API 探测。
              </div>
            </div>
          </div>
        </div>

        {instEditing ? (
          <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
            <div style={{ fontWeight: 900 }}>{instId ? '编辑组件' : '添加组件'}</div>
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="组件类型">
                <select value={instKey} onChange={(e) => setInstKey(e.target.value)} style={selStyle}>
                  <option value="flink">Flink</option>
                  <option value="starrocks">StarRocks</option>
                  <option value="dataworks">DataWorks</option>
                  <option value="dlf">DLF</option>
                  <option value="actiontrail">ActionTrail</option>
                  <option value="network">Network</option>
                </select>
              </Field>
              <Field label="实例名称">
                <input value={instName} onChange={(e) => setInstName(e.target.value)} placeholder="例如：staging-starrocks" style={inpStyle} />
              </Field>
              <Field label="env">
                <input value={instEnv} onChange={(e) => setInstEnv(e.target.value)} placeholder="staging" style={inpStyle} />
              </Field>
              <Field label="region">
                <input value={instRegion} onChange={(e) => setInstRegion(e.target.value)} placeholder="cn-shenzhen" style={inpStyle} />
              </Field>
              <Field label="RoleArn（可选）">
                <input value={instRoleArn} onChange={(e) => setInstRoleArn(e.target.value)} placeholder="acs:ram::xxxx:role/xxx" style={inpStyle} />
              </Field>
              <Field label="配置（高级，JSON）">
                <textarea value={instCfg} onChange={(e) => setInstCfg(e.target.value)} spellCheck={false} style={taStyle} />
              </Field>
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
              <button type="button" onClick={saveInstance} style={btnPrimary}>保存</button>
              <button type="button" onClick={() => setInstEditing(false)} style={btn}>取消</button>
            </div>
          </div>
        ) : null}
      </div>

      {hint ? <div style={{ marginTop: 10, fontSize: 12, opacity: 0.82 }}>{hint}</div> : null}

      <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => {
            loadDefs()
            loadRuns('staging')
          }}
          style={{
            height: 34,
            padding: '0 12px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(255,255,255,0.03)',
            cursor: 'pointer',
            fontWeight: 850,
          }}
        >
          刷新
        </button>
        <button
          type="button"
          onClick={upsertDefaultDef}
          style={{
            height: 34,
            padding: '0 12px',
            borderRadius: 12,
            border: '1px solid rgba(124,92,255,0.55)',
            background: 'rgba(124,92,255,0.12)',
            cursor: 'pointer',
            fontWeight: 850,
          }}
          title="保存当前 envJson 到巡检定义（DB 快照）"
        >
          保存巡检定义
        </button>
        <button
          type="button"
          onClick={testConnectivity}
          style={{
            height: 34,
            padding: '0 12px',
            borderRadius: 12,
            border: '1px solid rgba(56,239,125,0.35)',
            background: 'rgba(56,239,125,0.10)',
            cursor: 'pointer',
            fontWeight: 900,
          }}
          title="创建 run 并触发 GitLab CI 执行连通性测试（需要先配置 GitLab）"
        >
          测试连通性（触发 CI）
        </button>
        <button
          type="button"
          onClick={createRun}
          style={{
            height: 34,
            padding: '0 12px',
            borderRadius: 12,
            border: '1px solid rgba(56,239,125,0.35)',
            background: 'rgba(56,239,125,0.10)',
            cursor: 'pointer',
            fontWeight: 850,
          }}
          title="创建 runId（随后由 GitLab CI 执行并回传 report）"
        >
          创建巡检 Run
        </button>
      </div>

      {toast ? <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9, whiteSpace: 'pre-wrap' }}>{toast}</div> : null}

      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '360px 1fr', gap: 12, minHeight: 520 }}>
        <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', opacity: 0.75, fontSize: 12 }}>
            巡检定义（{defs.length}）
          </div>
          {defsLoading ? <div style={{ padding: 12, opacity: 0.75 }}>加载中…</div> : null}
          {defsErr ? <div style={{ padding: 12, color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{defsErr}</div> : null}
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            {defs.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setActiveDefId(d.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: 10,
                  border: 'none',
                  borderTop: '1px solid rgba(255,255,255,0.06)',
                  background: d.id === activeDefId ? 'rgba(124,92,255,0.12)' : 'transparent',
                  cursor: 'pointer',
                  color: 'rgba(255,255,255,0.92)',
                }}
              >
                <div style={{ fontWeight: 900, fontSize: 13 }}>{d.name}</div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
                  id={d.id} · env={d.env_id} · kind={d.kind} · {d.enabled ? 'enabled' : 'disabled'}
                </div>
              </button>
            ))}
          </div>

          <div style={{ padding: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontWeight: 850, marginBottom: 8 }}>env.json（staging 示例）</div>
            <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>
              先用模板占位字段，填上 workspace/namespace、StarRocks FE、DataWorks/DLF 信息后保存。
            </div>
            <textarea
              value={envJsonText}
              onChange={(e) => setEnvJsonText(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%',
                minHeight: 220,
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(0,0,0,0.18)',
                padding: 10,
                outline: 'none',
                color: 'rgba(255,255,255,0.92)',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
                fontSize: 12,
              }}
            />
            {templateJson ? null : <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>（未加载到模板也不影响，你可以直接粘贴 env.json）</div>}
          </div>
        </div>

        <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontWeight: 900, fontSize: 14 }}>最近运行（staging）</div>
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
              运行创建后，把返回的 runId 作为 GitLab CI 的变量 `RUN_ID` 传入，然后 CI 回传 `POST /api/aiops/inspections/report`。
            </div>
          </div>
          {runsLoading ? <div style={{ padding: 12, opacity: 0.75 }}>加载中…</div> : null}
          {runsErr ? <div style={{ padding: 12, color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{runsErr}</div> : null}
          <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 12, padding: 12 }}>
            <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', opacity: 0.75, fontSize: 12 }}>
                Runs（{runs.length}）
              </div>
              <div style={{ maxHeight: 420, overflow: 'auto' }}>
                {runs.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setActiveRunId(r.id)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: 10,
                      border: 'none',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                      background: r.id === activeRunId ? 'rgba(124,92,255,0.12)' : 'transparent',
                      cursor: 'pointer',
                      color: 'rgba(255,255,255,0.92)',
                    }}
                  >
                    <div style={{ fontWeight: 900, fontSize: 13 }}>{r.status}{typeof r.ok === 'number' ? ` · ok=${r.ok}` : ''}</div>
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
                      id={r.id}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
                      created: {fmtTs(r.created_at)} · finished: {fmtTs(r.finished_at)}
                    </div>
                    {r.summary ? <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>{String(r.summary).slice(0, 140)}</div> : null}
                    {r.error ? <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,140,140,0.95)' }}>{String(r.error).slice(0, 140)}</div> : null}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', opacity: 0.75, fontSize: 12 }}>
                Run 详情
              </div>
              {runDetailErr ? <div style={{ padding: 10, color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{runDetailErr}</div> : null}
              {activeRun ? (
                <div style={{ padding: 10 }}>
                  <div style={{ fontWeight: 900 }}>runId={String(activeRun.id || '')}</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                    status={String(activeRun.status || '')} · ok={String(activeRun.ok)} · env={String(activeRun.env_id || '')}
                  </div>
                  {activeRun.summary ? <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8, whiteSpace: 'pre-wrap' }}>{String(activeRun.summary)}</div> : null}
                  {activeRun.incident_ids_json ? (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 850, marginBottom: 6 }}>关联 Incidents</div>
                      <pre style={{ margin: 0, fontSize: 12, opacity: 0.85, whiteSpace: 'pre-wrap' }}>
                        {String(activeRun.incident_ids_json).slice(0, 4000)}
                      </pre>
                    </div>
                  ) : null}
                  {activeRun.report_json ? (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 850, marginBottom: 6 }}>Report（截断展示）</div>
                      <pre style={{ margin: 0, fontSize: 12, opacity: 0.85, whiteSpace: 'pre-wrap' }}>
                        {String(activeRun.report_json).slice(0, 6000)}
                      </pre>
                    </div>
                  ) : (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72 }}>未收到 report（等待 GitLab CI 回传）。</div>
                  )}
                </div>
              ) : (
                <div style={{ padding: 10, opacity: 0.72 }}>请选择一个 run</div>
              )}
            </div>
          </div>
        </div>
      </div>
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

const selStyle: React.CSSProperties = {
  height: 36,
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  padding: '0 10px',
  outline: 'none',
  width: '100%',
  color: 'rgba(255,255,255,0.92)',
}

const taStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 90,
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(0,0,0,0.18)',
  padding: 10,
  outline: 'none',
  color: 'rgba(255,255,255,0.92)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
  fontSize: 12,
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
  fontWeight: 900,
}

const btnSmall: React.CSSProperties = {
  height: 30,
  padding: '0 10px',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.03)',
  cursor: 'pointer',
  fontWeight: 850,
}

const btnSmallPrimary: React.CSSProperties = {
  height: 30,
  padding: '0 10px',
  borderRadius: 12,
  border: '1px solid rgba(124,92,255,0.55)',
  background: 'rgba(124,92,255,0.12)',
  cursor: 'pointer',
  fontWeight: 900,
}

const btnGreen: React.CSSProperties = {
  height: 34,
  padding: '0 12px',
  borderRadius: 12,
  border: '1px solid rgba(56,239,125,0.35)',
  background: 'rgba(56,239,125,0.10)',
  cursor: 'pointer',
  fontWeight: 900,
}

