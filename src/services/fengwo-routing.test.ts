import { selectNodeForGroup } from 'tauri-plugin-mihomo-api'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProxyGroupView, ProxyViewV1 } from '@/types/proxy-view'

import { getProxyView, patchClashMode, recordSelectedNode } from './cmds'
import {
  changeRoutingMode,
  currentRoute,
  routingGroups,
} from './fengwo-routing'

vi.mock('tauri-plugin-mihomo-api', () => ({ selectNodeForGroup: vi.fn() }))
vi.mock('./cmds', () => ({
  getProxyView: vi.fn(),
  patchClashMode: vi.fn(),
  recordSelectedNode: vi.fn(),
}))

const capabilities = {
  udp: false,
  xudp: false,
  tfo: false,
  mptcp: false,
  smux: false,
}
const nodeRef = (name: string) => ({
  kind: 'node' as const,
  name,
  recordId: name,
})
function group(
  name: string,
  now: string,
  members: ProxyGroupView['members'],
): ProxyGroupView {
  return {
    ...capabilities,
    name,
    now,
    members,
    type: 'Selector',
    alive: true,
    history: [],
  }
}
function fixture(): ProxyViewV1 {
  return {
    schemaVersion: 1,
    orderSource: 'runtime',
    providerState: 'ready',
    global: group('GLOBAL', 'DIRECT', [
      nodeRef('DIRECT'),
      { kind: 'group', name: 'subscription' },
      nodeRef('node-b'),
    ]),
    direct: 'DIRECT',
    groups: [
      group('subscription', 'node-a', [nodeRef('node-a'), nodeRef('DIRECT')]),
    ],
    records: Object.fromEntries(
      ['DIRECT', 'node-a', 'node-b'].map((name) => [
        name,
        {
          ...capabilities,
          recordId: name,
          name,
          type: name === 'DIRECT' ? 'Direct' : 'Vless',
          alive: false,
          history: [],
          source: { kind: 'core' as const, proxyName: name },
        },
      ]),
    ),
    standalone: [],
    providers: [],
  }
}

let view: ProxyViewV1
beforeEach(() => {
  vi.resetAllMocks()
  view = fixture()
  vi.mocked(getProxyView).mockResolvedValue(view)
  vi.mocked(selectNodeForGroup).mockResolvedValue(undefined)
  vi.mocked(recordSelectedNode).mockResolvedValue(undefined)
  vi.mocked(patchClashMode).mockResolvedValue(undefined)
})

describe('mode-aware Fengwo routes', () => {
  it('exposes GLOBAL instead of inactive subscription groups in global mode', () => {
    view.groups.push({ ...view.groups[0], name: 'hidden', hidden: true })
    expect(routingGroups(view, 'global')).toEqual([view.global])
    expect(routingGroups(view, 'rule')).toEqual([view.groups[0]])
    expect(routingGroups({ ...view, global: null }, 'global')).toEqual([])
  })
  it('reports the active node instead of the rule selector in global and direct modes', () => {
    expect(currentRoute(view, 'rule')).toEqual({
      name: 'node-a',
      direct: false,
    })
    expect(currentRoute(view, 'global')).toEqual({
      name: 'DIRECT',
      direct: true,
    })
    view.global!.now = 'node-b'
    expect(currentRoute(view, 'GLOBAL')).toEqual({
      name: 'node-b',
      direct: false,
    })
    expect(currentRoute(view, 'direct')).toEqual({
      name: 'DIRECT',
      direct: true,
    })
    view.global!.now = 'subscription'
    expect(currentRoute(view, 'global')).toEqual({
      name: 'node-a',
      direct: false,
    })
  })
})

describe('global mode transition', () => {
  it('selects and persists the subscription route before switching out of rule mode', async () => {
    await changeRoutingMode('global')
    expect(selectNodeForGroup).toHaveBeenCalledWith('GLOBAL', 'subscription')
    expect(recordSelectedNode).toHaveBeenCalledWith('GLOBAL', 'subscription')
    expect(patchClashMode).toHaveBeenCalledWith('global')
    expect(
      vi.mocked(selectNodeForGroup).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(recordSelectedNode).mock.invocationCallOrder[0])
    expect(
      vi.mocked(recordSelectedNode).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(patchClashMode).mock.invocationCallOrder[0])
  })
  it('preserves an explicitly selected global proxy', async () => {
    view.global!.now = 'node-b'
    await changeRoutingMode('global')
    expect(selectNodeForGroup).not.toHaveBeenCalled()
    expect(recordSelectedNode).not.toHaveBeenCalled()
    expect(patchClashMode).toHaveBeenCalledWith('global')
  })
  it('replaces the core PassRule adapter with the selected subscription', async () => {
    view.records['PASS-RULE'] = {
      ...view.records.DIRECT,
      recordId: 'PASS-RULE',
      name: 'PASS-RULE',
      type: 'PassRule',
      source: { kind: 'core', proxyName: 'PASS-RULE' },
    }
    view.global!.members.push(nodeRef('PASS-RULE'))
    view.global!.now = 'PASS-RULE'
    await changeRoutingMode('global')
    expect(selectNodeForGroup).toHaveBeenCalledWith('GLOBAL', 'subscription')
    expect(recordSelectedNode).toHaveBeenCalledWith('GLOBAL', 'subscription')
    expect(patchClashMode).toHaveBeenCalledWith('global')
  })
  it.each([
    'missing-global',
    'direct-subscription',
    'pass-rule-subscription',
    'missing-member',
    'cycle',
  ])(
    'does not enable global mode with an unusable route: %s',
    async (scenario) => {
      if (scenario === 'missing-global') view.global = null
      if (scenario === 'direct-subscription') view.groups[0].now = 'DIRECT'
      if (scenario === 'pass-rule-subscription')
        view.records['node-a'].type = 'PassRule'
      if (scenario === 'missing-member')
        view.global!.members = [nodeRef('DIRECT')]
      if (scenario === 'cycle') {
        view.groups[0].now = 'subscription'
        view.groups[0].members = [{ kind: 'group', name: 'subscription' }]
      }
      await expect(changeRoutingMode('global')).rejects.toThrow()
      expect(selectNodeForGroup).not.toHaveBeenCalled()
      expect(patchClashMode).not.toHaveBeenCalled()
    },
  )
  it('does not enable global mode when reading the core or selecting a route fails', async () => {
    vi.mocked(getProxyView).mockRejectedValueOnce(new Error('core unavailable'))
    await expect(changeRoutingMode('global')).rejects.toThrow(
      'core unavailable',
    )
    expect(patchClashMode).not.toHaveBeenCalled()
    vi.mocked(selectNodeForGroup).mockRejectedValueOnce(
      new Error('selection failed'),
    )
    await expect(changeRoutingMode('global')).rejects.toThrow(
      'selection failed',
    )
    expect(recordSelectedNode).not.toHaveBeenCalled()
    expect(patchClashMode).not.toHaveBeenCalled()
  })
  it('does not enable global mode when persisting its route fails', async () => {
    vi.mocked(recordSelectedNode).mockRejectedValueOnce(new Error('disk full'))
    await expect(changeRoutingMode('global')).rejects.toThrow('disk full')
    expect(patchClashMode).not.toHaveBeenCalled()
  })
  it('reports a failed mode change instead of claiming it succeeded', async () => {
    vi.mocked(patchClashMode).mockRejectedValueOnce(new Error('mode failed'))
    await expect(changeRoutingMode('global')).rejects.toThrow('mode failed')
  })
  it.each(['rule', 'direct'] as const)(
    'does not rewrite proxy choices in %s mode',
    async (mode) => {
      await changeRoutingMode(mode)
      expect(getProxyView).not.toHaveBeenCalled()
      expect(selectNodeForGroup).not.toHaveBeenCalled()
      expect(patchClashMode).toHaveBeenCalledWith(mode)
    },
  )
})
