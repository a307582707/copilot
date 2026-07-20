import { useState } from 'react'
import { FormField, FormInput, FormSelect, FormSwitch, FormTextarea } from '../../../ui/Form'
import { Button } from '../../../ui/Button'

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

const componentTypes = [
  { value: 'flink', label: 'Flink' },
  { value: 'starrocks', label: 'StarRocks' },
  { value: 'dataworks', label: 'DataWorks' },
  { value: 'dlf', label: 'DLF' },
  { value: 'actiontrail', label: 'ActionTrail' },
  { value: 'network', label: 'Network' },
]

export function AssetForm(props: {
  initialData?: Partial<AssetFormData>
  onSubmit: (data: AssetFormData) => Promise<void>
  onCancel: () => void
  submitting?: boolean
}) {
  const { initialData, onSubmit, onCancel, submitting } = props

  const [data, setData] = useState<AssetFormData>({
    id: initialData?.id || '',
    component_key: initialData?.component_key || 'flink',
    name: initialData?.name || '',
    env: initialData?.env || '',
    region: initialData?.region || '',
    role_arn: initialData?.role_arn || '',
    config: initialData?.config || '{}',
    enabled: initialData?.enabled ?? true,
  })

  const [errors, setErrors] = useState<Record<string, string>>({})

  function validate(): boolean {
    const errs: Record<string, string> = {}
    if (!data.name.trim()) errs.name = '名称不能为空'
    if (!data.component_key) errs.component_key = '请选择组件类型'

    // Validate config JSON
    if (data.config.trim()) {
      try {
        JSON.parse(data.config)
      } catch {
        errs.config = 'JSON 格式不正确'
      }
    }

    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return
    await onSubmit(data)
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
      <FormField label="组件类型" required error={errors.component_key}>
        <FormSelect value={data.component_key} onChange={(e) => setData({ ...data, component_key: e.target.value })} disabled={!!initialData?.id}>
          {componentTypes.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </FormSelect>
      </FormField>

      <FormField label="名称" required error={errors.name}>
        <FormInput type="text" value={data.name} onChange={(e) => setData({ ...data, name: e.target.value })} placeholder="例如：Flink-US-Prod" />
      </FormField>

      <FormField label="环境" help="例如：prod、test、dev">
        <FormInput type="text" value={data.env} onChange={(e) => setData({ ...data, env: e.target.value })} placeholder="prod" />
      </FormField>

      <FormField label="区域" help="例如：us-west-1、cn-shenzhen">
        <FormInput type="text" value={data.region} onChange={(e) => setData({ ...data, region: e.target.value })} placeholder="us-west-1" />
      </FormField>

      <FormField label="RAM 角色 ARN" help="用于跨账号访问的 RAM 角色">
        <FormInput
          type="text"
          value={data.role_arn}
          onChange={(e) => setData({ ...data, role_arn: e.target.value })}
          placeholder="acs:ram::123456:role/MyRole"
        />
      </FormField>

      <FormField label="配置（JSON）" error={errors.config} help="组件特定配置，JSON 格式">
        <FormTextarea value={data.config} onChange={(e) => setData({ ...data, config: e.target.value })} placeholder='{"key": "value"}' rows={5} />
      </FormField>

      <FormField>
        <FormSwitch checked={data.enabled} onChange={(e) => setData({ ...data, enabled: e.target.checked })} label="启用" />
      </FormField>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? '提交中…' : initialData?.id ? '保存' : '创建'}
        </Button>
      </div>
    </form>
  )
}
