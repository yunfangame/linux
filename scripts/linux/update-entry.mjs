import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { releaseInfo } from './release.mjs'

const [installer, output, manifestOutput] = process.argv.slice(2)
if (!installer || !output)
  throw new Error(
    'Usage: node scripts/linux/update-entry.mjs INSTALLER.run OUTPUT.json [PLAINTEXT_MANIFEST.json]',
  )
const release = await releaseInfo()
const metadata = JSON.parse(await readFile(`${installer}.json`, 'utf8'))
if (
  metadata.format !== 'fengwo-linux-bundle' ||
  metadata.buildNumber !== release.buildNumber ||
  metadata.version !== release.version
)
  throw new Error('Installer metadata does not match this release.')
const url = new URL(process.env.FENGWO_DOWNLOAD_URL)
if (url.protocol !== 'https:' || url.username || url.password)
  throw new Error('Download URL must be HTTPS without credentials')
const hash = createHash('sha256')
for await (const chunk of createReadStream(installer)) hash.update(chunk)
const sha256 = hash.digest('hex')
if (metadata.sha256 !== sha256)
  throw new Error('Installer hash does not match its build metadata.')
const entry = {
  'linux-universal': {
    enabled: true,
    installerFormat: 'fengwo-universal-run-v1',
    ...release,
    downloadUrl: url.href,
    sha256,
    title: `Fengwo Linux ${release.version}`,
  },
}
await writeFile(output, `${JSON.stringify(entry, null, 2)}\n`)
if (manifestOutput) {
  await writeFile(
    manifestOutput,
    `${JSON.stringify({ Authentication: 'FengWo', format: 'fengwo-update', schemaVersion: 1, packages: entry }, null, 2)}\n`,
  )
}
console.log(
  `Wrote ${output}. Merge into the existing update manifest's packages, then encrypt and sign using the existing config publisher.`,
)
