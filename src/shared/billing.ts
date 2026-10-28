/**
 * Provider 计费模式：
 * - metered：按量计费（DeepSeek / OpenAI / OpenCode 余额等），用美元估算 + 预算硬停；
 * - subscription：套餐内计费（OpenCode Go），不按请求额外扣费，美元只是标价估算，
 *   因此不做美元预算硬停，界面显示「套餐内 · 已用 N 轮」。
 */
export type BillingMode = 'metered' | 'subscription'

const SUBSCRIPTION_PROVIDERS = new Set(['opencode-go'])

export function providerBilling(providerId: string | null | undefined): BillingMode {
  if (!providerId) return 'metered'
  return SUBSCRIPTION_PROVIDERS.has(providerId) ? 'subscription' : 'metered'
}

/** 套餐内不硬停：token 用量仍统计，但不按美元预算拒绝请求 */
export function shouldEnforceBudget(billing: BillingMode): boolean {
  return billing === 'metered'
}
