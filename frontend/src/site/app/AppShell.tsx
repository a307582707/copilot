import { Link, Route, Routes, useLocation } from 'react-router-dom'
import ChatApp from '../../App'

function Tab(props: { to: string; label: string }) {
  const loc = useLocation()
  const active = loc.pathname === props.to || (props.to !== '/app' && loc.pathname.startsWith(props.to))
  return (
    <Link
      to={props.to}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 36,
        padding: '0 12px',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.10)',
        background: active ? 'rgba(124,92,255,0.12)' : 'rgba(255,255,255,0.03)',
        textDecoration: 'none',
        color: 'rgba(255,255,255,0.92)',
        fontWeight: 850,
      }}
    >
      {props.label}
    </Link>
  )
}

export function AppShell() {
  return (
    <div>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '16px 18px 0' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Tab to="/app" label="聊天/工作区" />
          <div style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }} />
        </div>
      </div>

      <Routes>
        <Route path="/" element={<ChatApp />} />
      </Routes>
    </div>
  )
}

