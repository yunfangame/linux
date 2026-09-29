import { selectNodeForGroup } from 'tauri-plugin-mihomo-api'

import type { ProxyGroupView, ProxyViewV1 } from '@/types/proxy-view'

import { getProxyView, patchClashMode, recordSelectedNode } from './cmds'
import { resolveDelayNode } from './fengwo-delay'

export function routingGroups(
  view: ProxyViewV1 | undefined,
  mode?: string | null,
) {
  if (mode?.toLowerCase() === 'global') return view?.global ? [view.global] : []
  return view?.groups.filter((group) => !group.hidden) ?? []
}

function selectedNode(view: ProxyViewV1, group?: ProxyGroupView) {
  return group?.now ? resolveDelayNode(view, group, group.now)?.node : undefined
}

export function currentRoute(
  view: ProxyViewV1 | undefined,
  mode?: string | null,
) {
  if (mode?.toLowerCase() === 'direct') return { name: 'DIRECT', direct: true }
  const group = routingGroups(view, mode)[0]
  const node = view && selectedNode(view, group)
  return {
    name: node?.name ?? group?.now,
    direct: node?.type.toLowerCase() === 'direct',
  }
}

function isProxy(view: ProxyViewV1, group?: ProxyGroupView) {
  const node = selectedNode(view, group)
  return (
    !!node &&
    ![
      'direct',
      'reject',
      'rejectdrop',
      'pass',
      'passrule',
      'compatible',
    ].includes(node.type.toLowerCase())
  )
}

export async function changeRoutingMode(mode: 'rule' | 'global' | 'direct') {
  if (mode === 'global') {
    const view = await getProxyView()
    const global = view.global
    if (!global) throw new Error('全局代理组暂不可用，请稍后重试。')
    if (!isProxy(view, global)) {
      const primary = routingGroups(view, 'rule')[0]
      const members = global.members.filter(
        (member) => member.kind === 'group' && member.name === primary?.name,
      )
      if (!primary || members.length !== 1 || !isProxy(view, primary))
        throw new Error('当前没有选中的代理节点，无法开启全局模式。')

      // Establish and persist the route before global mode can send traffic.
      await selectNodeForGroup(global.name, primary.name)
      await recordSelectedNode(global.name, primary.name)
    }
  }
  await patchClashMode(mode)
}
