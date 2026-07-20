import type { ReactNode } from 'react'
import { Modal } from './Modal'

export type ConfirmDialogTone = 'danger' | 'default'

export function ConfirmDialog(props: {
  open: boolean
  title: ReactNode
  description?: ReactNode
  confirmText?: string
  cancelText?: string
  tone?: ConfirmDialogTone
  onCancel: () => void
  onConfirm: () => void
}) {
  const { open, title, description, confirmText = '删除', cancelText = '取消', tone = 'danger', onCancel, onConfirm } = props
  return (
    <Modal
      open={open}
      title={title}
      ariaLabel={typeof title === 'string' ? title : '确认操作'}
      size="sm"
      onClose={onCancel}
      className="ui-confirmModal"
      footer={
        <div className="ui-confirmActions">
          <button className="btn" type="button" onClick={onCancel}>
            {cancelText}
          </button>
          <button className={tone === 'danger' ? 'btn btnDanger' : 'btn btnPrimary'} type="button" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      }
    >
      {description ? <div className="ui-confirmDesc">{description}</div> : null}
    </Modal>
  )
}

