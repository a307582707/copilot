import { Link } from 'react-router-dom'
import { PublicLayout } from './layout'

export function PricingPage() {
  return (
    <PublicLayout>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 18px 60px' }}>
        <div>
          <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: -0.8, color: '#0f172a' }}>Covixa 免费 Beta 规则</div>
          <div style={{ marginTop: 10, fontSize: 16, lineHeight: 1.75, color: '#64748b' }}>
            当前阶段不公开收费、不开放在线充值。每个 Beta 用户会获得有限试用额度，模型调用从额度中扣减；达到个人或全站预算后会暂停新请求。
          </div>
        </div>

        <div className="pricingGrid" style={{ marginTop: 18 }}>
          <PlanCard
            title="Beta 试用"
            price="免费受控"
            desc="适合第一批真实用户验证模型能力、稳定性和成本。"
            items={['注册后发放初始 Beta 额度', '额度只用于试运营消耗控制', '额度用完后等待补发或下一轮开放']}
            cta={{ to: '/auth/register', label: '申请试用' }}
            highlight
          />
          <PlanCard
            title="费用闸门"
            price="硬上限"
            desc="先把成本和滥用风险关住，再讨论正式售卖。"
            items={['单用户日/月预算', '全站每日预算', '单次输出长度和并发限制']}
            cta={{ to: '/auth/register', label: '进入 Beta' }}
          />
          <PlanCard
            title="正式收费"
            price="暂未开放"
            desc="支付、退款、客服和对账 SOP 完成后再发布正式套餐。"
            items={['暂不承诺自动续费', '暂不开放公开充值', '后台仅保留人工补发 Beta 额度']}
            cta={{ to: '/docs', label: '查看文档' }}
          />
        </div>

        <div className="pricingTableWrap" style={{ marginTop: 18 }}>
          <div className="pricingTableTitle">试运营限制</div>
          <table className="pricingTable">
            <thead>
              <tr>
                <th>限制项</th>
                <th>Beta 默认行为</th>
                <th>目的</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>初始额度</td>
                <td>注册后自动发放一笔 Beta 额度</td>
                <td>避免无限免费消耗</td>
              </tr>
              <tr>
                <td>每日预算</td>
                <td>单用户和全站都有每日上限</td>
                <td>防止短时间成本失控</td>
              </tr>
              <tr>
                <td>单次输出</td>
                <td>达到输出上限后自动截断</td>
                <td>控制长回答和异常请求</td>
              </tr>
              <tr>
                <td>并发请求</td>
                <td>同一账号限制同时进行的模型请求</td>
                <td>降低滥用和排队风险</td>
              </tr>
              <tr>
                <td>付费入口</td>
                <td>暂不公开收费</td>
                <td>等支付、退款和客服闭环稳定后再开放</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="pricingFAQ" style={{ marginTop: 18 }}>
          <div className="pricingTableTitle">FAQ 常见问题</div>
          <FaqItem q="现在可以付费购买吗？" a="不可以。当前是受控免费 Beta，只开放有限额度试用，不公开充值或自动续费。" />
          <FaqItem q="Beta 额度是什么？" a="它是试运营额度，用来衡量和限制模型调用消耗，不代表可提现现金余额。" />
          <FaqItem q="额度用完怎么办？" a="新请求会被拦截。你可以等待下一轮开放，或由管理员根据试运营情况手动补发额度。" />
          <FaqItem q="什么时候开放收费？" a="等支付、退款、客服、对账和成本模型都跑稳定后，再发布正式套餐。" />
        </div>

        <div style={{ marginTop: 18, opacity: 0.75, lineHeight: 1.8, fontSize: 13 }}>
          <Link to="/docs" style={{ textDecoration: 'underline', opacity: 0.9 }}>
            查看产品文档
          </Link>
        </div>
      </div>
    </PublicLayout>
  )
}

function PlanCard(props: {
  title: string
  price: string
  desc: string
  items: string[]
  cta: { to: string; label: string }
  highlight?: boolean
}) {
  const hot = props.highlight
  return (
    <div className={hot ? 'pricingCard pricingCardHot' : 'pricingCard'}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 15, color: hot ? 'rgba(255,255,255,0.6)' : '#64748b' }}>{props.title}</span>
        {hot ? (
          <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.85)', fontWeight: 600 }}>
            推荐
          </span>
        ) : null}
      </div>
      <div style={{ marginTop: 10, fontSize: 36, fontWeight: 700, letterSpacing: -1, color: hot ? '#ffffff' : '#0f172a' }}>{props.price}</div>
      <div style={{ marginTop: 6, fontSize: 13, color: hot ? 'rgba(255,255,255,0.45)' : '#94a3b8' }}>{props.desc}</div>
      <ul style={{ marginTop: 14, paddingLeft: 18, lineHeight: 1.9, fontSize: 13, color: hot ? 'rgba(255,255,255,0.70)' : '#475569' }}>
        {props.items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <Link
        to={props.cta.to}
        style={{
          marginTop: 16,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          padding: '10px 14px',
          borderRadius: 8,
          border: hot ? '1px solid rgba(255,255,255,0.18)' : '1px solid #e2e8f0',
          background: hot ? 'rgba(255,255,255,0.12)' : '#f8fafc',
          color: hot ? '#ffffff' : '#0f172a',
          fontWeight: 600,
          fontSize: 14,
          textDecoration: 'none',
          boxSizing: 'border-box',
        }}
      >
        {props.cta.label}
      </Link>
    </div>
  )
}

function FaqItem(props: { q: string; a: string }) {
  return (
    <div className="faqItem">
      <div className="faqQ">{props.q}</div>
      <div className="faqA">{props.a}</div>
    </div>
  )
}



