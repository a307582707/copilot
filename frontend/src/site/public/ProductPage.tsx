import { Link } from 'react-router-dom'
import { PublicLayout } from './layout'

export function ProductPage() {
  return (
    <PublicLayout>
      <ProductLanding />
    </PublicLayout>
  )
}

export function ProductLanding() {
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 18px 70px' }}>
      {/* Hero */}
      <div className="lpProductHero">
        <div className="lpProductHeroLeft">
          <div className="lpBadge">Covixa 免费 Beta：受控开放，多模型 AI 工作台</div>
          <div className="lpProductTitle">
            一站式多模型 AI 能力平台
            <div className="lpProductSubtitle">（Web + Client 一体化）</div>
          </div>
          <div className="lpProductDesc">
            从日常代码补全、上下文对话到团队知识复用，Covixa 先以受控免费 Beta 验证稳定性、成本和真实使用场景。
          </div>

          <div className="lpProductCtas">
            <Link to="/auth/register" className="lpBtn lpBtnPrimary">
              申请 Beta 试用
            </Link>
            <Link to="/pricing" className="lpBtn lpBtnGhost">
              查看 Beta 规则
            </Link>
          </div>
        </div>

        <div className="lpProductHeroRight">
          <div className="lpDemo">
            <div className="lpDemoTop">
              <span className="lpDot lpDotRed" />
              <span className="lpDot lpDotYellow" />
              <span className="lpDot lpDotGreen" />
              <span style={{ marginLeft: 10, opacity: 0.75, fontSize: 12 }}>演示：智能补全 / 多轮对话 / 代码解释</span>
            </div>
            <pre className="lpDemoCode">
              <code>
                {`// 选中函数，让 AI 解释逻辑并补全测试\nfunction syncBillingState(user, invoice) {\n  if (!invoice.paid) return 'pending'\n  return user.plan === 'team' ? 'team_active' : 'active'\n}\n\n// AI: 已补充边界条件说明，并生成测试建议`}
              </code>
            </pre>
          </div>
        </div>
      </div>

      {/* Core features */}
      <div className="lpSection">
        <div className="lpSectionTitle">核心特性</div>
        <div className="lpFeatureGrid">
          <FeatureCard title="⚡ 智能补全" desc="覆盖高频编码场景，减少重复输入和上下文切换。" />
          <FeatureCard title="💬 多轮上下文对话" desc="围绕代码、文档和问题单持续追问，回答更连贯。" />
          <FeatureCard title="👥 团队协作" desc="先从小规模 Beta 用户验证，再逐步扩展到团队使用。" />
        </div>
      </div>

      {/* Pain points (alternating) */}
      <div className="lpSection">
        <div className="lpSectionTitle">典型场景</div>

        <div className="lpAltRow">
          <div className="lpAltMedia">
            <div className="lpMediaBox">图：复杂代码解释</div>
          </div>
          <div className="lpAltText">
            <div className="lpAltTitle">读不懂老代码？</div>
            <div className="lpAltDesc">让 AI 基于上下文解释核心逻辑、依赖关系和潜在风险，降低接手门槛。</div>
          </div>
        </div>

        <div className="lpAltRow lpAltReverse">
          <div className="lpAltMedia">
            <div className="lpMediaBox">图：一键生成测试建议</div>
          </div>
          <div className="lpAltText">
            <div className="lpAltTitle">重复性编码太多？</div>
            <div className="lpAltDesc">从补全、重构建议到测试样例生成，把高频重复工作交给 AI 先完成第一版。</div>
          </div>
        </div>
      </div>

      {/* Trust */}
      <div className="lpSection">
        <div className="lpSectionTitle">Beta 阶段价值</div>
        <div className="lpTrust">
          当前不公开收费，用有限额度换取真实体验数据；等支付、退款、客服和成本模型跑稳后，再发布正式套餐。
        </div>
      </div>

      {/* Bottom CTA */}
      <div className="lpCtaBar">
        <div>
          <div className="lpCtaTitle">准备好开始使用 Covixa 了吗？</div>
          <div className="lpCtaDesc">现在注册即可进入受控免费 Beta，额度用完后等待补发或下一轮开放。</div>
        </div>
        <Link to="/auth/register" className="lpBtn lpBtnPrimary">
          申请试用
        </Link>
      </div>
    </div>
  )
}

function FeatureCard(props: { title: string; desc: string }) {
  return (
    <div className="lpFeatureCard">
      <div className="lpFeatureTitle">{props.title}</div>
      <div className="lpFeatureDesc">{props.desc}</div>
    </div>
  )
}




