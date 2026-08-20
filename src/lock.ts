import { randomUUID } from 'node:crypto'
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
  owner: LockOwner
  path: string
}

interface LockOwner {
  acquiredAt: string
  pid: number
  token: string
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

function recoveryRequired(error: unknown, root: string): SnapshotError {
  return new SnapshotError(
    'SNAPSHOT_CORRUPT',
    'Snapshot writer lock may require operator recovery before another snapshot can run',
    { cause: error, recovery: lockRecoveryMessage(root) },
  )
}

function sameLock(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev !== undefined && left.ino !== undefined && left.dev === right.dev && left.ino === right.ino
}

function ownerToken(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('token' in value)) return undefined
  const token = value.token
  return typeof token === 'string' ? token : undefined
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
      const owner: LockOwner = { pid: process.pid, acquiredAt: new Date().toISOString(), token: randomUUID() }
      ownedLock = { identity, owner, path: lockPath }
      const ownerPath = join(lockPath, 'owner.json')
      await this.#fs.writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
      await this.#fs.chmod(ownerPath, 0o600)
      return ownedLock
    } catch (error) {
      if (await this.#removeEmptyLock(lockPath)) throw lockFailure(error)
      throw recoveryRequired(error, this.#root)
    }
  }

  async #release(ownedLock: OwnedLock): Promise<void> {
    try {
      const current = await this.#fs.lstat(ownedLock.path)
      if (!sameLock(ownedLock.identity, current)) throw recoveryRequired(undefined, this.#root)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') throw recoveryRequired(error, this.#root)
      if (error instanceof SnapshotError) throw error
      throw releaseFailure(error)
    }

    const ownerPath = join(ownedLock.path, 'owner.json')
    try {
      const currentOwner = JSON.parse(String(await this.#fs.readFile(ownerPath, 'utf8'))) as unknown
      if (ownerToken(currentOwner) !== ownedLock.owner.token) throw recoveryRequired(undefined, this.#root)
    } catch (error) {
      if (error instanceof SnapshotError) throw error
      throw recoveryRequired(error, this.#root)
    }

    // Node has no atomic checked-path delete. Cooperative writers leave this
    // directory untouched; nonrecursive cleanup fails closed if it changes.
    try {
      await this.#fs.rm(ownerPath, { recursive: false, force: false })
    } catch (error) {
      throw recoveryRequired(error, this.#root)
    }

    try {
      await this.#fs.rmdir(ownedLock.path)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return
      if (isNodeError(error) && error.code === 'ENOTEMPTY') throw recoveryRequired(error, this.#root)
      throw releaseFailure(error)
    }
  }

  async #removeEmptyLock(lockPath: string): Promise<boolean> {
    try {
      await this.#fs.rmdir(lockPath)
      return true
    } catch (error) {
      return isNodeError(error) && error.code === 'ENOENT'
    }
  }
}
