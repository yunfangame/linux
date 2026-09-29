import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { billedBytes, bytes, date, money, paymentPayload } from './fengwo'

describe('business data', () => {
  it('prices use integer cents', () => {
    expect(money(1999)).toBe('¥19.99')
    expect(money(0)).toBe('¥0.00')
  })
  it('counts billed traffic with the desktop multiplier limits', () => {
    expect(billedBytes({ u: 10, d: 20, server_rate: 1.5, record_at: 1 })).toBe(
      45,
    )
    expect(billedBytes({ u: -10, d: 20, server_rate: -1, record_at: 1 })).toBe(
      0,
    )
    expect(
      billedBytes({ u: -10, d: 20, server_rate: Infinity, record_at: 1 }),
    ).toBe(0)
    expect(billedBytes({ u: 1, d: 1, server_rate: 100001, record_at: 1 })).toBe(
      200000,
    )
    expect(bytes(-1)).toBe('0 B')
    expect(bytes(1024)).toBe('1.00 KB')
  })
  it.each(['qrcode', 'qr_code', 'url', 'pay_url', 'payment_url'])(
    'accepts payment field %s',
    (field) => {
      expect(
        paymentPayload({
          type: 0,
          data: { [field]: 'https://example.org/pay' },
        }),
      ).toBe('https://example.org/pay')
    },
  )
  it('handles date strings from login history', () => {
    expect(date('2026-09-29T00:00:00Z')).not.toBe('未知')
    expect(date('broken')).toBe('未知')
    expect(date(null)).toBe('长期有效')
  })
})

describe('account boundaries', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
  })
  it('binds commands to the current native session', async () => {
    const api = await import('./fengwo')
    invokeMock.mockResolvedValueOnce({ id: 'a', summary: {}, offline: false })
    await api.restoreSession()
    invokeMock.mockResolvedValueOnce([])
    await api.business('orders')
    expect(invokeMock).toHaveBeenLastCalledWith('fengwo_action', {
      action: 'orders',
      payload: {},
      sessionId: 'a',
    })
  })
  it('rejects a late response after logout instead of displaying another account', async () => {
    const api = await import('./fengwo')
    invokeMock.mockResolvedValueOnce({ id: 'a', summary: {}, offline: false })
    await api.restoreSession()
    let resolveOrders!: (value: unknown[]) => void
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOrders = resolve
        }),
    )
    const orders = api.business('orders')
    invokeMock.mockResolvedValueOnce(null)
    await api.business('logout')
    resolveOrders([])
    await expect(orders).rejects.toThrow('session_changed')
  })
  it('refreshes native session state on expiry without replaying the failed request', async () => {
    const api = await import('./fengwo')
    invokeMock.mockResolvedValueOnce({ id: 'a', summary: {}, offline: false })
    await api.restoreSession()
    const error = { detail: 'authentication_expired' }
    invokeMock
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        id: 'a',
        summary: {},
        offline: false,
        needsLogin: true,
      })
    await expect(api.business('createOrder')).rejects.toEqual(error)
    expect(invokeMock).toHaveBeenLastCalledWith('fengwo_action', {
      action: 'sessionState',
    })
    expect(invokeMock).toHaveBeenCalledTimes(3)
  })
  it('does not perform session recovery for failed login or network errors', async () => {
    const api = await import('./fengwo')
    invokeMock.mockRejectedValueOnce({ detail: 'invalid_credentials' })
    await expect(api.business('login')).rejects.toEqual({
      detail: 'invalid_credentials',
    })
    expect(invokeMock).toHaveBeenCalledTimes(1)
    invokeMock.mockRejectedValueOnce({ detail: 'network_unavailable' })
    await expect(api.business('orders')).rejects.toEqual({
      detail: 'network_unavailable',
    })
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })
})
