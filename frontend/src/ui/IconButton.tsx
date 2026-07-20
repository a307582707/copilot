import type { ButtonHTMLAttributes } from 'react'
import { cn } from './cn'
import { Button } from './Button'

export function IconButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'primary' | 'danger' | 'ghost'
    size?: 'md' | 'sm'
  },
) {
  const { className, children, variant, size, ...rest } = props
  return (
    <Button {...rest} variant={variant} size={size} className={cn('ui-iconBtn', className)}>
      {children}
    </Button>
  )
}
