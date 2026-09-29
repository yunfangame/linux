import {
  AddRounded,
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  DeleteOutlineRounded,
  EditOutlined,
  PowerSettingsNewRounded,
  SpeedRounded,
  SyncRounded,
  TuneRounded,
} from '@mui/icons-material'
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  LinearProgress,
  MenuItem,
  Switch,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import useSWR from 'swr'
import {
  closeAllConnections,
  closeConnection,
  delayProxyByName,
  healthcheckNodeInProvider,
} from 'tauri-plugin-mihomo-api'

import ProxyControlSwitches from '@/components/shared/proxy-control-switches'
import { useClashMode } from '@/hooks/use-clash'
import { useConnectionData } from '@/hooks/use-connection-data'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { getProxyView } from '@/services/cmds'
import {
  type LocalRule,
  type NodeMetadata,
  type TrafficRecord,
  billedBytes,
  business,
  bytes,
  date,
  useAction,
  useBusiness,
  useFengwo,
} from '@/services/fengwo'
import {
  desktopDelayBatch,
  nodeStatus,
  resolveDelayNode,
} from '@/services/fengwo-delay'
import {
  changeRoutingMode,
  currentRoute,
  routingGroups,
} from '@/services/fengwo-routing'

import { RichText } from './content'
import { Feedback, Loading, Page, Refresh, Stat } from './shared'

function useFengwoProxies() {
  const { session } = useFengwo()
  return useSWR(
    session?.profileUid
      ? ['fengwo-proxies', session.id, session.profileUid]
      : null,
    getProxyView,
    { refreshInterval: 5000 },
  )
}
function ModeSelector() {
  const mode = useClashMode()
  const proxies = useFengwoProxies()
  const action = useAction()
  return (
    <>
      <ToggleButtonGroup
        size="small"
        value={mode.data?.toLowerCase() ?? 'rule'}
        exclusive
        onChange={(_, value) => {
          if (value)
            void action.run(async () => {
              await changeRoutingMode(value)
              await mode.refetch()
              await proxies.mutate()
            })
        }}
        disabled={action.busy || mode.isLoading}
      >
        <ToggleButton value="rule">规则模式</ToggleButton>
        <ToggleButton value="global">全局模式</ToggleButton>
        <ToggleButton value="direct">直连模式</ToggleButton>
      </ToggleButtonGroup>
      <Feedback {...action} />
    </>
  )
}
export function DashboardPage() {
  const [selectedNotice, setSelectedNotice] = useState<{
    title: string
    content: string
  }>()
  const { session } = useFengwo()
  const summary = session?.summary
  const action = useAction()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const proxies = useFengwoProxies()
  const mode = useClashMode()
  const route = currentRoute(proxies.data, mode.data)
  const traffic = useTrafficData()
  const { indicator, toggleSystemProxy } = useSystemProxyState()
  const notices =
    useBusiness<{ id: number; title: string; content: string }[]>('notices')
  const used = Number(summary?.u ?? 0) + Number(summary?.d ?? 0)
  const total = Number(summary?.transfer_enable ?? 0)
  return (
    <Page
      title="加速主页"
      actions={
        <Button
          disabled={action.busy || session?.offline}
          startIcon={<SyncRounded />}
          onClick={() =>
            void action.run(async () => {
              await business('sync')
              await business('summary')
              await proxies.mutate()
            }, '订阅已更新')
          }
        >
          更新订阅
        </Button>
      }
    >
      <Feedback {...action} />
      {!session?.profileUid && (
        <Alert severity="info">当前账号尚未同步订阅。</Alert>
      )}
      <div className="fengwo-network">
        <div className="fengwo-form">
          <Chip
            sx={{ alignSelf: 'start' }}
            color={indicator && !route.direct ? 'success' : 'default'}
            label={indicator ? '系统代理已开启' : '加速未开启'}
          />
          <Button
            size="large"
            variant="contained"
            startIcon={<PowerSettingsNewRounded />}
            disabled={action.busy || (!session?.profileUid && !indicator)}
            onClick={() => void action.run(() => toggleSystemProxy(!indicator))}
          >
            {indicator ? '断开加速' : '开启加速'}
          </Button>
          <ModeSelector />
          {indicator && route.direct && (
            <Alert severity="warning">当前流量直连</Alert>
          )}
          <Button
            startIcon={<TuneRounded />}
            onClick={() => navigate('/nodes')}
          >
            {route.name ?? '选择节点'}
          </Button>
        </div>
        <div>
          <ProxyControlSwitches
            onError={(error) => action.setError(String(error))}
          />
          <ProxyControlSwitches
            label={t('settings.sections.system.toggles.tunMode')}
            onError={(error) => action.setError(String(error))}
          />
          <div className="fengwo-stats">
            <Stat
              label="下载速度"
              value={`${bytes(traffic.response.data?.down)}/s`}
              color="success.main"
            />
            <Stat
              label="上传速度"
              value={`${bytes(traffic.response.data?.up)}/s`}
              color="primary.main"
            />
          </div>
        </div>
      </div>
      <div className="fengwo-toolbar">
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          {summary?.plan?.name ?? '暂无套餐'}
        </Typography>
        <Button onClick={() => navigate('/plans')}>购买 / 续费</Button>
      </div>
      <div className="fengwo-stats">
        <Stat label="已用流量" value={bytes(used)} />
        <Stat label="剩余流量" value={bytes(Math.max(0, total - used))} />
        <Stat label="套餐流量" value={bytes(total)} />
        <Stat
          label="到期时间"
          value={
            summary?.expired_at
              ? new Date(summary.expired_at * 1000).toLocaleDateString('zh-CN')
              : '长期有效'
          }
        />
      </div>
      <LinearProgress
        aria-label="套餐流量使用比例"
        variant="determinate"
        value={total > 0 ? Math.min(100, (used / total) * 100) : 0}
      />
      {!!notices.data?.length && (
        <section>
          <Typography variant="h6" sx={{ mb: 1 }}>
            公告
          </Typography>
          {notices.data.slice(0, 3).map((notice) => (
            <Alert
              key={notice.id ?? notice.title}
              severity="info"
              sx={{ mb: 1 }}
              action={
                <Button onClick={() => setSelectedNotice(notice)}>查看</Button>
              }
            >
              {notice.title}
            </Alert>
          ))}
        </section>
      )}
      <Dialog
        open={!!selectedNotice}
        onClose={() => setSelectedNotice(undefined)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{selectedNotice?.title}</DialogTitle>
        <DialogContent>
          <RichText>{selectedNotice?.content ?? ''}</RichText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedNotice(undefined)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </Page>
  )
}
export function NodesPage() {
  const { session } = useFengwo()
  const mode = useClashMode()
  return (
    <NodeList
      key={`${session?.profileUid ?? 'empty'}:${mode.data}`}
      mode={mode.data}
    />
  )
}
function NodeList({ mode }: { mode?: string | null }) {
  const { session } = useFengwo()
  const proxies = useFengwoProxies()
  const metadata = useBusiness<NodeMetadata[]>('nodes')
  const [groupName, setGroupName] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState(false)
  const [delays, setDelays] = useState<Record<string, number>>({})
  const action = useAction()
  const generationRef = useRef({ value: 0 })
  useEffect(() => {
    const generation = generationRef.current
    return () => {
      generation.value++
    }
  }, [])
  const groups = routingGroups(proxies.data, mode ?? undefined)
  const group = groups.find((item) => item.name === groupName) ?? groups[0]
  const { changeProxy } = useProxySelection({
    onSuccess: () => {
      void proxies.mutate()
    },
    onError: () => action.setError('节点切换失败，请重试。'),
  })
  const fresh = !metadata.error && !metadata.isValidating && !session?.offline
  const rows = (group?.members ?? []).filter((ref) =>
    ref.name.toLowerCase().includes(query.toLowerCase()),
  )
  if (sort && !action.busy)
    rows.sort(
      (a, b) =>
        (delays[a.name] > 0 ? delays[a.name] : Infinity) -
        (delays[b.name] > 0 ? delays[b.name] : Infinity),
    )
  const test = async (names: string[]) => {
    if (!group || !proxies.data) return
    const view = proxies.data
    const revision = ++generationRef.current.value
    const valid = () => generationRef.current.value === revision
    await desktopDelayBatch(
      names,
      async (name) => {
        if (
          !valid() ||
          nodeStatus(name, metadata.data ?? [], fresh) === 'offline'
        )
          return
        const resolved = resolveDelayNode(view, group, name)
        if (
          !resolved ||
          nodeStatus(resolved.node.name, metadata.data ?? [], fresh) ===
            'offline'
        )
          return
        setDelays((previous) => ({ ...previous, [name]: 0 }))
        try {
          const { node, url } = resolved
          const result =
            node.source.kind === 'provider'
              ? await healthcheckNodeInProvider(
                  node.source.providerName,
                  node.source.proxyName,
                  url,
                  5000,
                )
              : await delayProxyByName(node.source.proxyName, url, 5000)
          if (valid())
            setDelays((previous) => ({
              ...previous,
              [name]: result.delay > 0 ? result.delay : -1,
            }))
        } catch {
          if (valid()) setDelays((previous) => ({ ...previous, [name]: -1 }))
        }
      },
      valid,
    )
  }
  return (
    <Page
      title="节点状态"
      actions={
        <>
          <Refresh
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                await business('sync')
                await metadata.mutate()
                await proxies.mutate()
              })
            }
          />
          <Button
            startIcon={<SpeedRounded />}
            disabled={action.busy || !group}
            onClick={() =>
              void action.run(() =>
                test((group?.members ?? []).map((item) => item.name)),
              )
            }
          >
            全部测速
          </Button>
        </>
      }
    >
      <Feedback {...action} />
      <div className="fengwo-toolbar">
        <TextField
          select
          size="small"
          label="代理组"
          value={group?.name ?? ''}
          sx={{ minWidth: 180 }}
          onChange={(event) => {
            generationRef.current.value++
            setDelays({})
            setGroupName(event.target.value)
          }}
        >
          {groups.map((item) => (
            <MenuItem key={item.name} value={item.name}>
              {item.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="搜索节点"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <FormControlLabel
          control={
            <Switch
              checked={sort}
              onChange={(_, checked) => setSort(checked)}
              disabled={action.busy}
            />
          }
          label="按延迟排序"
        />
      </div>
      {metadata.error && (
        <Alert severity="warning">节点后台状态暂不可用，测速仍可使用。</Alert>
      )}
      <Loading
        loading={proxies.isLoading}
        error={proxies.error}
        empty={!rows.length}
      >
        <div className="fengwo-table">
          <Table>
            <TableHead>
              <TableRow>
                {['节点', '后台状态', '参考延迟', '操作'].map((text) => (
                  <TableCell key={text}>{text}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((node) => {
                const status = nodeStatus(node.name, metadata.data ?? [], fresh)
                return (
                  <TableRow
                    key={
                      node.kind === 'node'
                        ? node.recordId
                        : `${node.kind}:${node.name}`
                    }
                    selected={group?.now === node.name}
                  >
                    <TableCell>
                      {node.name}
                      {group?.now === node.name && (
                        <Chip sx={{ ml: 1 }} size="small" label="当前" />
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        color={
                          status === 'online'
                            ? 'success'
                            : status === 'offline'
                              ? 'error'
                              : 'default'
                        }
                        label={
                          { online: '在线', offline: '离线', unknown: '未知' }[
                            status
                          ]
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {delays[node.name] === undefined
                        ? '未测试'
                        : delays[node.name] === 0
                          ? '测速中'
                          : delays[node.name] < 0
                            ? '超时'
                            : `${delays[node.name]} ms`}
                    </TableCell>
                    <TableCell>
                      <Tooltip title="节点测速">
                        <span>
                          <IconButton
                            aria-label={`测速 ${node.name}`}
                            disabled={
                              action.busy ||
                              status === 'offline' ||
                              node.kind === 'unresolved'
                            }
                            onClick={() =>
                              void action.run(() => test([node.name]))
                            }
                          >
                            <SpeedRounded />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Button
                        disabled={
                          !group ||
                          action.busy ||
                          node.kind === 'unresolved' ||
                          !['Selector', 'URLTest', 'Fallback'].includes(
                            group.type,
                          )
                        }
                        onClick={() =>
                          group &&
                          changeProxy(
                            group.name,
                            node.name,
                            group.now,
                            group.fixed,
                          )
                        }
                      >
                        选择
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </Loading>
    </Page>
  )
}
export function TrafficPage() {
  const { session } = useFengwo()
  const logs = useBusiness<TrafficRecord[]>('traffic')
  const action = useAction()
  const records = [...(logs.data ?? [])]
    .filter((item) => item.record_at > 0)
    .sort((a, b) => b.record_at - a.record_at)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const daily = records
    .filter(
      (record) =>
        new Date(record.record_at * 1000).toDateString() === now.toDateString(),
    )
    .reduce((sum, record) => sum + billedBytes(record), 0)
  const monthly = records
    .filter((record) => {
      const d = new Date(record.record_at * 1000)
      return (
        d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      )
    })
    .reduce((sum, record) => sum + billedBytes(record), 0)
  const summary = session?.summary
  return (
    <Page
      title="流量详情"
      actions={
        <Refresh
          busy={action.busy}
          onClick={() =>
            void action.run(async () => {
              await business('summary')
              await logs.mutate()
            })
          }
        />
      }
    >
      <Feedback {...action} />
      <div className="fengwo-stats">
        <Stat label="今日计费流量" value={bytes(daily)} />
        <Stat label="本月计费流量" value={bytes(monthly)} />
        <Stat
          label="剩余流量"
          value={bytes(
            Math.max(
              0,
              Number(summary?.transfer_enable ?? 0) -
                Number(summary?.u ?? 0) -
                Number(summary?.d ?? 0),
            ),
          )}
        />
        <Stat label="套餐流量" value={bytes(summary?.transfer_enable)} />
      </div>
      <Loading
        loading={logs.isLoading}
        error={logs.error}
        empty={!records.length}
      >
        <div className="fengwo-table">
          <Table>
            <TableHead>
              <TableRow>
                {['时间', '上传', '下载', '倍率', '计费流量'].map((label) => (
                  <TableCell key={label}>{label}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {records.map((record) => (
                <TableRow
                  key={`${record.record_at}:${record.server_rate}:${record.u}:${record.d}`}
                >
                  <TableCell>{date(record.record_at)}</TableCell>
                  <TableCell>{bytes(record.u)}</TableCell>
                  <TableCell>{bytes(record.d)}</TableCell>
                  <TableCell>{record.server_rate ?? 1}×</TableCell>
                  <TableCell>{bytes(billedBytes(record))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Loading>
    </Page>
  )
}

export function RoutingPage() {
  const rules = useBusiness<LocalRule[]>('rules', {}, true)
  const [tab, setTab] = useState(() =>
    new URLSearchParams(window.location.search).get('tab') === 'rules' ? 1 : 0,
  )
  const [poll, setPoll] = useState(true)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<LocalRule>()
  const [detail, setDetail] = useState<IConnectionsItem>()
  const connections = useConnectionData({ enabled: tab === 0 && poll })
  const proxies = useFengwoProxies()
  const { session } = useFengwo()
  const action = useAction()
  const list = connections.response.data?.activeConnections ?? []
  const filtered = list.filter((item) =>
    `${item.metadata.host} ${item.metadata.destinationIP} ${item.metadata.process}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const save = (next: LocalRule[]) =>
    action.run(async () => {
      await business('saveRules', { rules: next })
      await rules.mutate()
    }, '规则已保存并生效')
  const add = (host = '', kind = 'DOMAIN') =>
    setEditing({
      id: crypto.randomUUID(),
      kind,
      value: host,
      target: 'DIRECT',
      enabled: true,
    })
  const move = (index: number, offset: number) => {
    const next = [...(rules.data ?? [])]
    ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
    void save(next)
  }
  return (
    <Page title="代理规则" actions={<ModeSelector />}>
      <Feedback {...action} />
      <Tabs value={tab} onChange={(_, value) => setTab(value)}>
        <Tab label={`当前连接 ${list.length}`} />
        <Tab label={`已保存规则 ${rules.data?.length ?? 0}`} />
      </Tabs>
      {tab === 0 ? (
        <>
          <div className="fengwo-toolbar">
            <TextField
              label="搜索域名 / IP / 进程"
              size="small"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={poll}
                  onChange={(_, value) => setPoll(value)}
                />
              }
              label="自动刷新"
            />
            <Button
              disabled={action.busy || !list.length}
              onClick={() => void action.run(closeAllConnections)}
            >
              关闭全部连接
            </Button>
          </div>
          <Loading empty={!filtered.length}>
            <div className="fengwo-table">
              <Table>
                <TableHead>
                  <TableRow>
                    {['目标', '进程', '规则 / 节点', '下载 / 上传', '操作'].map(
                      (label) => (
                        <TableCell key={label}>{label}</TableCell>
                      ),
                    )}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        {item.metadata.host || item.metadata.destinationIP}:
                        {item.metadata.destinationPort}
                      </TableCell>
                      <TableCell>{item.metadata.process}</TableCell>
                      <TableCell>
                        {item.rule}
                        <Typography variant="caption" sx={{ display: 'block' }}>
                          {item.chains.join(' → ')}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {bytes(item.download)} / {bytes(item.upload)}
                      </TableCell>
                      <TableCell>
                        <Button onClick={() => setDetail(item)}>详情</Button>
                        <Button
                          disabled={!session?.profileUid}
                          onClick={() =>
                            add(
                              item.metadata.host ||
                                `${item.metadata.destinationIP ?? ''}/${item.metadata.destinationIP?.includes(':') ? 128 : 32}`,
                              item.metadata.host
                                ? 'DOMAIN'
                                : item.metadata.destinationIP?.includes(':')
                                  ? 'IP-CIDR6'
                                  : 'IP-CIDR',
                            )
                          }
                        >
                          添加规则
                        </Button>
                        <Button
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(() => closeConnection(item.id))
                          }
                        >
                          关闭
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Loading>
        </>
      ) : (
        <>
          <div>
            <Button
              startIcon={<AddRounded />}
              disabled={action.busy || !session?.profileUid}
              onClick={() => add()}
            >
              添加规则
            </Button>
          </div>
          <Loading
            loading={rules.isLoading}
            error={rules.error}
            empty={!rules.data?.length}
          >
            <div className="fengwo-table">
              <Table>
                <TableHead>
                  <TableRow>
                    {['启用', '类型', '匹配内容', '策略', '操作'].map(
                      (label) => (
                        <TableCell key={label}>{label}</TableCell>
                      ),
                    )}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rules.data?.map((rule, index) => (
                    <TableRow key={rule.id}>
                      <TableCell>
                        <Switch
                          aria-label={`启用规则 ${rule.value}`}
                          checked={rule.enabled}
                          disabled={action.busy}
                          onChange={(_, enabled) =>
                            void save(
                              (rules.data ?? []).map((item) =>
                                item.id === rule.id
                                  ? { ...item, enabled }
                                  : item,
                              ),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>{rule.kind}</TableCell>
                      <TableCell>{rule.value}</TableCell>
                      <TableCell>{rule.target}</TableCell>
                      <TableCell>
                        <Tooltip title="编辑">
                          <IconButton
                            aria-label="编辑规则"
                            disabled={action.busy}
                            onClick={() => setEditing(rule)}
                          >
                            <EditOutlined />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="上移">
                          <span>
                            <IconButton
                              aria-label="上移规则"
                              disabled={action.busy || index === 0}
                              onClick={() => move(index, -1)}
                            >
                              <ArrowUpwardRounded />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="下移">
                          <span>
                            <IconButton
                              aria-label="下移规则"
                              disabled={
                                action.busy ||
                                index === (rules.data?.length ?? 0) - 1
                              }
                              onClick={() => move(index, 1)}
                            >
                              <ArrowDownwardRounded />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="删除">
                          <IconButton
                            aria-label="删除规则"
                            disabled={action.busy}
                            onClick={() =>
                              void save(
                                (rules.data ?? []).filter(
                                  (item) => item.id !== rule.id,
                                ),
                              )
                            }
                          >
                            <DeleteOutlineRounded />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Loading>
        </>
      )}
      <Dialog
        open={!!editing}
        onClose={action.busy ? undefined : () => setEditing(undefined)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>代理规则</DialogTitle>
        <DialogContent>
          <div className="fengwo-form" style={{ paddingTop: 8 }}>
            <TextField
              select
              label="规则类型"
              value={editing?.kind ?? 'DOMAIN'}
              onChange={(e) =>
                setEditing(
                  (value) => value && { ...value, kind: e.target.value },
                )
              }
            >
              {[
                'DOMAIN',
                'DOMAIN-SUFFIX',
                'DOMAIN-KEYWORD',
                'IP-CIDR',
                'IP-CIDR6',
                'PROCESS-NAME',
                'PROCESS-PATH',
              ].map((kind) => (
                <MenuItem key={kind} value={kind}>
                  {kind}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="匹配内容"
              value={editing?.value ?? ''}
              onChange={(e) =>
                setEditing(
                  (value) => value && { ...value, value: e.target.value },
                )
              }
            />
            <TextField
              select
              label="策略"
              value={editing?.target ?? 'DIRECT'}
              onChange={(e) =>
                setEditing(
                  (value) => value && { ...value, target: e.target.value },
                )
              }
            >
              {[
                'DIRECT',
                'REJECT',
                ...(proxies.data?.groups.map((group) => group.name) ?? []),
              ].map((target) => (
                <MenuItem key={target} value={target}>
                  {target}
                </MenuItem>
              ))}
            </TextField>
            <Feedback {...action} />
          </div>
        </DialogContent>
        <DialogActions>
          <Button disabled={action.busy} onClick={() => setEditing(undefined)}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={
              action.busy ||
              !editing?.value.trim() ||
              /[,\r\n]/.test(editing.value)
            }
            onClick={() =>
              void action.run(async () => {
                if (!editing) return
                const next = [...(rules.data ?? [])]
                const index = next.findIndex((rule) => rule.id === editing.id)
                if (index >= 0) next[index] = editing
                else next.push(editing)
                await business('saveRules', { rules: next })
                await rules.mutate()
                setEditing(undefined)
              })
            }
          >
            保存并应用
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!detail} onClose={() => setDetail(undefined)} fullWidth>
        <DialogTitle>连接详情</DialogTitle>
        <DialogContent>
          <Typography>
            目标：{detail?.metadata.host || detail?.metadata.destinationIP}
          </Typography>
          <Typography>进程：{detail?.metadata.processPath}</Typography>
          <Typography>
            规则：{detail?.rule} / {detail?.rulePayload}
          </Typography>
          <Typography>代理链：{detail?.chains.join(' → ')}</Typography>
          <Typography>建立时间：{detail?.start}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetail(undefined)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </Page>
  )
}
