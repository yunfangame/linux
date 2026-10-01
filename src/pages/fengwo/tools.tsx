import {
  BuildOutlined,
  LinkRounded,
  LocationOnOutlined,
  MovieOutlined,
  OpenInNewRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Tab,
  Tabs,
  Typography,
} from '@mui/material'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { Link } from 'react-router'
import useSWR from 'swr'

import SettingClash from '@/components/setting/setting-clash'
import SettingSystem from '@/components/setting/setting-system'
import SettingVergeAdvanced from '@/components/setting/setting-verge-advanced'
import SettingVergeBasic from '@/components/setting/setting-verge-basic'
import { useSystemState } from '@/hooks/use-system-state'
import { exportDiagnosticInfo, openLogsDir } from '@/services/cmds'
import { business, useAction, useFengwo } from '@/services/fengwo'
import { requestService } from '@/services/service-request'

import { Feedback, Loading, Page, Refresh, Stat } from './shared'
import { LinuxUpdates } from './update'

interface LinuxStatus {
  linux: boolean
  arch: string
  distribution: string
  packageManager: string
  polkit: boolean
  tun: boolean
  updatesConfigured: boolean
  build: string
}
export function AdvancedPage() {
  const [tab, setTab] = useState(() =>
    new URLSearchParams(window.location.search).get('tab') === 'environment'
      ? 2
      : 0,
  )
  const action = useAction()
  const status = useSWR('fengwo-linux-status', () =>
    invoke<LinuxStatus>('fengwo_linux_status'),
  )
  const { runState } = useSystemState()
  const error = () => action.setError('设置未能保存，请重试。')
  return (
    <Page title="高级设置">
      <Feedback {...action} />
      <Tabs
        value={tab}
        variant="scrollable"
        onChange={(_, value) => setTab(value)}
      >
        <Tab label="网络设置" />
        <Tab label="应用设置" />
        <Tab label="环境与更新" />
      </Tabs>
      {tab === 0 ? (
        <>
          <SettingSystem onError={error} />
          <SettingClash onError={error} />
        </>
      ) : tab === 1 ? (
        <>
          <SettingVergeBasic onError={error} />
          <SettingVergeAdvanced onError={error} />
        </>
      ) : (
        <Loading loading={status.isLoading} error={status.error}>
          <div className="fengwo-stats">
            <Stat label="发行版" value={status.data?.distribution} />
            <Stat label="架构" value={status.data?.arch} />
            <Stat label="包管理器" value={status.data?.packageManager} />
            <Stat label="当前构建" value={status.data?.build} />
          </div>
          <Typography>
            内核：{runState.mode} · TUN：
            {status.data?.tun ? '可用' : '未检测到'} · 授权组件：
            {status.data?.polkit ? '可用' : '未检测到'}
          </Typography>
          <div className="fengwo-toolbar">
            <Refresh onClick={() => void status.mutate()} />
            <Button
              startIcon={<BuildOutlined />}
              onClick={() => requestService({ reason: 'tunNeedsService' })}
            >
              检查 / 安装服务
            </Button>
            <Button onClick={() => void action.run(openLogsDir)}>
              打开日志
            </Button>
            <Button onClick={() => void action.run(exportDiagnosticInfo)}>
              导出诊断
            </Button>
          </div>
          <LinuxUpdates />
        </Loading>
      )}
    </Page>
  )
}
export function ToolsPage() {
  const [tool, setTool] = useState('')
  const [ip, setIp] = useState<Record<string, unknown>>()
  const action = useAction()
  const { session } = useFengwo()
  const tools = [
    { key: 'ip', title: 'IP 地址查询', icon: LocationOnOutlined },
    { key: 'stream', title: '流媒体解锁测试', icon: MovieOutlined },
    { key: 'chain', title: '链式代理', icon: LinkRounded },
  ]
  return (
    <Page title="实用工具">
      <Feedback {...action} />
      <div className="fengwo-grid">
        {tools.map(({ key, title, icon: Icon }) => (
          <Box key={key} className="fengwo-plan">
            <Icon color="primary" sx={{ fontSize: 30 }} />
            <Typography variant="h6">{title}</Typography>
            {key === 'stream' || key === 'chain' ? (
              <Button
                component={Link}
                to={key === 'stream' ? '/unlock' : '/proxies'}
                startIcon={<OpenInNewRounded />}
              >
                打开
              </Button>
            ) : (
              <Button onClick={() => setTool(key)}>打开</Button>
            )}
          </Box>
        ))}
      </div>
      <Dialog
        open={!!tool}
        onClose={action.busy ? undefined : () => setTool('')}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {tools.find((item) => item.key === tool)?.title}
        </DialogTitle>
        <DialogContent>
          <div className="fengwo-form">
            <Feedback {...action} />
            <Button
              disabled={action.busy || session?.offline}
              onClick={() =>
                void action.run(async () =>
                  setIp(await business<Record<string, unknown>>('ipLookup')),
                )
              }
            >
              查询出口 IP
            </Button>
            {ip && (
              <>
                <Typography variant="h6">{String(ip.ip ?? '')}</Typography>
                <Typography>
                  {[ip.country, ip.region, ip.city].filter(Boolean).join(' · ')}
                </Typography>
                <Typography>
                  {String(
                    (ip.connection as Record<string, unknown>)?.isp ?? '',
                  )}
                </Typography>
              </>
            )}
          </div>
        </DialogContent>
        <DialogActions>
          <Button disabled={action.busy} onClick={() => setTool('')}>
            关闭
          </Button>
        </DialogActions>
      </Dialog>
    </Page>
  )
}
