import type { HTMLAttributes, PropsWithChildren, ReactNode } from 'react'
import { cn } from './cn'

export function ListRow(
  props: PropsWithChildren<
    HTMLAttributes<HTMLDivElement> & {
      title?: ReactNode
      meta?: ReactNode
      actions?: ReactNode
    }
  >,
) {
  const { className, title, meta, actions, children, ...rest } = props
  return (
    <div {...rest} className={cn('ui-row', className)}>
      <div className="ui-rowMain">
        {title ? <div className="ui-rowTitle">{title}</div> : null}
        {meta ? <div className="ui-rowMeta">{meta}</div> : null}
        {children}
      </div>
      {actions ? <div className="ui-rowActions">{actions}</div> : null}
    </div>
  )
}

