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
  MailOutlineRounded,
  LockOutlined,
  VisibilityOutlined,
  VisibilityOffOutlined,
} from '@mui/icons-material'
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
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

import loginBrand from '@/assets/image/fengwo-login-brand.png'
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
      <div
        className="fengwo-empty fengwo-session-loading"
        role="status"
        aria-label="正在恢复登录"
      >
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
  const [passwordVisible, setPasswordVisible] = useState(false)
  const action = useAction()
  const { toggleSystemProxy } = useSystemProxyState()
  const { patchVerge } = useVerge()
  return (
    <Box className="fengwo-login">
      <section
        className="fengwo-login-brand"
        aria-label="蜂窝加速器 Linux 版本"
      >
        <div className="fengwo-login-brand-content">
          <img src={loginBrand} alt="蜂窝加速器" />
          <Typography className="fengwo-login-edition">Linux 版本</Typography>
          <Typography className="fengwo-login-slogan">
            更快，更稳，更实惠
          </Typography>
        </div>
        <Typography className="fengwo-login-copyright">
          蜂窝加速器 · 2.5.6
        </Typography>
      </section>
      <main className="fengwo-login-panel">
        <div className="fengwo-login-tools">
          <UpdateNotice />
        </div>
        <div className="fengwo-login-content">
          <header>
            <Typography component="h1" className="fengwo-login-title">
              {session?.needsLogin ? '重新登录' : '登录'}
            </Typography>
            <Typography className="fengwo-login-welcome">
              {session?.needsLogin
                ? '登录凭证已失效，请重新登录您的账号。'
                : '欢迎回来，请登录您的账号'}
            </Typography>
          </header>
          <Box
            component="form"
            onSubmit={(event) => {
              event.preventDefault()
              void action.run(async () => {
                await toggleSystemProxy(false)
                await patchVerge({ enable_tun_mode: false })
                await business('login', { email: email.trim(), password })
                setPassword('')
                setPasswordVisible(false)
              })
            }}
          >
            <div className="fengwo-login-field">
              <Typography component="label" htmlFor="fengwo-login-email">
                邮箱
              </Typography>
              <TextField
                id="fengwo-login-email"
                type="email"
                value={email}
                required
                fullWidth
                autoComplete="username"
                disabled={action.busy}
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <MailOutlineRounded />
                      </InputAdornment>
                    ),
                  },
                }}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="fengwo-login-field">
              <Typography component="label" htmlFor="fengwo-login-password">
                密码
              </Typography>
              <TextField
                id="fengwo-login-password"
                type={passwordVisible ? 'text' : 'password'}
                value={password}
                required
                fullWidth
                autoComplete="current-password"
                disabled={action.busy}
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <LockOutlined />
                      </InputAdornment>
                    ),
                    endAdornment: (
                      <InputAdornment position="end">
                        <Tooltip
                          title={passwordVisible ? '隐藏密码' : '显示密码'}
                        >
                          <IconButton
                            type="button"
                            aria-label={
                              passwordVisible ? '隐藏密码' : '显示密码'
                            }
                            aria-pressed={passwordVisible}
                            disabled={action.busy}
                            onClick={() => setPasswordVisible(!passwordVisible)}
                            edge="end"
                          >
                            {passwordVisible ? (
                              <VisibilityOffOutlined />
                            ) : (
                              <VisibilityOutlined />
                            )}
                          </IconButton>
                        </Tooltip>
                      </InputAdornment>
                    ),
                  },
                }}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Feedback error={action.error || error} />
            <Button
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              disabled={action.busy}
              endIcon={
                action.busy ? <CircularProgress size={18} /> : <LoginRounded />
              }
            >
              登录
            </Button>
          </Box>
        </div>
      </main>
    </Box>
  )
}
