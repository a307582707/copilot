import type { ReactNode } from 'react'
import { cn } from './cn'

export type TabItem = {
  id: string
  label: ReactNode
  disabled?: boolean
}

export function Tabs(props: {
  items: TabItem[]
  value: string
  onChange: (id: string) => void
  className?: string
  ariaLabel?: string
}) {
  const { items, value, onChange, className, ariaLabel } = props
  return (
    <div className={cn('ui-tabs', className)} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.id}
          className={cn('ui-tabsItem', value === item.id && 'ui-tabsItem--active')}
          onClick={() => !item.disabled && onChange(item.id)}
          disabled={item.disabled}
          role="tab"
          aria-selected={value === item.id}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
