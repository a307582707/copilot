import type { ReactNode } from 'react'
import React from 'react'

type Props = {
  children: ReactNode
}

type State = {
  error: Error | null
}

function toError(e: unknown): Error {
  if (e instanceof Error) return e
  return new Error(typeof e === 'string' ? e : JSON.stringify(e))
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: toError(error) }
  }

  componentDidCatch(error: unknown) {
    const err = toError(error)
    try {
      // eslint-disable-next-line no-console
      console.error('[ErrorBoundary]', err)
      ;(window as any).__showBootError__?.(err.message, err.stack || '')
    } catch {
      // ignore
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    const msg = this.state.error.message || 'Unknown error'
    const stack = this.state.error.stack || ''
    const showDetails = Boolean((import.meta as any)?.env?.DEV)
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 18,
          background: 'linear-gradient(135deg, rgb(6, 10, 20), rgb(5, 18, 14))',
          color: 'rgba(255,255,255,0.92)',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: 820,
            width: '100%',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(15,22,33,0.78)',
            boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
            padding: 16,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 850, marginBottom: 10 }}>页面发生错误</div>
          <div style={{ opacity: 0.85, lineHeight: 1.6 }}>
            <div style={{ marginBottom: 8 }}>页面运行时遇到异常，请刷新重试；如果反复出现，请联系管理员。</div>
            <div
              style={{
                borderRadius: 12,
                border: '1px solid rgba(255,85,85,0.30)',
                background: 'rgba(255,85,85,0.08)',
                padding: 12,
                fontSize: 13,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {showDetails ? `${msg}${stack ? `\n\n${stack}` : ''}` : msg}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            <a
              href="/"
              style={{
                padding: '8px 12px',
                borderRadius: 12,
                border: '1px solid rgba(124,92,255,0.55)',
                background: 'rgba(124,92,255,0.14)',
                color: 'rgba(255,255,255,0.92)',
                textDecoration: 'none',
                fontWeight: 850,
              }}
            >
              返回首页
            </a>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 12px',
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.04)',
                cursor: 'pointer',
                color: 'rgba(255,255,255,0.92)',
                fontWeight: 800,
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    )
  }
}




