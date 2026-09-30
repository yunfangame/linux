import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const origin = process.env.FENGWO_PREVIEW_URL || 'http://127.0.0.1:4319'
const output = path.resolve('target/fengwo-ui')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYWRIGHT_CHANNEL,
})
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  })
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  )
  // Native IPC is mocked only in this browser test, never in a production entry point.
  await context.addInitScript(() => {
    const caps = {
      udp: true,
      xudp: false,
      tfo: false,
      mptcp: false,
      smux: false,
    }
    const names = ['香港 01', '日本 01', '新加坡 01']
    const records = Object.fromEntries(
      names.map((name, index) => [
        String(index),
        {
          ...caps,
          recordId: String(index),
          name,
          type: 'ss',
          alive: true,
          history: [],
          source: { kind: 'core', proxyName: name },
        },
      ]),
    )
    records.DIRECT = {
      ...caps,
      recordId: 'DIRECT',
      name: 'DIRECT',
      type: 'Direct',
      alive: true,
      history: [],
      source: { kind: 'core', proxyName: 'DIRECT' },
    }
    const proxyView = {
      schemaVersion: 1,
      orderSource: 'runtime',
      providerState: 'ready',
      global: {
        ...caps,
        name: 'GLOBAL',
        type: 'Selector',
        alive: true,
        now: 'DIRECT',
        history: [],
        members: [
          { kind: 'node', name: 'DIRECT', recordId: 'DIRECT' },
          { kind: 'group', name: '蜂窝加速' },
          ...names.map((name, index) => ({
            kind: 'node',
            name,
            recordId: String(index),
          })),
        ],
      },
      direct: 'DIRECT',
      standalone: [],
      providers: [],
      records,
      groups: [
        {
          ...caps,
          name: '蜂窝加速',
          type: 'Selector',
          alive: true,
          now: names[0],
          history: [],
          members: names.map((name, index) => ({
            kind: 'node',
            name,
            recordId: String(index),
          })),
        },
      ],
    }
    let session = {
      id: 'browser-fixture',
      summary: {
        email: 'preview@example.org',
        plan_id: 1,
        plan: { id: 1, name: '蜂窝标准套餐' },
        u: 1024 ** 3,
        d: 14 * 1024 ** 3,
        transfer_enable: 200 * 1024 ** 3,
        expired_at: 1820000000,
      },
      offline: false,
      profileUid: 'fixture-profile',
    }
    let verge = {
      language: 'zh',
      theme_mode: 'light',
      auto_check_update: false,
      enable_system_proxy: false,
      enable_tun_mode: false,
      enable_custom_clash_rules: false,
      verge_mixed_port: 7897,
    }
    let mode = 'rule'
    let ruleList = [
      {
        id: 'fixture-rule',
        kind: 'DOMAIN-SUFFIX',
        value: 'example.org',
        target: 'DIRECT',
        enabled: true,
      },
    ]
    const plans = [
      {
        id: 1,
        name: '蜂窝标准套餐',
        transfer_enable: 200,
        month_price: 1990,
        year_price: 19900,
        content:
          '<p>200 GB 月流量</p><ul><li>全球高速节点</li><li>不限速</li></ul>',
        sell: 1,
      },
      {
        id: 2,
        name: '蜂窝专业套餐',
        transfer_enable: 500,
        month_price: 3990,
        year_price: 39900,
        content: '<p>500 GB 月流量</p>',
        sell: 1,
      },
    ]
    window.__fengwoCalls = []
    let releaseRestore
    const restoring = new Promise((resolve) => {
      releaseRestore = resolve
    })
    window.__fengwoFixture = {
      expireNextAction: '',
      updateAvailable: false,
      releaseRestore: (value) => {
        if (value === null) session = null
        releaseRestore(value)
      },
    }
    let callbackId = 0
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
      transformCallback: () => ++callbackId,
      unregisterCallback() {},
      convertFileSrc: (p) => p,
      invoke: async (command, args = {}) => {
        window.__fengwoCalls.push({ command, args })
        if (command === 'fengwo_action') {
          const { action, payload = {} } = args
          if (action === 'session') {
            const restoreError = await restoring
            if (restoreError) throw restoreError
            return session
          }
          if (action === 'sessionState') return session
          if (window.__fengwoFixture.expireNextAction === action) {
            window.__fengwoFixture.expireNextAction = ''
            session = { ...session, needsLogin: true }
            throw { detail: 'device_not_registered' }
          }
          if (action === 'sync' || action === 'summary') return session
          if (action === 'logout') {
            session = null
            return null
          }
          if (action === 'login') {
            session = {
              id: 'browser-login',
              summary: { email: payload.email },
              offline: false,
              profileUid: 'fixture-profile',
            }
            return session
          }
          if (action === 'offline') {
            session = { ...session, offline: payload.enabled }
            return session
          }
          if (action === 'plans') return plans
          if (action === 'paymentMethods')
            return [
              {
                id: 1,
                name: '支付宝',
                handling_fee_fixed: 0,
                handling_fee_percent: 0,
              },
            ]
          if (action === 'createOrder') return 'FIXTURE-ORDER'
          if (action === 'checkout')
            return { type: 0, data: 'https://example.org/fixture-payment' }
          if (action === 'checkOrder') return 0
          if (action === 'nodes')
            return names.map((name) => ({ name, is_online: true, rate: 1 }))
          if (action === 'rules') return ruleList
          if (action === 'campus')
            return {
              operators: ['telecom'],
              operator: 'telecom',
              enabled: false,
            }
          if (action === 'saveRules') {
            ruleList = payload.rules
            return session
          }
          if (action === 'orders')
            return [
              {
                trade_no: 'FIXTURE-ORDER',
                status: 0,
                total_amount: 1990,
                period: 'month_price',
                created_at: 1790000000,
                plan: { name: plans[0].name },
              },
            ]
          if (action === 'traffic')
            return [
              {
                record_at: 1790000000,
                u: 1024 ** 3,
                d: 14 * 1024 ** 3,
                server_rate: 1.5,
              },
            ]
          if (action === 'notices')
            return [
              { id: 1, title: '蜂窝 Linux 测试公告', content: '测试内容' },
            ]
          if (action === 'user')
            return {
              email: 'preview@example.org',
              balance: 1200,
              commission_balance: 300,
              remind_expire: 1,
              remind_traffic: 1,
            }
          if (action === 'loginIps')
            return {
              items: [
                {
                  ip: '192.0.2.1',
                  is_blocked: false,
                  location: '测试地区',
                  login_count: 2,
                  last_login_at: '2026-09-29T00:00:00Z',
                },
              ],
            }
          if (action === 'invite')
            return {
              codes: [{ code: 'PREVIEW', created_at: 1790000000 }],
              stat: [12, 2000, 200, 10, 300],
            }
          if (action === 'inviteDetails') return []
          return true
        }
        if (command === 'get_verge_config') return verge
        if (command === 'patch_verge_config') {
          verge = { ...verge, ...args.payload }
          return null
        }
        if (command === 'get_proxy_view') return structuredClone(proxyView)
        if (command === 'get_profiles')
          return {
            current: 'fixture-profile',
            items: [{ uid: 'fixture-profile', type: 'local', name: 'Fengwo' }],
          }
        if (command === 'get_clash_info')
          return {
            mixed_port: 7897,
            server: '127.0.0.1:9090',
            secret: 'fixture',
          }
        if (command === 'get_runtime_config')
          return { 'mixed-port': 7897, tun: { enable: false }, dns: {} }
        if (command === 'get_clash_mode') return mode
        if (command === 'patch_clash_mode') {
          mode = args.payload
          return null
        }
        if (command === 'plugin:mihomo|select_node_for_group') {
          const group = [proxyView.global, ...proxyView.groups].find(
            (item) => item.name === args.groupName,
          )
          if (!group) throw new Error('Unknown fixture group')
          group.now = args.node
          return null
        }
        if (command === 'get_runtime_state')
          return {
            mode: 'Sidecar',
            service: 'notInstalled',
            pendingAction: null,
            serviceUnavailableReason: null,
            sidecarAllowed: true,
            isAdmin: false,
            opInFlight: false,
            serviceUsable: false,
            tunCapable: false,
            serviceNeedsAttention: false,
          }
        if (command === 'get_sys_proxy' || command === 'get_auto_proxy')
          return {
            enable: false,
            server: '127.0.0.1:7897',
            bypass: '',
            url: '',
          }
        if (
          command === 'get_pending_failures' ||
          command === 'get_clash_logs' ||
          command === 'get_network_interfaces'
        )
          return []
        if (command === 'fengwo_linux_status')
          return {
            linux: true,
            arch: 'x86_64',
            distribution: 'Debian GNU/Linux 12',
            packageManager: 'apt',
            polkit: true,
            tun: true,
            updatesConfigured: true,
            build: '1',
          }
        if (command === 'fengwo_check_update')
          return window.__fengwoFixture.updateAvailable
            ? {
                version: '2.5.6+2',
                build: 2,
                sha256: 'a'.repeat(64),
                notes: '测试更新',
              }
            : null
        if (command === 'plugin:mihomo|get_base_config')
          return {
            mode,
            mixedPort: 7897,
            tun: { enable: false },
            dns: {},
            allowLan: false,
            ipv6: false,
          }
        if (command === 'plugin:mihomo|get_connections')
          return { connections: [], uploadTotal: 0, downloadTotal: 0 }
        if (command === 'plugin:mihomo|get_rules') return { rules: [] }
        if (
          command === 'plugin:mihomo|get_rule_providers' ||
          command === 'plugin:mihomo|get_proxy_providers'
        )
          return { providers: {} }
        if (command === 'plugin:mihomo|get_version')
          return { version: 'fixture', meta: true }
        if (command === 'plugin:mihomo|delay_proxy_by_name')
          return { delay: 42 }
        if (command.startsWith('plugin:mihomo|ws_')) return 1
        if (command === 'plugin:event|listen') return ++callbackId
        if (
          command === 'plugin:window|is_decorated' ||
          command === 'plugin:window|is_visible' ||
          command === 'plugin:window|is_focused'
        )
          return true
        if (command === 'plugin:window|scale_factor') return 1
        if (command.includes('size')) return { width: 1280, height: 900 }
        if (command.includes('position')) return { x: 0, y: 0 }
        if (command === 'plugin:app|version') return '2.5.6'
        if (command.includes('uptime')) return 100
        return null
      },
    }
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text())
  })
  const pages = [
    ['/', '加速主页'],
    ['/plans', '购买套餐'],
    ['/nodes', '节点状态'],
    ['/routing', '代理规则'],
    ['/traffic', '流量详情'],
    ['/orders', '我的订单'],
    ['/invite', '邀请推广'],
    ['/account', '个人中心'],
    ['/advanced', '高级设置'],
    ['/tools', '实用工具'],
  ]
  await page.goto(origin)
  await page.getByRole('status', { name: '正在恢复登录' }).waitFor()
  assert.equal(await page.locator('.fengwo-sidebar').count(), 0)
  assert.equal(await page.locator('nav').count(), 0)
  await page.evaluate(() => window.__fengwoFixture.releaseRestore())
  for (const [route, title] of pages) {
    await page.locator(`nav a[href="${route}"]`).click()
    await page.getByRole('heading', { name: title, exact: true }).waitFor()
    await page.mouse.move(1270, 890)
    await page.waitForTimeout(250)
    await page.screenshot({
      path: path.join(
        output,
        `${route === '/' ? 'home' : route.slice(1)}-desktop.png`,
      ),
    })
  }
  await page.locator('nav a[href="/nodes"]').click()
  await page.getByRole('button', { name: '全部测速' }).click()
  await page.getByText('42 ms', { exact: true }).first().waitFor()
  await page.locator('nav a[href="/"]').click()
  await page.getByRole('button', { name: '全局模式', exact: true }).click()
  await page.getByRole('button', { name: '香港 01', exact: true }).waitFor()
  const routeCalls = await page.evaluate(() =>
    window.__fengwoCalls.filter(({ command }) =>
      [
        'plugin:mihomo|select_node_for_group',
        'record_selected_node',
        'patch_clash_mode',
      ].includes(command),
    ),
  )
  assert.deepEqual(
    routeCalls.map(({ command }) => command),
    [
      'plugin:mihomo|select_node_for_group',
      'record_selected_node',
      'patch_clash_mode',
    ],
  )
  assert.deepEqual(routeCalls[0].args, {
    groupName: 'GLOBAL',
    node: '蜂窝加速',
  })
  await page.locator('nav a[href="/nodes"]').click()
  assert.equal(
    (await page.getByRole('combobox', { name: '代理组' }).textContent()).trim(),
    'GLOBAL',
  )
  await page
    .getByRole('row')
    .filter({ hasText: '日本 01' })
    .getByRole('button', { name: '选择', exact: true })
    .click()
  await page
    .getByRole('row')
    .filter({ hasText: '日本 01' })
    .getByText('当前', { exact: true })
    .waitFor()
  await page.locator('nav a[href="/"]').click()
  await page.getByRole('button', { name: '日本 01', exact: true }).waitFor()
  await page.getByRole('button', { name: '规则模式', exact: true }).click()
  await page.getByRole('button', { name: '香港 01', exact: true }).waitFor()
  await page.getByRole('button', { name: '全局模式', exact: true }).click()
  await page.getByRole('button', { name: '日本 01', exact: true }).waitFor()
  await page.getByRole('button', { name: '直连模式', exact: true }).click()
  await page.getByRole('button', { name: 'DIRECT', exact: true }).waitFor()
  await page.getByRole('button', { name: '规则模式', exact: true }).click()
  await page.getByRole('button', { name: '香港 01', exact: true }).waitFor()
  await page.locator('nav a[href="/plans"]').click()
  await page.getByRole('button', { name: /购买/ }).first().click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: '确认并支付' }).click()
  await page.getByText('订单号：FIXTURE-ORDER').waitFor()
  await page.screenshot({ path: path.join(output, 'payment-desktop.png') })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  for (const [route, title] of pages) {
    await page.locator(`nav a[href="${route}"]`).click()
    await page.getByRole('heading', { name: title, exact: true }).waitFor()
    await page.mouse.move(389, 843)
    await page.waitForTimeout(250)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )
    assert.equal(overflow, false, `Page overflows at mobile width: ${route}`)
    await page.screenshot({
      path: path.join(
        output,
        `${route === '/' ? 'home' : route.slice(1)}-mobile.png`,
      ),
    })
  }
  await page.getByRole('switch', { name: '离线模式' }).check()
  await page
    .getByText('离线模式 · 当前使用本地订阅，在线业务已暂停。')
    .waitFor()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('switch', { name: '离线模式' }).uncheck()
  await page.locator('nav a[href="/"]').click()
  await page.getByRole('heading', { name: '加速主页', exact: true }).waitFor()
  await page.evaluate(() => {
    window.__fengwoFixture.expireNextAction = 'sync'
  })
  await page.getByRole('button', { name: '更新订阅', exact: true }).click()
  await page.getByRole('heading', { name: '重新登录', exact: true }).waitFor()
  assert.equal(
    await page.getByLabel('邮箱').inputValue(),
    'preview@example.org',
  )
  assert.equal(await page.locator('.fengwo-sidebar').count(), 0)
  assert.equal(await page.getByRole('switch', { name: '离线模式' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '退出登录' }).count(), 0)
  await page.getByLabel('密码', { exact: true }).fill('test-only-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('heading', { name: '加速主页', exact: true }).waitFor()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await page.getByRole('heading', { name: '登录', exact: true }).waitFor()
  assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '')
  async function checkLoginLayout(target, name, width, height) {
    await target.setViewportSize({ width, height })
    assert.equal(await target.locator('nav').count(), 0)
    assert.equal(await target.locator('.fengwo-sidebar').count(), 0)
    assert.equal(
      await target.getByRole('switch', { name: '离线模式' }).count(),
      0,
    )
    assert.equal(await target.getByText('使用本地缓存进入').count(), 0)
    await target.getByText('Linux 版本', { exact: true }).waitFor()
    const layout = await target.evaluate(() => {
      const login = document.querySelector('.fengwo-login')
      const image = login.querySelector('img')
      return {
        fits:
          login.scrollWidth <= login.clientWidth &&
          document.documentElement.scrollWidth <= innerWidth,
        image: image.complete && image.naturalWidth > 0,
      }
    })
    assert.deepEqual(layout, { fits: true, image: true })
    await target.mouse.move(width - 1, height - 1)
    await target.screenshot({
      path: path.join(output, `login-${name}.png`),
      animations: 'disabled',
    })
    await target
      .getByRole('button', { name: '登录', exact: true })
      .scrollIntoViewIfNeeded()
    const button = await target
      .getByRole('button', { name: '登录', exact: true })
      .boundingBox()
    assert.ok(
      button &&
        button.x >= 0 &&
        button.x + button.width <= width &&
        button.y >= 0 &&
        button.y + button.height <= height,
    )
  }
  await checkLoginLayout(page, 'desktop', 1280, 900)
  await checkLoginLayout(page, 'short', 940, 580)
  await checkLoginLayout(page, 'mobile', 390, 844)
  await page.getByLabel('密码', { exact: true }).fill('fixture-password')
  await page.getByRole('button', { name: '显示密码', exact: true }).click()
  assert.equal(
    await page.getByLabel('密码', { exact: true }).getAttribute('type'),
    'text',
  )
  assert.equal(
    await page.getByLabel('密码', { exact: true }).inputValue(),
    'fixture-password',
  )
  await page.getByRole('button', { name: '隐藏密码', exact: true }).click()
  assert.equal(
    await page.getByLabel('密码', { exact: true }).getAttribute('type'),
    'password',
  )
  await page.getByLabel('密码', { exact: true }).fill('')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate(() => {
    window.__fengwoFixture.updateAvailable = true
  })
  await page.getByRole('button', { name: '客户端更新', exact: true }).click()
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByRole('button', { name: '安装更新', exact: true }).click()
  await page
    .getByRole('dialog', { name: '安装 Linux 更新 2.5.6+2' })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await page.getByText('更新已安装，重启后生效。').waitFor()
  const installation = await page.evaluate(() =>
    window.__fengwoCalls.find(
      ({ command }) => command === 'fengwo_install_update',
    ),
  )
  assert.deepEqual(installation.args, {
    expectedBuild: 2,
    expectedSha256: 'a'.repeat(64),
  })
  await page.screenshot({
    path: path.join(output, 'signed-out-update-desktop.png'),
    animations: 'disabled',
  })
  await page
    .getByRole('dialog', { name: '客户端更新' })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: '新版本 2.5.6+2', exact: true })
    .click()
  await page.getByText('更新已安装，重启后生效。').waitFor()
  assert.equal(
    await page.getByRole('button', { name: '安装更新', exact: true }).count(),
    0,
  )
  await page.screenshot({
    path: path.join(output, 'signed-out-update-mobile.png'),
    animations: 'disabled',
  })
  const freshLogin = await context.newPage()
  freshLogin.on('pageerror', (error) => errors.push(error.message))
  await freshLogin.goto(`${origin}/nodes`)
  await freshLogin.getByRole('status', { name: '正在恢复登录' }).waitFor()
  assert.equal(await freshLogin.locator('nav').count(), 0)
  await freshLogin.evaluate(() => window.__fengwoFixture.releaseRestore(null))
  await freshLogin.getByRole('heading', { name: '登录', exact: true }).waitFor()
  await checkLoginLayout(freshLogin, 'fresh', 1280, 900)
  await freshLogin.reload()
  await freshLogin.getByRole('status', { name: '正在恢复登录' }).waitFor()
  await freshLogin.evaluate(() =>
    window.__fengwoFixture.releaseRestore({
      detail: 'profile_validation_failed',
    }),
  )
  await freshLogin.getByText('配置校验失败，已保留上一次有效配置。').waitFor()
  assert.equal(await freshLogin.locator('nav').count(), 0)
  assert.equal(
    await freshLogin.getByRole('switch', { name: '离线模式' }).count(),
    0,
  )
  await freshLogin.close()
  assert.deepEqual(errors, [])
  console.log(
    `UI smoke passed: ten desktop/mobile pages, global routing and persistence, node test, payment, authenticated offline, isolated login/loading/expiry/logout, password visibility and signed-out update. Screenshots: ${output}`,
  )
} finally {
  await browser.close()
}
