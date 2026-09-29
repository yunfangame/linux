import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { releaseInfo } from './release.mjs'

if (process.platform !== 'linux')
  throw new Error('Fengwo release packages must be built on Linux.')
if (!['x64', 'arm64'].includes(process.arch))
  throw new Error('Only x86_64 and ARM64 are supported.')
const env = { ...process.env }
if (env.FENGWO_ENV_FILE) {
  const config = JSON.parse(await readFile(env.FENGWO_ENV_FILE, 'utf8'))
  for (const key of [
    'REMOTE_CONFIG_AES_KEY',
    'REMOTE_CONFIG_SIGNING_PUBLIC_KEY',
    'FENGWO_BUILD_NUMBER',
  ]) {
    if (!env[key] && typeof config[key] === 'string') env[key] = config[key]
  }
}
const release = await releaseInfo(env.FENGWO_BUILD_NUMBER)
for (const key of [
  'REMOTE_CONFIG_AES_KEY',
  'REMOTE_CONFIG_SIGNING_PUBLIC_KEY',
]) {
  if (!env[key] || Buffer.from(env[key], 'base64url').length !== 32)
    throw new Error(`Missing or invalid ${key}`)
}
const releaseConfig = {
  version: release.version,
  bundle: { linux: { rpm: { release: env.FENGWO_BUILD_NUMBER } } },
}
const result = spawnSync(
  'pnpm',
  [
    'build',
    '--config',
    'src-tauri/tauri.linux.conf.json',
    '--config',
    JSON.stringify(releaseConfig),
    ...process.argv.slice(2),
  ],
  { env, stdio: 'inherit' },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
