import { createRoot } from 'react-dom/client'
import './index.css'
import './ui/styles.css'
import RouterApp from './RouterApp.tsx'
import { ErrorBoundary } from './site/shared/ErrorBoundary'
import { bootTheme } from './theme/bootTheme'

bootTheme()

// Build bust: used to force a unique hashed asset filename per deploy.
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __FRONTEND_BUILD_BUST__: string
try {
  ;(window as any).__FRONTEND_BUILD_BUST__ = __FRONTEND_BUILD_BUST__
} catch {
  // ignore
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <RouterApp />
  </ErrorBoundary>,
)

try {
  ;(window as any).__APP_BOOTED__ = true
  ;(window as any).__hideBootFallback__?.()
} catch {
  // ignore
}
