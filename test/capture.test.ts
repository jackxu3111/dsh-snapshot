import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { basename, join } from 'node:path'

import { SnapshotError } from '../src/errors.ts'
import { nodeFileSystem } from '../src/filesystem.ts'
import type { FileSystem } from '../src/filesystem.ts'
import { profileRoot, resolveWhitelist, snapshotRoot } from '../src/policy.ts'
import { SnapshotRepository, sha256 } from '../src/repository.ts'
import { MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES } from '../src/types.ts'
import type { LogicalPath } from '../src/types.ts'
import { CaptureService } from '../src/capture.ts'
import { WriterLock } from '../src/lock.ts'
import {
  allLogicalPaths,
  immediateWriterLock,
  withTemporaryDshHome,
} from './helpers.ts'

const fixedDate = new Date('2026-08-20T10:45:30.123Z')

type FixtureFiles = Partial<Readonly<Record<LogicalPath, Buffer>>>

async function seedProfile(home: string, files: FixtureFiles, profile = 'work'): Promise<void> {
  await mkdir(profileRoot(home, profile), { recursive: true, mode: 0o700 })
  const targets = resolveWhitelist(home, profile)

  for (const [logicalPath, bytes] of Object.entries(files)) {
    const target = targets.get(logicalPath as LogicalPath)
    assert.ok(target)
    await writeFile(target, bytes)
    await chmod(target, 0o640)
  }
}

function makeRepository(home: string, randomHexes = ['a1b2c3']): SnapshotRepository {
  let index = 0
  return new SnapshotRepository({
    dshHome: home,
    now: fixedDate,
    randomHex: () => randomHexes[index++] ?? 'f0f0f0',
  })
}

function makeCapture(
  home: string,
  options: {
    fs?: FileSystem
    randomHexes?: string[]
    writerLock?: ReturnType<typeof immediateWriterLock>
    now?: Date
  } = {},
): {
  capture: CaptureService
  repository: SnapshotRepository
  writerLock: ReturnType<typeof immediateWriterLock>
} {
  const repository = makeRepository(home, options.randomHexes)
  const writerLock = options.writerLock ?? immediateWriterLock()
  return {
    capture: new CaptureService({
      dshHome: home,
      repository,
      fs: options.fs,
      now: options.now ?? fixedDate,
      pluginVersion: '1.2.3',
      dshVersion: '4.5.6',
      writerLock,
    }),
    repository,
    writerLock,
  }
}

async function assertNoPublishedOrTemporarySnapshot(home: string): Promise<void> {
  try {
    const entries = await readdir(snapshotRoot(home))
    assert.deepEqual(entries, [])
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
  }
}

function copyMetadata(metadata: unknown, changes: Record<string, unknown>): unknown {
  return {
    ...(metadata as Record<string, unknown>),
    ...changes,
    isFile: () => true,
  }
}

function wrapCaptureHandle(
  handle: unknown,
  readFile: () => Promise<Buffer>,
  stat?: () => Promise<unknown>,
): unknown {
  const fileHandle = handle as {
    stat: () => Promise<unknown>
    close: () => Promise<void>
  }
  return {
    stat: stat ?? (() => fileHandle.stat()),
    readFile,
    close: () => fileHandle.close(),
  }
}

test('captures all six canonical entries with present/absent metadata and safe warning', async () => {
  await withTemporaryDshHome(async (home) => {
    const files: FixtureFiles = {
      'home/settings.yaml': Buffer.from('settings\n'),
      'home/cordis.patch.yml': Buffer.from('home patch\n'),
      'profile/package.json': Buffer.from('{"name":"work"}\n'),
      'profile/cordis.patch.yml': Buffer.from('profile patch\n'),
      'profile/pnpm-lock.yaml': Buffer.from('lock\n'),
    }
    await seedProfile(home, files)
    const { capture, repository, writerLock } = makeCapture(home)

    const result = await capture.capture({ profile: 'work', label: '  release  ' })

    assert.equal(writerLock.calls, 1)
    assert.equal(result.snapshotId, '20260820T104530123Z-a1b2c3')
    assert.equal(result.createdAt, fixedDate.toISOString())
    assert.equal(result.profile, 'work')
    assert.equal(result.kind, 'normal')
    assert.deepEqual(result.present, allLogicalPaths.slice(0, 5))
    assert.deepEqual(result.absent, ['profile/pnpm-workspace.yaml'])
    assert.match(result.warning, /local/i)
    assert.match(result.warning, /sensitive/i)
    assert.match(result.warning, /do not share/i)

    const manifest = await repository.readManifest(result.snapshotId)
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.pluginVersion, '1.2.3')
    assert.equal(manifest.dshVersion, '4.5.6')
    assert.equal(manifest.label, 'release')
    assert.deepEqual(
      manifest.entries.map((entry) => entry.logicalPath),
      allLogicalPaths,
    )

    for (const [index, entry] of manifest.entries.entries()) {
      const logicalPath = allLogicalPaths[index]
      assert.ok(logicalPath)
      const expected = files[logicalPath]
      if (expected === undefined) {
        assert.deepEqual(entry, { logicalPath, status: 'absent' })
        continue
      }

      assert.equal(entry.status, 'present')
      assert.equal(entry.bytes, expected.byteLength)
      assert.equal(entry.sha256, sha256(expected))
      if (process.platform !== 'win32') assert.equal(entry.mode, 0o640)
      assert.equal(Object.keys(entry).length, 6)
      const payload: Buffer = await readFile(join(snapshotRoot(home), result.snapshotId, 'files', entry.storedName))
      assert.deepEqual(payload, expected)
    }
  })
})

test('trims labels and limits them to 120 Unicode code points', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, {})
    const { capture, repository } = makeCapture(home)
    const label = `  ${'🙂'.repeat(121)}  `
    const expected = Array.from(label.trim()).slice(0, 120).join('')

    const result = await capture.capture({ profile: 'work', label })
    const manifest = await repository.readManifest(result.snapshotId)

    assert.equal(manifest.label, expected)
    assert.equal(Array.from(manifest.label ?? '').length, 120)
  })
})

test('captureUnlocked publishes without acquiring the writer lock', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, {})
    const { capture, repository, writerLock } = makeCapture(home, {
      randomHexes: ['a1b2c3', 'd4e5f6'],
    })

    await capture.capture({ profile: 'work' })
    const result = await capture.captureUnlocked({
      profile: 'work',
      kind: 'protection',
      label: 'Before restore',
    })

    assert.equal(writerLock.calls, 1)
    const manifest = await repository.readManifest(result.snapshotId)
    assert.equal(manifest.kind, 'protection')
    assert.equal(manifest.label, 'Before restore')
  })
})

test('captureUnlocked can publish a restore-style protection snapshot while the writer lock is held', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, {})
    const repository = makeRepository(home)
    const writerLock = new WriterLock({ root: home })
    const capture = new CaptureService({
      dshHome: home,
      repository,
      now: fixedDate,
      pluginVersion: '1.2.3',
      dshVersion: '4.5.6',
      writerLock,
    })

    const result = await writerLock.runExclusive(() =>
      capture.captureUnlocked({ profile: 'work', kind: 'protection', label: 'Before restore' }),
    )

    assert.equal((await repository.readManifest(result.snapshotId)).kind, 'protection')
  })
})

test('independent capture writers hold the lock from repository precheck through final rename', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': Buffer.from('settings\n') })
    let releaseRename!: () => void
    const renameMayFinish = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    let signalRename!: () => void
    const finalRenameReached = new Promise<void>((resolve) => {
      signalRename = resolve
    })
    let paused = false
    const fs = {
      ...nodeFileSystem,
      rename: async (from: string, to: string) => {
        if (!paused && basename(from).startsWith('.tmp-') && to.startsWith(snapshotRoot(home))) {
          paused = true
          signalRename()
          await renameMayFinish
        }
        return nodeFileSystem.rename(from, to)
      },
    } as unknown as FileSystem
    const firstRepository = new SnapshotRepository({
      dshHome: home,
      now: fixedDate,
      randomHex: 'a1b2c3',
      fs,
    })
    const secondRepository = new SnapshotRepository({
      dshHome: home,
      now: fixedDate,
      randomHex: 'a1b2c3',
    })
    const firstCapture = new CaptureService({
      dshHome: home,
      repository: firstRepository,
      fs,
      now: fixedDate,
      pluginVersion: '1.2.3',
      writerLock: new WriterLock({ root: home, fs }),
    })
    const secondCapture = new CaptureService({
      dshHome: home,
      repository: secondRepository,
      now: fixedDate,
      pluginVersion: '1.2.3',
      writerLock: new WriterLock({ root: home }),
    })

    const first = firstCapture.capture({ profile: 'work' })
    await finalRenameReached
    await assert.rejects(
      secondCapture.capture({ profile: 'work' }),
      (error: unknown) => error instanceof SnapshotError && error.code === 'BUSY',
    )

    releaseRename()
    const result = await first
    assert.equal((await firstRepository.readManifest(result.snapshotId)).snapshotId, result.snapshotId)
  })
})

test('retries once when lstat metadata changes during a read', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': Buffer.from('stable after retry') })
    const target = resolveWhitelist(home, 'work').get('home/settings.yaml')
    assert.ok(target)
    let targetLstatCalls = 0
    let latestTargetMetadata: unknown
    const fs = {
      ...nodeFileSystem,
      lstat: async (path: string) => {
        const metadata = await nodeFileSystem.lstat(path)
        if (path !== target) return metadata
        targetLstatCalls += 1
        const mtimeMs = Number((metadata as { mtimeMs: number }).mtimeMs) + (targetLstatCalls < 3 ? targetLstatCalls - 1 : 1)
        latestTargetMetadata = copyMetadata(metadata, { mtimeMs })
        return latestTargetMetadata as Awaited<ReturnType<typeof nodeFileSystem.lstat>>
      },
      open: async (path: unknown, ...options: unknown[]) => {
        const handle = await (nodeFileSystem.open as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...options)
        if (path !== target) return handle
        return wrapCaptureHandle(
          handle,
          () => (handle as { readFile: () => Promise<Buffer> }).readFile(),
          async () => latestTargetMetadata,
        )
      },
    } as unknown as FileSystem
    const { capture } = makeCapture(home, { fs })

    const result = await capture.capture({ profile: 'work' })

    assert.equal(result.present.includes('home/settings.yaml'), true)
    assert.equal(targetLstatCalls, 4)
  })
})

test('fails after a second unstable read and leaves no snapshot residue', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': Buffer.from('never stable') })
    const target = resolveWhitelist(home, 'work').get('home/settings.yaml')
    assert.ok(target)
    let targetLstatCalls = 0
    let latestTargetMetadata: unknown
    const fs = {
      ...nodeFileSystem,
      lstat: async (path: string) => {
        if (path === target) targetLstatCalls += 1
        const metadata = await nodeFileSystem.lstat(path)
        if (path !== target) return metadata
        latestTargetMetadata = copyMetadata(metadata, { mtimeMs: Number(metadata.mtimeMs) + targetLstatCalls })
        return latestTargetMetadata as Awaited<
          ReturnType<typeof nodeFileSystem.lstat>
        >
      },
      open: async (path: unknown, ...options: unknown[]) => {
        const handle = await (nodeFileSystem.open as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...options)
        if (path !== target) return handle
        return wrapCaptureHandle(
          handle,
          () => (handle as { readFile: () => Promise<Buffer> }).readFile(),
          async () => latestTargetMetadata,
        )
      },
    } as unknown as FileSystem
    const { capture, repository } = makeCapture(home, { fs })

    await assert.rejects(capture.capture({ profile: 'work' }), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'SNAPSHOT_CORRUPT'
    })

    assert.equal(targetLstatCalls, 4)
    assert.deepEqual(await repository.list(), [])
    await assertNoPublishedOrTemporarySnapshot(home)
  })
})

test('retries a transient ENOENT after an initial lstat', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': Buffer.from('recovered after retry') })
    const target = resolveWhitelist(home, 'work').get('home/settings.yaml')
    assert.ok(target)
    let openAttempts = 0
    const fs = {
      ...nodeFileSystem,
      open: async (path: unknown, ...options: unknown[]) => {
        if (path === target && openAttempts++ === 0) {
          throw Object.assign(new Error('transient open removal'), { code: 'ENOENT' })
        }
        return (nodeFileSystem.open as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...options)
      },
    } as unknown as FileSystem
    const { capture } = makeCapture(home, { fs })

    const result = await capture.capture({ profile: 'work' })

    assert.equal(result.present.includes('home/settings.yaml'), true)
    assert.equal(openAttempts, 2)
  })
})

test('reports absent only after a read ENOENT remains absent on retry', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': Buffer.from('removed during capture') })
    const target = resolveWhitelist(home, 'work').get('home/settings.yaml')
    assert.ok(target)
    let targetLstatCalls = 0
    let readAttempts = 0
    const fs = {
      ...nodeFileSystem,
      lstat: async (path: string) => {
        if (path === target) targetLstatCalls += 1
        const metadata = await nodeFileSystem.lstat(path)
        return metadata
      },
      open: async (path: unknown, ...options: unknown[]) => {
        const handle = await (nodeFileSystem.open as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...options)
        if (path !== target || readAttempts++ !== 0) return handle
        return wrapCaptureHandle(handle, async () => {
          await rm(target)
          throw Object.assign(new Error('stable removal'), { code: 'ENOENT' })
        })
      },
      readFile: async (path: string) => {
        if (path === target) {
          throw new Error('capture must read through its opened handle')
        }
        return nodeFileSystem.readFile(path)
      },
    } as unknown as FileSystem
    const { capture } = makeCapture(home, { fs })

    const result = await capture.capture({ profile: 'work' })

    assert.equal(result.absent.includes('home/settings.yaml'), true)
    assert.equal(targetLstatCalls, 2)
    assert.equal(readAttempts, 1)
  })
})

test('rejects symlinks and non-regular files before publication', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': Buffer.from('target') })
    const target = resolveWhitelist(home, 'work').get('home/settings.yaml')
    assert.ok(target)
    const outside = join(home, 'outside-settings.yaml')
    await writeFile(outside, 'outside')
    await rm(target)
    await symlink(outside, target)
    const { capture, repository } = makeCapture(home)

    await assert.rejects(capture.capture({ profile: 'work' }), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'UNSAFE_FILE_TYPE'
    })

    assert.deepEqual(await repository.list(), [])
    await assertNoPublishedOrTemporarySnapshot(home)
  })

  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': Buffer.from('target') })
    const target = resolveWhitelist(home, 'work').get('home/settings.yaml')
    assert.ok(target)
    await rm(target)
    await mkdir(target)
    const { capture, repository } = makeCapture(home)

    await assert.rejects(capture.capture({ profile: 'work' }), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'UNSAFE_FILE_TYPE'
    })

    assert.deepEqual(await repository.list(), [])
    await assertNoPublishedOrTemporarySnapshot(home)
  })
})

test('rejects a leaf symlink swap before reading outside the whitelist', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': Buffer.from('inside') })
    const target = resolveWhitelist(home, 'work').get('home/settings.yaml')
    assert.ok(target)
    const outside = join(home, 'outside-settings.yaml')
    await writeFile(outside, 'escape')
    let originalMetadata: unknown
    let swapped = false
    const swapTarget = async (): Promise<void> => {
      if (swapped) return
      swapped = true
      await rm(target)
      await symlink(outside, target)
    }
    const fs = {
      ...nodeFileSystem,
      lstat: async (path: string) => {
        const metadata = await nodeFileSystem.lstat(path)
        if (path === target) {
          originalMetadata ??= metadata
          return originalMetadata
        }
        return metadata
      },
      readFile: async (path: string) => {
        if (path === target) await swapTarget()
        return nodeFileSystem.readFile(path)
      },
      open: async (path: unknown, ...options: unknown[]) => {
        if (path === target) await swapTarget()
        return (nodeFileSystem.open as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...options)
      },
    } as unknown as FileSystem
    const { capture, repository } = makeCapture(home, { fs })

    await assert.rejects(capture.capture({ profile: 'work' }), (error: unknown) => {
      return error instanceof SnapshotError
    })

    assert.deepEqual(await repository.list(), [])
    await assertNoPublishedOrTemporarySnapshot(home)
  })
})

test('rejects a static symlink in the DSH Home to Profile directory chain', async () => {
  await withTemporaryDshHome(async (home) => {
    const outsideProfiles = join(home, 'outside-profiles')
    await mkdir(join(outsideProfiles, 'work'), { recursive: true })
    await symlink(outsideProfiles, join(home, 'profiles'))
    const { capture, repository } = makeCapture(home)

    await assert.rejects(capture.capture({ profile: 'work' }), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'UNSAFE_FILE_TYPE'
    })

    assert.deepEqual(await repository.list(), [])
    await assertNoPublishedOrTemporarySnapshot(home)
  })
})

test('rejects a missing Profile directory without creating a snapshot', async () => {
  await withTemporaryDshHome(async (home) => {
    const { capture, repository } = makeCapture(home)

    await assert.rejects(capture.capture({ profile: 'work' }), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'SNAPSHOT_NOT_FOUND'
    })

    assert.deepEqual(await repository.list(), [])
    await assertNoPublishedOrTemporarySnapshot(home)
  })
})

test('enforces the per-file and aggregate size limits before publication', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': Buffer.alloc(MAX_FILE_BYTES + 1) })
    const { capture, repository } = makeCapture(home)

    await assert.rejects(capture.capture({ profile: 'work' }), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'SIZE_LIMIT'
    })

    assert.deepEqual(await repository.list(), [])
    await assertNoPublishedOrTemporarySnapshot(home)
  })

  await withTemporaryDshHome(async (home) => {
    const perFile = Math.floor(MAX_SNAPSHOT_BYTES / allLogicalPaths.length) + 1
    const files = Object.fromEntries(allLogicalPaths.map((logicalPath) => [logicalPath, Buffer.alloc(perFile)])) as FixtureFiles
    await seedProfile(home, files)
    const { capture, repository } = makeCapture(home)

    await assert.rejects(capture.capture({ profile: 'work' }), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'SIZE_LIMIT'
    })

    assert.deepEqual(await repository.list(), [])
    await assertNoPublishedOrTemporarySnapshot(home)
  })
})

test('maps EACCES and EPERM to safe remediation without leaking paths or content', async () => {
  for (const code of ['EACCES', 'EPERM'] as const) {
    await withTemporaryDshHome(async (home) => {
      await seedProfile(home, { 'home/settings.yaml': Buffer.from('private secret body') })
      const target = resolveWhitelist(home, 'work').get('home/settings.yaml')
      assert.ok(target)
      const fs = {
        ...nodeFileSystem,
        open: async (path: unknown, ...options: unknown[]) => {
          if (path === target) {
            throw Object.assign(new Error(`${code}: private secret body at ${target}`), { code })
          }
          return (nodeFileSystem.open as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...options)
        },
      } as unknown as FileSystem
      const { capture, repository } = makeCapture(home, { fs })

      await assert.rejects(capture.capture({ profile: 'work' }), (error: unknown) => {
        return (
          error instanceof SnapshotError &&
          error.code === 'SNAPSHOT_CORRUPT' &&
          /permission/i.test(error.message) &&
          !error.message.includes(home) &&
          !error.message.includes('private secret body')
        )
      })

      assert.deepEqual(await repository.list(), [])
      await assertNoPublishedOrTemporarySnapshot(home)
    })
  }
})

test('fails when bytes do not match stable metadata, even if lstat metadata is unchanged', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home, { 'home/settings.yaml': Buffer.from('short') })
    const target = resolveWhitelist(home, 'work').get('home/settings.yaml')
    assert.ok(target)
    const fs = {
      ...nodeFileSystem,
      open: async (path: unknown, ...options: unknown[]) => {
        const handle = await (nodeFileSystem.open as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...options)
        if (path !== target) return handle
        return wrapCaptureHandle(handle, async () => {
          const bytes = await (handle as { readFile: () => Promise<Buffer> }).readFile()
          return Buffer.concat([bytes, Buffer.from('changed')])
        })
      },
    } as unknown as FileSystem
    const { capture, repository } = makeCapture(home, { fs })

    await assert.rejects(capture.capture({ profile: 'work' }), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'SNAPSHOT_CORRUPT'
    })

    assert.deepEqual(await repository.list(), [])
    await assertNoPublishedOrTemporarySnapshot(home)
  })
})
