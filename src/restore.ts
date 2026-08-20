import { constants as fsConstants } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

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
  backup?: string
  originalPresent: boolean
  originalMoved: boolean
  installed: boolean
}

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

function selectRandomHex(value: RestoreServiceOptions['randomHex']): string {
  const random = typeof value === 'function' ? value() : value ?? '000000'
  if (!/^[0-9a-f]{6}$/.test(random)) throw new TypeError('Invalid random suffix')
  return random
}

async function existsRegular(fs: FileSystem, path: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(path)
    if (!isRegular(stat)) throw new SnapshotError('UNSAFE_FILE_TYPE', 'A restore target is not a regular file')
    return true
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return false
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
        const originalPresent = await existsRegular(this.#fs, target)
        const record: JournalEntry = { logicalPath, target, originalPresent, originalMoved: false, installed: false }
        if (entry.status === 'present') record.stage = await this.#stage(snapshotId, entry, target)
        journal.push(record)
      }

      for (const record of journal) {
        if (record.originalPresent) {
          record.backup = `${record.target}.dsh-backup-${selectRandomHex(this.#randomHex)}`
          await this.#fs.rename(record.target, record.backup)
          record.originalMoved = true
        }
        if (record.stage !== undefined) {
          await this.#fs.rename(record.stage, record.target)
          record.installed = true
        }
        await this.#syncDirectory(dirname(record.target))
      }
    } catch (error) {
      const rolledBack = await this.#rollback(journal)
      if (rolledBack) {
        throw new SnapshotError('RESTORE_FAILED_ROLLED_BACK', 'Restore failed and the original configuration was restored', {
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
      for (const record of journal) if (record.backup !== undefined) await removeIfPresent(this.#fs, record.backup)
    } catch (error) {
      throw new SnapshotError(
        'RESTORE_FAILED_MANUAL_RECOVERY',
        'Restore completed but cleanup needs manual recovery; keep generated recovery files and contact an operator',
        { cause: error, protectionSnapshotId, residuals: journal.map((record) => ({ backup: record.backup })) },
      )
    }

    const restored = journal.filter((record) => record.stage !== undefined).map((record) => record.logicalPath)
    const removed = journal.filter((record) => record.stage === undefined && record.originalPresent).map((record) => record.logicalPath)
    const dependenciesChanged = journal.some(
      (record) =>
        (record.logicalPath === 'profile/package.json' || record.logicalPath === 'profile/pnpm-lock.yaml') &&
        (record.stage !== undefined || record.originalPresent),
    )
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

  async #stage(snapshotId: string, entry: PresentManifestEntry, target: string): Promise<string> {
    const stage = join(dirname(target), `.${basename(target)}.dsh-stage-${selectRandomHex(this.#randomHex)}`)
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
      output = await this.#fs.open(stage, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
      await output.writeFile(bytes)
      await output.sync()
      await output.close()
      output = undefined
      if (this.#platform !== 'win32') await this.#fs.chmod(stage, entry.mode)
      const verified = Buffer.from(await this.#fs.readFile(stage))
      if (verified.byteLength !== entry.bytes || sha256(verified) !== entry.sha256) {
        throw new SnapshotError('SNAPSHOT_CORRUPT', 'Restore stage verification failed')
      }
      return stage
    } catch (error) {
      try { await removeIfPresent(this.#fs, stage) } catch { /* original error is authoritative */ }
      throw safeFailure(error, 'Could not safely stage snapshot data')
    } finally {
      if (source !== undefined) await source.close()
      if (output !== undefined) await output.close()
    }
  }

  async #rollback(journal: readonly JournalEntry[]): Promise<boolean> {
    try {
      for (const record of [...journal].reverse()) {
        if (record.installed) await removeIfPresent(this.#fs, record.target)
        if (record.originalMoved && record.backup !== undefined) await this.#fs.rename(record.backup, record.target)
        if (!record.originalPresent) await removeIfPresent(this.#fs, record.target)
        if (record.stage !== undefined) await removeIfPresent(this.#fs, record.stage)
      }
      return true
    } catch {
      return false
    }
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
