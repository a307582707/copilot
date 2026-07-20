import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { LoginRequiredModal } from './LoginRequiredModal'

export function ProductGate(props: {
  children: ReactNode
  title?: string
  message?: string
  loadingText?: string
  unauthText?: string
}) {
  const loc = useLocation()
  const nav = useNavigate()
  const [state, setState] = useState<'loading' | 'ok' | 'unauth'>('loading')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/me', { headers: { Accept: 'application/json' }, credentials: 'include' })
        if (!cancelled) setState(r.ok ? 'ok' : 'unauth')
      } catch {
        if (!cancelled) setState('unauth')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'loading') {
    return <div style={gateTextStyle}>{props.loadingText || '正在验证登录态…'}</div>
  }

  if (state === 'unauth') {
    const next = encodeURIComponent(loc.pathname + loc.search)
    return (
      <>
        <div style={gateTextStyle}>{props.unauthText || '需要登录后才能进入网页版。'}</div>
        <LoginRequiredModal
          open
          title={props.title || '需要登录'}
          message={props.message || '请先登录后再进入网页版工作区。'}
          confirmText="立即登录"
          cancelText="返回首页"
          onConfirm={() => nav(`/auth/login?next=${next}`)}
          onCancel={() => nav('/', { replace: true })}
        />
      </>
    )
  }

  return <>{props.children}</>
}

const gateTextStyle: CSSProperties = {
  minHeight: '100vh',
  padding: 24,
  color: '#334155',
  background: 'linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)',
}


