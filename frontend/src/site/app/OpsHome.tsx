import { useEffect, useMemo, useState } from 'react'

type MeResp = { ok: boolean; user?: { role?: string } }
type ComponentsResp = { ok: boolean; components?: any[]; instances?: any[] }
type StatusResp = { ok: boolean; status?: any }

export function OpsHome() {
  const [role, setRole] = useState<string>('')
  const [err, setErr] = useState<string>('')
  const [instances, setInstances] = useState<any[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [snap, setSnap] = useState<Record<string, any>>({})
  const [chatInput, setChatInput] = useState<string>('')
  const [msgs, setMsgs] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([])
  const [reportDir, setReportDir] = useState<string>('bigdata/staging')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/me', { credentials: 'include' })
        const j = (await r.json().catch(() => null)) as MeResp | null
        if (cancelled) return
        setRole(String(j?.user?.role || ''))
      } catch {
        // ignore
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected])

  async function load() {
    setErr('')
    try {
      const r = await fetch('/api/aiops/components', { credentials: 'include' })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setErr(t ? `加载失败：${t}` : '加载失败')
        return
      }
      const j = (await r.json().catch(() => null)) as ComponentsResp | null
      const rows = (j?.instances || []).filter(Boolean)
      setInstances(rows)
    } catch (e: any) {
      setErr(`加载失败：${String(e?.message || e)}`)
    }
  }

  async function refreshSelected() {
    setErr('')
    try {
      const out: Record<string, any> = {}
      for (const id of selectedIds.slice(0, 20)) {
        const r = await fetch(`/api/aiops/components/instances/${encodeURIComponent(id)}/status`, { credentials: 'include' })
        if (!r.ok) continue
        const j = (await r.json().catch(() => null)) as StatusResp | null
        out[id] = j?.status || null
      }
      setSnap((prev) => ({ ...prev, ...out }))
    } catch (e: any) {
      setErr(`刷新失败：${String(e?.message || e)}`)
    }
  }

  async function generateReport() {
    setErr('')
    try {
      const r = await fetch('/api/aiops/reports/generate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceIds: selectedIds, outDir: reportDir }),
      })
      const t = await r.text().catch(() => '')
      if (!r.ok) {
        setErr(t || '生成报告失败')
        return
      }
      const j = JSON.parse(t || '{}')
      setMsgs((m) => [...m, { role: 'assistant', text: `已生成巡检报告：${String(j?.path || '')}` }])
    } catch (e: any) {
      setErr(`生成报告异常：${String(e?.message || e)}`)
    }
  }

  async function sendChat() {
    const msg = chatInput.trim()
    if (!msg) return
    setChatInput('')
    setMsgs((m) => [...m, { role: 'user', text: msg }])
    try {
      const ctx = selectedIds.slice(0, 20).map((id) => {
        const inst = instances.find((x: any) => String(x?.id || '') === id) || {}
        const st = snap[id] || null
        return {
          kind: 'component',
          title: `${String(inst?.name || id)} (${String(inst?.component_key || '')})`,
          content: JSON.stringify({ instance: inst, status: st }, null, 2),
        }
      })
      const r = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: `ops_${Date.now()}`,
          message: `你是大数据 SRE 智能运维助手。基于我勾选的组件状态做只读排错/状态解读，给出可执行的下一步（不允许猜测）。\n\n我的问题：\n${msg}`,
          model: '',
          context_items: ctx,
        }),
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        setMsgs((m) => [...m, { role: 'assistant', text: t ? `请求失败：${t}` : '请求失败' }])
        return
      }
      const t = await r.text().catch(() => '')
      setMsgs((m) => [...m, { role: 'assistant', text: t || '(empty)' }])
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'assistant', text: `异常：${String(e?.message || e)}` }])
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (role && role !== 'admin') {
    return (
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 18px 50px' }}>
        <div style={{ fontSize: 26, fontWeight: 900 }}>智能运维（Ops）</div>
        <div style={{ marginTop: 10, opacity: 0.78 }}>当前账号不是管理员，暂无权限查看巡检/故障详情。</div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 18px 50px' }}>
      <div style={{ fontSize: 26, fontWeight: 900 }}>智能运维（Ops）</div>
      <div style={{ marginTop: 10, opacity: 0.78, lineHeight: 1.8 }}>
        V1：勾选组件 → 展示状态 → AI 只读排错/查询 → 生成巡检报告（写入服务器目录）。
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          onClick={load}
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
          onClick={refreshSelected}
          style={{
            height: 34,
            padding: '0 12px',
            borderRadius: 12,
            border: '1px solid rgba(56,239,125,0.35)',
            background: 'rgba(56,239,125,0.10)',
            cursor: 'pointer',
            fontWeight: 900,
          }}
        >
          刷新所选状态
        </button>
        <div style={{ fontSize: 12, opacity: 0.7 }}>更多配置：去 `/admin/aiops?tab=inspections`</div>
      </div>

      {err ? <div style={{ marginTop: 10, color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{err}</div> : null}

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12 }}>
        <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, background: 'rgba(15,22,33,0.55)', padding: 14 }}>
          <div style={{ fontWeight: 900 }}>组件列表</div>
          <div style={{ marginTop: 10, display: 'grid', gap: 8, maxHeight: 520, overflow: 'auto' }}>
            {(instances || []).map((it: any) => {
              const id = String(it?.id || '')
              const on = Boolean(selected[id])
              return (
                <label key={id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', background: on ? 'rgba(124,92,255,0.10)' : 'rgba(0,0,0,0.10)' }}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => setSelected((p) => ({ ...p, [id]: e.target.checked }))}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 900, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(it?.name || id)}</div>
                    <div style={{ marginTop: 2, fontSize: 12, opacity: 0.72 }}>{String(it?.component_key || '')} · env={String(it?.env || '')}</div>
                  </div>
                </label>
              )
            })}
            {!instances?.length ? <div style={{ opacity: 0.75 }}>暂无组件（去后台添加）</div> : null}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateRows: '240px 1fr', gap: 12 }}>
          <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, background: 'rgba(15,22,33,0.55)', padding: 14 }}>
            <div style={{ fontWeight: 900 }}>状态看板（所选组件）</div>
            <div style={{ marginTop: 10, display: 'grid', gap: 10, maxHeight: 190, overflow: 'auto' }}>
              {selectedIds.map((id) => {
                const it = instances.find((x: any) => String(x?.id || '') === id) || {}
                const st = snap[id]
                return (
                  <div key={id} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, background: 'rgba(0,0,0,0.14)', padding: 10 }}>
                    <div style={{ fontWeight: 900, fontSize: 13 }}>{String(it?.name || id)} · {String(it?.component_key || '')}</div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78 }}>{st?.summary ? String(st.summary) : '（未刷新状态）'}</div>
                  </div>
                )
              })}
              {!selectedIds.length ? <div style={{ opacity: 0.75 }}>先在左侧勾选组件，再点“刷新所选状态”。</div> : null}
            </div>
          </div>

          <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, background: 'rgba(15,22,33,0.55)', padding: 14, display: 'grid', gridTemplateRows: '1fr auto', gap: 10 }}>
            <div style={{ overflow: 'auto', paddingRight: 4 }}>
              {msgs.map((m, idx) => (
                <div key={idx} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>{m.role}</div>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13, opacity: 0.92 }}>{m.text}</pre>
                </div>
              ))}
              {!msgs.length ? <div style={{ opacity: 0.75 }}>在右下输入框问 AI：例如“帮我看下这些组件有没有明显异常？下一步排查怎么做？”</div> : null}
            </div>

            <div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <div style={{ fontSize: 12, opacity: 0.72 }}>报告目录（服务器相对路径）</div>
                <input value={reportDir} onChange={(e) => setReportDir(e.target.value)} style={{ height: 30, borderRadius: 10, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.12)', padding: '0 10px', color: 'rgba(255,255,255,0.9)', minWidth: 220 }} />
                <button type="button" onClick={generateReport} style={{ height: 30, padding: '0 10px', borderRadius: 10, border: '1px solid rgba(56,239,125,0.35)', background: 'rgba(56,239,125,0.10)', cursor: 'pointer', fontWeight: 900 }}>
                  生成巡检报告
                </button>
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="对 AI 发送指令（会带上你勾选的组件状态）"
                  style={{ flex: 1, height: 36, borderRadius: 12, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.12)', padding: '0 12px', color: 'rgba(255,255,255,0.92)' }}
                />
                <button type="button" onClick={sendChat} style={{ height: 36, padding: '0 14px', borderRadius: 12, border: '1px solid rgba(124,92,255,0.55)', background: 'rgba(124,92,255,0.12)', cursor: 'pointer', fontWeight: 900 }}>
                  发送
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

