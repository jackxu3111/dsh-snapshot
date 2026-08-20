import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const projectRoot = resolve(new URL('..', import.meta.url).pathname)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
const dshBin = join(dshPackage, '..', 'lib', 'bin.js')
const smokeRoot = mkdtempSync(join(tmpdir(), 'dsh-snapshot-loader-'))
const dshHome = join(smokeRoot, 'home')
let tarball

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, DSH_HOME: dshHome, ...options.env },
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

try {
  tarball = join(projectRoot, JSON.parse(run(npm, ['pack', '--json']).stdout)[0].filename)
  run(process.execPath, [dshBin, 'plugin', '--profile', 'smoke', 'add', tarball])

  const profileManifest = JSON.parse(readFileSync(join(dshHome, 'profiles', 'smoke', 'package.json'), 'utf8'))
  if (!profileManifest.dsh?.profile?.bundles?.includes('dsh-snapshot')) {
    throw new Error('installed profile does not reference dsh-snapshot as a bundle')
  }

  run(process.execPath, [dshBin, '--profile', 'smoke', '--help'])
  console.log('loader smoke verified')
} finally {
  if (tarball) rmSync(tarball, { force: true })
  rmSync(smokeRoot, { recursive: true, force: true })
}
