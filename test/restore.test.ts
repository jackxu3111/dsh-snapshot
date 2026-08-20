import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'

import { CaptureService } from '../src/capture.ts'
import { SnapshotError } from '../src/errors.ts'
import { nodeFileSystem } from '../src/filesystem.ts'
import { WriterLock } from '../src/lock.ts'
import { dirname } from 'node:path'

import { profileRoot, resolveWhitelist } from '../src/policy.ts'
import { SnapshotRepository } from '../src/repository.ts'
import { RestoreService } from '../src/restore.ts'
import type { LogicalPath } from '../src/types.ts'
import { faultInjectingFileSystem, immediateWriterLock, withTemporaryDshHome } from './helpers.ts'

const fixedDate = new Date('2026-08-20T10:45:30.123Z')

async function seed(home: string, bytes: Partial<Record<LogicalPath, Buffer>>): Promise<void> {
  await mkdir(profileRoot(home, 'work'), { recursive: true })
  for (const [logicalPath, value] of Object.entries(bytes)) {
    const path = resolveWhitelist(home, 'work').get(logicalPath as LogicalPath)
    assert.ok(path)
    await writeFile(path, value)
    await chmod(path, 0o640)
  }
}

function services(home: string, fs = nodeFileSystem): { restore: RestoreService; repository: SnapshotRepository; capture: CaptureService } {
  let random = 0
  const repository = new SnapshotRepository({ dshHome: home, fs, now: fixedDate, randomHex: () => ['a1b2c3', 'd4e5f6'][random++] ?? 'aabbcc' })
  const writerLock = new WriterLock({ root: home, fs })
  const capture = new CaptureService({ dshHome: home, fs, repository, writerLock, now: fixedDate, pluginVersion: '1.2.3' })
  return { repository, capture, restore: new RestoreService({ dshHome: home, fs, repository, capture, writerLock, randomHex: () => 'abcdef' }) }
}

test('restore preflights before creating a protection snapshot or touching targets', async () => {
  await withTemporaryDshHome(async (home) => {
    await seed(home, { 'home/settings.yaml': Buffer.from('original') })
    const { restore } = services(home)

    await assert.rejects(restore.restore('not-an-id'), (error: unknown) => error instanceof TypeError)
    assert.equal(String(await readFile(resolveWhitelist(home, 'work').get('home/settings.yaml')!)), 'original')
  })
})

test('restore captures protection under one writer lock then restores present and absent entries', async () => {
  await withTemporaryDshHome(async (home) => {
    await seed(home, {
      'home/settings.yaml': Buffer.from('snapshot settings'),
      'profile/package.json': Buffer.from('{"snapshot":true}\n'),
    })
    const { repository, restore } = services(home)
    const capture = new CaptureService({ dshHome: home, repository, writerLock: new WriterLock({ root: home }), now: fixedDate, pluginVersion: '1.2.3' })
    const snapshot = await capture.capture({ profile: 'work' })
    await seed(home, {
      'home/settings.yaml': Buffer.from('changed'),
      'home/cordis.patch.yml': Buffer.from('delete me'),
      'profile/package.json': Buffer.from('{"changed":true}\n'),
    })

    const result = await restore.restore(snapshot.snapshotId)
    assert.deepEqual(result.restored, ['home/settings.yaml', 'profile/package.json'])
    assert.deepEqual(result.removed, ['home/cordis.patch.yml'])
    assert.equal(result.restartRequired, true)
    assert.equal(result.dependencyInstallCommand, 'pnpm install --frozen-lockfile')
    assert.match(result.protectionSnapshotId, /^\d{8}T\d{9}Z-[0-9a-f]{6}$/)
    assert.equal(String(await readFile(resolveWhitelist(home, 'work').get('home/settings.yaml')!)), 'snapshot settings')
    await assert.rejects(readFile(resolveWhitelist(home, 'work').get('home/cordis.patch.yml')!), { code: 'ENOENT' })
    assert.equal(String(await readFile(resolveWhitelist(home, 'work').get('profile/package.json')!)), '{"snapshot":true}\n')
  })
})

test('fault injection preserves originals and reports a rolled-back restore', async () => {
  await withTemporaryDshHome(async (home) => {
    await seed(home, { 'home/settings.yaml': Buffer.from('before') })
    const plain = services(home)
    const snapshot = await plain.capture.capture({ profile: 'work' })
    await seed(home, { 'home/settings.yaml': Buffer.from('after') })
    const injected = faultInjectingFileSystem(nodeFileSystem, { method: 'rename', failAtCall: 1, error: Object.assign(new Error('busy'), { code: 'EPERM' }) })
    const restore = new RestoreService({ dshHome: home, fs: injected.fs, repository: plain.repository, capture: plain.capture, writerLock: new WriterLock({ root: home, fs: injected.fs }), randomHex: () => 'abcdef' })

    await assert.rejects(restore.restore(snapshot.snapshotId), (error: unknown) => error instanceof SnapshotError && error.code === 'RESTORE_FAILED_ROLLED_BACK')
    assert.equal(String(await readFile(resolveWhitelist(home, 'work').get('home/settings.yaml')!)), 'after')
    assert.ok(injected.calls.every((call) => call.path === undefined || typeof call.path === 'string'))
  })
})

for (const [method, failAtCall] of [
  ['write', 1],
  ['sync', 1],
  ['chmod', 1],
  ['rename', 1],
  ['rename', 2],
] as const) {
  test(`a ${method} fault at restore boundary ${failAtCall} rolls back original bytes`, async () => {
    await withTemporaryDshHome(async (home) => {
      await seed(home, { 'home/settings.yaml': Buffer.from('snapshot') })
      const plain = services(home)
      const snapshot = await plain.capture.capture({ profile: 'work' })
      await seed(home, { 'home/settings.yaml': Buffer.from('original') })
      const injected = faultInjectingFileSystem(nodeFileSystem, {
        method,
        failAtCall,
        error: Object.assign(new Error('injected'), { code: 'EACCES' }),
      })
      const restore = new RestoreService({
        dshHome: home,
        fs: injected.fs,
        repository: plain.repository,
        capture: plain.capture,
        writerLock: immediateWriterLock(),
        randomHex: () => 'abcdef',
      })

      await assert.rejects(restore.restore(snapshot.snapshotId), (error: unknown) =>
        error instanceof SnapshotError && error.code === 'RESTORE_FAILED_ROLLED_BACK')
      assert.equal(String(await readFile(resolveWhitelist(home, 'work').get('home/settings.yaml')!)), 'original')
    })
  })
}

test('cleanup fault retains recovery material and asks for manual recovery', async () => {
  await withTemporaryDshHome(async (home) => {
    await seed(home, { 'home/settings.yaml': Buffer.from('snapshot') })
    const plain = services(home)
    const snapshot = await plain.capture.capture({ profile: 'work' })
    await seed(home, { 'home/settings.yaml': Buffer.from('original') })
    const injected = faultInjectingFileSystem(nodeFileSystem, {
      method: 'rm', failAtCall: 1, error: Object.assign(new Error('busy'), { code: 'EBUSY' }),
    })
    const restore = new RestoreService({
      dshHome: home, fs: injected.fs, repository: plain.repository, capture: plain.capture,
      writerLock: immediateWriterLock(), randomHex: () => 'abcdef',
    })
    await assert.rejects(restore.restore(snapshot.snapshotId), (error: unknown) =>
      error instanceof SnapshotError && error.code === 'RESTORE_FAILED_MANUAL_RECOVERY')
    assert.equal(String(await readFile(resolveWhitelist(home, 'work').get('home/settings.yaml')!)), 'snapshot')
  })
})

test('a second rollback failure retains recovery material and reports manual recovery', async () => {
  await withTemporaryDshHome(async (home) => {
    await seed(home, { 'home/settings.yaml': Buffer.from('snapshot') })
    const plain = services(home)
    const snapshot = await plain.capture.capture({ profile: 'work' })
    await seed(home, { 'home/settings.yaml': Buffer.from('original') })
    const injected = faultInjectingFileSystem(nodeFileSystem, {
      method: 'rename', failAtCall: [2, 3], error: Object.assign(new Error('busy'), { code: 'EPERM' }),
    })
    const restore = new RestoreService({
      dshHome: home, fs: injected.fs, repository: plain.repository, capture: plain.capture,
      writerLock: immediateWriterLock(), randomHex: () => 'abcdef',
    })
    let error: unknown
    try {
      await restore.restore(snapshot.snapshotId)
      assert.fail('restore should fail')
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof SnapshotError)
    assert.equal(error.code, 'RESTORE_FAILED_MANUAL_RECOVERY')
    assert.match(error.message, /manual recovery/i)
  })
})

test('Windows restore skips chmod but still installs staged bytes', async () => {
  await withTemporaryDshHome(async (home) => {
    await seed(home, { 'home/settings.yaml': Buffer.from('snapshot') })
    const plain = services(home)
    const snapshot = await plain.capture.capture({ profile: 'work' })
    await seed(home, { 'home/settings.yaml': Buffer.from('original') })
    const injected = faultInjectingFileSystem(nodeFileSystem, {
      method: 'chmod', failAtCall: 1, error: Object.assign(new Error('should not run'), { code: 'EPERM' }),
    })
    const restore = new RestoreService({
      dshHome: home, fs: injected.fs, repository: plain.repository, capture: plain.capture,
      writerLock: immediateWriterLock(), randomHex: () => 'abcdef', platform: 'win32',
    })
    await restore.restore(snapshot.snapshotId)
    assert.equal(String(await readFile(resolveWhitelist(home, 'work').get('home/settings.yaml')!)), 'snapshot')
    assert.equal(injected.calls.filter((call) => call.method === 'chmod').length, 0)
  })
})

test('POSIX restore syncs the target directory after rename commits', async () => {
  await withTemporaryDshHome(async (home) => {
    await seed(home, { 'home/settings.yaml': Buffer.from('snapshot') })
    const plain = services(home)
    const snapshot = await plain.capture.capture({ profile: 'work' })
    await seed(home, { 'home/settings.yaml': Buffer.from('original') })
    const injected = faultInjectingFileSystem(nodeFileSystem, { method: 'rm', failAtCall: 99, error: new Error('unused') })
    const target = resolveWhitelist(home, 'work').get('home/settings.yaml')!
    const restore = new RestoreService({
      dshHome: home, fs: injected.fs, repository: plain.repository, capture: plain.capture,
      writerLock: immediateWriterLock(), randomHex: () => 'abcdef', platform: 'darwin',
    })
    await restore.restore(snapshot.snapshotId)
    assert.ok(injected.calls.some((call) => call.method === 'sync' && call.path === dirname(target)))
  })
})
