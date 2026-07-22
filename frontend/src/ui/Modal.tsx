import type { HTMLAttributes, PropsWithChildren, ReactNode } from 'react'
import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'

export type ModalSize = 'sm' | 'md' | 'lg'

export function Modal(
  props: PropsWithChildren<{
    open: boolean
    title?: ReactNode
    /**
     * Fallback label when title is not a plain string.
     * Prefer passing a real `title` for visible UI.
     */
    ariaLabel?: string
    size?: ModalSize
    onClose: () => void
    footer?: ReactNode
    className?: string
    overlayClassName?: string
  }>,
) {
  const { open, title, ariaLabel, size = 'md', onClose, footer, className, overlayClassName, children } = props
  const labelId = useId()
  const prevOverflowRef = useRef<string>('')

  useEffect(() => {
    if (!open) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)

    // Lock scroll: prevent background page from moving.
    try {
      prevOverflowRef.current = document.body.style.overflow || ''
      document.body.style.overflow = 'hidden'
    } catch {
      // ignore
    }

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      try {
        document.body.style.overflow = prevOverflowRef.current
      } catch {
        // ignore
      }
    }
  }, [open, onClose])

  if (!open) return null

  const aria = ariaLabel || (typeof title === 'string' ? title : undefined) || '弹窗'

  return createPortal(
    <>
      <div className={cn('ui-modalOverlay', overlayClassName)} aria-hidden="true" onClick={onClose} />
      <div
        className={cn('ui-modal', size === 'sm' && 'ui-modal--sm', size === 'lg' && 'ui-modal--lg', className)}
        role="dialog"
        aria-modal="true"
        aria-label={aria}
        aria-labelledby={title ? labelId : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <div className="ui-modalHeader">
            <div className="ui-modalTitle" id={labelId}>
              {title}
            </div>
            <button className="ui-modalClose" type="button" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </div>
        ) : null}

        <div className="ui-modalBody">{children}</div>

        {footer ? <div className="ui-modalFooter">{footer}</div> : null}
      </div>
    </>,
    document.body,
  )
}

export function ModalSection(props: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  const { className, ...rest } = props
  return <div {...rest} className={cn('ui-modalSection', className)} />
}

