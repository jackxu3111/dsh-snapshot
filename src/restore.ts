import { constants as fsConstants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { SnapshotError } from './errors.ts'
import { nodeFileSystem } from './filesystem.ts'
import type { FileSystem } from './filesystem.ts'
import type { CaptureInput, CaptureService } from './capture.ts'
import type { WriterLockLike } from './lock.ts'
import { resolveWhitelist, snapshotDirectory, validateSnapshotId } from './policy.ts'
import { sha256 } from './repository.ts'
import type { Manifest, PresentManifestEntry } from './types.ts'
import type { LogicalPath, RestoreResult } from './types.ts'

const LOGICAL_PATHS: readonly LogicalPath[] = [
  'home/settings.yaml',
  'home/cordis.patch.yml',
  'profile/package.json',
  'profile/cordis.patch.yml',
  'profile/pnpm-lock.yaml',
  'profile/pnpm-workspace.yaml',
]
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

export interface RestoreRepository {
  preflight(snapshotId: string): Promise<Manifest>
}

export interface RestoreCapture {
  captureUnlocked(input: CaptureInput): Promise<{ snapshotId: string }>
}

export interface RestoreServiceOptions {
  dshHome: string
  repository: RestoreRepository
  capture: RestoreCapture | CaptureService
  writerLock: WriterLockLike
  fs?: FileSystem
  randomHex?: string | (() => string)
  platform?: NodeJS.Platform
}

interface JournalEntry {
  logicalPath: LogicalPath
  target: string
  stage?: string
  stageIdentity?: FileIdentity
  backup?: string
  originalPresent: boolean
  original?: FileIdentity
  originalSha256?: string
  originalMode?: number
  originalMoved: boolean
  installed: boolean
}

interface FileIdentity { dev?: number | bigint; ino?: number | bigint; size?: number | bigint; mtimeMs?: number | bigint }
interface Stage { path: string; identity: FileIdentity }

function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function isRegular(stat: unknown): boolean {
  return typeof stat === 'object' && stat !== null && 'isFile' in stat && typeof stat.isFile === 'function'
    ? Boolean(stat.isFile())
    : false
}

function identity(stat: unknown): FileIdentity {
  if (typeof stat !== 'object' || stat === null) throw new SnapshotError('UNSAFE_FILE_TYPE', 'A restore target is unsafe')
  const value = stat as FileIdentity
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}

function safeFailure(error: unknown, fallback: string): SnapshotError {
  if (error instanceof SnapshotError) return error
  const code = nodeCode(error)
  if (code === 'EPERM' || code === 'EACCES') {
    return new SnapshotError('SNAPSHOT_CORRUPT', `${fallback}; check permissions and try again`, { cause: error })
  }
  if (code === 'EBUSY') {
    return new SnapshotError('SNAPSHOT_CORRUPT', `${fallback}; close applications using the configuration and try again`, { cause: error })
  }
  return new SnapshotError('SNAPSHOT_CORRUPT', fallback, { cause: error })
}

function remediation(error: unknown): string {
  const code = nodeCode(error)
  if (code === 'EACCES' || code === 'EPERM') return '; check permissions and try again'
  if (code === 'EBUSY') return '; close applications using the configuration and try again'
  return ''
}

function selectRandomHex(value: RestoreServiceOptions['randomHex']): string {
  const random = typeof value === 'function' ? value() : value ?? randomBytes(3).toString('hex')
  if (!/^[0-9a-f]{6}$/.test(random)) throw new TypeError('Invalid random suffix')
  return random
}

async function inspectRegular(fs: FileSystem, path: string): Promise<FileIdentity | undefined> {
  try {
    const stat = await fs.lstat(path)
    if (!isRegular(stat)) throw new SnapshotError('UNSAFE_FILE_TYPE', 'A restore target is not a regular file')
    return identity(stat)
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return undefined
    throw error
  }
}

async function removeIfPresent(fs: FileSystem, path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: false, force: false })
  } catch (error) {
    if (nodeCode(error) !== 'ENOENT') throw error
  }
}

/** Restores a verified snapshot as a reversible, per-file rename transaction. */
export class RestoreService {
  readonly #dshHome: string
  readonly #repository: RestoreRepository
  readonly #capture: RestoreCapture
  readonly #writerLock: WriterLockLike
  readonly #fs: FileSystem
  readonly #randomHex: RestoreServiceOptions['randomHex']
  readonly #platform: NodeJS.Platform

  constructor(options: RestoreServiceOptions) {
    this.#dshHome = options.dshHome
    this.#repository = options.repository
    this.#capture = options.capture
    this.#writerLock = options.writerLock
    this.#fs = options.fs ?? nodeFileSystem
    this.#randomHex = options.randomHex
    this.#platform = options.platform ?? process.platform
  }

  async restore(snapshotId: string): Promise<RestoreResult> {
    validateSnapshotId(snapshotId)
    return this.#writerLock.runExclusive(() => this.#restoreUnlocked(snapshotId))
  }

  async #restoreUnlocked(snapshotId: string): Promise<RestoreResult> {
    const manifest = await this.#repository.preflight(snapshotId)
    const targets = resolveWhitelist(this.#dshHome, manifest.profile)
    let protectionSnapshotId: string
    try {
      protectionSnapshotId = (await this.#capture.captureUnlocked({
        profile: manifest.profile,
        kind: 'protection',
        label: `Before restore ${snapshotId}`,
      })).snapshotId
    } catch (error) {
      throw new SnapshotError('PROTECTION_FAILED', 'Could not create the safety snapshot before restore', { cause: error })
    }

    const journal: JournalEntry[] = []
    try {
      for (const logicalPath of LOGICAL_PATHS) {
        const entry = manifest.entries.find((candidate) => candidate.logicalPath === logicalPath)
        const target = targets.get(logicalPath)
        if (!entry || !target) throw new SnapshotError('SNAPSHOT_CORRUPT', 'Restore policy is incomplete')
        const original = await inspectRegular(this.#fs, target)
        const record: JournalEntry = { logicalPath, target, originalPresent: original !== undefined, original, originalMoved: false, installed: false }
        if (original !== undefined && (logicalPath === 'profile/package.json' || logicalPath === 'profile/pnpm-lock.yaml')) {
          const current = await this.#readRegular(target, original)
          record.originalSha256 = sha256(current.bytes)
          record.originalMode = current.mode
        }
        if (entry.status === 'present') {
          const staged = await this.#stage(snapshotId, entry, target)
          record.stage = staged.path
          record.stageIdentity = staged.identity
        }
        journal.push(record)
      }

      for (const record of journal) {
        if (record.originalPresent) {
          if (record.original === undefined || !sameIdentity(record.original, await this.#requireSameRegular(record.target, record.original))) {
            throw new SnapshotError('UNSAFE_FILE_TYPE', 'A restore target changed before it could be protected')
          }
          record.backup = await this.#availableSibling(record.target, 'backup')
          await this.#fs.rename(record.target, record.backup)
          record.originalMoved = true
        }
        if (record.stage !== undefined) {
          if (record.stageIdentity === undefined || !sameIdentity(record.stageIdentity, await this.#requireSameRegular(record.stage, record.stageIdentity))) {
            throw new SnapshotError('UNSAFE_FILE_TYPE', 'A restore stage changed before installation')
          }
          if (await inspectRegular(this.#fs, record.target) !== undefined) {
            throw new SnapshotError('UNSAFE_FILE_TYPE', 'A restore target appeared during commit')
          }
          await this.#fs.rename(record.stage, record.target)
          record.installed = true
        }
        await this.#syncDirectory(dirname(record.target))
      }
    } catch (error) {
      const rollbackFailures = await this.#rollback(journal)
      const mutated = journal.some((record) => record.originalMoved || record.installed)
      if (!mutated) {
        throw new SnapshotError('RESTORE_FAILED_ROLLED_BACK', 'Restore failed before configuration changes were made', {
          cause: error,
          protectionSnapshotId,
        })
      }
      if (rollbackFailures.length === 0) {
        throw new SnapshotError('RESTORE_FAILED_ROLLED_BACK', `Restore failed and the original configuration was restored${remediation(error)}`, {
          cause: error,
          protectionSnapshotId,
        })
      }
      throw new SnapshotError(
        'RESTORE_FAILED_MANUAL_RECOVERY',
        'Restore failed and needs manual recovery; keep the generated recovery files and contact an operator',
        { cause: error, protectionSnapshotId, residuals: journal.map((record) => ({ backup: record.backup, stage: record.stage })) },
      )
    }

    try {
      for (const record of journal) {
        if (record.backup === undefined) continue
        await removeIfPresent(this.#fs, record.backup)
        await this.#syncDirectory(dirname(record.backup))
      }
    } catch (error) {
      throw new SnapshotError(
        'RESTORE_FAILED_MANUAL_RECOVERY',
        `Restore completed but cleanup needs manual recovery${remediation(error)}; keep generated recovery files and contact an operator`,
        { cause: error, protectionSnapshotId, residuals: journal.map((record) => ({ backup: record.backup })) },
      )
    }

    const restored = journal.filter((record) => record.stage !== undefined).map((record) => record.logicalPath)
    const removed = journal.filter((record) => record.stage === undefined && record.originalPresent).map((record) => record.logicalPath)
    const dependenciesChanged = manifest.entries.some((entry) => {
      if (entry.logicalPath !== 'profile/package.json' && entry.logicalPath !== 'profile/pnpm-lock.yaml') return false
      const record = journal.find((candidate) => candidate.logicalPath === entry.logicalPath)
      if (record === undefined || record.originalPresent !== (entry.status === 'present')) return true
      if (entry.status === 'absent') return false
      return record.originalSha256 !== entry.sha256 || (this.#platform !== 'win32' && record.originalMode !== entry.mode)
    })
    return {
      snapshotId,
      profile: manifest.profile,
      protectionSnapshotId,
      restored,
      removed,
      restartRequired: true,
      ...(dependenciesChanged ? { dependencyInstallCommand: 'pnpm install --frozen-lockfile' } : {}),
    }
  }

  async #stage(snapshotId: string, entry: PresentManifestEntry, target: string): Promise<Stage> {
    let stage: string | undefined
    let stageCreated = false
    let source: Awaited<ReturnType<FileSystem['open']>> | undefined
    let output: Awaited<ReturnType<FileSystem['open']>> | undefined
    try {
      const payload = join(snapshotDirectory(this.#dshHome, snapshotId), 'files', entry.storedName)
      source = await this.#fs.open(payload, fsConstants.O_RDONLY | O_NOFOLLOW)
      const sourceStat = await source.stat()
      if (!isRegular(sourceStat)) throw new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot payload is unsafe')
      const bytes = Buffer.from(await source.readFile())
      if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
        throw new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot payload changed during restore')
      }
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = join(dirname(target), `.${basename(target)}.dsh-stage-${selectRandomHex(this.#randomHex)}`)
        try {
          output = await this.#fs.open(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
          stage = candidate
          stageCreated = true
          break
        } catch (error) {
          if (nodeCode(error) !== 'EEXIST' || attempt === 15) throw error
        }
      }
      if (stage === undefined || output === undefined) throw new SnapshotError('SNAPSHOT_CORRUPT', 'Could not reserve a restore stage')
      await output.writeFile(bytes)
      await output.sync()
      await output.close()
      output = undefined
      if (this.#platform !== 'win32') await this.#fs.chmod(stage, entry.mode)
      const verified = await this.#readRegular(stage)
      if (verified.bytes.byteLength !== entry.bytes || sha256(verified.bytes) !== entry.sha256) {
        throw new SnapshotError('SNAPSHOT_CORRUPT', 'Restore stage verification failed')
      }
      return { path: stage, identity: verified.identity }
    } catch (error) {
      if (stageCreated && stage !== undefined) {
        try { await removeIfPresent(this.#fs, stage) } catch { /* original error is authoritative */ }
      }
      throw safeFailure(error, 'Could not safely stage snapshot data')
    } finally {
      if (source !== undefined) await source.close()
      if (output !== undefined) await output.close()
    }
  }

  async #rollback(journal: readonly JournalEntry[]): Promise<unknown[]> {
    const failures: unknown[] = []
    for (const record of [...journal].reverse()) {
      let targetRemoved = !record.installed
      if (record.installed) {
        try { await removeIfPresent(this.#fs, record.target); await this.#syncDirectory(dirname(record.target)); targetRemoved = true } catch (error) { failures.push(error) }
      }
      if (record.originalMoved && record.backup !== undefined && targetRemoved) {
        try { await this.#fs.rename(record.backup, record.target); await this.#syncDirectory(dirname(record.target)) } catch (error) { failures.push(error) }
      }
      if (!record.originalPresent && !record.installed) {
        try { await removeIfPresent(this.#fs, record.target); await this.#syncDirectory(dirname(record.target)) } catch (error) { failures.push(error) }
      }
      if (record.stage !== undefined) {
        try { await removeIfPresent(this.#fs, record.stage); await this.#syncDirectory(dirname(record.stage)) } catch (error) { failures.push(error) }
      }
    }
    return failures
  }

  async #readRegular(path: string, expected?: FileIdentity): Promise<{ bytes: Buffer; mode: number; identity: FileIdentity }> {
    let handle: Awaited<ReturnType<FileSystem['open']>> | undefined
    try {
      handle = await this.#fs.open(path, fsConstants.O_RDONLY | O_NOFOLLOW)
      const before = await handle.stat()
      if (!isRegular(before)) throw new SnapshotError('UNSAFE_FILE_TYPE', 'A restore file is not regular')
      const beforeIdentity = identity(before)
      if (expected !== undefined && !sameIdentity(expected, beforeIdentity)) {
        throw new SnapshotError('UNSAFE_FILE_TYPE', 'A restore file changed unexpectedly')
      }
      const bytes = Buffer.from(await handle.readFile())
      const after = await this.#fs.lstat(path)
      if (!isRegular(after) || !sameIdentity(beforeIdentity, identity(after))) {
        throw new SnapshotError('UNSAFE_FILE_TYPE', 'A restore file changed unexpectedly')
      }
      const mode = typeof (after as { mode?: unknown }).mode === 'number' ? (after as { mode: number }).mode & 0o777 : 0
      return { bytes, mode, identity: beforeIdentity }
    } finally {
      if (handle !== undefined) await handle.close()
    }
  }

  async #requireSameRegular(path: string, expected: FileIdentity): Promise<FileIdentity> {
    const current = await inspectRegular(this.#fs, path)
    if (current === undefined || !sameIdentity(current, expected)) {
      throw new SnapshotError('UNSAFE_FILE_TYPE', 'A restore target changed unexpectedly')
    }
    return current
  }

  async #availableSibling(target: string, kind: 'backup'): Promise<string> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = `${target}.dsh-${kind}-${selectRandomHex(this.#randomHex)}`
      if (await inspectRegularOrAbsent(this.#fs, candidate)) continue
      return candidate
    }
    throw new SnapshotError('SNAPSHOT_CORRUPT', 'Could not reserve safe restore recovery material')
  }

  async #syncDirectory(path: string): Promise<void> {
    if (this.#platform === 'win32') return
    let directory: Awaited<ReturnType<FileSystem['open']>> | undefined
    try {
      directory = await this.#fs.open(path, fsConstants.O_RDONLY)
      await directory.sync()
    } catch (error) {
      const code = nodeCode(error)
      if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') {
        throw safeFailure(error, 'Could not synchronize restored configuration')
      }
    } finally {
      if (directory !== undefined) await directory.close()
    }
  }
}

async function inspectRegularOrAbsent(fs: FileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return false
    throw error
  }
}
