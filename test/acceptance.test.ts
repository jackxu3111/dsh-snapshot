import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { dirname, join } from 'node:path'

import { createServices } from '../src/index.ts'
import { SnapshotError } from '../src/errors.ts'
import { profileRoot, resolveWhitelist, snapshotRoot } from '../src/policy.ts'
import type { LogicalPath } from '../src/types.ts'
import { allLogicalPaths, withTemporaryDshHome } from './helpers.ts'

const profile = 'work'

type FileFixtures = Readonly<Record<LogicalPath, Buffer>>
type FileState = { exists: boolean; bytes?: Buffer; mode?: number }

const initialFiles: FileFixtures = {
  'home/settings.yaml': Buffer.from([0, 1, 2, 255, 10, 13]),
  'home/cordis.patch.yml': Buffer.from('home patch\0\u0001\n', 'utf8'),
  'profile/package.json': Buffer.from([123, 34, 110, 97, 109, 101, 34, 58, 0, 125]),
  'profile/cordis.patch.yml': Buffer.from([0xff, 0xfe, 0xfd, 0x00]),
  'profile/pnpm-lock.yaml': Buffer.from('lock\n\u0000binary', 'utf8'),
  'profile/pnpm-workspace.yaml': Buffer.from([0x80, 0x81, 0x82, 0x83, 0x84]),
}

const mutatedFiles: FileFixtures = {
  'home/settings.yaml': Buffer.from([9, 8, 7, 6, 0, 255]),
  'home/cordis.patch.yml': Buffer.from('changed home\0patch', 'utf8'),
  'profile/package.json': Buffer.from([0, 1, 2, 3, 4, 5, 6]),
  'profile/cordis.patch.yml': Buffer.from([0x10, 0x20, 0x30, 0x40]),
  'profile/pnpm-lock.yaml': Buffer.from('changed lock\n\0', 'utf8'),
  'profile/pnpm-workspace.yaml': Buffer.from([0xf0, 0xf1, 0xf2]),
}

const initialModes: Readonly<Record<LogicalPath, number>> = {
  'home/settings.yaml': 0o600,
  'home/cordis.patch.yml': 0o640,
  'profile/package.json': 0o644,
  'profile/cordis.patch.yml': 0o660,
  'profile/pnpm-lock.yaml': 0o700,
  'profile/pnpm-workspace.yaml': 0o750,
}

async function seedProfile(
  home: string,
  files: Partial<FileFixtures>,
  modes: number | Partial<Readonly<Record<LogicalPath, number>>> = 0o640,
): Promise<void> {
  await mkdir(profileRoot(home, profile), { recursive: true, mode: 0o700 })
  const targets = resolveWhitelist(home, profile)
  for (const [logicalPath, bytes] of Object.entries(files)) {
    const target = targets.get(logicalPath as LogicalPath)
    assert.ok(target)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, bytes)
    const mode = typeof modes === 'number' ? modes : modes[logicalPath as LogicalPath] ?? 0o640
    await chmod(target, mode)
  }
}

async function seedExcludedFixtures(home: string): Promise<void> {
  const profilePath = profileRoot(home, profile)
  await mkdir(join(profilePath, 'sessions'), { recursive: true })
  await mkdir(join(profilePath, 'cache'), { recursive: true })
  await mkdir(join(profilePath, 'node_modules', 'private-package'), { recursive: true })
  await writeFile(join(home, '.credentials.yaml'), 'credential-secret')
  await writeFile(join(home, '.env'), 'ENV_SECRET=do-not-copy')
  await writeFile(join(profilePath, '.env'), 'PROFILE_SECRET=do-not-copy')
  await writeFile(join(profilePath, 'sessions', 'session.json'), 'session-secret')
  await writeFile(join(profilePath, 'cache', 'entry.bin'), Buffer.from([0, 255]))
  await writeFile(join(profilePath, 'node_modules', 'private-package', 'index.js'), 'private module')
}

async function readState(home: string): Promise<Record<LogicalPath, FileState>> {
  const targets = resolveWhitelist(home, profile)
  const state = {} as Record<LogicalPath, FileState>
  for (const logicalPath of allLogicalPaths) {
    const target = targets.get(logicalPath)
    assert.ok(target)
    try {
      const metadata = await stat(target)
      state[logicalPath] = {
        exists: true,
        bytes: await readFile(target),
        mode: metadata.mode & 0o777,
      }
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
      state[logicalPath] = { exists: false }
    }
  }
  return state
}

function assertStateEqual(actual: Record<LogicalPath, FileState>, expected: Record<LogicalPath, FileState>): void {
  for (const logicalPath of allLogicalPaths) {
    assert.equal(actual[logicalPath]?.exists, expected[logicalPath]?.exists, logicalPath)
    if (!expected[logicalPath]?.exists) continue
    assert.deepEqual(actual[logicalPath]?.bytes, expected[logicalPath]?.bytes, logicalPath)
    if (process.platform !== 'win32') assert.equal(actual[logicalPath]?.mode, expected[logicalPath]?.mode, logicalPath)
  }
}

async function writeFixtureSet(home: string, files: Partial<FileFixtures>): Promise<void> {
  const targets = resolveWhitelist(home, profile)
  for (const [logicalPath, bytes] of Object.entries(files)) {
    const target = targets.get(logicalPath as LogicalPath)
    assert.ok(target)
    await writeFile(target, bytes)
  }
}

async function chmodFixtureSet(home: string, mode: number): Promise<void> {
  const targets = resolveWhitelist(home, profile)
  for (const logicalPath of allLogicalPaths) {
    const target = targets.get(logicalPath)
    assert.ok(target)
    await chmod(target, mode)
  }
}

async function holdWriterLockInChild(root: string): Promise<{ release(): void; exited: Promise<number | null> }> {
  const lockModule = new URL('../src/lock.ts', import.meta.url).href
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { WriterLock } from ${JSON.stringify(lockModule)}; const lock = new WriterLock({ root: process.argv[1] }); await lock.runExclusive(async () => { console.log('LOCKED'); process.stdin.resume(); await new Promise((resolve) => process.stdin.once('end', resolve)); });`,
      root,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let output = ''
  let errorOutput = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const locked = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.includes('LOCKED')) resolve()
    })
    child.stderr.on('data', (chunk: string) => {
      errorOutput += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (!output.includes('LOCKED')) {
        reject(new Error(`Child writer exited before acquiring lock (${code}): ${errorOutput}`))
      }
    })
  })
  await locked
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  return { release: () => child.stdin.end(), exited }
}

test('acceptance restores six binary-safe files, modes, and excludes private fixtures', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, initialFiles, initialModes)
    await seedExcludedFixtures(home)
    const services = createServices({ dshHome: home })
    const before = await readState(home)

    const snapshot = await services.capture.capture({ profile, label: 'binary acceptance' })
    const manifest = await services.repository.readManifest(snapshot.snapshotId)
    assert.deepEqual(manifest.entries.map((entry) => entry.logicalPath), allLogicalPaths)
    const manifestText = JSON.stringify(manifest)
    for (const excludedFixture of ['credentials', 'session', 'cache', '.env', 'node_modules']) {
      assert.equal(manifestText.includes(excludedFixture), false, excludedFixture)
    }
    assert.equal(manifestText.includes('credential-secret'), false)
    assert.equal(manifestText.includes('session-secret'), false)
    assert.equal(snapshot.present.length, allLogicalPaths.length)
    assert.deepEqual(snapshot.absent, [])

    await writeFixtureSet(home, mutatedFiles)
    await chmodFixtureSet(home, 0o600)
    const mutated = await readState(home)
    assert.notDeepEqual(mutated, before)

    const restored = await services.restore.restore(snapshot.snapshotId)
    assert.equal(restored.snapshotId, snapshot.snapshotId)
    assert.equal(restored.protectionSnapshotId.length > 0, true)
    assert.deepEqual(restored.restored, allLogicalPaths)
    assert.deepEqual(restored.removed, [])
    assertStateEqual(await readState(home), before)

    const listed = await services.repository.list(profile)
    assert.equal(listed.length, 2)
    assert.equal(listed.every((entry) => entry.status === 'available'), true)
    assert.equal(listed.some((entry) => entry.kind === 'normal'), true)
    assert.equal(listed.some((entry) => entry.kind === 'protection'), true)
    for (let index = 1; index < listed.length; index += 1) {
      assert.ok(listed[index - 1]!.createdAt >= listed[index]!.createdAt)
    }
  })
})

test('acceptance restores absent entries and reverses through the generated protection snapshot', async () => {
  await withTemporaryDshHome(async (home) => {
    const alternating: Partial<FileFixtures> = {
      'home/settings.yaml': initialFiles['home/settings.yaml'],
      'profile/package.json': initialFiles['profile/package.json'],
      'profile/pnpm-lock.yaml': initialFiles['profile/pnpm-lock.yaml'],
    }
    await seedProfile(home, alternating, initialModes)
    const services = createServices({ dshHome: home })
    const targetSnapshot = await services.capture.capture({ profile })
    assert.deepEqual(targetSnapshot.present, [
      'home/settings.yaml',
      'profile/package.json',
      'profile/pnpm-lock.yaml',
    ])
    assert.deepEqual(targetSnapshot.absent, [
      'home/cordis.patch.yml',
      'profile/cordis.patch.yml',
      'profile/pnpm-workspace.yaml',
    ])

    await writeFixtureSet(home, mutatedFiles)
    const stateImmediatelyBeforeRestore = await readState(home)
    for (const logicalPath of allLogicalPaths) {
      assert.equal(stateImmediatelyBeforeRestore[logicalPath]?.exists, true, logicalPath)
    }

    const firstRestore = await services.restore.restore(targetSnapshot.snapshotId)
    assert.deepEqual(firstRestore.restored, [
      'home/settings.yaml',
      'profile/package.json',
      'profile/pnpm-lock.yaml',
    ])
    assert.deepEqual(firstRestore.removed, [
      'home/cordis.patch.yml',
      'profile/cordis.patch.yml',
      'profile/pnpm-workspace.yaml',
    ])
    const restoredAbsentState = await readState(home)
    for (const logicalPath of firstRestore.removed) {
      assert.equal(restoredAbsentState[logicalPath]?.exists, false, logicalPath)
    }

    const reverseRestore = await services.restore.restore(firstRestore.protectionSnapshotId)
    assert.equal(reverseRestore.snapshotId, firstRestore.protectionSnapshotId)
    assertStateEqual(await readState(home), stateImmediatelyBeforeRestore)
  })
})

test('acceptance serializes concurrent writers, reports cross-process BUSY, and ignores residue', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': initialFiles['home/settings.yaml'] })
    const services = createServices({ dshHome: home })

    const created = await Promise.all([
      services.capture.capture({ profile, label: 'concurrent one' }),
      services.capture.capture({ profile, label: 'concurrent two' }),
    ])
    assert.equal(new Set(created.map((result) => result.snapshotId)).size, 2)

    await writeFixtureSet(home, { 'home/settings.yaml': mutatedFiles['home/settings.yaml'] })
    const restoreResults = await Promise.all(
      created.map((result) => services.restore.restore(result.snapshotId)),
    )
    assert.equal(new Set(restoreResults.map((result) => result.protectionSnapshotId)).size, 2)
    assert.deepEqual(
      (await readFile(resolveWhitelist(home, profile).get('home/settings.yaml')!)),
      initialFiles['home/settings.yaml'],
    )

    const root = snapshotRoot(home)
    const held = await holdWriterLockInChild(root)
    try {
      await assert.rejects(
        services.capture.capture({ profile }),
        (error: unknown) => error instanceof SnapshotError && error.code === 'BUSY',
      )
      const listedWhileBusy = await services.repository.list(profile)
      assert.equal(listedWhileBusy.length, 4)
      assert.equal(listedWhileBusy.every((entry) => entry.status === 'available'), true)
    } finally {
      held.release()
      assert.equal(await held.exited, 0)
    }

    const afterChild = await services.capture.capture({ profile, label: 'after child' })
    assert.equal(afterChild.present.includes('home/settings.yaml'), true)

    const rootResidues = await readdir(root)
    assert.equal(rootResidues.some((entry) => entry.startsWith('.tmp-')), false)
    assert.equal(rootResidues.includes('.writer-lock'), false)
    const profileResidues = await readdir(profileRoot(home, profile))
    assert.equal(profileResidues.some((entry) => entry.includes('.dsh-stage-')), false)
    assert.equal(profileResidues.some((entry) => entry.includes('.dsh-backup-')), false)

    await mkdir(join(root, '.tmp-residue'), { recursive: true })
    await mkdir(join(root, '.writer-lock'), { recursive: true })
    const target = resolveWhitelist(home, profile).get('home/settings.yaml')
    assert.ok(target)
    await writeFile(`${target}.dsh-stage-residue`, 'stage')
    await writeFile(`${target}.dsh-backup-residue`, 'backup')
    const listedWithResidue = await services.repository.list(profile)
    assert.equal(listedWithResidue.every((entry) => /^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{6}$/.test(entry.snapshotId)), true)
    assert.equal(listedWithResidue.some((entry) => entry.snapshotId.includes('residue')), false)
  })
})
