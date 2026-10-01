import i18n from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./cmds', () => ({ getVergeConfig: vi.fn() }))

import { getVergeConfig } from './cmds'
import { getCachedLanguage } from './i18n'
import { preloadAppData } from './preload'

describe('Linux startup language', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    vi.mocked(getVergeConfig).mockReset()
    vi.stubGlobal('navigator', { language: 'en-US' })
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defaults to Chinese on an English host without a saved language', async () => {
    vi.mocked(getVergeConfig).mockResolvedValue({})
    await preloadAppData()
    expect(i18n.language).toBe('zh')
    expect(getCachedLanguage()).toBe('zh')
    expect(
      i18n.t((t) => t.settings.sections.proxyControl.fields.systemProxy),
    ).toBe('系统代理')
    expect(i18n.t((t) => t.settings.sections.proxyControl.fields.tunMode)).toBe(
      '虚拟网卡模式',
    )
  })

  it('uses the persisted language instead of a stale browser cache', async () => {
    storage.set('verge-language', 'en')
    vi.mocked(getVergeConfig).mockResolvedValue({ language: 'zh' })
    await preloadAppData()
    expect(i18n.language).toBe('zh')
    expect(getCachedLanguage()).toBe('zh')
  })

  it('preserves an explicitly saved language', async () => {
    vi.mocked(getVergeConfig).mockResolvedValue({ language: 'en' })
    await preloadAppData()
    expect(i18n.language).toBe('en')
    expect(getCachedLanguage()).toBe('en')
  })

  it.each([
    ['en', 'en'],
    [undefined, 'zh'],
  ])(
    'restores cache %s when native configuration is unavailable',
    async (cached, expected) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (cached) storage.set('verge-language', cached)
      vi.mocked(getVergeConfig).mockRejectedValue(new Error('unavailable'))
      await preloadAppData()
      expect(i18n.language).toBe(expected)
      expect(getCachedLanguage()).toBe(expected)
    },
  )
})
