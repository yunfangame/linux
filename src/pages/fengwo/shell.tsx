import {
  HomeOutlined,
  ShoppingCartOutlined,
  TuneRounded,
  ShowChartRounded,
  PieChartOutlineRounded,
  ReceiptLongOutlined,
  CardGiftcardRounded,
  PersonOutlineRounded,
  SettingsOutlined,
  WorkOutlineRounded,
  LogoutRounded,
  WifiOffRounded,
  LoginRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  CircularProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { Fragment, type ReactNode, useState } from 'react'
import { NavLink } from 'react-router'

import logo from '@/assets/image/fengwo-logo.png'
import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useVerge } from '@/hooks/use-verge'
import {
  business,
  useAction,
  useFengwo,
  useSessionInit,
} from '@/services/fengwo'

import { Confirm, Feedback } from './shared'
import { UpdateNotice } from './update'
import './style.css'

const fengwoNavigation = [
  { path: '/', title: '加速主页', icon: HomeOutlined },
  { path: '/plans', title: '购买套餐', icon: ShoppingCartOutlined },
  { path: '/nodes', title: '节点状态', icon: TuneRounded },
  { path: '/routing', title: '代理规则', icon: ShowChartRounded },
  { path: '/traffic', title: '流量详情', icon: PieChartOutlineRounded },
  { path: '/orders', title: '我的订单', icon: ReceiptLongOutlined },
  { path: '/invite', title: '邀请推广', icon: CardGiftcardRounded },
  { path: '/account', title: '个人中心', icon: PersonOutlineRounded },
  { path: '/advanced', title: '高级设置', icon: SettingsOutlined },
  { path: '/tools', title: '实用工具', icon: WorkOutlineRounded },
]
export function FengwoSidebar() {
  const { session } = useFengwo()
  const action = useAction()
  const [logout, setLogout] = useState(false)
  const { toggleSystemProxy } = useSystemProxyState()
  const { patchVerge } = useVerge()
  return (
    <Box
      component="aside"
      className="fengwo-sidebar"
      sx={{ bgcolor: 'background.default', borderColor: 'divider' }}
    >
      <div className="fengwo-brand" data-tauri-drag-region>
        <img src={logo} alt="蜂窝加速器" />
        <div>
          <Typography sx={{ fontWeight: 800 }}>蜂窝加速器</Typography>
          <Typography variant="caption" color="text.secondary">
            Linux · 2.5.6
          </Typography>
        </div>
      </div>
      <List component="nav" className="fengwo-nav">
        {fengwoNavigation.map(({ path, title, icon: Icon }) => (
          <Tooltip key={path} title={title} placement="right">
            <ListItemButton
              component={NavLink}
              to={path}
              end={path === '/'}
              className="fengwo-nav-item"
            >
              <ListItemIcon>
                <Icon />
              </ListItemIcon>
              <ListItemText primary={title} />
            </ListItemButton>
          </Tooltip>
        ))}
      </List>
      <div className="fengwo-sidebar-bottom">
        <UpdateNotice />
        <Feedback error={action.error} />
        <div className="fengwo-offline">
          <WifiOffRounded />
          <span>离线模式</span>
          <Switch
            slotProps={{ input: { 'aria-label': '离线模式', role: 'switch' } }}
            checked={session?.offline ?? false}
            disabled={!session || action.busy || !session.profileUid}
            onChange={(_, enabled) =>
              void action.run(() => business('offline', { enabled }))
            }
          />
        </div>
        <Button
          startIcon={<LogoutRounded />}
          disabled={!session || action.busy}
          onClick={() => setLogout(true)}
        >
          退出登录
        </Button>
      </div>
      <Confirm
        open={logout}
        title="退出登录"
        busy={action.busy}
        onClose={() => setLogout(false)}
        onConfirm={() =>
          void action.run(async () => {
            await toggleSystemProxy(false)
            await patchVerge({ enable_tun_mode: false })
            await business('logout')
            setLogout(false)
          })
        }
      >
        将关闭系统代理和 TUN，清除当前登录凭证。
      </Confirm>
    </Box>
  )
}
export function SessionBoundary({ children }: { children: ReactNode }) {
  useSessionInit()
  const { session, ready } = useFengwo()
  if (!ready)
    return (
      <div className="fengwo-empty">
        <CircularProgress />
      </div>
    )
  if (session && (!session.needsLogin || session.offline))
    return <Fragment key={session.id}>{children}</Fragment>
  return <LoginForm key={session?.id ?? 'signed-out'} />
}
function LoginForm() {
  const { session, error } = useFengwo()
  const [email, setEmail] = useState(session?.summary.email ?? '')
  const [password, setPassword] = useState('')
  const action = useAction()
  const { toggleSystemProxy } = useSystemProxyState()
  const { patchVerge } = useVerge()
  return (
    <Box className="fengwo-login">
      <img src={logo} alt="蜂窝加速器" />
      <Typography variant="h5" sx={{ fontWeight: 800 }}>
        {session?.needsLogin ? '重新登录蜂窝加速器' : '登录蜂窝加速器'}
      </Typography>
      <Typography color="text.secondary">
        {session?.needsLogin
          ? '登录凭证已失效，本地订阅仍保留。'
          : 'Linux 客户端'}
      </Typography>
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            await toggleSystemProxy(false)
            await patchVerge({ enable_tun_mode: false })
            await business('login', { email: email.trim(), password })
            setPassword('')
          })
        }}
      >
        <TextField
          label="邮箱"
          type="email"
          value={email}
          required
          fullWidth
          autoComplete="username"
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label="密码"
          type="password"
          value={password}
          required
          fullWidth
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
        />
        <Feedback error={action.error || error} />
        <Button
          type="submit"
          variant="contained"
          size="large"
          fullWidth
          disabled={action.busy}
          startIcon={
            action.busy ? <CircularProgress size={18} /> : <LoginRounded />
          }
        >
          登录
        </Button>
      </Box>
    </Box>
  )
}
