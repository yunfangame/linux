import { readFile } from 'node:fs/promises'

// The branded 1.x series must sort after the upstream-numbered test packages.
export const packageEpoch = 1

export function buildNumber(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw new Error('FENGWO_BUILD_NUMBER must be a positive safe integer.')
  return Number(value)
}

export async function releaseInfo(value = process.env.FENGWO_BUILD_NUMBER) {
  const build = buildNumber(value)
  const pkg = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  return { buildNumber: build, version: `${pkg.version}+${build}` }
}

export function validatePackage(metadata, arch, format, release) {
  const expectedArch =
    format === 'deb' ? (arch === 'x86_64' ? 'amd64' : 'arm64') : arch
  if (metadata.arch !== expectedArch)
    throw new Error(`Architecture mismatch: ${arch}.${format}`)
  if (metadata.name !== 'fengwo-linux')
    throw new Error(`Package name mismatch: ${arch}.${format}`)
  const version =
    format === 'deb' ? `${packageEpoch}:${release.version}` : release.version
  if (metadata.version !== version)
    throw new Error(`Version mismatch: ${arch}.${format}`)
  if (format === 'rpm' && metadata.epoch !== String(packageEpoch))
    throw new Error(`RPM epoch mismatch: ${arch}.${format}`)
  if (format === 'rpm' && metadata.release !== String(release.buildNumber))
    throw new Error(`RPM release mismatch: ${arch}.${format}`)
}
