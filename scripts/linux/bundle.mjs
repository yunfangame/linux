import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  copyFile,
  writeFile,
  chmod,
  rm,
  mkdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { releaseInfo, validatePackage } from './release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const [input, output] = process.argv.slice(2)
if (!input || !output)
  throw new Error(
    'Usage: node scripts/linux/bundle.mjs PACKAGE_DIRECTORY OUTPUT.run',
  )
const release = await releaseInfo()
const stage = await mkdtemp(path.join(tmpdir(), 'fengwo-bundle-'))
const hash = (data) => createHash('sha256').update(data).digest('hex')
try {
  const checksums = []
  const packages = []
  for (const arch of ['x86_64', 'aarch64']) {
    for (const format of ['deb', 'rpm']) {
      const filename = `fengwo-${arch}.${format}`
      const source = path.resolve(input, filename)
      const bytes = await readFile(source)
      if (!bytes.length) throw new Error(`Empty package: ${filename}`)
      const query = (field) =>
        format === 'deb'
          ? execFileSync('dpkg-deb', ['-f', source, field], {
              encoding: 'utf8',
            }).trim()
          : execFileSync(
              'rpm',
              ['-qp', '--queryformat', `%{${field}}`, source],
              { encoding: 'utf8' },
            ).trim()
      const metadata =
        format === 'deb'
          ? {
              arch: query('Architecture'),
              name: query('Package'),
              version: query('Version'),
            }
          : {
              arch: query('ARCH'),
              name: query('NAME'),
              version: query('VERSION'),
              release: query('RELEASE'),
            }
      validatePackage(metadata, arch, format, release)
      packages.push({ filename, ...metadata, sha256: hash(bytes) })
      await copyFile(source, path.join(stage, filename))
      checksums.push(`${hash(bytes)}  ${filename}`)
    }
  }
  await writeFile(path.join(stage, 'SHA256SUMS'), checksums.join('\n') + '\n')
  const archive = execFileSync('tar', ['-czf', '-', '-C', stage, '.'], {
    maxBuffer: 1024 * 1024 * 1024,
  })
  const template = await readFile(
    path.join(root, 'scripts/linux/installer.sh'),
    'utf8',
  )
  const header = template
    .replace('@PAYLOAD_SHA256@', hash(archive))
    .replace('@VERSION@', release.version)
    .replace('@BUILD@', String(release.buildNumber))
  await mkdir(path.dirname(path.resolve(output)), { recursive: true })
  await writeFile(output, Buffer.concat([Buffer.from(header), archive]))
  await chmod(output, 0o755)
  await writeFile(
    `${output}.sha256`,
    `${hash(await readFile(output))}  ${path.basename(output)}\n`,
  )
  await writeFile(
    `${output}.json`,
    JSON.stringify(
      {
        format: 'fengwo-linux-bundle',
        ...release,
        sha256: hash(await readFile(output)),
        packages,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`Built ${path.resolve(output)}`)
} finally {
  await rm(stage, { recursive: true, force: true })
}
