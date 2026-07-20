import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { cn } from './cn'

export type TableColumn<T> = {
  id: string
  header: ReactNode
  accessor?: (row: T) => ReactNode
  width?: string | number
  align?: 'left' | 'center' | 'right'
  sortable?: boolean
}

export type TableProps<T> = {
  columns: TableColumn<T>[]
  data: T[]
  keyExtractor: (row: T, index: number) => string
  onRowClick?: (row: T) => void
  selectedRows?: Set<string>
  onSelectRows?: (keys: Set<string>) => void
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  onSort?: (columnId: string) => void
  className?: string
  emptyMessage?: string
}

export function Table<T>(props: TableProps<T>) {
  const { columns, data, keyExtractor, onRowClick, selectedRows, onSelectRows, sortBy, sortOrder, onSort, className, emptyMessage } = props

  const allKeys = useMemo(() => data.map((row, idx) => keyExtractor(row, idx)), [data, keyExtractor])
  const allSelected = selectedRows && selectedRows.size > 0 && allKeys.every((k) => selectedRows.has(k))

  function toggleAll() {
    if (!onSelectRows) return
    if (allSelected) {
      onSelectRows(new Set())
    } else {
      onSelectRows(new Set(allKeys))
    }
  }

  return (
    <div className={cn('ui-table', className)}>
      <div className="ui-tableHeader">
        {onSelectRows ? (
          <div className="ui-tableCell ui-tableCell--checkbox">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="全选" />
          </div>
        ) : null}
        {columns.map((col) => (
          <div
            key={col.id}
            className={cn('ui-tableCell', col.sortable && 'ui-tableCell--sortable', col.align && `ui-tableCell--${col.align}`)}
            style={{ width: col.width }}
            onClick={() => col.sortable && onSort?.(col.id)}
          >
            {col.header}
            {col.sortable && sortBy === col.id ? <span className="ui-tableSortIcon">{sortOrder === 'asc' ? '↑' : '↓'}</span> : null}
          </div>
        ))}
      </div>
      {data.length === 0 ? (
        <div className="ui-tableEmpty">{emptyMessage || '暂无数据'}</div>
      ) : (
        <div className="ui-tableBody">
          {data.map((row, idx) => {
            const key = keyExtractor(row, idx)
            const selected = selectedRows?.has(key)
            return (
              <div
                key={key}
                className={cn('ui-tableRow', selected && 'ui-tableRow--selected', onRowClick && 'ui-tableRow--clickable')}
                onClick={() => onRowClick?.(row)}
              >
                {onSelectRows ? (
                  <div className="ui-tableCell ui-tableCell--checkbox">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) => {
                        e.stopPropagation()
                        const next = new Set(selectedRows)
                        if (next.has(key)) next.delete(key)
                        else next.add(key)
                        onSelectRows(next)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`选择行 ${key}`}
                    />
                  </div>
                ) : null}
                {columns.map((col) => (
                  <div
                    key={col.id}
                    className={cn('ui-tableCell', col.align && `ui-tableCell--${col.align}`)}
                    style={{ width: col.width }}
                  >
                    {col.accessor ? col.accessor(row) : null}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
