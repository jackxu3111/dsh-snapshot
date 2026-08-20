import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rm, stat, utimes } from 'node:fs/promises'
import test from 'node:test'
import { join } from 'node:path'

import { SnapshotError } from '../src/errors.ts'
import { nodeFileSystem } from '../src/filesystem.ts'
import type { FileSystem } from '../src/filesystem.ts'
import { WriterLock, lockRecoveryMessage } from '../src/lock.ts'
import { withTemporaryDshHome } from './helpers.ts'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('runs queued operations in FIFO order', async () => {
  await withTemporaryDshHome(async (root) => {
    const lock = new WriterLock({ root })
    const firstMayFinish = deferred()
    const secondMayFinish = deferred()
    const firstEntered = deferred()
    const secondEntered = deferred()
    const entered: string[] = []

    const first = lock.runExclusive(async () => {
      entered.push('first')
      firstEntered.resolve()
      await firstMayFinish.promise
    })

    await firstEntered.promise
    const second = lock.runExclusive(async () => {
      entered.push('second')
      secondEntered.resolve()
      await secondMayFinish.promise
    })

    assert.deepEqual(entered, ['first'])

    firstMayFinish.resolve()
    await first
    await secondEntered.promise
    assert.deepEqual(entered, ['first', 'second'])

    secondMayFinish.resolve()
    await second
  })
})

test('releases its queue after a rejected operation', async () => {
  await withTemporaryDshHome(async (root) => {
    const lock = new WriterLock({ root })
    const failure = new Error('publish failed')
    const rejected = lock.runExclusive(async () => {
      throw failure
    })
    const following = lock.runExclusive(async () => 'published')

    await assert.rejects(rejected, failure)
    assert.equal(await following, 'published')
  })
})

test('uses an atomic private lock directory with minimal owner metadata and removes it after success', async () => {
  await withTemporaryDshHome(async (root) => {
    const lock = new WriterLock({ root })
    const lockPath = join(root, '.writer-lock')
    let owner: Record<string, unknown> | undefined
    await chmod(root, 0o755)

    const result = await lock.runExclusive(async () => {
      const lockMetadata = await stat(lockPath)
      assert.equal(lockMetadata.isDirectory(), true)
      const ownerMetadata = await stat(join(lockPath, 'owner.json'))
      if (process.platform !== 'win32') {
        assert.equal((await stat(root)).mode & 0o777, 0o700)
        assert.equal(lockMetadata.mode & 0o777, 0o700)
        assert.equal(ownerMetadata.mode & 0o777, 0o600)
      }
      owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as Record<string, unknown>
      return 42
    })

    assert.equal(result, 42)
    assert.deepEqual(Object.keys(owner ?? {}).sort(), ['acquiredAt', 'pid', 'token'])
    assert.equal(owner?.pid, process.pid)
    assert.match(owner?.acquiredAt as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.match(owner?.token as string, /^[0-9a-f-]{36}$/)
    await assert.rejects(stat(lockPath), { code: 'ENOENT' })
  })
})

test('a separate process receives BUSY while a writer owns the same root', async () => {
  await withTemporaryDshHome(async (root) => {
    const lockModule = new URL('../src/lock.ts', import.meta.url).href
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { WriterLock } from ${JSON.stringify(lockModule)}; const lock = new WriterLock({ root: process.argv[1] }); await lock.runExclusive(async () => { console.log('locked'); await new Promise((resolve) => setTimeout(resolve, 500)); });`,
        root,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    await new Promise<void>((resolve, reject) => {
      let acquired = false
      child.once('error', reject)
      child.stdout.once('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('locked')) {
          acquired = true
          resolve()
        }
        else reject(new Error(`Unexpected child output: ${chunk.toString('utf8')}`))
      })
      child.once('exit', (code) => {
        if (!acquired) reject(new Error(`Child writer exited before acquiring the lock (${code})`))
      })
    })

    await assert.rejects(
      new WriterLock({ root }).runExclusive(async () => undefined),
      (error: unknown) => error instanceof SnapshotError && error.code === 'BUSY',
    )

    const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    assert.equal(exitCode, 0)
  })
})

test('independent lock instances fail closed while another writer holds the same root', async () => {
  await withTemporaryDshHome(async (root) => {
    const firstLock = new WriterLock({ root })
    const secondLock = new WriterLock({ root })
    const releaseFirst = deferred()
    const firstEntered = deferred()
    const first = firstLock.runExclusive(async () => {
      firstEntered.resolve()
      await releaseFirst.promise
    })
    let secondRan = false

    await firstEntered.promise
    await assert.rejects(
      secondLock.runExclusive(async () => {
        secondRan = true
      }),
      (error: unknown) => error instanceof SnapshotError && error.code === 'BUSY',
    )
    assert.equal(secondRan, false)

    releaseFirst.resolve()
    await first
    assert.equal(await secondLock.runExclusive(async () => 'available'), 'available')
  })
})

test('does not reclaim a pre-existing lock regardless of its age', async () => {
  await withTemporaryDshHome(async (root) => {
    const lockPath = join(root, '.writer-lock')
    await mkdir(lockPath, { mode: 0o700 })
    await utimes(lockPath, new Date('2000-01-01T00:00:00.000Z'), new Date('2000-01-01T00:00:00.000Z'))
    let ran = false

    await assert.rejects(
      new WriterLock({ root }).runExclusive(async () => {
        ran = true
      }),
      (error: unknown) => error instanceof SnapshotError && error.code === 'BUSY',
    )

    assert.equal(ran, false)
    assert.equal((await stat(lockPath)).isDirectory(), true)
  })
})

test('maps lock permission failures to actionable remediation', async () => {
  await withTemporaryDshHome(async (root) => {
    for (const code of ['EACCES', 'EPERM'] as const) {
      const fs = {
        ...nodeFileSystem,
        mkdir: async (..._args: unknown[]) => {
          const error = new Error(code) as NodeJS.ErrnoException
          error.code = code
          throw error
        },
      } as unknown as FileSystem

      await assert.rejects(
        new WriterLock({ root, fs }).runExclusive(async () => undefined),
        (error: unknown) =>
          error instanceof SnapshotError &&
          error.code === 'SNAPSHOT_CORRUPT' &&
          /permission/i.test(error.message),
      )
    }
  })
})

test('removes an unpopulated lock directory when initial lstat setup fails', async () => {
  await withTemporaryDshHome(async (root) => {
    const lockPath = join(root, '.writer-lock')
    let lstatCalls = 0
    let callbackRan = false
    const fs = {
      ...nodeFileSystem,
      lstat: async (path: string) => {
        if (path === lockPath && ++lstatCalls === 1) throw new Error('lstat failed')
        return nodeFileSystem.lstat(path)
      },
    } as unknown as FileSystem

    await assert.rejects(new WriterLock({ root, fs }).runExclusive(async () => {
      callbackRan = true
    }))

    assert.equal(callbackRan, false)
    await assert.rejects(stat(lockPath), { code: 'ENOENT' })
    assert.equal(await new WriterLock({ root }).runExclusive(async () => 'available'), 'available')
  })
})

test('removes an unpopulated lock directory when owner metadata setup fails', async () => {
  await withTemporaryDshHome(async (root) => {
    const lockPath = join(root, '.writer-lock')
    let callbackRan = false
    const fs = {
      ...nodeFileSystem,
      writeFile: async (path: string, ..._args: unknown[]) => {
        if (path === join(lockPath, 'owner.json')) throw new Error('owner write failed')
        return undefined
      },
    } as unknown as FileSystem

    await assert.rejects(new WriterLock({ root, fs }).runExclusive(async () => {
      callbackRan = true
    }))

    assert.equal(callbackRan, false)
    await assert.rejects(stat(lockPath), { code: 'ENOENT' })
    assert.equal(await new WriterLock({ root }).runExclusive(async () => 'available'), 'available')
  })
})

test('preserves a populated setup-failure lock for operator recovery', async () => {
  await withTemporaryDshHome(async (root) => {
    const lockPath = join(root, '.writer-lock')
    let callbackRan = false
    const fs = {
      ...nodeFileSystem,
      lstat: async (path: string) => {
        if (path === lockPath) {
          await nodeFileSystem.writeFile(join(lockPath, 'foreign'), 'cooperative writer')
          throw new Error('lstat failed')
        }
        return nodeFileSystem.lstat(path)
      },
    } as unknown as FileSystem

    await assert.rejects(
      new WriterLock({ root, fs }).runExclusive(async () => {
        callbackRan = true
      }),
      (error: unknown) => error instanceof SnapshotError && /operator/i.test(error.message),
    )

    assert.equal(callbackRan, false)
    assert.equal((await stat(join(lockPath, 'foreign'))).isFile(), true)
    await assert.rejects(
      new WriterLock({ root }).runExclusive(async () => undefined),
      (error: unknown) => error instanceof SnapshotError && error.code === 'BUSY',
    )
    await rm(lockPath, { recursive: true, force: true })
  })
})

test('gives operators a manual lock recovery procedure without automatic deletion', () => {
  const root = '/safe/dsh-home'
  const message = lockRecoveryMessage(root)

  assert.match(message, /\.writer-lock/)
  assert.match(message, /owner\.json/)
  assert.match(message, /verify/i)
  assert.match(message, /remove/i)
  assert.match(message, /manual|operator/i)
})

test('does not remove a replacement lock directory it no longer owns', async () => {
  await withTemporaryDshHome(async (root) => {
    const lockPath = join(root, '.writer-lock')
    let lockLstatCalls = 0
    const fs = {
      ...nodeFileSystem,
      lstat: async (path: string) => {
        const metadata = await nodeFileSystem.lstat(path)
        if (path === lockPath && ++lockLstatCalls > 1) return { ...metadata, ino: 999999999 }
        return metadata
      },
    } as unknown as FileSystem

    await assert.rejects(
      new WriterLock({ root, fs }).runExclusive(async () => undefined),
      (error: unknown) => error instanceof SnapshotError && /operator/i.test(error.message),
    )
    assert.equal((await stat(lockPath)).isDirectory(), true)
    await rm(lockPath, { recursive: true, force: true })
  })
})

test('fails closed when its owned lock directory disappears before release', async () => {
  await withTemporaryDshHome(async (root) => {
    const lockPath = join(root, '.writer-lock')
    let lockLstatCalls = 0
    const fs = {
      ...nodeFileSystem,
      lstat: async (path: string) => {
        if (path === lockPath && ++lockLstatCalls === 2) {
          await rm(lockPath, { recursive: true, force: true })
        }
        return nodeFileSystem.lstat(path)
      },
    } as unknown as FileSystem

    await assert.rejects(
      new WriterLock({ root, fs }).runExclusive(async () => undefined),
      (error: unknown) => error instanceof SnapshotError && /operator/i.test(error.message),
    )
  })
})

test('never recursively deletes a cooperative replacement that repopulates the lock during release', async () => {
  await withTemporaryDshHome(async (root) => {
    const lockPath = join(root, '.writer-lock')
    const ownerPath = join(lockPath, 'owner.json')
    let callbackRan = false
    const fs = {
      ...nodeFileSystem,
      rm: async (path: string, options: { recursive?: boolean; force?: boolean }) => {
        await nodeFileSystem.rm(path, options)
        if (path === ownerPath) {
          await nodeFileSystem.writeFile(
            ownerPath,
            JSON.stringify({ pid: 999, acquiredAt: '2026-08-20T00:00:00.000Z', token: 'replacement' }),
            { flag: 'wx', mode: 0o600 },
          )
        }
      },
    } as unknown as FileSystem

    await assert.rejects(
      new WriterLock({ root, fs }).runExclusive(async () => {
        callbackRan = true
      }),
      (error: unknown) => error instanceof SnapshotError && /operator/i.test(error.message),
    )

    assert.equal(callbackRan, true)
    assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).token, 'replacement')
    await assert.rejects(
      new WriterLock({ root }).runExclusive(async () => undefined),
      (error: unknown) => error instanceof SnapshotError && error.code === 'BUSY',
    )
    await rm(lockPath, { recursive: true, force: true })
  })
})
