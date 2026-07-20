import { useMemo } from 'react'
import { Button } from '../../../ui/Button'
import { FormField, FormInput, FormSelect } from '../../../ui/Form'

export type AssetFilterState = {
  searchQuery: string
  componentKeys: string[]
  envs: string[]
  regions: string[]
  statusFilter: 'all' | 'ok' | 'error' | 'unknown'
}

export const defaultFilterState: AssetFilterState = {
  searchQuery: '',
  componentKeys: [],
  envs: [],
  regions: [],
  statusFilter: 'all',
}

type BigDataItem = {
  instance: {
    id: string
    component_key: string
    name: string
    env?: string
    region?: string
    enabled?: boolean
  }
  snapshot?: {
    ok?: boolean | null
  } | null
}

export function AssetFilter(props: {
  items: BigDataItem[]
  filter: AssetFilterState
  onChange: (filter: AssetFilterState) => void
  onReset: () => void
}) {
  const { items, filter, onChange, onReset } = props

  const uniqueKeys = useMemo(() => Array.from(new Set(items.map((it) => it.instance.component_key))).sort(), [items])
  const uniqueEnvs = useMemo(
    () =>
      Array.from(new Set(items.map((it) => it.instance.env).filter(Boolean)))
        .sort()
        .slice(0, 20),
    [items],
  )
  const uniqueRegions = useMemo(
    () =>
      Array.from(new Set(items.map((it) => it.instance.region).filter(Boolean)))
        .sort()
        .slice(0, 20),
    [items],
  )

  return (
    <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
      <FormField label="搜索">
        <FormInput
          type="text"
          placeholder="搜索名称或ID…"
          value={filter.searchQuery}
          onChange={(e) => onChange({ ...filter, searchQuery: e.target.value })}
        />
      </FormField>

      <FormField label="类型">
        <FormSelect value={filter.componentKeys[0] || ''} onChange={(e) => onChange({ ...filter, componentKeys: e.target.value ? [e.target.value] : [] })}>
          <option value="">全部</option>
          {uniqueKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </FormSelect>
      </FormField>

      <FormField label="环境">
        <FormSelect value={filter.envs[0] || ''} onChange={(e) => onChange({ ...filter, envs: e.target.value ? [e.target.value] : [] })}>
          <option value="">全部</option>
          {uniqueEnvs.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </FormSelect>
      </FormField>

      <FormField label="区域">
        <FormSelect value={filter.regions[0] || ''} onChange={(e) => onChange({ ...filter, regions: e.target.value ? [e.target.value] : [] })}>
          <option value="">全部</option>
          {uniqueRegions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </FormSelect>
      </FormField>

      <FormField label="状态">
        <FormSelect value={filter.statusFilter} onChange={(e) => onChange({ ...filter, statusFilter: e.target.value as any })}>
          <option value="all">全部</option>
          <option value="ok">正常</option>
          <option value="error">异常</option>
          <option value="unknown">未知</option>
        </FormSelect>
      </FormField>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <Button variant="ghost" onClick={onReset}>
          重置
        </Button>
      </div>
    </div>
  )
}

export function applyAssetFilter(items: BigDataItem[], filter: AssetFilterState): BigDataItem[] {
  let result = items

  if (filter.searchQuery) {
    const q = filter.searchQuery.toLowerCase()
    result = result.filter((it) => it.instance.name.toLowerCase().includes(q) || it.instance.id.toLowerCase().includes(q))
  }

  if (filter.componentKeys.length > 0) {
    result = result.filter((it) => filter.componentKeys.includes(it.instance.component_key))
  }

  if (filter.envs.length > 0) {
    result = result.filter((it) => it.instance.env && filter.envs.includes(it.instance.env))
  }

  if (filter.regions.length > 0) {
    result = result.filter((it) => it.instance.region && filter.regions.includes(it.instance.region))
  }

  if (filter.statusFilter !== 'all') {
    result = result.filter((it) => {
      const ok = it.snapshot?.ok
      if (filter.statusFilter === 'ok') return ok === true
      if (filter.statusFilter === 'error') return ok === false
      if (filter.statusFilter === 'unknown') return ok == null
      return true
    })
  }

  return result
}
