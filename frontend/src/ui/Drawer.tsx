import type { PropsWithChildren, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'

export function Drawer(
  props: PropsWithChildren<{
    open: boolean
    title?: ReactNode
    ariaLabel?: string
    onClose: () => void
    footer?: ReactNode
    hideClose?: boolean
    className?: string
    overlayClassName?: string
    width?: number | string
  }>,
) {
  const { open, title, ariaLabel, onClose, footer, hideClose, className, overlayClassName, width, children } = props
  const prevOverflowRef = useRef<string>('')

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    try {
      prevOverflowRef.current = document.body.style.overflow || ''
      document.body.style.overflow = 'hidden'
    } catch {}
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      try {
        document.body.style.overflow = prevOverflowRef.current
      } catch {}
    }
  }, [open, onClose])

  if (!open) return null
  const aria = ariaLabel || (typeof title === 'string' ? title : undefined) || '抽屉'

  return createPortal(
    <>
      <div className={cn('ui-drawerOverlay', overlayClassName)} aria-hidden="true" onClick={onClose} />
      <div
        className={cn('ui-drawer', className)}
        role="dialog"
        aria-modal="true"
        aria-label={aria}
        style={width ? { width } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <div className="ui-drawerHeader">
            <div className="ui-drawerTitle">{title}</div>
            {!hideClose ? (
              <button className="ui-drawerClose" type="button" onClick={onClose} aria-label="关闭">
                ✕
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="ui-drawerBody">{children}</div>
        {footer ? <div className="ui-drawerFooter">{footer}</div> : null}
      </div>
    </>,
    document.body,
  )
}

