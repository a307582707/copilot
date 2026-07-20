import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../../ui/Button'
import { Modal, ModalSection } from '../../../ui/Modal'
import type { CliAccountOption, CloudAccountOption } from './AssetCliAccountModal'

export type SyncScheduleRow = {
  id: string
  cloud_account_key: string
  cli_account_id: string
  region: string
  cron_expr: string
  enabled: boolean
  last_run_id?: string | null
  last_run_at?: number | null
  next_run_at?: number | null
}

type Props = {
  open: boolean
  account: string
  cliAccountId: string
  region: string
  cloudAccounts: CloudAccountOption[]
  cliAccounts: CliAccountOption[]
  schedules: SyncScheduleRow[]
  onClose: () => void
  onSaved: (message: string) => void
}

const inputStyle: React.CSSProperties = {
  height: 38,
  width: '100%',
  borderRadius: 10,
  border: '1px solid #e2e8f0',
  background: '#ffffff',
  padding: '0 12px',
  color: '#0f172a',
  outline: 'none',
}

function fmtTs(ts?: number | null) {
  if (!ts) return '-'
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN')
  } catch {
    return String(ts)
  }
}

function emptyForm(account: string, cliAccountId: string, region: string) {
  return {
    id: '',
    account,
    cliAccountId,
    region: region || 'all',
    cronExpr: '0 18 * * *',
    enabled: true,
  }
}

export function AssetSyncScheduleModal(props: Props) {
  const { open, account, cliAccountId, region, cloudAccounts, cliAccounts, schedules, onClose, onSaved } = props
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [form, setForm] = useState(() => emptyForm(account, cliAccountId, region))

  useEffect(() => {
    if (!open) return
    setErr('')
    setForm(emptyForm(account, cliAccountId, region))
  }, [open, account, cliAccountId, region])

  const accountSchedules = useMemo(
    () => schedules.filter((item) => !account || item.cloud_account_key === account),
    [schedules, account],
  )

  async function save() {
    setSaving(true)
    setErr('')
    try {
      const resp = await fetch('/api/aiops/sync/schedules', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = (await resp.json().catch(() => ({}))) as any
      if (!resp.ok) throw new Error(data?.detail || `HTTP ${resp.status}`)
      onSaved(form.id ? '定时同步已更新。' : '定时同步已新增。')
      setForm(emptyForm(account, cliAccountId, region))
    } catch (e: any) {
      setErr(`保存失败：${String(e?.message || e)}`)
    } finally {
      setSaving(false)
    }
  }

  async function remove(scheduleId: string) {
    setSaving(true)
    setErr('')
    try {
      const resp = await fetch(`/api/aiops/sync/schedules/${encodeURIComponent(scheduleId)}/delete`, {
        method: 'POST',
        credentials: 'include',
      })
      const data = (await resp.json().catch(() => ({}))) as any
      if (!resp.ok) throw new Error(data?.detail || `HTTP ${resp.status}`)
      onSaved('定时同步已删除。')
      setForm(emptyForm(account, cliAccountId, region))
    } catch (e: any) {
      setErr(`删除失败：${String(e?.message || e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="定时同步设置"
      footer={
        <>
          <Button variant="ghost" onClick={() => setForm(emptyForm(account, cliAccountId, region))}>
            新建一条
          </Button>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : form.id ? '保存修改' : '保存定时同步'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', gap: 12 }}>
        <ModalSection>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>当前账号下的定时任务</div>
          {accountSchedules.length === 0 ? (
            <div style={{ opacity: 0.6, fontSize: 13 }}>当前账号下还没有配置定时同步。</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {accountSchedules.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() =>
                    setForm({
                      id: item.id,
                      account: item.cloud_account_key,
                      cliAccountId: item.cli_account_id,
                      region: item.region || 'all',
                      cronExpr: item.cron_expr,
                      enabled: item.enabled !== false,
                    })
                  }
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    borderRadius: 12,
                    border: '1px solid #e2e8f0',
                    background: '#ffffff',
                    padding: 10,
                    cursor: 'pointer',
                    color: 'inherit',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontWeight: 850 }}>{item.region === 'all' ? '全部区域' : item.region}</div>
                    <div style={{ fontSize: 11, opacity: 0.72 }}>{item.enabled ? '启用' : '停用'}</div>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7, lineHeight: 1.6 }}>
                    cron: {item.cron_expr}
                    <br />
                    下次执行: {fmtTs(item.next_run_at)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </ModalSection>

        <ModalSection>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>{form.id ? '编辑定时同步' : '新增定时同步'}</div>
          <div style={{ display: 'grid', gap: 12 }}>
            <Field label="阿里云账号">
              <select value={form.account} onChange={(e) => setForm((prev) => ({ ...prev, account: e.target.value }))} style={inputStyle}>
                {cloudAccounts.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="CLI 账号">
              <select value={form.cliAccountId} onChange={(e) => setForm((prev) => ({ ...prev, cliAccountId: e.target.value }))} style={inputStyle}>
                {cliAccounts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="区域">
              <select value={form.region} onChange={(e) => setForm((prev) => ({ ...prev, region: e.target.value }))} style={inputStyle}>
                <option value="all">全部区域</option>
                <option value="us-west-1">美国 (硅谷)</option>
                <option value="cn-shenzhen">华南1 (深圳)</option>
              </select>
            </Field>

            <Field label="Cron 表达式">
              <input value={form.cronExpr} onChange={(e) => setForm((prev) => ({ ...prev, cronExpr: e.target.value }))} placeholder="例如：0 18 * * *" style={inputStyle} />
            </Field>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))} />
              启用这条定时同步
            </label>

            {form.id ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="danger" onClick={() => void remove(form.id)} disabled={saving}>
                  删除这条定时同步
                </Button>
              </div>
            ) : null}

            {err ? <div style={{ color: 'rgba(255,140,140,0.95)', whiteSpace: 'pre-wrap' }}>{err}</div> : null}
          </div>
        </ModalSection>
      </div>
    </Modal>
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
