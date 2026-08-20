import { constants as fsConstants } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { SnapshotError } from './errors.ts'
import { nodeFileSystem } from './filesystem.ts'
import type { FileSystem } from './filesystem.ts'
import type { FileHandle } from './filesystem.ts'
import type { WriterLockLike } from './lock.ts'
import { profileRoot, resolveWhitelist, validateProfile } from './policy.ts'
import { sha256 } from './repository.ts'
import type { SnapshotPayloads } from './repository.ts'
import {
  MAX_FILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  SCHEMA_VERSION,
} from './types.ts'
import type {
  CreateResult,
  LogicalPath,
  Manifest,
  ManifestEntry,
  SnapshotKind,
} from './types.ts'

const CANONICAL_LOGICAL_PATHS: readonly LogicalPath[] = [
  'home/settings.yaml',
  'home/cordis.patch.yml',
  'profile/package.json',
  'profile/cordis.patch.yml',
  'profile/pnpm-lock.yaml',
  'profile/pnpm-workspace.yaml',
]

const CAPTURE_WARNING =
  'This local snapshot may contain sensitive configuration; keep it on this device, do not commit it to Git, and do not share it publicly.'
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
const READ_ONLY_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW

type PrimitiveDate = Date | string | number
type CaptureClock = PrimitiveDate | (() => PrimitiveDate)

interface NodeErrorLike {
  code?: string
}

interface FileMetadata {
  dev?: number | bigint
  ino?: number | bigint
  size?: number | bigint
  mode?: number
  mtimeMs?: number | bigint
  ctimeMs?: number | bigint
  mtime?: Date
  ctime?: Date
  isFile?: () => boolean
  isDirectory?: () => boolean
}

interface StableFile {
  bytes: Buffer
  mode: number
}

export interface CaptureRepository {
  createId(): string
  publish(manifest: Manifest, payloads: SnapshotPayloads): Promise<void>
}

export interface CaptureServiceOptions {
  dshHome: string
  repository: CaptureRepository
  fs?: FileSystem
  now?: CaptureClock
  pluginVersion: string
  dshVersion?: string
  writerLock: WriterLockLike
}

export interface CaptureInput {
  profile: string
  kind?: SnapshotKind
  label?: string
}

function isNodeError(value: unknown): value is NodeErrorLike {
  return typeof value === 'object' && value !== null && 'code' in value
}

function unsupportedNoFollowFlag(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EINVAL' || error.code === 'ENOTSUP' || error.code === 'EOPNOTSUPP')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDirectory(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  if (typeof metadata.isDirectory === 'function') {
    try {
      return metadata.isDirectory() as boolean
    } catch {
      return false
    }
  }
  return typeof metadata.mode === 'number' && (metadata.mode & 0o170000) === 0o040000
}

function isRegularFile(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  if (typeof metadata.isFile === 'function') {
    try {
      return metadata.isFile() as boolean
    } catch {
      return false
    }
  }
  return typeof metadata.mode === 'number' && (metadata.mode & 0o170000) === 0o100000
}

function metadataRecord(value: unknown): FileMetadata {
  return isRecord(value) ? (value as FileMetadata) : {}
}

function timeValue(metadata: FileMetadata, millisecondKey: 'mtimeMs' | 'ctimeMs', dateKey: 'mtime' | 'ctime'): unknown {
  if (metadata[millisecondKey] !== undefined) return metadata[millisecondKey]
  const date = metadata[dateKey]
  return date instanceof Date ? date.getTime() : date
}

function metadataChanged(beforeValue: unknown, afterValue: unknown): boolean {
  const before = metadataRecord(beforeValue)
  const after = metadataRecord(afterValue)
  return (
    !Object.is(before.dev, after.dev) ||
    !Object.is(before.ino, after.ino) ||
    !Object.is(before.size, after.size) ||
    !Object.is(timeValue(before, 'mtimeMs', 'mtime'), timeValue(after, 'mtimeMs', 'mtime')) ||
    !Object.is(timeValue(before, 'ctimeMs', 'ctime'), timeValue(after, 'ctimeMs', 'ctime')) ||
    // Preserve the mode from the same stable file version as the bytes.
    !Object.is(before.mode, after.mode)
  )
}

function metadataSize(metadata: unknown): number | undefined {
  const size = metadataRecord(metadata).size
  if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) return size
  if (typeof size === 'bigint' && size >= 0n && size <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(size)
  return undefined
}

function metadataMode(metadata: unknown): number {
  const mode = metadataRecord(metadata).mode
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0) {
    throw new SnapshotError('SNAPSHOT_CORRUPT', 'File metadata is invalid')
  }
  return mode & 0o777
}

function invalidFileType(): SnapshotError {
  return new SnapshotError('UNSAFE_FILE_TYPE', 'A whitelisted target is not a regular file')
}

function unstableFile(): SnapshotError {
  return new SnapshotError(
    'SNAPSHOT_CORRUPT',
    'A whitelisted file changed while it was being captured; retry when configuration files are idle',
  )
}

function safeFileSystemError(error: unknown, message: string): SnapshotError {
  if (error instanceof SnapshotError) return error
  if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return new SnapshotError(
      'SNAPSHOT_CORRUPT',
      'A whitelisted file could not be read; check file permissions and try again',
      { cause: error },
    )
  }
  return new SnapshotError('SNAPSHOT_CORRUPT', message, { cause: error })
}

function sizeLimit(scope: 'file' | 'snapshot'): SnapshotError {
  return new SnapshotError(
    'SIZE_LIMIT',
    scope === 'file'
      ? 'A whitelisted file exceeds the 10 MiB capture limit'
      : 'The snapshot exceeds the 30 MiB aggregate capture limit',
  )
}

function toDate(value: CaptureClock | undefined): Date {
  const selected = typeof value === 'function' ? value() : value
  const date =
    selected === undefined
      ? new Date()
      : selected instanceof Date
        ? new Date(selected.getTime())
        : new Date(selected)
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid capture clock')
  return date
}

function normalizeLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined
  if (typeof label !== 'string') throw new TypeError('Invalid snapshot label')
  const trimmed = label.trim()
  const limited = Array.from(trimmed).slice(0, 120).join('')
  return limited.length > 0 ? limited : undefined
}

/**
 * Reject static symlinks in the DSH Home → Profile directory chain. The
 * controller threat model intentionally excludes same-UID nanosecond parent
 * directory races; this check covers the persisted on-disk chain.
 */
async function assertProfileDirectoryChain(fs: FileSystem, dshHome: string, profilePath: string): Promise<void> {
  const base = resolve(dshHome)
  const target = resolve(profilePath)
  const remainder = relative(base, target)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || remainder.includes(sep + sep)) {
    throw new SnapshotError('UNSAFE_FILE_TYPE', 'The requested Profile path is outside the DSH Home')
  }

  const paths = [base]
  let current = base
  for (const part of remainder.split(sep).filter(Boolean)) {
    current = join(current, part)
    paths.push(current)
  }

  for (const path of paths) {
    let metadata: unknown
    try {
      metadata = await fs.lstat(path)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new SnapshotError('SNAPSHOT_NOT_FOUND', 'The requested Profile directory was not found', { cause: error })
      }
      throw safeFileSystemError(error, 'The requested Profile directory could not be inspected')
    }
    if (!isDirectory(metadata)) {
      throw new SnapshotError('UNSAFE_FILE_TYPE', 'The requested Profile directory chain is not safe')
    }
  }
}

async function readStableFile(fs: FileSystem, path: string): Promise<StableFile | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before: unknown
    try {
      before = await fs.lstat(path)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw safeFileSystemError(error, 'A whitelisted target could not be inspected')
    }

    if (!isRegularFile(before)) throw invalidFileType()
    const beforeSize = metadataSize(before)
    if (beforeSize === undefined) throw new SnapshotError('SNAPSHOT_CORRUPT', 'File metadata is invalid')
    if (beforeSize > MAX_FILE_BYTES) throw sizeLimit('file')

    let handle: FileHandle | undefined
    try {
      try {
        try {
          handle = await fs.open(path, READ_ONLY_FLAGS)
        } catch (error) {
          if (O_NOFOLLOW === 0 || !unsupportedNoFollowFlag(error)) throw error
          handle = await fs.open(path, fsConstants.O_RDONLY)
        }
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          if (attempt === 0) continue
          return undefined
        }
        throw safeFileSystemError(error, 'A whitelisted target could not be opened')
      }

      let opened: unknown
      try {
        opened = await handle.stat()
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          if (attempt === 0) continue
          return undefined
        }
        throw safeFileSystemError(error, 'A whitelisted target could not be inspected')
      }
      if (!isRegularFile(opened)) throw invalidFileType()
      const openedSize = metadataSize(opened)
      if (openedSize === undefined) throw new SnapshotError('SNAPSHOT_CORRUPT', 'File metadata is invalid')
      if (openedSize > MAX_FILE_BYTES) throw sizeLimit('file')
      if (metadataChanged(before, opened)) {
        if (attempt === 0) continue
        throw unstableFile()
      }

      let raw: Uint8Array
      try {
        raw = await handle.readFile()
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          if (attempt === 0) continue
          return undefined
        }
        throw safeFileSystemError(error, 'A whitelisted target could not be read')
      }
      const bytes = Buffer.from(raw)
      if (bytes.byteLength > MAX_FILE_BYTES) throw sizeLimit('file')

      let after: unknown
      try {
        after = await fs.lstat(path)
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          if (attempt === 0) continue
          return undefined
        }
        throw safeFileSystemError(error, 'A whitelisted target could not be rechecked')
      }

      if (!isRegularFile(after)) throw invalidFileType()
      const afterSize = metadataSize(after)
      if (afterSize === undefined) throw new SnapshotError('SNAPSHOT_CORRUPT', 'File metadata is invalid')
      if (afterSize > MAX_FILE_BYTES) throw sizeLimit('file')
      if (
        metadataChanged(before, after) ||
        metadataChanged(opened, after) ||
        bytes.byteLength !== openedSize ||
        bytes.byteLength !== afterSize
      ) {
        if (attempt === 0) continue
        throw unstableFile()
      }

      return { bytes, mode: metadataMode(after) }
    } finally {
      if (handle !== undefined) await handle.close()
    }
  }

  throw unstableFile()
}

export class CaptureService {
  readonly #dshHome: string
  readonly #repository: CaptureRepository
  readonly #fs: FileSystem
  readonly #now: CaptureClock | undefined
  readonly #pluginVersion: string
  readonly #dshVersion: string | undefined
  readonly #writerLock: WriterLockLike

  constructor(options: CaptureServiceOptions) {
    if (typeof options.pluginVersion !== 'string' || options.pluginVersion.length === 0) {
      throw new TypeError('Invalid plugin version')
    }
    this.#dshHome = options.dshHome
    this.#repository = options.repository
    this.#fs = options.fs ?? nodeFileSystem
    this.#now = options.now
    this.#pluginVersion = options.pluginVersion
    this.#dshVersion = options.dshVersion
    this.#writerLock = options.writerLock
  }

  capture(input: CaptureInput): Promise<CreateResult> {
    return this.#writerLock.runExclusive(() => this.captureUnlocked(input))
  }

  async captureUnlocked(input: CaptureInput): Promise<CreateResult> {
    const profile = validateProfile(input.profile)
    const kind = input.kind ?? 'normal'
    if (kind !== 'normal' && kind !== 'protection') throw new TypeError('Invalid snapshot kind')
    const label = normalizeLabel(input.label)
    const createdAt = toDate(this.#now).toISOString()
    const profilePath = profileRoot(this.#dshHome, profile)
    await assertProfileDirectoryChain(this.#fs, this.#dshHome, profilePath)
    const targets = resolveWhitelist(this.#dshHome, profile)
    const entries: ManifestEntry[] = []
    const payloads = new Map<LogicalPath, Buffer>()
    let totalBytes = 0

    for (const [index, logicalPath] of CANONICAL_LOGICAL_PATHS.entries()) {
      const path = targets.get(logicalPath)
      if (path === undefined) throw new SnapshotError('SNAPSHOT_CORRUPT', 'Whitelist policy is incomplete')
      const captured = await readStableFile(this.#fs, path)
      if (captured === undefined) {
        entries.push({ logicalPath, status: 'absent' })
        continue
      }

      totalBytes += captured.bytes.byteLength
      if (totalBytes > MAX_SNAPSHOT_BYTES) throw sizeLimit('snapshot')
      const storedName = `entry-${index}.bin`
      payloads.set(logicalPath, captured.bytes)
      entries.push({
        logicalPath,
        status: 'present',
        bytes: captured.bytes.byteLength,
        sha256: sha256(captured.bytes),
        storedName,
        mode: captured.mode,
      })
    }

    const manifest: Manifest = {
      schemaVersion: SCHEMA_VERSION,
      snapshotId: this.#repository.createId(),
      createdAt,
      profile,
      kind,
      pluginVersion: this.#pluginVersion,
      entries,
    }
    if (label !== undefined) manifest.label = label
    if (this.#dshVersion !== undefined) manifest.dshVersion = this.#dshVersion

    await this.#repository.publish(manifest, payloads)

    return {
      snapshotId: manifest.snapshotId,
      createdAt: manifest.createdAt,
      profile: manifest.profile,
      kind: manifest.kind,
      present: entries.filter((entry): entry is Extract<ManifestEntry, { status: 'present' }> => entry.status === 'present').map(
        (entry) => entry.logicalPath,
      ),
      absent: entries.filter((entry): entry is Extract<ManifestEntry, { status: 'absent' }> => entry.status === 'absent').map(
        (entry) => entry.logicalPath,
      ),
      warning: CAPTURE_WARNING,
    }
  }
}
