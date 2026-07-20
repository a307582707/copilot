import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react'
import { cn } from './cn'

export type StatusTone = 'ok' | 'warn' | 'err' | 'neutral'

export function StatusPill(
  props: PropsWithChildren<
    ButtonHTMLAttributes<HTMLButtonElement> & {
      tone?: StatusTone
      left?: ReactNode
    }
  >,
) {
  const { className, tone = 'neutral', left, children, ...rest } = props
  return (
    <button
      {...rest}
      className={cn(
        'ui-statusPill',
        tone === 'ok' && 'ui-statusPill--ok',
        tone === 'warn' && 'ui-statusPill--warn',
        tone === 'err' && 'ui-statusPill--err',
        className,
      )}
      type={rest.type || 'button'}
    >
      <span className={cn('ui-statusDot', tone === 'ok' && 'ui-statusDot--ok', tone === 'warn' && 'ui-statusDot--warn', tone === 'err' && 'ui-statusDot--err')} />
      {left ? <span className="ui-statusLeft">{left}</span> : null}
      <span className="ui-statusText">{children}</span>
    </button>
  )
}

