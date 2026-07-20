import { StrictMode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import ChatApp from './App'
import { AdminGate } from './site/admin/AdminGate'
import { AdminHome } from './site/admin/AdminHome'
import { AdminLoginPage } from './site/admin/AdminLoginPage'
import { AdminOverseasPage } from './site/admin/AdminOverseasPage'
import { ProductGate } from './site/auth/ProductGate'
import { LoginPage } from './site/auth/LoginPage'
import { RegisterPage } from './site/auth/RegisterPage'
import { DownloadPage } from './site/public/DownloadPage'
import { DocsHome } from './site/public/DocsHome'
import { HomePage } from './site/public/HomePage'
import { ProductPage } from './site/public/ProductPage'
import { PricingPage } from './site/public/PricingPage'
import { MeHome } from './site/user/MeHome'

export default function RouterApp() {
  return (
    <StrictMode>
      <BrowserRouter>
        <Routes>
          {/* Public */}
          <Route path="/" element={<HomePage />} />
          <Route path="/product" element={<ProductPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/download" element={<DownloadPage />} />
          <Route path="/docs/*" element={<DocsHome />} />

          {/* Auth */}
          <Route path="/auth/login" element={<LoginPage />} />
          <Route path="/auth/register" element={<RegisterPage />} />

          {/* Product web app (existing chat UI) */}
          <Route
            path="/app/*"
            element={
              <ProductGate>
                <ChatApp />
              </ProductGate>
            }
          />
          <Route
            path="/chat/*"
            element={
              <ProductGate>
                <ChatApp />
              </ProductGate>
            }
          />

          {/* User center */}
          <Route
            path="/me/*"
            element={
              <ProductGate
                title="需要登录"
                message="请先登录后再查看个人中心、订阅和账单。"
                unauthText="需要登录后才能进入个人中心。"
              >
                <MeHome />
              </ProductGate>
            }
          />

          {/* Admin */}
          <Route path="/admin/login" element={<AdminLoginPage />} />
          {/* Admin AIOps is intentionally not exposed until the backend/admin surface is productized. */}
          <Route path="/admin/aiops/*" element={<NotFound title="功能暂未开放" message="AIOps 管理入口还没有开放给后台使用，请先返回后台总览。" />} />
          <Route
            path="/admin/overseas"
            element={
              <AdminGate>
                <AdminOverseasPage />
              </AdminGate>
            }
          />
          <Route
            path="/admin/*"
            element={
              <AdminGate>
                <AdminHome />
              </AdminGate>
            }
          />

          {/* Back-compat / simple redirects */}
          <Route path="/login" element={<Navigate to="/auth/login" replace />} />
          <Route path="/register" element={<Navigate to="/auth/register" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </StrictMode>
  )
}

function NotFound(props: { title?: string; message?: string }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)',
        color: '#0f172a',
      }}
    >
      <div style={{ width: 'min(520px, 100%)', border: '1px solid #e2e8f0', borderRadius: 20, background: '#ffffff', padding: 24, boxShadow: '0 18px 42px rgba(15,23,42,0.10)' }}>
        <div style={{ fontSize: 24, fontWeight: 900 }}>{props.title || '页面不存在'}</div>
        <div style={{ marginTop: 10, color: '#64748b', lineHeight: 1.7 }}>
          {props.message || '你访问的页面不存在，或当前版本暂未开放。'}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 18 }}>
          <a href="/" style={{ padding: '8px 12px', borderRadius: 12, background: '#0f172a', color: '#ffffff', textDecoration: 'none', fontWeight: 850 }}>
            返回首页
          </a>
          <a href="/app" style={{ padding: '8px 12px', borderRadius: 12, border: '1px solid #e2e8f0', color: '#0f172a', textDecoration: 'none', fontWeight: 850 }}>
            进入工作区
          </a>
        </div>
      </div>
    </div>
  )
}



