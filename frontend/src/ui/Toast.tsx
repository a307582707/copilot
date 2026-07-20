import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'

export type ToastTone = 'success' | 'error' | 'warning' | 'info'

export type ToastOptions = {
  id: string
  message: string
  tone?: ToastTone
  duration?: number
  actionLabel?: string
  onAction?: () => void
}

export function Toast(props: ToastOptions & { onClose: () => void }) {
  const { id, message, tone = 'info', actionLabel, onAction, onClose } = props
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
  }, [])

  function handleClose() {
    setVisible(false)
    setTimeout(onClose, 200)
  }

  return createPortal(
    <div
      className={cn('ui-toast', visible && 'ui-toast--visible', `ui-toast--${tone}`)}
      role="alert"
      aria-live="polite"
    >
      <div className="ui-toastContent">{message}</div>
      <div className="ui-toastActions">
        {actionLabel && onAction ? (
          <button className="ui-toastAction" type="button" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
        <button className="ui-toastClose" type="button" onClick={handleClose} aria-label="关闭">
          ✕
        </button>
      </div>
    </div>,
    document.body,
  )
}

export function ToastContainer(props: { toasts: ToastOptions[]; onRemove: (id: string) => void }) {
  const { toasts, onRemove } = props
  return (
    <>
      {toasts.map((t) => (
        <Toast key={t.id} {...t} onClose={() => onRemove(t.id)} />
      ))}
    </>
  )
}
