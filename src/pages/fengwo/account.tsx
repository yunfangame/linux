import {
  ContentCopyRounded,
  CardGiftcardRounded,
  LockResetRounded,
  SaveOutlined,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useState } from 'react'

import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useVerge } from '@/hooks/use-verge'
import {
  type CommissionRecord,
  type InviteData,
  type LoginIp,
  type UserInfo,
  business,
  date,
  money,
  useAction,
  useBusiness,
  useFengwo,
} from '@/services/fengwo'

import { Confirm, Feedback, Loading, Page, Refresh, Stat } from './shared'

export function AccountPage() {
  const { toggleSystemProxy } = useSystemProxyState()
  const { patchVerge } = useVerge()
  const user = useBusiness<UserInfo>('user')
  const ips = useBusiness<{ items: LoginIp[] }>('loginIps')
  const { session } = useFengwo()
  const action = useAction()
  const [passwords, setPasswords] = useState({ old: '', next: '', confirm: '' })
  const [blocked, setBlocked] = useState<LoginIp>()
  const [reset, setReset] = useState(false)
  const disabled = action.busy || session?.offline
  const changeReminders = (
    key: 'remind_expire' | 'remind_traffic',
    checked: boolean,
  ) =>
    void action.run(async () => {
      await business('updateUser', {
        remind_expire: user.data?.remind_expire ?? 0,
        remind_traffic: user.data?.remind_traffic ?? 0,
        [key]: checked ? 1 : 0,
      })
      await user.mutate()
    })
  return (
    <Page
      title="个人中心"
      actions={
        <Refresh
          busy={action.busy}
          onClick={() =>
            void action.run(async () => {
              await user.mutate()
              await ips.mutate()
            })
          }
        />
      }
    >
      <Feedback {...action} />
      <Loading loading={user.isLoading} error={user.error}>
        <Typography variant="h6">
          {user.data?.email ?? session?.summary.email}
        </Typography>
        <div className="fengwo-stats">
          <Stat label="钱包余额" value={money(user.data?.balance)} />
          <Stat label="可用佣金" value={money(user.data?.commission_balance)} />
          <Stat
            label="当前套餐"
            value={session?.summary.plan?.name ?? '暂无套餐'}
          />
          <Stat label="到期时间" value={date(session?.summary.expired_at)} />
        </div>
        <div className="fengwo-toolbar">
          <FormControlLabel
            label="到期提醒"
            control={
              <Switch
                checked={!!user.data?.remind_expire}
                disabled={disabled}
                onChange={(_, value) => changeReminders('remind_expire', value)}
              />
            }
          />
          <FormControlLabel
            label="流量提醒"
            control={
              <Switch
                checked={!!user.data?.remind_traffic}
                disabled={disabled}
                onChange={(_, value) =>
                  changeReminders('remind_traffic', value)
                }
              />
            }
          />
        </div>
      </Loading>
      <Typography variant="h6">修改密码</Typography>
      <Box
        component="form"
        className="fengwo-form"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            if (passwords.next !== passwords.confirm) {
              action.setError('两次输入的密码不一致。')
              return
            }
            await business('changePassword', {
              old_password: passwords.old,
              new_password: passwords.next,
            })
            setPasswords({ old: '', next: '', confirm: '' })
          }, '密码已修改')
        }}
      >
        {(['old', 'next', 'confirm'] as const).map((key, index) => (
          <TextField
            key={key}
            label={['当前密码', '新密码', '确认新密码'][index]}
            type="password"
            autoComplete={index ? 'new-password' : 'current-password'}
            required
            value={passwords[key]}
            onChange={(event) =>
              setPasswords((value) => ({ ...value, [key]: event.target.value }))
            }
          />
        ))}
        <Button
          type="submit"
          variant="contained"
          startIcon={<SaveOutlined />}
          disabled={
            disabled || passwords.next !== passwords.confirm || !passwords.next
          }
        >
          保存密码
        </Button>
      </Box>
      <Typography variant="h6">登录 IP 记录</Typography>
      <Loading
        loading={ips.isLoading}
        error={ips.error}
        empty={!ips.data?.items?.length}
      >
        <div className="fengwo-table">
          <Table>
            <TableHead>
              <TableRow>
                {[
                  'IP 地址',
                  '位置',
                  '最近登录',
                  '登录次数',
                  '状态',
                  '操作',
                ].map((label) => (
                  <TableCell key={label}>{label}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {ips.data?.items.map((ip) => (
                <TableRow key={ip.ip}>
                  <TableCell>{ip.ip}</TableCell>
                  <TableCell>{ip.location}</TableCell>
                  <TableCell>{date(ip.last_login_at)}</TableCell>
                  <TableCell>{ip.login_count}</TableCell>
                  <TableCell>{ip.is_blocked ? '已封禁' : '正常'}</TableCell>
                  <TableCell>
                    <Button
                      disabled={disabled}
                      color={ip.is_blocked ? 'primary' : 'warning'}
                      onClick={() => setBlocked(ip)}
                    >
                      {ip.is_blocked ? '解除封禁' : '封禁'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Loading>
      <div>
        <Button
          color="warning"
          startIcon={<LockResetRounded />}
          disabled={disabled}
          onClick={() => setReset(true)}
        >
          重置订阅安全凭证
        </Button>
      </div>
      <Confirm
        open={!!blocked}
        title={blocked?.is_blocked ? '解除 IP 封禁' : '封禁登录 IP'}
        busy={action.busy}
        onClose={() => setBlocked(undefined)}
        onConfirm={() =>
          void action.run(async () => {
            await business(blocked?.is_blocked ? 'unblockIp' : 'blockIp', {
              ip: blocked?.ip,
            })
            setBlocked(undefined)
            await ips.mutate()
          })
        }
      >
        确认更改 {blocked?.ip} 的登录权限？
      </Confirm>
      <Confirm
        open={reset}
        title="重置订阅安全凭证"
        busy={action.busy}
        onClose={() => setReset(false)}
        onConfirm={() =>
          void action.run(async () => {
            await toggleSystemProxy(false)
            await patchVerge({ enable_tun_mode: false })
            await business('resetSecurity')
            setReset(false)
          })
        }
      >
        已有订阅凭证将失效，需要重新登录。
      </Confirm>
    </Page>
  )
}
export function InvitePage() {
  const invite = useBusiness<InviteData>('invite')
  const records = useBusiness<CommissionRecord[]>('inviteDetails', {
    current: 1,
    page_size: 50,
  })
  const { session } = useFengwo()
  const action = useAction()
  const [transfer, setTransfer] = useState(false)
  const [withdrawal, setWithdrawal] = useState(false)
  const [method, setMethod] = useState('支付宝')
  const [account, setAccount] = useState('')
  const [amount, setAmount] = useState('')
  const stat = invite.data?.stat ?? []
  const disabled = action.busy || session?.offline
  const available = Number(stat[4] ?? 0)
  return (
    <Page
      title="邀请推广"
      actions={
        <Refresh
          busy={action.busy}
          onClick={() =>
            void action.run(async () => {
              await invite.mutate()
              await records.mutate()
            })
          }
        />
      }
    >
      <Feedback {...action} />
      <Loading loading={invite.isLoading} error={invite.error}>
        <div className="fengwo-stats">
          <Stat label="已邀请用户" value={stat[0] ?? 0} />
          <Stat label="累计佣金" value={money(stat[1])} />
          <Stat label="待确认佣金" value={money(stat[2])} />
          <Stat label="佣金比例" value={`${stat[3] ?? 0}%`} />
        </div>
        <div className="fengwo-toolbar">
          <Typography variant="h6">可用佣金 {money(available)}</Typography>
          <Button
            disabled={disabled || available <= 0}
            onClick={() => setTransfer(true)}
          >
            划转至余额
          </Button>
          <Button
            disabled={disabled || available <= 0}
            onClick={() => setWithdrawal(true)}
          >
            申请提现
          </Button>
        </div>
        <div className="fengwo-toolbar">
          <Typography variant="h6">邀请码</Typography>
          <Button
            startIcon={<CardGiftcardRounded />}
            disabled={disabled}
            onClick={() =>
              void action.run(async () => {
                await business('generateInvite')
                await invite.mutate()
              })
            }
          >
            生成邀请码
          </Button>
        </div>
        <div className="fengwo-table">
          <Table>
            <TableBody>
              {invite.data?.codes?.map((code) => (
                <TableRow key={code.code}>
                  <TableCell>{code.code}</TableCell>
                  <TableCell>{date(code.created_at)}</TableCell>
                  <TableCell>
                    <Button
                      startIcon={<ContentCopyRounded />}
                      disabled={disabled}
                      onClick={() =>
                        void action.run(async () => {
                          const link = await business<string>('inviteLink', {
                            code: code.code,
                          })
                          await writeText(link)
                        }, '邀请链接已复制')
                      }
                    >
                      复制邀请链接
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Loading>
      <Typography variant="h6">佣金明细</Typography>
      <Loading
        loading={records.isLoading}
        error={records.error}
        empty={!records.data?.length}
      >
        <div className="fengwo-table">
          <Table>
            <TableHead>
              <TableRow>
                {['时间', '订单号', '佣金'].map((label) => (
                  <TableCell key={label}>{label}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {records.data?.map((record) => (
                <TableRow
                  key={`${record.trade_no}:${record.created_at}:${record.commission_balance}`}
                >
                  <TableCell>{date(record.created_at)}</TableCell>
                  <TableCell>{record.trade_no}</TableCell>
                  <TableCell>{money(record.get_amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Loading>
      <Confirm
        open={transfer}
        title="佣金划转"
        busy={action.busy}
        onClose={() => setTransfer(false)}
        onConfirm={() =>
          void action.run(async () => {
            await business('transfer', { transfer_amount: available })
            setTransfer(false)
            await invite.mutate()
          }, '佣金已划转')
        }
      >
        将 {money(available)} 划转到钱包余额。余额只能用于购买套餐。
      </Confirm>
      <Dialog
        open={withdrawal}
        onClose={action.busy ? undefined : () => setWithdrawal(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>申请佣金提现</DialogTitle>
        <DialogContent>
          <div className="fengwo-form" style={{ paddingTop: 8 }}>
            <TextField
              select
              label="收款方式"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {['支付宝', '微信', 'USDT', '银行卡'].map((label) => (
                <MenuItem key={label} value={label}>
                  {label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="收款账号"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
            <TextField
              label="提现金额（元）"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Alert severity="info">
              可提现 {money(available)}，申请将提交为工单。
            </Alert>
            <Feedback {...action} />
          </div>
        </DialogContent>
        <DialogActions>
          <Button disabled={action.busy} onClick={() => setWithdrawal(false)}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={
              disabled ||
              !account.trim() ||
              !Number.isFinite(Number(amount)) ||
              Number(amount) <= 0 ||
              Math.round(Number(amount) * 100) > available
            }
            onClick={() =>
              void action.run(async () => {
                await business('createTicket', {
                  subject: '佣金提现申请',
                  level: 2,
                  message: `提现方式：${method}\n提现金额：${money(Math.round(Number(amount) * 100))}\n收款账号：${account.trim()}`,
                })
                setWithdrawal(false)
                setAccount('')
                setAmount('')
              }, '提现工单已提交')
            }
          >
            提交申请
          </Button>
        </DialogActions>
      </Dialog>
    </Page>
  )
}
