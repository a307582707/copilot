import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'
export type ButtonSize = 'md' | 'sm'

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant
    size?: ButtonSize
    leftIcon?: ReactNode
  },
) {
  const { className, variant = 'default', size = 'md', leftIcon, children, ...rest } = props

  return (
    <button
      {...rest}
      className={cn(
        'ui-btn',
        variant === 'primary' && 'ui-btn--primary',
        variant === 'danger' && 'ui-btn--danger',
        variant === 'ghost' && 'ui-btn--ghost',
        size === 'sm' && 'ui-btn--sm',
        className,
      )}
    >
      {leftIcon ? <span style={{ display: 'inline-flex', alignItems: 'center' }}>{leftIcon}</span> : null}
      {children}
    </button>
  )
}


