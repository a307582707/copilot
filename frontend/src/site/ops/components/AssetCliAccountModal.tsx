import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../../ui/Button'
import { Modal, ModalSection } from '../../../ui/Modal'

export type CloudAccountOption = {
  key: string
  label: string
  enabled?: boolean
}

export type CliAccountOption = {
  id: string
  name: string
  profileDefault?: string
  profileDataworks?: string
  cloudAccountKeys?: string[]
  regions?: string[]
  enabled?: boolean
  updatedAt?: number
}

type SyncOptionsResp = {
  ok: boolean
  cloudAccounts?: CloudAccountOption[]
  cliAccounts?: CliAccountOption[]
}

type Props = {
  open: boolean
  presetAccountKey?: string
  onClose: () => void
  onSaved?: (item: CliAccountOption) => void
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

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  height: 92,
  padding: '10px 12px',
  resize: 'vertical',
}

function emptyForm(presetAccountKey: string) {
  return {
    id: '',
    name: '',
    profileDefault: '',
    profileDataworks: '',
    cloudAccountKeys: presetAccountKey ? [presetAccountKey] : ([] as string[]),
    regionsInput: '',
    enabled: true,
  }
}

export function AssetCliAccountModal({ open, presetAccountKey = '', onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [cloudAccounts, setCloudAccounts] = useState<CloudAccountOption[]>([])
  const [cliAccounts, setCliAccounts] = useState<CliAccountOption[]>([])
  const [form, setForm] = useState(() => emptyForm(presetAccountKey))

  async function loadOptions() {
    setLoading(true)
    setErr('')
    try {
      const resp = await fetch('/api/aiops/sync/options', { credentials: 'include' })
      const data = (await resp.json().catch(() => ({}))) as SyncOptionsResp
      if (!resp.ok) throw new Error((data as any)?.detail || `HTTP ${resp.status}`)
      setCloudAccounts(Array.isArray(data.cloudAccounts) ? data.cloudAccounts : [])
      setCliAccounts(Array.isArray(data.cliAccounts) ? data.cliAccounts : [])
    } catch (e: any) {
      setErr(`加载 CLI 账号配置失败：${String(e?.message || e)}`)
      setCloudAccounts([])
      setCliAccounts([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setForm(emptyForm(presetAccountKey))
    void loadOptions()
  }, [open, presetAccountKey])

  const visibleAccounts = useMemo(
    () => cloudAccounts.filter((item) => item.enabled !== false),
    [cloudAccounts],
  )

  function loadIntoForm(item: CliAccountOption) {
    setForm({
      id: item.id || '',
      name: item.name || '',
      profileDefault: item.profileDefault || '',
      profileDataworks: item.profileDataworks || '',
      cloudAccountKeys: Array.isArray(item.cloudAccountKeys) ? item.cloudAccountKeys : [],
      regionsInput: Array.isArray(item.regions) ? item.regions.join(', ') : '',
      enabled: item.enabled !== false,
    })
  }

  async function save() {
    setSaving(true)
    setErr('')
    try {
      const regions = form.regionsInput
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      const payload = {
        id: form.id || undefined,
        name: form.name.trim(),
        profileDefault: form.profileDefault.trim(),
        profileDataworks: form.profileDataworks.trim(),
        cloudAccountKeys: form.cloudAccountKeys,
        regions,
        enabled: form.enabled,
      }
      const resp = await fetch('/api/aiops/sync/cli-accounts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = (await resp.json().catch(() => ({}))) as any
      if (!resp.ok) throw new Error(data?.detail || `HTTP ${resp.status}`)
      await loadOptions()
      const savedItem: CliAccountOption = {
        id: String(data?.id || payload.id || ''),
        name: payload.name,
        profileDefault: payload.profileDefault,
        profileDataworks: payload.profileDataworks,
        cloudAccountKeys: payload.cloudAccountKeys,
        regions,
        enabled: payload.enabled,
      }
      setForm(emptyForm(presetAccountKey))
      onSaved?.(savedItem)
    } catch (e: any) {
      setErr(`保存失败：${String(e?.message || e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="CLI 账号管理"
      footer={
        <>
          <Button variant="ghost" onClick={() => setForm(emptyForm(presetAccountKey))}>
            新建一条
          </Button>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : form.id ? '保存修改' : '新增 CLI 账号'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', gap: 12 }}>
        <ModalSection style={{ minHeight: 0 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>已有 CLI 账号</div>
          <div style={{ fontSize: 12, opacity: 0.68, lineHeight: 1.7, marginBottom: 10 }}>
            这里只展示真实账号。点右侧编辑后，会直接回填到表单里。
          </div>
          {loading ? (
            <div style={{ opacity: 0.65 }}>加载中…</div>
          ) : cliAccounts.length === 0 ? (
            <div style={{ opacity: 0.58, fontSize: 13 }}>还没有配置任何 CLI 账号。</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {cliAccounts.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => loadIntoForm(item)}
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <div style={{ fontWeight: 850 }}>{item.name}</div>
                    <div style={{ fontSize: 11, opacity: item.enabled === false ? 0.56 : 0.78 }}>{item.enabled === false ? '停用' : '启用'}</div>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68, lineHeight: 1.6 }}>
                    default: {item.profileDefault || '-'}
                    <br />
                    dataworks: {item.profileDataworks || '-'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </ModalSection>

        <ModalSection>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>{form.id ? '编辑 CLI 账号' : '新增 CLI 账号'}</div>
          <div style={{ display: 'grid', gap: 12 }}>
            <Field label="CLI 账号名称">
              <input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} placeholder="例如：美区只读发现账号" style={inputStyle} />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Default Profile">
                <input
                  value={form.profileDefault}
                  onChange={(e) => setForm((prev) => ({ ...prev, profileDefault: e.target.value }))}
                  placeholder="例如：aliyun-readonly"
                  style={inputStyle}
                />
              </Field>
              <Field label="DataWorks Profile">
                <input
                  value={form.profileDataworks}
                  onChange={(e) => setForm((prev) => ({ ...prev, profileDataworks: e.target.value }))}
                  placeholder="例如：aliyun-dataworks-readonly"
                  style={inputStyle}
                />
              </Field>
            </div>

            <Field label="适用阿里云账号">
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {visibleAccounts.map((item) => {
                  const checked = form.cloudAccountKeys.includes(item.key)
                  return (
                    <label
                      key={item.key}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        borderRadius: 999,
                        border: checked ? '1px solid rgba(124,92,255,0.16)' : '1px solid #e2e8f0',
                        background: checked ? 'rgba(124,92,255,0.05)' : '#ffffff',
                        padding: '8px 12px',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            cloudAccountKeys: e.target.checked
                              ? [...prev.cloudAccountKeys, item.key]
                              : prev.cloudAccountKeys.filter((key) => key !== item.key),
                          }))
                        }
                      />
                      <span>{item.label}</span>
                    </label>
                  )
                })}
              </div>
            </Field>

            <Field label="适用区域">
              <textarea
                value={form.regionsInput}
                onChange={(e) => setForm((prev) => ({ ...prev, regionsInput: e.target.value }))}
                placeholder="多个区域用英文逗号分隔，例如：us-west-1, cn-shenzhen"
                style={textareaStyle}
              />
            </Field>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))} />
              启用这条 CLI 账号
            </label>

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
