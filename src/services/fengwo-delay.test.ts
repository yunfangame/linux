import { describe, expect, it } from 'vitest'

import type {
  ProxyGroupView,
  ProxyNodeView,
  ProxyViewV1,
} from '@/types/proxy-view'

import {
  DEFAULT_PROBE_URL,
  desktopDelayBatch,
  nodeMatchKey,
  nodeStatus,
  probeUrl,
  resolveDelayNode,
} from './fengwo-delay'

const capabilities = {
  udp: false,
  xudp: false,
  tfo: false,
  mptcp: false,
  smux: false,
}
const node: ProxyNodeView = {
  ...capabilities,
  recordId: 'provider:a',
  name: 'HK 01',
  type: 'ss',
  alive: true,
  history: [],
  source: {
    kind: 'provider',
    providerName: 'subscription',
    proxyName: 'HK 01',
  },
}
function group(
  name: string,
  members: ProxyGroupView['members'],
  now?: string,
): ProxyGroupView {
  return {
    ...capabilities,
    name,
    type: 'Selector',
    alive: true,
    history: [],
    members,
    now,
  }
}
function view(groups: ProxyGroupView[]): ProxyViewV1 {
  return {
    schemaVersion: 1,
    orderSource: 'runtime',
    providerState: 'ready',
    global: null,
    direct: null,
    groups,
    records: { [node.recordId]: node },
    standalone: [],
    providers: [],
  }
}

describe('desktop node matching', () => {
  it('normalizes flags and separators, but prefers exact names', () => {
    expect(nodeMatchKey('🇭🇰 HK_01 | A')).toBe('hk01a')
    const nodes = [
      { name: 'HK 01', is_online: true },
      { name: 'HK-01', is_online: false },
    ]
    expect(nodeStatus('HK 01', nodes)).toBe('online')
    expect(nodeStatus('🇭🇰 HK_01', nodes)).toBe('unknown')
  })
  it.each([false, 0, '0', 'false'])(
    'recognizes explicit offline %s',
    (is_online) => {
      expect(nodeStatus('HK-01', [{ name: 'HK 01', is_online }])).toBe(
        'offline',
      )
    },
  )
  it('does not trust stale, missing, or duplicate metadata', () => {
    expect(nodeStatus('a', [{ name: 'a', is_online: false }], false)).toBe(
      'unknown',
    )
    expect(nodeStatus('a', [{ name: 'a' }])).toBe('unknown')
    expect(
      nodeStatus('a', [
        { name: 'a', is_online: false },
        { name: 'a', is_online: false },
      ]),
    ).toBe('unknown')
    expect(nodeStatus('', [])).toBe('unknown')
  })
})

describe('desktop latency resolution', () => {
  it('uses the default URL only after valid configured URLs are exhausted', () => {
    expect(probeUrl('file:///tmp/test', 'invalid')).toBe(DEFAULT_PROBE_URL)
    expect(probeUrl('invalid', 'https://example.org/204')).toBe(
      'https://example.org/204',
    )
  })
  it('resolves nested selections without losing provider identity', () => {
    const root = group('root', [{ kind: 'group', name: 'auto' }])
    const auto = group(
      'auto',
      [{ kind: 'node', name: node.name, recordId: node.recordId }],
      node.name,
    )
    auto.testUrl = 'https://example.org/204'
    expect(resolveDelayNode(view([root, auto]), root, 'auto')).toEqual({
      node,
      url: auto.testUrl,
    })
  })
  it('does not measure cycles or unresolved members', () => {
    const a = group('a', [{ kind: 'group', name: 'b' }], 'b')
    const b = group('b', [{ kind: 'group', name: 'a' }], 'a')
    expect(resolveDelayNode(view([a, b]), a, 'b')).toBeUndefined()
    expect(resolveDelayNode(view([a]), a, 'missing')).toBeUndefined()
  })
  it('does not guess when providers expose ambiguous member names', () => {
    const root = group('root', [
      { kind: 'node', name: node.name, recordId: node.recordId },
      { kind: 'node', name: node.name, recordId: 'another-provider' },
    ])
    expect(resolveDelayNode(view([root]), root, node.name)).toBeUndefined()
  })
  it('runs batches of at most 50, preserving every requested measurement', async () => {
    let active = 0
    let maximum = 0
    const measured: number[] = []
    await desktopDelayBatch(
      Array.from({ length: 123 }, (_, index) => index),
      async (index) => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        measured.push(index)
        active--
      },
    )
    expect(maximum).toBe(50)
    expect(measured).toHaveLength(123)
    expect(new Set(measured).size).toBe(123)
  })
  it('does not launch another batch after an account or group switch', async () => {
    let current = true
    let count = 0
    await desktopDelayBatch(
      Array.from({ length: 120 }, (_, index) => index),
      async () => {
        count++
        current = false
      },
      () => current,
    )
    expect(count).toBe(50)
  })
})
