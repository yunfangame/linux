import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import useSWR from 'swr'

export interface Summary {
  email?: string
  plan_id?: number
  plan?: { id: number; name: string }
  u?: number
  d?: number
  transfer_enable?: number
  expired_at?: number | null
  reset_day?: number
  next_reset_at?: number
  device_limit?: number
  speed_limit?: number
}
export interface Session {
  id: string
  summary: Summary
  offline: boolean
  profileUid?: string
  syncError?: string
  needsLogin?: boolean
}
export interface NodeMetadata {
  name: string
  is_online?: boolean | number | string
  rate?: number
  tags?: string[]
}
export interface Plan {
  id: number
  name: string
  content?: string
  transfer_enable?: number
  speed_limit?: number
  device_limit?: number
  sell?: boolean | number
  renew?: boolean | number
  is_sold_out?: boolean
  [key: string]: unknown
}
export interface Order {
  trade_no: string
  status: number
  total_amount: number
  balance_amount?: number
  discount_amount?: number
  handling_amount?: number
  period: string
  created_at: number
  plan?: { name: string }
  plan_id?: number
}
export interface PaymentMethod {
  id: number
  name: string
  handling_fee_fixed?: number
  handling_fee_percent?: number
}
export interface Checkout {
  type: number
  data: string | Record<string, string>
}
export interface TrafficRecord {
  u: number
  d: number
  record_at: number
  server_rate: number
}
export interface LocalRule {
  id: string
  kind: string
  value: string
  target: string
  enabled: boolean
}
export interface UserInfo {
  email: string
  balance: number
  commission_balance: number
  remind_expire: number
  remind_traffic: number
  created_at?: number
}
export interface LoginIp {
  ip: string
  is_blocked: boolean
  login_count?: number
  last_login_at?: number | string
  location?: string
  is_current?: boolean
}
export interface InviteData {
  codes?: { code: string; created_at?: number }[]
  stat?: number[]
  commission_balance?: number
  commission_rate?: number
}
export interface CommissionRecord {
  trade_no?: string
  created_at: number
  commission_balance: number
  commission_status?: number
  get_amount?: number
}

let state: { session: Session | null; ready: boolean; error?: string } = {
  session: null,
  ready: false,
}
const listeners = new Set<() => void>()
function emit() {
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
let restoring: Promise<void> | undefined
export function restoreSession() {
  if (restoring) return restoring
  state = { ...state, ready: false, error: undefined }
  emit()
  restoring = invoke<Session | null>('fengwo_action', { action: 'session' })
    .then((session) => {
      state = { session, ready: true }
      emit()
    })
    .catch((error) => {
      state = { ...state, ready: true, error: errorText(error) }
      emit()
    })
    .finally(() => {
      restoring = undefined
    })
  return restoring
}
export function useFengwo() {
  return useSyncExternalStore(subscribe, () => state)
}
const sessionActions = new Set([
  'login',
  'logout',
  'offline',
  'sync',
  'summary',
  'saveRules',
  'resetSecurity',
  'setCampus',
  'cfApply',
])
export async function business<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const id = state.session?.id
  let result: T
  try {
    result = await invoke<T>('fengwo_action', {
      action,
      payload,
      sessionId: id,
    })
  } catch (error) {
    if (
      action !== 'login' &&
      id &&
      id === state.session?.id &&
      ['authentication_expired', 'device_not_registered'].includes(
        errorCode(error),
      )
    ) {
      const session = await invoke<Session | null>('fengwo_action', {
        action: 'sessionState',
      })
      if (id === state.session?.id && session?.id === id) {
        state = { session, ready: true }
        emit()
      }
    }
    throw error
  }
  if (action !== 'login' && id !== state.session?.id)
    throw new Error('session_changed')
  if (sessionActions.has(action)) {
    state = { session: result as Session | null, ready: true }
    emit()
  }
  return result
}
export function useBusiness<T>(
  action: string,
  params: Record<string, unknown> = {},
  local = false,
) {
  const { session } = useFengwo()
  const key = session
    ? ['fengwo', session.id, action, JSON.stringify(params)]
    : null
  const result = useSWR<T>(key, () => business<T>(action, params), {
    isPaused: () => !local && !!(session?.offline || session?.needsLogin),
    revalidateOnFocus: !session?.offline && !session?.needsLogin,
    shouldRetryOnError: false,
  })
  return {
    ...result,
    isLoading: result.isLoading && (local || !session?.offline),
  }
}
export function useAction() {
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const run = async (work: () => Promise<unknown>, success = '') => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await work()
      setMessage(success)
    } catch (e) {
      setError(errorText(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return { busy, error, message, run, setError }
}
export function useSessionInit() {
  useEffect(() => {
    void restoreSession()
  }, [])
}
function errorCode(error: unknown): string {
  return typeof error === 'object' && error && 'detail' in error
    ? String(error.detail)
    : error instanceof Error
      ? error.message
      : String(error)
}
export function errorText(error: unknown): string {
  const code = errorCode(error)
  const messages: Record<string, string> = {
    build_configuration_missing:
      '当前构建缺少蜂窝配置密钥，请安装正式 Linux 版本。',
    configuration_unavailable: '无法获取服务配置，请检查网络后重试。',
    network_unavailable: '网络暂时不可用，请稍后重试。',
    network_timeout: '服务器响应超时，请稍后重试。',
    response_incomplete: '服务器响应接收中断，请稍后重试。',
    invalid_response: '服务器返回的数据无效，请稍后重试。',
    authentication_expired: '登录已失效，请重新登录。',
    device_not_registered: '设备凭证已失效，请重新登录。',
    device_limit_reached: '已达到设备数量上限，请先移除其他设备。',
    request_expired: '系统时间与服务器不一致，请校准时间后重试。',
    update_check_failed: '更新检查失败，请检查网络后重试。',
    update_install_failed: '安装未完成，请检查管理员授权和软件源后重试。',
    update_busy: '已有更新正在安装。',
    update_hash_mismatch: '安装包校验失败，请重新下载。',
    update_changed: '更新版本已变更，请重新检查并确认。',
    invalid_credentials: '邮箱或密码不正确。',
    login_failed: '邮箱或密码不正确。',
    session_changed: '账号已切换，请重试。',
    login_required: '请先登录。',
    offline_mode: '离线模式下无法使用此功能。',
    rate_limited: '请求过于频繁，请稍后重试。',
    subscription_required: '请先在加速主页更新订阅。',
    profile_validation_failed: '配置校验失败，已保留上一次有效配置。',
    profile_activation_failed: '配置未能生效，请检查内核状态。',
    profile_busy: '内核仍在加载配置，请稍后重试。',
    payment_method_required: '请选择支付方式。',
    not_in_gray_allowlist: '此账号尚未开通安全订阅，请联系管理员。',
    unknown_operation: '服务端暂不支持此操作，请联系管理员升级服务端。',
  }
  return messages[code] ?? '操作未完成，请检查网络或登录状态后重试。'
}
export function bytes(value = 0) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4)
  return `${(value / 1024 ** unit).toFixed(unit ? 2 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`
}
export const money = (cents = 0) => `¥${(Number(cents) / 100).toFixed(2)}`
export function date(value?: number | string | null) {
  if (!value) return '长期有效'
  const numeric = Number(value)
  const parsed = new Date(Number.isFinite(numeric) ? numeric * 1000 : value)
  return Number.isNaN(parsed.getTime())
    ? '未知'
    : parsed.toLocaleString('zh-CN')
}
export const periods: Record<string, string> = {
  month_price: '月付',
  quarter_price: '季付',
  half_year_price: '半年付',
  year_price: '年付',
  two_year_price: '两年付',
  three_year_price: '三年付',
  onetime_price: '一次性',
  reset_price: '重置流量',
}
export const orderStatuses = ['待支付', '开通中', '已取消', '已完成', '已折抵']
export function paymentPayload(checkout: Checkout) {
  if (typeof checkout.data === 'string') return checkout.data.trim()
  for (const key of ['qrcode', 'qr_code', 'url', 'pay_url', 'payment_url'])
    if (checkout.data?.[key]) return checkout.data[key]
  return ''
}
export function billedBytes(record: TrafficRecord) {
  const raw =
    Math.max(0, Number(record.u) || 0) + Math.max(0, Number(record.d) || 0)
  const rate = Number(record.server_rate ?? 1)
  return raw * (Number.isFinite(rate) ? Math.max(0, Math.min(rate, 100000)) : 0)
}
