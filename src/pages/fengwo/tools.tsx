import {
  BuildOutlined,
  CloudOutlined,
  LanguageRounded,
  LinkRounded,
  LocationOnOutlined,
  MovieOutlined,
  OpenInNewRounded,
  SpeedRounded,
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
  Switch,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  MenuItem,
  TextField,
} from '@mui/material'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useState } from 'react'
import { Link } from 'react-router'
import useSWR from 'swr'

import SettingClash from '@/components/setting/setting-clash'
import SettingSystem from '@/components/setting/setting-system'
import SettingVergeAdvanced from '@/components/setting/setting-verge-advanced'
import SettingVergeBasic from '@/components/setting/setting-verge-basic'
import { useSystemState } from '@/hooks/use-system-state'
import { exportDiagnosticInfo, openLogsDir } from '@/services/cmds'
import {
  business,
  bytes,
  useAction,
  useBusiness,
  useFengwo,
} from '@/services/fengwo'
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
interface CfResult {
  ip: string
  latency: number
  speed: number
  region: string
}
function CampusSettings() {
  const campus = useBusiness<{
    operators: string[]
    operator?: string
    enabled: boolean
  }>('campus', {}, true)
  const action = useAction()
  const { session } = useFengwo()
  const selected =
    campus.data?.operator &&
    campus.data.operators.includes(campus.data.operator)
      ? campus.data.operator
      : (campus.data?.operators[0] ?? '')
  const save = (enabled: boolean, operator = selected) =>
    void action.run(async () => {
      await business('setCampus', { enabled, operator })
      await campus.mutate()
    })
  return (
    <section className="fengwo-form">
      <Typography variant="h6">校园网络</Typography>
      <Feedback error={campus.error || action.error} />
      <FormControlLabel
        label="校园模式"
        control={
          <Switch
            checked={campus.data?.enabled ?? false}
            disabled={
              action.busy ||
              !session?.profileUid ||
              (!selected && !campus.data?.enabled)
            }
            onChange={(_, enabled) => save(enabled)}
          />
        }
      />
      {!!campus.data?.operators.length && (
        <TextField
          select
          label="校园线路"
          value={selected}
          disabled={action.busy || !campus.data.enabled}
          onChange={(event) => save(true, event.target.value)}
        >
          {campus.data.operators.map((operator, index) => (
            <MenuItem key={operator} value={operator}>
              线路 {index + 1}
            </MenuItem>
          ))}
        </TextField>
      )}
    </section>
  )
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
          <CampusSettings />
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
  const [results, setResults] = useState<CfResult[]>([])
  const action = useAction()
  const { session } = useFengwo()
  const links =
    tool === 'speed'
      ? [
          ['Speedtest', 'https://www.speedtest.net/zh-Hans'],
          ['Google Fiber', 'https://fiber.google.com/speedtest/'],
          ['Fast.com', 'https://fast.com'],
        ]
      : [
          ['Telegram', 'https://telegram.org/apps'],
          ['X', 'https://x.com/'],
          ['YouTube', 'https://www.youtube.com/'],
          ['Netflix', 'https://www.netflix.com/'],
          ['ChatGPT', 'https://chatgpt.com/'],
          ['Cloudflare', 'https://speed.cloudflare.com/'],
        ]
  const tools = [
    { key: 'speed', title: '网络测速', icon: SpeedRounded },
    { key: 'cf', title: 'Cloudflare 优选 IP', icon: CloudOutlined },
    { key: 'ip', title: 'IP 地址查询', icon: LocationOnOutlined },
    { key: 'stream', title: '流媒体解锁测试', icon: MovieOutlined },
    { key: 'chain', title: '链式代理', icon: LinkRounded },
    { key: 'apps', title: '常用应用', icon: LanguageRounded },
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
            {tool === 'speed' || tool === 'apps' ? (
              links.map(([label, url]) => (
                <Button
                  key={url}
                  startIcon={<OpenInNewRounded />}
                  onClick={() => void action.run(() => openUrl(url))}
                >
                  {label}
                </Button>
              ))
            ) : tool === 'ip' ? (
              <>
                <Button
                  disabled={action.busy || session?.offline}
                  onClick={() =>
                    void action.run(async () =>
                      setIp(
                        await business<Record<string, unknown>>('ipLookup'),
                      ),
                    )
                  }
                >
                  查询出口 IP
                </Button>
                {ip && (
                  <>
                    <Typography variant="h6">{String(ip.ip ?? '')}</Typography>
                    <Typography>
                      {[ip.country, ip.region, ip.city]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography>
                    <Typography>
                      {String(
                        (ip.connection as Record<string, unknown>)?.isp ?? '',
                      )}
                    </Typography>
                  </>
                )}
              </>
            ) : (
              <>
                <Alert severity="info">
                  测速会产生网络流量，优选结果仅在应用后生效。
                </Alert>
                <Button
                  startIcon={<SpeedRounded />}
                  disabled={action.busy || session?.offline}
                  onClick={() =>
                    void action.run(async () =>
                      setResults(await business<CfResult[]>('cfOptimize')),
                    )
                  }
                >
                  开始优选
                </Button>
                {action.busy && <Loading loading>{null}</Loading>}
                <div className="fengwo-table">
                  <Table>
                    <TableHead>
                      <TableRow>
                        {['IP', '延迟', '下载速度', '地区'].map((label) => (
                          <TableCell key={label}>{label}</TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {results.map((result) => (
                        <TableRow key={result.ip}>
                          <TableCell>{result.ip}</TableCell>
                          <TableCell>{result.latency} ms</TableCell>
                          <TableCell>{bytes(result.speed)}/s</TableCell>
                          <TableCell>{result.region}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Button
                  disabled={
                    action.busy ||
                    !results.length ||
                    session?.offline ||
                    !session?.profileUid
                  }
                  onClick={() =>
                    void action.run(
                      () => business('cfApply', { results }),
                      '优选 IP 已应用',
                    )
                  }
                >
                  应用优选 IP
                </Button>
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
