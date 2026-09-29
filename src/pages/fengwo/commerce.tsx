import { ShoppingCartOutlined, OpenInNewRounded } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { openUrl } from '@tauri-apps/plugin-opener'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useRef, useState } from 'react'

import {
  type Checkout,
  type Order,
  type PaymentMethod,
  type Plan,
  business,
  date,
  money,
  orderStatuses,
  paymentPayload,
  periods,
  useAction,
  useBusiness,
  useFengwo,
} from '@/services/fengwo'

import { RichText } from './content'
import { Confirm, Feedback, Loading, Page, Refresh } from './shared'

export function PaymentDialog({
  plan,
  period,
  order,
  onClose,
}: {
  plan?: Plan
  period?: string
  order?: Order
  onClose: () => void
}) {
  const { session } = useFengwo()
  const methods = useBusiness<PaymentMethod[]>('paymentMethods')
  const [method, setMethod] = useState<number | ''>('')
  const [trade, setTrade] = useState(order?.trade_no ?? '')
  const [checkout, setCheckout] = useState<Checkout>()
  const [paid, setPaid] = useState(false)
  const [pollError, setPollError] = useState(false)
  const action = useAction()
  const mountedRef = useRef(true)
  const { setError } = action
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (!trade || !checkout || paid || session?.offline) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const status = await business<number>('checkOrder', { trade_no: trade })
        if (!active) return
        setPollError(false)
        if (status === 1 || status === 3) {
          setPaid(true)
          void business('summary').catch(() => {})
          return
        }
        if (status === 2) {
          setError('订单已取消。')
          return
        }
      } catch {
        if (active) setPollError(true)
      }
      if (active) timer = setTimeout(poll, 3000)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [trade, checkout, paid, session?.offline, setError])
  const start = () =>
    void action.run(async () => {
      const selected = method || methods.data?.[0]?.id
      if (!selected) throw new Error('payment_method_required')
      const no =
        trade ||
        (await business<string>('createOrder', { plan_id: plan?.id, period }))
      if (mountedRef.current) setTrade(no)
      const result = await business<Checkout>('checkout', {
        trade_no: no,
        method: selected,
      })
      if (!mountedRef.current) return
      setCheckout(result)
      if (result.type === -1) {
        setPaid(true)
        await business('summary')
      }
    })
  const payload = checkout ? paymentPayload(checkout) : ''
  return (
    <Dialog
      open
      onClose={action.busy ? undefined : onClose}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle>{paid ? '支付成功' : '确认订单'}</DialogTitle>
      <DialogContent>
        <Box className="fengwo-form">
          <Typography>
            {plan?.name ?? order?.plan?.name} ·{' '}
            {periods[period ?? order?.period ?? '']}
          </Typography>
          <Typography variant="h5">
            {money(order?.total_amount ?? Number(plan?.[period ?? ''] ?? 0))}
          </Typography>
          <Feedback error={action.error} />
          <Loading
            loading={methods.isLoading}
            error={methods.error}
            empty={!methods.data?.length}
          >
            <TextField
              select
              label="支付方式"
              value={method || methods.data?.[0]?.id || ''}
              disabled={!!checkout || action.busy}
              onChange={(e) => setMethod(Number(e.target.value))}
            >
              {methods.data?.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.name} · 手续费 {money(item.handling_fee_fixed)} +{' '}
                  {item.handling_fee_percent ?? 0}%
                </MenuItem>
              ))}
            </TextField>
          </Loading>
          {paid ? (
            <Alert severity="success">订单已支付，套餐信息已刷新。</Alert>
          ) : checkout && payload ? (
            <>
              <Box sx={{ p: 2, bgcolor: 'white', alignSelf: 'center' }}>
                <QRCodeSVG value={payload} size={220} />
              </Box>
              <Typography variant="body2">订单号：{trade}</Typography>
              {/^https?:\/\//i.test(payload) && (
                <Button
                  startIcon={<OpenInNewRounded />}
                  onClick={() => void action.run(() => openUrl(payload))}
                >
                  打开支付页面
                </Button>
              )}
              {pollError && (
                <Alert severity="warning">
                  暂时无法确认支付结果，正在重试。请勿重复付款。
                </Alert>
              )}
            </>
          ) : (
            <Alert severity="info">确认后将创建订单，以结算金额为准。</Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button disabled={action.busy} onClick={onClose}>
          {paid ? '完成' : '关闭'}
        </Button>
        {!checkout && (
          <Button
            variant="contained"
            disabled={action.busy || !methods.data?.length || session?.offline}
            onClick={start}
          >
            {trade ? '重试支付' : '确认并支付'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
function PlanCard({
  plan,
  onBuy,
}: {
  plan: Plan
  onBuy: (period: string) => void
}) {
  const { session } = useFengwo()
  const available = Object.keys(periods).filter(
    (key) => plan[key] != null && Number(plan[key]) >= 0,
  )
  const [selected, setSelected] = useState(available[0] ?? '')
  const period = available.includes(selected) ? selected : available[0]
  const soldOut =
    plan.is_sold_out ||
    (typeof plan.capacity_limit === 'number' && plan.capacity_limit <= 0) ||
    String(plan.capacity_limit).toLowerCase().includes('sold out')
  const disabled = soldOut || plan.sell === false || plan.sell === 0
  return (
    <Box className="fengwo-plan">
      <div className="fengwo-toolbar">
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          {plan.name}
        </Typography>
        {session?.summary.plan_id === plan.id && (
          <Chip size="small" color="success" label="当前套餐" />
        )}
      </div>
      <Typography variant="h5" sx={{ fontWeight: 700 }}>
        {money(Number(plan[period]))}
      </Typography>
      <Typography color="text.secondary">
        {plan.transfer_enable ?? 0} GB ·{' '}
        {plan.speed_limit ? `${plan.speed_limit} Mbps` : '不限速'} ·{' '}
        {plan.device_limit ? `${plan.device_limit} 台设备` : '不限设备'}
      </Typography>
      <div className="fengwo-plan-content">
        <RichText>{plan.content ?? ''}</RichText>
      </div>
      <TextField
        select
        label="周期"
        value={period}
        onChange={(e) => setSelected(e.target.value)}
      >
        {available.map((key) => (
          <MenuItem key={key} value={key}>
            {periods[key]} · {money(Number(plan[key]))}
          </MenuItem>
        ))}
      </TextField>
      <Button
        variant="contained"
        startIcon={<ShoppingCartOutlined />}
        disabled={disabled || !period || session?.offline}
        onClick={() => onBuy(period)}
      >
        {soldOut ? '已售罄' : '购买套餐'}
      </Button>
    </Box>
  )
}
export function PlansPage() {
  const plans = useBusiness<Plan[]>('plans')
  const [filter, setFilter] = useState('all')
  const [payment, setPayment] = useState<{ plan: Plan; period: string }>()
  const visible = (plans.data ?? [])
    .filter((plan) =>
      Object.keys(periods).some(
        (key) => plan[key] != null && Number(plan[key]) >= 0,
      ),
    )
    .filter(
      (plan) =>
        filter === 'all' ||
        (filter === 'once'
          ? plan.onetime_price != null
          : Object.keys(periods).some(
              (key) =>
                !['onetime_price', 'reset_price'].includes(key) &&
                plan[key] != null,
            )),
    )
  return (
    <Page
      title="购买套餐"
      actions={
        <Refresh
          busy={plans.isValidating}
          onClick={() => void plans.mutate()}
        />
      }
    >
      <Tabs value={filter} onChange={(_, value) => setFilter(value)}>
        <Tab value="all" label="全部套餐" />
        <Tab value="recurring" label="周期套餐" />
        <Tab value="once" label="一次性套餐" />
      </Tabs>
      <Loading
        loading={plans.isLoading}
        error={plans.error}
        empty={!visible.length}
      >
        <div className="fengwo-grid">
          {visible.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              onBuy={(period) => setPayment({ plan, period })}
            />
          ))}
        </div>
      </Loading>
      {payment && (
        <PaymentDialog
          {...payment}
          onClose={() => {
            setPayment(undefined)
            void plans.mutate()
          }}
        />
      )}
    </Page>
  )
}
export function OrdersPage() {
  const orders = useBusiness<Order[]>('orders')
  const { session } = useFengwo()
  const [filter, setFilter] = useState(-1)
  const [payment, setPayment] = useState<Order>()
  const [cancel, setCancel] = useState<Order>()
  const [detail, setDetail] = useState<Order>()
  const action = useAction()
  const visible = (orders.data ?? []).filter(
    (order) => filter === -1 || order.status === filter,
  )
  return (
    <Page
      title="我的订单"
      actions={
        <Refresh
          busy={orders.isValidating}
          onClick={() => void orders.mutate()}
        />
      }
    >
      <Feedback {...action} />
      <Tabs
        value={filter}
        variant="scrollable"
        onChange={(_, value) => setFilter(value)}
      >
        <Tab value={-1} label="全部" />
        {orderStatuses.map((label, index) => (
          <Tab key={label} value={index} label={label} />
        ))}
      </Tabs>
      <Loading
        loading={orders.isLoading}
        error={orders.error}
        empty={!visible.length}
      >
        <div className="fengwo-table">
          <Table>
            <TableHead>
              <TableRow>
                {[
                  '套餐 / 订单号',
                  '周期',
                  '金额',
                  '状态',
                  '创建时间',
                  '操作',
                ].map((label) => (
                  <TableCell key={label}>{label}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((order) => (
                <TableRow key={order.trade_no}>
                  <TableCell>
                    {order.plan?.name}
                    <Typography variant="caption" sx={{ display: 'block' }}>
                      {order.trade_no}
                    </Typography>
                  </TableCell>
                  <TableCell>{periods[order.period] ?? order.period}</TableCell>
                  <TableCell>{money(order.total_amount)}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={orderStatuses[order.status] ?? '未知'}
                      color={order.status === 3 ? 'success' : 'default'}
                    />
                  </TableCell>
                  <TableCell>{date(order.created_at)}</TableCell>
                  <TableCell>
                    <Button
                      disabled={action.busy || session?.offline}
                      onClick={() =>
                        void action.run(async () =>
                          setDetail(
                            await business<Order>('orderDetail', {
                              trade_no: order.trade_no,
                            }),
                          ),
                        )
                      }
                    >
                      详情
                    </Button>
                    {order.status === 0 && (
                      <>
                        <Button
                          disabled={session?.offline}
                          onClick={() => setPayment(order)}
                        >
                          支付
                        </Button>
                        <Button
                          color="warning"
                          disabled={session?.offline}
                          onClick={() => setCancel(order)}
                        >
                          取消
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Loading>
      {payment && (
        <PaymentDialog
          order={payment}
          onClose={() => {
            setPayment(undefined)
            void orders.mutate()
          }}
        />
      )}
      <Confirm
        open={!!cancel}
        title="取消订单"
        busy={action.busy}
        onClose={() => setCancel(undefined)}
        onConfirm={() =>
          void action.run(async () => {
            await business('cancelOrder', { trade_no: cancel?.trade_no })
            setCancel(undefined)
            await orders.mutate()
          })
        }
      >
        确认取消订单 {cancel?.trade_no}？
      </Confirm>
      <Dialog open={!!detail} onClose={() => setDetail(undefined)}>
        <DialogTitle>订单详情</DialogTitle>
        <DialogContent>
          <Typography>{detail?.plan?.name}</Typography>
          <Typography>订单号：{detail?.trade_no}</Typography>
          <Typography>金额：{money(detail?.total_amount)}</Typography>
          <Typography>余额抵扣：{money(detail?.balance_amount)}</Typography>
          <Typography>优惠：{money(detail?.discount_amount)}</Typography>
          <Typography>手续费：{money(detail?.handling_amount)}</Typography>
          <Typography>创建时间：{date(detail?.created_at)}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetail(undefined)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </Page>
  )
}
