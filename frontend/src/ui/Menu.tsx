import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react'
import { cn } from './cn'

export function Menu(props: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  const { className, ...rest } = props
  return <div {...rest} className={cn('ui-menu', className)} />
}

export function MenuItem(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    danger?: boolean
  },
) {
  const { className, danger, ...rest } = props
  return <button {...rest} className={cn('ui-menuItem', danger && 'ui-menuItemDanger', className)} />
}


