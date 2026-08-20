import { join } from 'node:path'

import { SnapshotError } from './errors.ts'
import { nodeFileSystem } from './filesystem.ts'
import type { FileSystem } from './filesystem.ts'

interface NodeErrorLike {
  code?: string
}

interface LockIdentity {
  dev?: number | bigint
  ino?: number | bigint
}

interface OwnedLock {
  identity: LockIdentity
  path: string
}

export interface WriterLockLike {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
}

export interface WriterLockOptions {
  root: string
  fs?: FileSystem
}

function isNodeError(value: unknown): value is NodeErrorLike {
  return typeof value === 'object' && value !== null && 'code' in value
}

function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')
}

function lockFailure(error: unknown): SnapshotError {
  if (isPermissionError(error)) {
    return new SnapshotError(
      'SNAPSHOT_CORRUPT',
      'Snapshot writer lock could not be acquired; check directory permissions and try again',
      { cause: error },
    )
  }
  return new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot writer lock could not be acquired', { cause: error })
}

function releaseFailure(error: unknown): SnapshotError {
  if (isPermissionError(error)) {
    return new SnapshotError(
      'SNAPSHOT_CORRUPT',
      'Snapshot writer lock could not be released; check directory permissions and ask an operator to recover it',
      { cause: error },
    )
  }
  return new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot writer lock could not be released', { cause: error })
}

function sameLock(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev !== undefined && left.ino !== undefined && left.dev === right.dev && left.ino === right.ino
}

/** Instructions intended for an operator after verifying the owner is no longer running. */
export function lockRecoveryMessage(root: string): string {
  const lockPath = join(root, '.writer-lock')
  return `Operator recovery only: verify ${join(lockPath, 'owner.json')} belongs to a stopped writer, then manually remove ${lockPath}. Do not remove a lock held by an active writer.`
}

/**
 * Serializes snapshot mutations within this process and refuses concurrent
 * writers from other processes using an atomically-created directory.
 */
export class WriterLock implements WriterLockLike {
  readonly #fs: FileSystem
  readonly #root: string
  #tail: Promise<void> = Promise.resolve()

  constructor(options: WriterLockOptions) {
    this.#root = options.root
    this.#fs = options.fs ?? nodeFileSystem
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let releaseQueue!: () => void
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    const predecessor = this.#tail
    this.#tail = queued

    await predecessor
    try {
      const ownedLock = await this.#acquire()
      try {
        return await operation()
      } finally {
        await this.#release(ownedLock)
      }
    } finally {
      releaseQueue()
    }
  }

  async #acquire(): Promise<OwnedLock> {
    const lockPath = join(this.#root, '.writer-lock')
    try {
      await this.#fs.mkdir(this.#root, { recursive: true, mode: 0o700 })
      await this.#fs.chmod(this.#root, 0o700)
    } catch (error) {
      throw lockFailure(error)
    }

    try {
      await this.#fs.mkdir(lockPath, { mode: 0o700 })
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new SnapshotError(
          'BUSY',
          'Another snapshot writer is active; wait for it to finish or ask an operator to recover a stale lock.',
          { cause: error, recovery: lockRecoveryMessage(this.#root) },
        )
      }
      throw lockFailure(error)
    }

    let ownedLock: OwnedLock | undefined
    try {
      const identity = await this.#fs.lstat(lockPath)
      ownedLock = { identity, path: lockPath }
      const owner = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })
      const ownerPath = join(lockPath, 'owner.json')
      await this.#fs.writeFile(ownerPath, owner, { flag: 'wx', mode: 0o600 })
      await this.#fs.chmod(ownerPath, 0o600)
      return ownedLock
    } catch (error) {
      if (ownedLock !== undefined) {
        try {
          await this.#release(ownedLock)
        } catch {
          // The original acquisition failure is the actionable result.
        }
      }
      throw lockFailure(error)
    }
  }

  async #release(ownedLock: OwnedLock): Promise<void> {
    try {
      const current = await this.#fs.lstat(ownedLock.path)
      if (!sameLock(ownedLock.identity, current)) return
      await this.#fs.rm(ownedLock.path, { recursive: true, force: false })
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return
      throw releaseFailure(error)
    }
  }
}
