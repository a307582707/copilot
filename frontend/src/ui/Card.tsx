import type { HTMLAttributes } from 'react'
import { cn } from './cn'

export function Card(props: HTMLAttributes<HTMLDivElement>) {
  const { className, ...rest } = props
  return <div {...rest} className={cn('ui-card', className)} />
}


