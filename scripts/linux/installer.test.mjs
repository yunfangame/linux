import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildNumber, releaseInfo, validatePackage } from './release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// Package-manager shims only record invocations. No test installs host packages.
async function fixture(manager = 'apt') {
  const dir = await mkdtemp(path.join(tmpdir(), 'fengwo-install-test-'))
  const bin = path.join(dir, 'bin')
  const input = path.join(dir, 'packages')
  await mkdir(bin)
  await mkdir(input)
  const script = async (name, text) => {
    const file = path.join(bin, name)
    await writeFile(file, `#!/bin/sh\nset -eu\n${text}\n`)
    await chmod(file, 0o755)
  }
  for (const utility of [
    'tar',
    'gzip',
    'awk',
    'tail',
    'mktemp',
    'rm',
    'mkdir',
    'cp',
    'sha256sum',
  ]) {
    const actual = execFileSync('/bin/sh', ['-c', `command -v ${utility}`], {
      encoding: 'utf8',
    }).trim()
    await symlink(actual, path.join(bin, utility))
  }
  await script(
    'uname',
    'case "$1" in -s) printf "%s\\n" "${TEST_OS:-Linux}";; -m) printf "%s\\n" "${TEST_ARCH:-x86_64}";; esac',
  )
  await script('id', 'printf "0\\n"')
  await script(
    'dpkg-deb',
    'case "$3" in Package) printf "%s" "${TEST_NAME:-fengwo-linux}";; Version) printf "%s" "${TEST_VERSION:-$PACKAGE_VERSION}";; Architecture) case "$2" in *aarch64*) printf arm64;; *) printf amd64;; esac;; esac',
  )
  await script(
    'rpm',
    'case "$3" in "%{NAME}") printf "%s" "${TEST_NAME:-fengwo-linux}";; "%{VERSION}") printf "%s" "${TEST_VERSION:-$PACKAGE_VERSION}";; "%{RELEASE}") printf "%s" "$FENGWO_BUILD_NUMBER";; "%{ARCH}") case "$4" in *aarch64*) printf aarch64;; *) printf x86_64;; esac;; esac',
  )
  if (manager === 'apt') {
    await script('dpkg', ':')
    await script('apt-get', 'printf "%s\\n" "$*" >> "$TEST_LOG"')
  } else if (manager === 'dnf') {
    await script('dnf', 'printf "%s\\n" "$*" >> "$TEST_LOG"')
  }
  for (const arch of ['x86_64', 'aarch64']) {
    for (const format of ['deb', 'rpm'])
      await writeFile(
        path.join(input, `fengwo-${arch}.${format}`),
        `${arch}-${format}`,
      )
  }
  const installer = path.join(dir, 'Fengwo-Linux.run')
  const env = {
    ...process.env,
    PATH: bin,
    TEST_LOG: path.join(dir, 'commands'),
    FENGWO_BUILD_NUMBER: '2',
    PACKAGE_VERSION: (await releaseInfo('2')).version,
  }
  execFileSync(
    process.execPath,
    [path.join(root, 'scripts/linux/bundle.mjs'), input, installer],
    { env },
  )
  return {
    dir,
    bin,
    input,
    installer,
    env,
    run: (args = [], extra = {}) =>
      spawnSync('/bin/sh', [installer, ...args], {
        env: { ...env, ...extra },
        encoding: 'utf8',
      }),
  }
}

for (const manager of ['apt', 'dnf']) {
  for (const arch of ['x86_64', 'aarch64']) {
    test(`dispatches ${arch} to ${manager} after validation`, async () => {
      const f = await fixture(manager)
      try {
        const checked = f.run(['--check'], { TEST_ARCH: arch })
        assert.equal(checked.status, 0, checked.stderr)
        await assert.rejects(readFile(f.env.TEST_LOG))
        const installed = f.run(['--yes'], { TEST_ARCH: arch })
        assert.equal(installed.status, 0, installed.stderr)
        const log = await readFile(f.env.TEST_LOG, 'utf8')
        assert.match(
          log,
          new RegExp(`fengwo-${arch}\\.${manager === 'apt' ? 'deb' : 'rpm'}`),
        )
        if (manager === 'apt') assert.match(log, /^update\ninstall -y /)
      } finally {
        await rm(f.dir, { recursive: true, force: true })
      }
    })
  }
}
test('rejects non-Linux, unsupported CPUs, and a modified payload before privilege escalation', async () => {
  const f = await fixture()
  try {
    assert.notEqual(f.run(['--yes'], { TEST_OS: 'Darwin' }).status, 0)
    assert.notEqual(f.run(['--yes'], { TEST_ARCH: 'armv7l' }).status, 0)
    const bytes = await readFile(f.installer)
    bytes[bytes.length - 15] ^= 1
    await writeFile(f.installer, bytes)
    assert.notEqual(f.run(['--yes']).status, 0)
    await assert.rejects(readFile(f.env.TEST_LOG))
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
test('rejects mismatched package identity/version before invoking the package manager', async () => {
  for (const manager of ['apt', 'dnf']) {
    const f = await fixture(manager)
    try {
      assert.notEqual(f.run(['--yes'], { TEST_NAME: 'clash-verge' }).status, 0)
      assert.notEqual(f.run(['--yes'], { TEST_VERSION: '2.5.6+1' }).status, 0)
      await assert.rejects(readFile(f.env.TEST_LOG))
      const bundled = spawnSync(
        process.execPath,
        [
          path.join(root, 'scripts/linux/bundle.mjs'),
          f.input,
          path.join(f.dir, 'mixed.run'),
        ],
        {
          env: { ...f.env, TEST_VERSION: '2.5.6+1' },
          encoding: 'utf8',
        },
      )
      assert.notEqual(bundled.status, 0)
      assert.match(bundled.stderr, /Version mismatch/)
    } finally {
      await rm(f.dir, { recursive: true, force: true })
    }
  }
})
test('update entries use the verified bundle metadata rather than an unrelated build number', async () => {
  const f = await fixture()
  try {
    const output = path.join(f.dir, 'entry.json')
    const args = [
      path.join(root, 'scripts/linux/update-entry.mjs'),
      f.installer,
      output,
    ]
    const env = {
      ...f.env,
      FENGWO_DOWNLOAD_URL: 'https://example.org/Fengwo.run',
    }
    execFileSync(process.execPath, args, { env })
    const entry = JSON.parse(await readFile(output, 'utf8'))['linux-universal']
    assert.equal(entry.buildNumber, 2)
    assert.equal(entry.version, f.env.PACKAGE_VERSION)
    assert.notEqual(
      spawnSync(process.execPath, args, {
        env: { ...env, FENGWO_BUILD_NUMBER: '3' },
      }).status,
      0,
    )
    await writeFile(f.installer, 'modified')
    assert.notEqual(spawnSync(process.execPath, args, { env }).status, 0)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
test('release numbers and all package metadata must agree across architectures', async () => {
  for (const value of [
    undefined,
    '',
    '01',
    '0',
    '-1',
    '1.5',
    '9007199254740992',
  ])
    assert.throws(() => buildNumber(value))
  const release = await releaseInfo('2')
  const meta = {
    name: 'fengwo-linux',
    arch: 'aarch64',
    version: release.version,
    release: '2',
  }
  assert.doesNotThrow(() => validatePackage(meta, 'aarch64', 'rpm', release))
  for (const overrides of [
    { arch: 'x86_64' },
    { release: '1' },
    { name: 'clash-verge' },
    { version: '2.5.6' },
  ]) {
    assert.throws(() =>
      validatePackage({ ...meta, ...overrides }, 'aarch64', 'rpm', release),
    )
  }
})
test('extracts only to a new directory and leaves installation untouched', async () => {
  const f = await fixture()
  try {
    const target = path.join(f.dir, 'extracted')
    assert.equal(f.run(['--extract', target]).status, 0)
    assert.equal(
      await readFile(path.join(target, 'fengwo-aarch64.deb'), 'utf8'),
      'aarch64-deb',
    )
    assert.notEqual(f.run(['--extract', target]).status, 0)
    await assert.rejects(readFile(f.env.TEST_LOG))
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
test('reports a missing gzip dependency before trying to extract or install', async () => {
  const f = await fixture()
  try {
    await rm(path.join(f.bin, 'gzip'))
    const result = f.run(['--yes'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Required utility missing: gzip/)
    await assert.rejects(readFile(f.env.TEST_LOG))
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
