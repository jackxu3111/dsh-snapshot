import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SnapshotError } from '../src/errors.ts'
import { nodeFileSystem } from '../src/filesystem.ts'
import type { FileSystem } from '../src/filesystem.ts'
import { snapshotDirectory, snapshotRoot } from '../src/policy.ts'
import { SnapshotRepository, sha256 } from '../src/repository.ts'
import type { LogicalPath, Manifest, ManifestEntry } from '../src/types.ts'
import { allLogicalPaths, fixtureManifest } from './helpers.ts'

const snapshotId = '20260820T104530123Z-a1b2c3'
const payloads = new Map<LogicalPath, Buffer>([
  ['home/settings.yaml', Buffer.from('settings')],
  ['home/cordis.patch.yml', Buffer.from('home patch')],
  ['profile/package.json', Buffer.from('{"name":"work"}\n')],
  ['profile/cordis.patch.yml', Buffer.from('profile patch')],
  ['profile/pnpm-lock.yaml', Buffer.from('lock')],
  ['profile/pnpm-workspace.yaml', Buffer.from('workspace')],
])

function manifestFor(id = snapshotId, present = allLogicalPaths): Manifest {
  const entries: ManifestEntry[] = allLogicalPaths.map((logicalPath, index) => {
    const payload = payloads.get(logicalPath)
    if (!present.includes(logicalPath) || !payload) return { logicalPath, status: 'absent' }

    return {
      logicalPath,
      status: 'present',
      bytes: payload.byteLength,
      sha256: sha256(payload),
      storedName: `entry-${index}.bin`,
      mode: 0o600,
    }
  })

  return fixtureManifest(id, entries)
}

async function temporaryHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-snapshot-repository-'))
}

async function seedManifest(home: string, id: string, value: unknown): Promise<void> {
  const directory = snapshotDirectory(home, id)
  await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }))
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(value), 'utf8')
}

async function withHome<T>(operation: (home: string) => Promise<T>): Promise<T> {
  const home = await temporaryHome()
  try {
    return await operation(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

function recordingFileSystem(failWritePath?: string) {
  const calls: string[] = []
  const fs = {
    ...nodeFileSystem,
    writeFile: async (path: unknown, data: unknown, options: unknown) => {
      calls.push(`write:${String(path)}`)
      if (failWritePath !== undefined && String(path).endsWith(failWritePath)) {
        throw Object.assign(new Error('injected write failure'), { code: 'EIO' })
      }
      return (nodeFileSystem.writeFile as unknown as (...args: unknown[]) => Promise<void>)(path, data, options)
    },
    open: async (path: unknown, ...options: unknown[]) => {
      calls.push(`open:${String(path)}`)
      const handle = await (nodeFileSystem.open as unknown as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...options,
      )
      return {
        sync: async () => {
          calls.push(`sync:${String(path)}`)
          return (handle as { sync: () => Promise<void> }).sync()
        },
        close: async () => (handle as { close: () => Promise<void> }).close(),
      }
    },
    rename: async (from: unknown, to: unknown) => {
      calls.push(`rename:${String(from)}:${String(to)}`)
      return nodeFileSystem.rename(from as string, to as string)
    },
    rm: async (path: unknown, options: unknown) => {
      calls.push(`rm:${String(path)}`)
      return nodeFileSystem.rm(path as string, options as { recursive: boolean; force: boolean })
    },
  } as unknown as FileSystem
  return { fs, calls }
}

function swapAfterLstat(target: string, replacement: string, rejectPathReads = false): FileSystem {
  let swapped = false
  return {
    ...nodeFileSystem,
    lstat: async (path: unknown) => {
      const metadata = await nodeFileSystem.lstat(path as string)
      if (!swapped && path === target) {
        swapped = true
        await rm(target)
        await symlink(replacement, target)
      }
      return metadata
    },
    readFile: async (path: unknown, ...options: unknown[]) => {
      if (rejectPathReads && path === target) throw new Error('path read must not be used')
      return (nodeFileSystem.readFile as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...options)
    },
  } as unknown as FileSystem
}

test('sha256 returns the lowercase SHA-256 digest of bytes', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('createId uses UTC milliseconds and the injected random suffix', () => {
  const repository = new SnapshotRepository({
    dshHome: '/tmp/dsh-home',
    now: () => new Date('2026-08-20T10:45:30.123Z'),
    randomHex: () => 'a1b2c3',
  })

  assert.equal(repository.createId(), snapshotId)
})

test('readManifest rejects duplicate, missing, and unknown logical entries', async () => {
  await withHome(async (home) => {
    const repository = new SnapshotRepository({ dshHome: home })
    const valid = manifestFor()

    const duplicate = { ...valid, entries: [...valid.entries.slice(0, 5), valid.entries[0]] }
    await seedManifest(home, snapshotId, duplicate)
    await assert.rejects(repository.readManifest(snapshotId), SnapshotError)

    const missing = {
      ...valid,
      entries: valid.entries.filter((entry) => entry.logicalPath !== 'profile/package.json'),
    }
    await writeFile(
      join(snapshotDirectory(home, snapshotId), 'manifest.json'),
      JSON.stringify(missing),
      'utf8',
    )
    await assert.rejects(repository.readManifest(snapshotId), SnapshotError)

    const unknown = {
      ...valid,
      entries: valid.entries.map((entry, index) =>
        index === 0 ? { ...entry, logicalPath: 'profile/unknown.json' } : entry,
      ),
    }
    await writeFile(
      join(snapshotDirectory(home, snapshotId), 'manifest.json'),
      JSON.stringify(unknown),
      'utf8',
    )
    await assert.rejects(repository.readManifest(snapshotId), SnapshotError)
  })
})

test('readManifest rejects unsafe names, malformed digests, bad sizes and modes', async () => {
  await withHome(async (home) => {
    const repository = new SnapshotRepository({ dshHome: home })
    const cases = [
      { storedName: '../escape' },
      { storedName: '/absolute' },
      { sha256: 'ABC' },
      { bytes: -1 },
      { bytes: 1.5 },
      { mode: 0o100600 },
    ]

    for (const change of cases) {
      const value = manifestFor()
      const first = value.entries[0]
      assert.equal(first?.status, 'present')
      const invalid = {
        ...value,
        entries: value.entries.map((entry, index) =>
          index === 0 && entry.status === 'present' ? { ...entry, ...change } : entry,
        ),
      }
      await seedManifest(home, snapshotId, invalid)
      await assert.rejects(repository.readManifest(snapshotId), SnapshotError)
    }
  })
})

test('readManifest rejects unknown top-level fields, mismatched IDs and invalid JSON', async () => {
  await withHome(async (home) => {
    const repository = new SnapshotRepository({ dshHome: home })
    const value = manifestFor()

    await seedManifest(home, snapshotId, { ...value, unexpected: true })
    await assert.rejects(repository.readManifest(snapshotId), SnapshotError)

    await seedManifest(home, snapshotId, { ...value, snapshotId: '20260820T104530123Z-ffffff' })
    await assert.rejects(repository.readManifest(snapshotId), SnapshotError)

    const directory = snapshotDirectory(home, snapshotId)
    await writeFile(join(directory, 'manifest.json'), '{not-json', 'utf8')
    await assert.rejects(repository.readManifest(snapshotId), SnapshotError)
  })
})

test('readManifest rejects a manifest symlink instead of following it', async () => {
  await withHome(async (home) => {
    const repository = new SnapshotRepository({ dshHome: home })
    const directory = snapshotDirectory(home, snapshotId)
    await seedManifest(home, snapshotId, manifestFor())
    const regularManifest = join(directory, 'regular-manifest.json')
    await writeFile(regularManifest, JSON.stringify(manifestFor()), 'utf8')
    await rm(join(directory, 'manifest.json'))
    await symlink(regularManifest, join(directory, 'manifest.json'))

    await assert.rejects(repository.readManifest(snapshotId), SnapshotError)
  })
})

test('readManifest rejects a manifest replaced with a symlink after lstat', async () => {
  await withHome(async (home) => {
    const directory = snapshotDirectory(home, snapshotId)
    await seedManifest(home, snapshotId, manifestFor())
    const externalManifest = join(home, 'external-manifest.json')
    await writeFile(externalManifest, JSON.stringify(manifestFor()), 'utf8')
    const manifestPath = join(directory, 'manifest.json')
    const repository = new SnapshotRepository({
      dshHome: home,
      fs: swapAfterLstat(manifestPath, externalManifest),
    })

    await assert.rejects(repository.readManifest(snapshotId), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'SNAPSHOT_CORRUPT'
    })
  })
})

test('readManifest rejects a symlinked snapshot directory', async () => {
  await withHome(async (home) => {
    await mkdir(snapshotRoot(home), { recursive: true })
    const externalDirectory = join(home, 'external-snapshot')
    await mkdir(externalDirectory, { recursive: true })
    await symlink(externalDirectory, snapshotDirectory(home, snapshotId))
    const repository = new SnapshotRepository({ dshHome: home })

    await assert.rejects(repository.readManifest(snapshotId), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'SNAPSHOT_CORRUPT'
    })
  })
})

test('list rejects a symlinked snapshot root instead of traversing it', async () => {
  await withHome(async (home) => {
    const externalRoot = join(home, 'external-root')
    await mkdir(externalRoot, { recursive: true })
    await mkdir(join(home, 'snapshots', 'dsh-snapshot'), { recursive: true })
    await symlink(externalRoot, snapshotRoot(home))
    const repository = new SnapshotRepository({ dshHome: home })

    await assert.rejects(repository.list(), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'SNAPSHOT_CORRUPT'
    })
  })
})

test('publish writes payloads before a LF manifest with restrictive modes', async () => {
  await withHome(async (home) => {
    const repository = new SnapshotRepository({
      dshHome: home,
      randomHex: () => 'a1b2c3',
    })
    await repository.publish(manifestFor(), payloads)

    const directory = snapshotDirectory(home, snapshotId)
    const filesDirectory = join(directory, 'files')
    const manifestText = await readFile(join(directory, 'manifest.json'), 'utf8')
    assert.equal(manifestText.endsWith('\n'), true)
    assert.equal(manifestText.includes('\r'), false)
    assert.equal(manifestText.includes(home), false)
    assert.equal(manifestText.includes('home patch'), false)

    const rootMode = (await stat(snapshotRoot(home))).mode & 0o777
    const directoryMode = (await stat(directory)).mode & 0o777
    const filesMode = (await stat(filesDirectory)).mode & 0o777
    const manifestMode = (await stat(join(directory, 'manifest.json'))).mode & 0o777
    assert.equal(rootMode, 0o700)
    assert.equal(directoryMode, 0o700)
    assert.equal(filesMode, 0o700)
    assert.equal(manifestMode, 0o600)

    const storedNames = (manifestFor().entries as Array<ManifestEntry & { status: 'present' }>).map(
      (entry) => (entry.status === 'present' ? entry.storedName : ''),
    )
    for (const storedName of storedNames) {
      if (storedName) assert.equal((await stat(join(filesDirectory, storedName))).mode & 0o777, 0o600)
    }
  })
})

test('preflight rehashes every present payload and rejects tampering', async () => {
  await withHome(async (home) => {
    const repository = new SnapshotRepository({ dshHome: home, randomHex: () => 'a1b2c3' })
    await repository.publish(manifestFor(), payloads)
    await repository.preflight(snapshotId)

    await writeFile(join(snapshotDirectory(home, snapshotId), 'files', 'entry-0.bin'), 'tampered')
    await assert.rejects(repository.preflight(snapshotId), SnapshotError)
  })
})

test('preflight rejects a payload replaced with a symlink after lstat', async () => {
  await withHome(async (home) => {
    const regularRepository = new SnapshotRepository({ dshHome: home, randomHex: () => 'a1b2c3' })
    await regularRepository.publish(manifestFor(), payloads)
    const payloadPath = join(snapshotDirectory(home, snapshotId), 'files', 'entry-0.bin')
    const externalPayload = join(home, 'external-payload.bin')
    await writeFile(externalPayload, payloads.get('home/settings.yaml') as Buffer)
    const repository = new SnapshotRepository({
      dshHome: home,
      fs: swapAfterLstat(payloadPath, externalPayload),
    })

    await assert.rejects(repository.preflight(snapshotId), (error: unknown) => {
      return error instanceof SnapshotError && error.code === 'SNAPSHOT_CORRUPT'
    })
  })
})

test('publish syncs payloads before the manifest and performs one final rename', async () => {
  await withHome(async (home) => {
    const recording = recordingFileSystem()
    const repository = new SnapshotRepository({ dshHome: home, fs: recording.fs, randomHex: () => 'a1b2c3' })
    await repository.publish(manifestFor(), payloads)

    const writes = recording.calls.filter((call) => call.startsWith('write:'))
    assert.equal(writes.at(-1)?.endsWith('/manifest.json'), true)
    assert.equal(recording.calls.filter((call) => call.startsWith('sync:')).length, 7)
    assert.equal(recording.calls.filter((call) => call.startsWith('rename:')).length, 1)
  })
})

test('publish cleans its temporary sibling after a write failure', async () => {
  await withHome(async (home) => {
    const recording = recordingFileSystem('entry-2.bin')
    const repository = new SnapshotRepository({ dshHome: home, fs: recording.fs, randomHex: () => 'a1b2c3' })

    await assert.rejects(repository.publish(manifestFor(), payloads), SnapshotError)
    assert.equal((await repository.list()).length, 0)
    assert.equal(recording.calls.some((call) => call.startsWith('rm:') && call.includes('.tmp-a1b2c3')), true)
  })
})

test('publish refuses to replace an immutable existing snapshot ID', async () => {
  await withHome(async (home) => {
    const repository = new SnapshotRepository({ dshHome: home, randomHex: () => 'a1b2c3' })
    await repository.publish(manifestFor(), payloads)
    await assert.rejects(repository.publish(manifestFor(), payloads), SnapshotError)
    assert.equal((await repository.list()).length, 1)
  })
})

test('publish does not remove a pre-existing temporary sibling after a name collision', async () => {
  await withHome(async (home) => {
    const temporary = join(snapshotRoot(home), '.tmp-a1b2c3')
    await mkdir(temporary, { recursive: true })
    const repository = new SnapshotRepository({ dshHome: home, randomHex: () => 'a1b2c3' })

    await assert.rejects(repository.publish(manifestFor(), payloads), SnapshotError)
    assert.equal((await stat(temporary)).isDirectory(), true)
  })
})

test('list is shallow, isolates corrupt siblings, filters profile and ignores temporary directories', async () => {
  await withHome(async (home) => {
    const repository = new SnapshotRepository({ dshHome: home, randomHex: () => 'a1b2c3' })
    await repository.publish(manifestFor(snapshotId), payloads)

    const secondId = '20260819T104530123Z-a1b2c3'
    const secondManifest = manifestFor(secondId, ['profile/package.json'])
    secondManifest.createdAt = '2026-08-19T10:45:30.123Z'
    await repository.publish(
      secondManifest,
      new Map([['profile/package.json', payloads.get('profile/package.json') as Buffer]]),
    )
    await rm(join(snapshotDirectory(home, secondId), 'files', 'entry-2.bin'))

    const corruptId = '20260818T104530123Z-a1b2c3'
    await seedManifest(home, corruptId, { nope: true })
    const temporary = join(snapshotRoot(home), '.tmp-writing')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(temporary, { recursive: true }))
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifestFor(corruptId)), 'utf8')

    const shallowFs = {
      ...nodeFileSystem,
      readFile: async (path: unknown, ...options: unknown[]) => {
        assert.equal(String(path).includes('/files/'), false)
        return (nodeFileSystem.readFile as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...options)
      },
    } as unknown as FileSystem
    const shallowRepository = new SnapshotRepository({ dshHome: home, fs: shallowFs })
    const rows = await shallowRepository.list()
    assert.equal(rows.length, 3)
    assert.equal(rows[0]?.snapshotId, snapshotId)
    assert.equal(rows[0]?.status, 'available')
    assert.equal(rows[1]?.snapshotId, corruptId)
    assert.equal(rows[2]?.status, 'corrupt')
    assert.equal(rows[2]?.snapshotId, secondId)

    const filtered = await repository.list('work')
    assert.equal(filtered.length, 2)
    assert.equal((await repository.list('other')).length, 0)
  })
})

test('list marks a payload symlink corrupt without reading its target body', async () => {
  await withHome(async (home) => {
    const repository = new SnapshotRepository({ dshHome: home, randomHex: () => 'a1b2c3' })
    await repository.publish(manifestFor(), payloads)
    const payloadPath = join(snapshotDirectory(home, snapshotId), 'files', 'entry-0.bin')
    const externalPayload = join(home, 'external-list-payload.bin')
    await writeFile(externalPayload, payloads.get('home/settings.yaml') as Buffer)
    await rm(payloadPath)
    await symlink(externalPayload, payloadPath)

    const rows = await repository.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.status, 'corrupt')
  })
})
