import type {
  ProxyGroupView,
  ProxyNodeView,
  ProxyViewV1,
} from '@/types/proxy-view'

import type { NodeMetadata } from './fengwo'

export const DESKTOP_DELAY_BATCH = 50
export const DEFAULT_PROBE_URL = 'http://cp.cloudflare.com/generate_204'
export function nodeMatchKey(name: string) {
  return name.toLowerCase().replace(/[\u{1f1e6}-\u{1f1ff}\s\-_·|｜]/gu, '')
}
export function nodeStatus(
  name: string,
  nodes: NodeMetadata[],
  fresh = true,
): 'online' | 'offline' | 'unknown' {
  if (!fresh || !name.trim()) return 'unknown'
  let matches = nodes.filter((node) => node.name === name)
  if (!matches.length) {
    const key = nodeMatchKey(name)
    if (!key) return 'unknown'
    matches = nodes.filter((node) => nodeMatchKey(node.name) === key)
  }
  if (matches.length !== 1) return 'unknown'
  const value = String(matches[0].is_online).trim().toLowerCase()
  return value === 'true' || value === '1'
    ? 'online'
    : value === 'false' || value === '0'
      ? 'offline'
      : 'unknown'
}
export function probeUrl(...values: (string | undefined)[]) {
  for (const value of values) {
    try {
      const url = new URL(value?.trim() ?? '')
      if (['http:', 'https:'].includes(url.protocol) && url.hostname)
        return url.href
    } catch {
      /* Invalid profile probe URLs use the desktop fallback. */
    }
  }
  return DEFAULT_PROBE_URL
}
export function resolveDelayNode(
  view: ProxyViewV1,
  group: ProxyGroupView,
  name: string,
): { node: ProxyNodeView; url: string } | undefined {
  const seen = new Set<string>()
  let current = group
  let selected = name
  let url = group.testUrl
  while (!seen.has(current.name)) {
    seen.add(current.name)
    const matches = current.members.filter((member) => member.name === selected)
    if (matches.length !== 1) return
    const ref = matches[0]
    if (!ref || ref.kind === 'unresolved') return
    if (ref.kind === 'node') {
      const node = view.records[ref.recordId]
      return node ? { node, url: probeUrl(node.testUrl, url) } : undefined
    }
    const next =
      view.groups.find((candidate) => candidate.name === ref.name) ??
      (view.global?.name === ref.name ? view.global : undefined)
    if (!next || !next.now) return
    current = next
    selected = next.now
    url = next.testUrl || url
  }
}
export async function desktopDelayBatch<T>(
  items: readonly T[],
  test: (item: T) => Promise<void>,
  isCurrent: () => boolean = () => true,
) {
  for (
    let index = 0;
    index < items.length && isCurrent();
    index += DESKTOP_DELAY_BATCH
  )
    await Promise.all(items.slice(index, index + DESKTOP_DELAY_BATCH).map(test))
}
