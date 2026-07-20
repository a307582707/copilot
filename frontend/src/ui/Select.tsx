import type { SelectHTMLAttributes } from 'react'
import { cn } from './cn'

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props
  return <select {...rest} className={cn('ui-select', className)} />
}


