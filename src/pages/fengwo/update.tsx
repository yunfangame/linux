import { DownloadRounded, RefreshRounded } from '@mui/icons-material'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Switch,
} from '@mui/material'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import useSWR from 'swr'

import { useVerge } from '@/hooks/use-verge'
import { restartApp } from '@/services/cmds'
import { useAction, useFengwo } from '@/services/fengwo'

import { Confirm, Feedback } from './shared'

interface LinuxUpdate {
  version: string
  build: number
  sha256: string
  notes?: string
}
function useLinuxUpdate() {
  const { session, ready } = useFengwo()
  const { verge } = useVerge()
  const automatic = verge?.auto_check_update !== false
  return useSWR(
    ready && !session?.offline ? 'fengwo-linux-update' : null,
    () => invoke<LinuxUpdate | null>('fengwo_check_update'),
    {
      refreshInterval: automatic ? 24 * 60 * 60 * 1000 : 0,
      revalidateOnMount: automatic,
      revalidateIfStale: automatic,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}
export function LinuxUpdates() {
  const update = useLinuxUpdate()
  const { session } = useFengwo()
  const { verge, patchVerge } = useVerge()
  const [confirmed, setConfirmed] = useState<LinuxUpdate | null>(null)
  const installed = useSWR<boolean>('fengwo-linux-installed', null, {
    fallbackData: false,
  })
  const action = useAction()
  const disabled = action.busy || !!session?.offline
  return (
    <section className="fengwo-form">
      <Feedback {...action} />
      <Feedback error={update.error} />
      {session?.offline && (
        <Alert severity="info">离线模式下已暂停更新。</Alert>
      )}
      <FormControlLabel
        label="自动检查更新"
        control={
          <Switch
            checked={verge?.auto_check_update !== false}
            disabled={action.busy}
            onChange={(_, enabled) =>
              void action.run(() => patchVerge({ auto_check_update: enabled }))
            }
          />
        }
      />
      <Button
        startIcon={<RefreshRounded />}
        disabled={disabled || update.isValidating}
        onClick={() => void action.run(() => update.mutate(), '更新检查完成')}
      >
        {update.isValidating ? '正在检查' : '检查更新'}
      </Button>
      {update.data === null && !update.error && (
        <Alert severity="info">暂无可用更新。</Alert>
      )}
      {update.data && !installed.data && (
        <Alert
          severity="info"
          action={
            <Button
              startIcon={<DownloadRounded />}
              disabled={disabled}
              onClick={() => setConfirmed(update.data!)}
            >
              安装更新
            </Button>
          }
        >
          新版本 {update.data.version}
          {update.data.notes ? ` · ${update.data.notes}` : ''}
        </Alert>
      )}
      {installed.data && (
        <Alert
          severity="success"
          action={<Button onClick={() => void restartApp()}>重启</Button>}
        >
          更新已安装，重启后生效。
        </Alert>
      )}
      <Confirm
        open={!!confirmed}
        title={`安装 Linux 更新 ${confirmed?.version ?? ''}`}
        busy={action.busy}
        onClose={() => setConfirmed(null)}
        onConfirm={() => {
          if (disabled || !confirmed) return
          void action.run(async () => {
            await invoke('fengwo_install_update', {
              expectedBuild: confirmed.build,
              expectedSha256: confirmed.sha256,
            })
            setConfirmed(null)
            await installed.mutate(true, { revalidate: false })
          })
        }}
      >
        将下载并验证统一安装包，自动安装所需依赖。系统可能请求管理员授权。
        <Feedback error={action.error} />
      </Confirm>
    </section>
  )
}
export function UpdateNotice() {
  const update = useLinuxUpdate()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        startIcon={<DownloadRounded />}
        onClick={() => setOpen(true)}
        title={update.data ? `新版本 ${update.data.version}` : '客户端更新'}
      >
        {update.data ? `新版本 ${update.data.version}` : '客户端更新'}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>客户端更新</DialogTitle>
        <DialogContent>
          <LinuxUpdates />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
