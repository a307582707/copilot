import { useEffect } from 'react'
import type { CSSProperties } from 'react'

export function LoginRequiredModal(props: {
  open: boolean
  title: string
  message: string
  confirmText: string
  cancelText: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    if (!props.open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') props.onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [props])

  if (!props.open) return null
  const msg = props.message.includes('\\n') ? props.message.replaceAll('\\n', '\n') : props.message

  return (
    <div style={overlay} onMouseDown={props.onCancel}>
      <div style={card} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>{props.title}</div>
            <div
              style={{
                marginTop: 8,
                color: '#64748b',
                lineHeight: 1.6,
                fontSize: 14,
                whiteSpace: 'pre-wrap',
              }}
            >
              {msg}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, paddingTop: 4, flexWrap: 'wrap' }}>
            <button type="button" style={btnGhost} onClick={props.onCancel}>
              {props.cancelText}
            </button>
            <button type="button" style={btnPrimary} onClick={props.onConfirm}>
              {props.confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  // Pure dimming, NO blur, to ensure background content remains 100% sharp.
  background: 'rgba(15,23,42,0.18)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  zIndex: 1000,
  animation: 'fadeIn 0.2s ease-out',
}

const card: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: 400,
  borderRadius: 16,
  border: '1px solid #e2e8f0',
  background: '#ffffff',
  boxShadow: '0 24px 48px rgba(15,23,42,0.14)',
  padding: 24,
  transform: 'translateY(0)',
  animation: 'slideUp 0.2s ease-out',
}

const btnGhost: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 36,
  minWidth: 88,
  padding: '0 16px',
  borderRadius: 10,
  border: '1px solid #e2e8f0',
  background: '#ffffff',
  cursor: 'pointer',
  color: '#475569',
  fontSize: 13,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  transition: 'all 0.15s',
}

const btnPrimary: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 36,
  minWidth: 88,
  padding: '0 20px',
  borderRadius: 10,
  border: '1px solid rgba(124,92,255,0.16)',
  // Brand gradient
  background: 'linear-gradient(135deg, #7C5CFF 0%, #5C4EFF 100%)',
  boxShadow: '0 4px 12px rgba(92, 78, 255, 0.25)',
  cursor: 'pointer',
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  transition: 'all 0.15s',
}


