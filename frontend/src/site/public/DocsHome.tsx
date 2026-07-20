import { Link, Route, Routes } from 'react-router-dom'
import { PublicLayout } from './layout'

function DocPage(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '40px 18px 60px' }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: '#0f172a', letterSpacing: -0.5 }}>{props.title}</div>
      <div style={{ marginTop: 14, color: '#475569', lineHeight: 1.9, fontSize: 15 }}>{props.children}</div>
    </div>
  )
}

export function DocsHome() {
  return (
    <PublicLayout>
      <Routes>
        <Route
          path="/"
          element={
            <DocPage title="帮助中心">
              <div>这里是 Covixa 的文档入口，优先覆盖注册、免费 Beta、客户端下载和日常使用这些最常用的内容。</div>
              <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                <Box to="/docs/getting-started" title="快速开始" desc="注册登录、试用、网页版与客户端使用。" />
                <Box to="/docs/billing" title="Beta 额度" desc="免费试运营、额度扣减、补发和正式收费节奏。" />
                <Box to="/docs/publish" title="版本发布说明" desc="如何发布客户端、生成版本清单与校验值。" />
                <Box to="/docs/security" title="安全与隐私" desc="账号安全、密钥与数据最小化原则。" />
              </div>
            </DocPage>
          }
        />
        <Route path="/getting-started" element={<GettingStarted />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/publish" element={<Publish />} />
        <Route path="/security" element={<Security />} />
        <Route path="/contact" element={<Contact />} />
      </Routes>
    </PublicLayout>
  )
}

function Box(props: { to: string; title: string; desc: string }) {
  return (
    <Link
      to={props.to}
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        padding: 16,
        background: '#ffffff',
        display: 'block',
        textDecoration: 'none',
        color: 'inherit',
        boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
        transition: 'border-color 120ms ease, box-shadow 120ms ease',
      }}
    >
      <div style={{ fontWeight: 600, color: '#0f172a', fontSize: 15 }}>{props.title}</div>
      <div style={{ marginTop: 6, color: '#64748b', fontSize: 13, lineHeight: 1.7 }}>{props.desc}</div>
    </Link>
  )
}

function GettingStarted() {
  return (
    <DocPage title="快速开始">
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        <li>注册账号并登录。</li>
        <li>进入网页版：`/app`。</li>
        <li>下载客户端：`/download`。</li>
        <li>登录后可在 Web 与客户端间使用同一账号和 Beta 额度。</li>
        <li>如需对接本地模型，可在客户端配置 API Base URL。</li>
      </ol>
    </DocPage>
  )
}

function Billing() {
  return (
    <DocPage title="Beta 额度">
      <div>Covixa 当前是受控免费 Beta，不公开收费、不开放在线充值。额度用于限制模型调用和资源消耗。</div>
      <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
        <li>初始额度：注册后自动发放一笔有限 Beta 额度。</li>
        <li>扣减规则：模型调用会按字符估算消耗，从额度中扣减。</li>
        <li>补发规则：额度用完后等待下一轮开放，或由管理员按试运营情况人工补发。</li>
      </ul>
    </DocPage>
  )
}

function Publish() {
  return (
    <DocPage title="版本发布说明">
      <div>下载页展示版本号的核心做法：发布时生成一份 releases 清单（JSON），由后端 `/api/public/releases` 输出。</div>
      <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
        <li>发布产物：Windows 安装器（installer）与绿色版（portable）。</li>
        <li>生成校验：SHA256（用于下载校验）。</li>
        <li>清单字段：版本号、文件名、URL、SHA256、大小、发布时间。</li>
      </ul>
    </DocPage>
  )
}

function Security() {
  return (
    <DocPage title="安全与隐私">
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>当前不公开收费；后续接入支付时，商户密钥仅在服务端配置，前端与客户端不包含任何商户密钥。</li>
        <li>最小权限：后台接口需要管理员角色，用户接口需要登录态。</li>
        <li>审计字段：额度发放、人工补发和模型扣费流水记录创建时间、操作者与关键状态变更。</li>
      </ul>
    </DocPage>
  )
}

function Contact() {
  return (
    <DocPage title="联系我们">
      <div>（占位）后续可放企业微信、邮箱、工单入口。</div>
    </DocPage>
  )
}



