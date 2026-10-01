import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { globSync } from 'glob'
import { execFileSync } from 'node:child_process'
import { packageEpoch, releaseInfo } from './release.mjs'

const { FENGWO_TARGET: target, FENGWO_ARCH: arch } = process.env
const targets = {
  x86_64: 'x86_64-unknown-linux-gnu',
  aarch64: 'aarch64-unknown-linux-gnu',
}
if (!arch || targets[arch] !== target)
  throw new Error('Invalid Linux target and architecture')
await mkdir('linux-packages', { recursive: true })
const release = await releaseInfo()
for (const format of ['deb', 'rpm']) {
  const files = globSync(
    `target/${target}/release/bundle/${format}/*.${format}`,
  )
  if (files.length !== 1)
    throw new Error(`Expected one ${format} package, found ${files.length}`)
  const destination = path.join('linux-packages', `fengwo-${arch}.${format}`)
  if (format === 'deb') {
    execFileSync(
      'python3',
      [
        'scripts/linux/deb-epoch.py',
        files[0],
        destination,
        release.version,
        String(packageEpoch),
      ],
      { stdio: 'inherit' },
    )
  } else await copyFile(files[0], destination)
}
