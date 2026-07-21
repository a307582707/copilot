import { Link, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { PublicLayout } from './layout'
import { LoginRequiredModal } from '../auth/LoginRequiredModal'
import { DASHBOARD_ENABLED } from '../../flags'

const HOME_MODELS = ['GPT-5.4', 'Claude 4.6', 'Gemini 3.1', 'DeepSeek', '更多模型']

const HOME_TRUST_BADGES = ['免费 Beta', '额度上限', '数据加密传输']

export function HomePage() {
  const nav = useNavigate()
  const homePlans = [
    {
      name: 'Beta 试用',
      price: '免费受控',
      desc: '第一阶段不公开收费，按账号发放有限 Beta 额度。',
      items: ['注册后获得初始 Beta 额度', '模型调用从额度中扣减', '额度用完后等待补发或下一轮开放'],
      cta: '查看规则',
      hot: true,
    },
    {
      name: '成本保护',
      price: '硬上限',
      desc: '单用户、单日、单月和全站预算都有闸门。',
      items: ['限制并发模型请求', '限制单次输出长度', '达到全站预算后暂停新请求'],
      cta: '了解限制',
    },
    {
      name: '后续付费',
      price: '暂未开放',
      desc: '支付、退款和客服 SOP 跑通前，不开放在线收费。',
      items: ['先验证真实使用成本', '后台可人工补发 Beta 额度', '付费套餐后续再发布'],
      cta: '查看路线',
    },
  ]
  const [needLogin, setNeedLogin] = useState(false)
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [meLabel, setMeLabel] = useState<string>('')
  const [meEmail, setMeEmail] = useState<string>('')
  const [plan, setPlan] = useState<string>('Free')
  const [proExpiresAt, setProExpiresAt] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/me', { headers: { Accept: 'application/json' }, credentials: 'include' })
        if (!cancelled) setAuthed(r.ok)
        if (r.ok) {
          const j = (await r.json().catch(() => null)) as any
          const email = String(j?.user?.email || '').trim()
          if (!cancelled) setMeEmail(email)
          const at = email.indexOf('@')
          const masked = email && at > 2 ? `${email.slice(0, 2)}***${email.slice(at)}` : email
          if (!cancelled) setMeLabel(masked)
          try {
            const b = await fetch('/api/me/billing', { headers: { Accept: 'application/json' }, credentials: 'include' })
            const bj = (await b.json().catch(() => null)) as any
            const p = (bj?.plan || bj?.billing?.plan || '').toString()
            const expiresAtRaw = bj?.expires_at ?? bj?.billing?.expires_at ?? null
            const expiresAt = typeof expiresAtRaw === 'number' ? expiresAtRaw : null
            if (!cancelled) {
              setPlan(p ? p : 'Free')
              setProExpiresAt(expiresAt)
            }
          } catch {
            // ignore
          }
        } else {
          if (!cancelled) setMeLabel('')
          if (!cancelled) setMeEmail('')
        }
      } catch {
        if (!cancelled) setAuthed(false)
        if (!cancelled) setMeLabel('')
        if (!cancelled) setMeEmail('')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <PublicLayout>
      <LoginRequiredModal
        open={needLogin}
        title="需要登录"
        message="欢迎使用 CodeSprite。\n请先登录后再进入网页版 AI 工作区。"
        confirmText="立即登录"
        cancelText="取消"
        onCancel={() => setNeedLogin(false)}
        onConfirm={() => nav('/auth/login?next=%2Fapp')}
      />
      {authed ? (
        <div className="lpPortal" style={{ padding: '32px 18px 70px', background: '#f8fafc' }}>
          <div style={{ maxWidth: 1180, margin: '0 auto' }}>
            {/* Portal Hero card */}
            <div className="lpPortalHero">
              <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>
                {`${timeGreeting()}，${displayName(meEmail) || meLabel || '朋友'}`}
                <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 500, color: '#94a3b8' }}>
                  {planLabel(plan)}
                </span>
              </div>
              <div style={{ marginTop: 8, fontSize: 14, color: '#64748b' }}>准备开始使用 CodeSprite 了吗？</div>

              <div className="lpPortalActions" style={{ marginTop: 16 }}>
                <button type="button" className="lpBtn lpBtnPrimary" onClick={() => nav('/app')}>
                  {DASHBOARD_ENABLED ? '进入控制台' : '进入工作区'}
                </button>
                <a href="/me/billing" target="_blank" rel="noreferrer" className="lpBtn lpBtnGhost">
                  查看 Beta 额度
                </a>
              </div>
            </div>

            {/* Feed cards */}
            <div className="lpPortalGrid" style={{ marginTop: 14 }}>
              <div className="lpPortalCard">
                <div className="lpPortalCardTitle">最新动态</div>
                <ul className="lpPortalList">
                  <li>v1.2.0 多云同步发布</li>
                  {DASHBOARD_ENABLED ? <li>新增：控制台首页（快捷操作 + 最近访问）</li> : null}
                  <li>优化：注册滑块安全验证与短信限流</li>
                </ul>
              </div>
              <div className="lpPortalCard">
                <div className="lpPortalCardTitle">使用概览</div>
                <ul className="lpPortalList">
                  <li>资产数：—</li>
                  <li>活跃工作区：—</li>
                  <li>
                    Beta：{String(plan || '').toLowerCase().includes('pro') ? '已开通' : '试用中'}
                    {proExpiresAt ? `（到期：${new Date(proExpiresAt * 1000).toISOString().slice(0, 10)}）` : ''}
                  </li>
                </ul>
                <div style={{ marginTop: 10, fontSize: 12, color: '#94a3b8' }}>使用统计稍后接入后台数据。</div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 18px 70px' }}>
          <section className="lpAiHero">
            <div className="lpAiHeroGlow" />
            <div className="lpAiHeroInner">
              <div className="lpBadge">CodeSprite 免费 Beta：名额有限，额度可控</div>
              <h1 className="lpAiHeroTitle">一站式多模型 AI 能力平台</h1>
              <div className="lpAiHeroDesc">
                支持 GPT、Claude、Gemini、DeepSeek 等主流模型能力。当前处于受控免费 Beta，按账号发放有限额度，先验证稳定性和真实成本。
              </div>
              <div className="lpAiModels">
                {HOME_MODELS.map((model) => (
                  <span key={model}>{model}</span>
                ))}
              </div>
              <div className="lpHeroCtas" style={{ marginTop: 26, display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
                <Link to="/auth/register" className="lpBtn lpBtnPrimary">
                  🚀 申请 Beta 试用
                </Link>
                <Link to="/pricing" className="lpBtn lpBtnGhost" style={{ position: 'relative', zIndex: 2 }}>
                  查看 Beta 规则
                </Link>
              </div>
              <div className="lpAiHeroHint">
                想了解更多？去 <Link to="/product" style={{ textDecoration: 'underline', opacity: 0.92 }}>产品页</Link> 看完整介绍。
              </div>
            </div>
          </section>

          <section className="lpAiPlans">
            {homePlans.map((item) => (
              <div key={item.name} className={item.hot ? 'lpAiPlanCard lpAiPlanCardHot' : 'lpAiPlanCard'}>
                {item.hot ? <div className="lpAiPlanTag">推荐</div> : null}
                <div className="lpAiPlanName">{item.name}</div>
                <div className="lpAiPlanPrice">
                  {item.price}
                </div>
                <div className="lpAiPlanMeta">{item.desc}</div>
                <ul className="lpAiPlanList">
                  {item.items.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <Link to="/pricing" className="lpAiPlanBtn">
                  {item.cta}
                </Link>
              </div>
            ))}
          </section>

          <section className="lpAiTrust">
            <div className="lpAiTrustBadges">
              {HOME_TRUST_BADGES.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            <div className="lpAiTrustText">当前不公开收费；Beta 额度只用于控制模型调用和资源消耗，避免免费试运营阶段成本失控。</div>
          </section>
        </div>
      )}
    </PublicLayout>
  )
}

function timeGreeting() {
  const h = new Date().getHours()
  if (h < 6) return '凌晨好'
  if (h < 12) return '上午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function displayName(email: string) {
  const e = (email || '').trim()
  if (!e) return ''
  const at = e.indexOf('@')
  if (at <= 0) return e
  return e.slice(0, at)
}

function planLabel(plan: string) {
  const p = (plan || '').toLowerCase()
  if (!p) return 'Free'
  if (p.includes('pro')) return 'Pro'
  return plan
}



