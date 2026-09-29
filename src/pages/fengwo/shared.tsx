import { RefreshRounded } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material'
import type { ReactNode } from 'react'

import { errorText, useFengwo } from '@/services/fengwo'

export function Page({
  title,
  children,
  actions,
}: {
  title: string
  children: ReactNode
  actions?: ReactNode
}) {
  const { session } = useFengwo()
  return (
    <Box className="fengwo-page">
      <header className="fengwo-header">
        <div>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            className="fengwo-account-email"
          >
            {session?.summary.email}
          </Typography>
        </div>
        <div className="fengwo-actions">{actions}</div>
      </header>
      {session?.offline && (
        <Alert severity="info">
          离线模式 · 当前使用本地订阅，在线业务已暂停。
        </Alert>
      )}
      {session?.syncError && !session.offline && (
        <Alert severity="warning">
          订阅尚未同步成功，可在加速主页重试更新订阅。
        </Alert>
      )}
      {children}
    </Box>
  )
}
export function Refresh({
  onClick,
  busy = false,
}: {
  onClick: () => void
  busy?: boolean
}) {
  return (
    <Tooltip title="刷新">
      <span>
        <IconButton aria-label="刷新" disabled={busy} onClick={onClick}>
          <RefreshRounded />
        </IconButton>
      </span>
    </Tooltip>
  )
}
export function Feedback({
  error,
  message,
}: {
  error?: unknown
  message?: string
}) {
  return (
    <>
      {!!error && (
        <Alert severity="error">
          {typeof error === 'string' ? error : errorText(error)}
        </Alert>
      )}
      {!!message && <Alert severity="success">{message}</Alert>}
    </>
  )
}
export function Loading({
  loading,
  empty,
  error,
  children,
}: {
  loading?: boolean
  empty?: boolean
  error?: unknown
  children: ReactNode
}) {
  if (loading)
    return (
      <Box className="fengwo-empty">
        <CircularProgress size={28} />
      </Box>
    )
  if (error) return <Feedback error={error} />
  if (empty)
    return (
      <Box className="fengwo-empty" color="text.secondary">
        暂无数据
      </Box>
    )
  return <>{children}</>
}
export function Stat({
  label,
  value,
  color,
}: {
  label: string
  value: ReactNode
  color?: string
}) {
  return (
    <Box className="fengwo-stat">
      <Typography color="text.secondary" variant="body2">
        {label}
      </Typography>
      <Typography variant="h6" sx={{ fontWeight: 700 }} color={color}>
        {value}
      </Typography>
    </Box>
  )
}
export function Confirm({
  open,
  title,
  children,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  children: ReactNode
  busy?: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>{children}</DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button disabled={busy} variant="contained" onClick={onConfirm}>
          确认
        </Button>
      </DialogActions>
    </Dialog>
  )
}
