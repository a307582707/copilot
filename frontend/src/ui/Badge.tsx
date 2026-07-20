import type { HTMLAttributes } from 'react'
import { cn } from './cn'

export function Badge(props: HTMLAttributes<HTMLSpanElement>) {
  const { className, ...rest } = props
  return <span {...rest} className={cn('ui-badge', className)} />
}


