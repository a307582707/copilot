export type BillingPlanKey = 'pro' | 'team'

export type BillingPlanSpec = {
  key: BillingPlanKey
  label: string
  monthlyPriceCents: number
  monthlyCreditCents: number
  desc: string
  features: string[]
}

export type BillingTopUpTier = {
  payCents: number
  giftCents: number
  creditCents: number
}

export const BILLING_PLANS: BillingPlanSpec[] = [
  {
    key: 'pro',
    label: 'Beta 试用',
    monthlyPriceCents: 0,
    monthlyCreditCents: 3000,
    desc: '受控免费试运营，按账号发放有限 Beta 额度。',
    features: ['免费 Beta 名额有限', '模型调用扣减 Beta 额度', '额度用完后等待补发'],
  },
  {
    key: 'team',
    label: 'Beta 团队候补',
    monthlyPriceCents: 0,
    monthlyCreditCents: 0,
    desc: '团队与更高上限将在试运营稳定后开放。',
    features: ['暂不公开收费', '暂不开放自动续费', '需人工评估后扩大额度'],
  },
]

export const BILLING_TOP_UP_TIERS: BillingTopUpTier[] = [
  { payCents: 9900, giftCents: 3000, creditCents: 12900 },
  { payCents: 19900, giftCents: 8000, creditCents: 27900 },
  { payCents: 49900, giftCents: 25000, creditCents: 74900 },
]

export function getBillingPlanSpec(plan: string | null | undefined): BillingPlanSpec {
  const key = String(plan || 'pro').trim().toLowerCase()
  return BILLING_PLANS.find((item) => item.key === key) || BILLING_PLANS[0]
}

export function formatCnyFromCents(cents: number, opts?: { stripZero?: boolean }) {
  const value = `¥${(Number(cents || 0) / 100).toFixed(2)}`
  return opts?.stripZero ? value.replace(/\.00$/, '') : value
}
