import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../../ui/Button'
import { StatusPill } from '../../../ui/StatusPill'
import { Table, type TableColumn } from '../../../ui/Table'

type BigDataItem = {
  instance: {
    id: string
    component_key: string
    name: string
    env?: string
    region?: string
    enabled?: boolean
    updated_at?: number
  }
  snapshot?: {
    ts?: number
    ok?: boolean | null
    status?: string
    summary?: string
  } | null
}

function typeLabel(key: string) {
  const m: Record<string, string> = {
    dataworks: 'DataWorks',
    starrocks: 'StarRocks',
    flink: 'Flink',
    cms_rule: 'CMS 规则',
    dlf: 'DLF',
    actiontrail: 'ActionTrail',
    network: 'Network',
  }
  return m[key] || key
}

export function AssetTable(props: {
  items: BigDataItem[]
  selectedIds: Set<string>
  onSelectIds: (ids: Set<string>) => void
  onRowClick?: (item: BigDataItem) => void
}) {
  const { items, selectedIds, onSelectIds, onRowClick } = props

  const columns = useMemo<TableColumn<BigDataItem>[]>(
    () => [
      {
        id: 'name',
        header: '名称',
        accessor: (row) => (
          <div style={{ minWidth: 0, overflow: 'hidden' }}>
            <div style={{ fontWeight: 850, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {row.instance.name || row.instance.id}
            </div>
            <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>ID: {row.instance.id}</div>
          </div>
        ),
        width: '25%',
      },
      {
        id: 'type',
        header: '类型',
        accessor: (row) => <span>{typeLabel(row.instance.component_key)}</span>,
        width: '12%',
      },
      {
        id: 'env',
        header: '环境',
        accessor: (row) => <span>{row.instance.env || '-'}</span>,
        width: '10%',
      },
      {
        id: 'region',
        header: '区域',
        accessor: (row) => <span>{row.instance.region || '-'}</span>,
        width: '12%',
      },
      {
        id: 'status',
        header: '状态',
        accessor: (row) => {
          const ok = row.snapshot?.ok
          if (ok === true) return <StatusPill tone="ok">正常</StatusPill>
          if (ok === false) return <StatusPill tone="err">异常</StatusPill>
          return <StatusPill tone="neutral">未知</StatusPill>
        },
        width: '10%',
      },
      {
        id: 'updated',
        header: '更新时间',
        accessor: (row) => {
          if (!row.instance.updated_at) return <span style={{ opacity: 0.6 }}>-</span>
          const d = new Date(row.instance.updated_at * 1000)
          return <span style={{ fontSize: 11, opacity: 0.75 }}>{d.toLocaleString('zh-CN')}</span>
        },
        width: '16%',
      },
      {
        id: 'actions',
        header: '操作',
        accessor: (row) => (
          <Link to={`/app/assets/console/${row.instance.id}`} style={{ textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="sm">
              详情
            </Button>
          </Link>
        ),
        width: '8%',
        align: 'right',
      },
    ],
    [],
  )

  return (
    <Table
      columns={columns}
      data={items}
      keyExtractor={(row) => row.instance.id}
      selectedRows={selectedIds}
      onSelectRows={onSelectIds}
      onRowClick={onRowClick}
      emptyMessage="暂无资产数据"
    />
  )
}
