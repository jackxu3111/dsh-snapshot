import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

import { SnapshotError } from './errors.ts'
import { nodeFileSystem } from './filesystem.ts'
import type { FileSystem } from './filesystem.ts'
import {
  snapshotDirectory,
  snapshotRoot,
  validateProfile,
  validateSnapshotId,
} from './policy.ts'
import {
  MAX_FILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  SCHEMA_VERSION,
} from './types.ts'
import type {
  LogicalPath,
  Manifest,
  ManifestEntry,
  PresentManifestEntry,
  SnapshotSummary,
} from './types.ts'
import type { FileHandle } from './filesystem.ts'

const LOGICAL_PATHS: readonly LogicalPath[] = [
  'home/settings.yaml',
  'home/cordis.patch.yml',
  'profile/package.json',
  'profile/cordis.patch.yml',
  'profile/pnpm-lock.yaml',
  'profile/pnpm-workspace.yaml',
]

const LOGICAL_PATH_SET = new Set<string>(LOGICAL_PATHS)
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const STORED_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SNAPSHOT_DIRECTORY_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/
const PRESENT_ENTRY_KEYS = ['logicalPath', 'status', 'bytes', 'sha256', 'storedName', 'mode'] as const
const ABSENT_ENTRY_KEYS = ['logicalPath', 'status'] as const
const MANIFEST_REQUIRED_KEYS = [
  'schemaVersion',
  'snapshotId',
  'createdAt',
  'profile',
  'kind',
  'pluginVersion',
  'entries',
] as const
const MANIFEST_OPTIONAL_KEYS = ['label', 'dshVersion'] as const
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
const READ_ONLY_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW

type PrimitiveDate = Date | string | number

export interface SnapshotRepositoryOptions {
  dshHome: string
  fs?: FileSystem
  now?: PrimitiveDate | (() => PrimitiveDate)
  randomHex?: string | (() => string)
}

export type SnapshotPayload = Uint8Array
export type SnapshotPayloads =
  | ReadonlyMap<string, SnapshotPayload>
  | Readonly<Record<string, SnapshotPayload>>
  | ReadonlyArray<readonly [string, SnapshotPayload]>

interface NodeErrorLike {
  code?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeErrorLike {
  return typeof value === 'object' && value !== null && 'code' in value
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown field ${key}`)
  }
  for (const key of required) {
    if (!hasOwn(value, key)) throw new Error(`missing field ${key}`)
  }
}

function invalidManifest(cause?: unknown): SnapshotError {
  return new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot manifest is invalid', { cause })
}

function assertManifest(condition: boolean, cause?: unknown): asserts condition {
  if (!condition) throw invalidManifest(cause)
}

function assertCanonicalTimestamp(value: unknown): asserts value is string {
  assertManifest(typeof value === 'string')
  const date = new Date(value)
  assertManifest(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
      !Number.isNaN(date.getTime()) &&
      (date.toISOString() === value || date.toISOString().replace('.000Z', 'Z') === value),
  )
}

function assertSafeStoredName(value: unknown): asserts value is string {
  assertManifest(typeof value === 'string')
  const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^.]*)?$/i
  assertManifest(
    value !== '.' &&
      value !== '..' &&
      !isAbsolute(value) &&
      basename(value) === value &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !/[ .]$/.test(value) &&
      !windowsReservedName.test(value) &&
      STORED_NAME_PATTERN.test(value),
  )
}

function parsePresentEntry(value: Record<string, unknown>): PresentManifestEntry {
  assertExactKeys(value, PRESENT_ENTRY_KEYS)
  assertManifest(value.status === 'present')
  assertManifest(typeof value.logicalPath === 'string' && LOGICAL_PATH_SET.has(value.logicalPath))
  assertManifest(
    typeof value.bytes === 'number' &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0 &&
      value.bytes <= MAX_FILE_BYTES,
  )
  assertManifest(typeof value.sha256 === 'string' && SHA256_PATTERN.test(value.sha256))
  assertSafeStoredName(value.storedName)
  assertManifest(
    typeof value.mode === 'number' &&
      Number.isInteger(value.mode) &&
      value.mode >= 0 &&
      value.mode <= 0o777,
  )

  return {
    logicalPath: value.logicalPath as LogicalPath,
    status: 'present',
    bytes: value.bytes,
    sha256: value.sha256,
    storedName: value.storedName,
    mode: value.mode,
  }
}

function parseEntry(value: unknown): ManifestEntry {
  assertManifest(isRecord(value))
  assertManifest(typeof value.logicalPath === 'string' && LOGICAL_PATH_SET.has(value.logicalPath))

  if (value.status === 'absent') {
    assertExactKeys(value, ABSENT_ENTRY_KEYS)
    return { logicalPath: value.logicalPath as LogicalPath, status: 'absent' }
  }

  return parsePresentEntry(value)
}

/**
 * Parse and validate an on-disk manifest. Unknown data is rejected so a
 * future or hand-edited manifest cannot silently change restore semantics.
 */
export function validateManifest(value: unknown, expectedSnapshotId?: string): Manifest {
  try {
    assertManifest(isRecord(value))
    assertExactKeys(value, MANIFEST_REQUIRED_KEYS, MANIFEST_OPTIONAL_KEYS)
    assertManifest(value.schemaVersion === SCHEMA_VERSION)
    assertManifest(typeof value.snapshotId === 'string')
    validateSnapshotId(value.snapshotId)
    if (expectedSnapshotId !== undefined) {
      assertManifest(value.snapshotId === expectedSnapshotId)
    }
    assertCanonicalTimestamp(value.createdAt)
    assertManifest(typeof value.profile === 'string')
    validateProfile(value.profile)
    assertManifest(value.kind === 'normal' || value.kind === 'protection')
    assertManifest(typeof value.pluginVersion === 'string' && value.pluginVersion.length > 0)
    if (hasOwn(value, 'label')) assertManifest(typeof value.label === 'string')
    if (hasOwn(value, 'dshVersion')) assertManifest(typeof value.dshVersion === 'string')
    assertManifest(Array.isArray(value.entries) && value.entries.length === LOGICAL_PATHS.length)

    const entries: ManifestEntry[] = []
    const seenLogicalPaths = new Set<LogicalPath>()
    const seenStoredNames = new Set<string>()
    let totalBytes = 0

    for (const rawEntry of value.entries) {
      const entry = parseEntry(rawEntry)
      assertManifest(!seenLogicalPaths.has(entry.logicalPath))
      seenLogicalPaths.add(entry.logicalPath)

      if (entry.status === 'present') {
        assertManifest(!seenStoredNames.has(entry.storedName))
        seenStoredNames.add(entry.storedName)
        totalBytes += entry.bytes
        assertManifest(totalBytes <= MAX_SNAPSHOT_BYTES)
      }

      entries.push(entry)
    }

    assertManifest(seenLogicalPaths.size === LOGICAL_PATHS.length)
    for (const logicalPath of LOGICAL_PATHS) assertManifest(seenLogicalPaths.has(logicalPath))

    const manifest: Manifest = {
      schemaVersion: SCHEMA_VERSION,
      snapshotId: value.snapshotId,
      createdAt: value.createdAt,
      profile: value.profile,
      kind: value.kind,
      pluginVersion: value.pluginVersion,
      entries,
    }
    if (hasOwn(value, 'label')) manifest.label = value.label as string
    if (hasOwn(value, 'dshVersion')) manifest.dshVersion = value.dshVersion as string
    return manifest
  } catch (error) {
    if (error instanceof SnapshotError) throw error
    throw invalidManifest(error)
  }
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function toDate(value: PrimitiveDate | (() => PrimitiveDate) | undefined): Date {
  const selected = typeof value === 'function' ? value() : value
  const date =
    selected === undefined
      ? new Date()
      : selected instanceof Date
        ? new Date(selected.getTime())
        : new Date(selected)
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid repository clock')
  return date
}

function formatSnapshotTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '')
}

function selectRandomHex(value: string | (() => string) | undefined): string {
  const selected = typeof value === 'function' ? value() : value
  const random = selected ?? randomBytes(3).toString('hex')
  if (!/^[0-9a-f]{6}$/.test(random)) throw new TypeError('Invalid random suffix')
  return random
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new TypeError('Payload must be bytes')
}

function payloadEntries(payloads: SnapshotPayloads): Array<readonly [string, Buffer]> {
  if (payloads instanceof Map) {
    return [...payloads.entries()].map(([key, value]) => [key, toBuffer(value)] as const)
  }
  if (Array.isArray(payloads)) {
    return payloads.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
        throw new TypeError('Invalid payload collection')
      }
      return [entry[0], toBuffer(entry[1])] as const
    })
  }
  if (isRecord(payloads)) {
    return Object.entries(payloads).map(([key, value]) => [key, toBuffer(value)] as const)
  }
  throw new TypeError('Invalid payload collection')
}

function isRegularFile(stat: unknown): boolean {
  if (!isRecord(stat)) return false
  if (typeof stat.isFile === 'function') {
    try {
      return stat.isFile() as boolean
    } catch {
      return false
    }
  }
  return typeof stat.mode === 'number' && (stat.mode & 0o170000) === 0o100000
}

function payloadMismatch(cause?: unknown): SnapshotError {
  return new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot payloads do not match the manifest', { cause })
}

function payloadPath(snapshotPath: string, entry: PresentManifestEntry): string {
  return join(snapshotPath, 'files', entry.storedName)
}

function unsupportedNoFollowFlag(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EINVAL' || error.code === 'ENOTSUP' || error.code === 'EOPNOTSUPP')
}

function directoryChainError(cause?: unknown): SnapshotError {
  return new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot directory is not safe', { cause })
}

function directoryNotFound(cause?: unknown): SnapshotError {
  return new SnapshotError('SNAPSHOT_NOT_FOUND', 'Snapshot directory was not found', { cause })
}

/**
 * Validate every existing component of a controlled snapshot directory. lstat
 * is intentional: a symlink in the chain must never be followed by a later
 * read or readdir call. Missing tail components are allowed only while the
 * publisher is creating the root.
 */
async function ensureDirectoryChain(
  fs: FileSystem,
  base: string,
  target: string,
  allowMissingTail = false,
): Promise<void> {
  const baseAbsolute = resolve(base)
  const absolute = resolve(target)
  const remainder = relative(baseAbsolute, absolute)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw directoryChainError()
  }
  const parts = remainder.split(sep).filter(Boolean)
  const paths = [baseAbsolute]
  let current = baseAbsolute
  for (const part of parts) {
    current = join(current, part)
    paths.push(current)
  }

  for (const path of paths) {
    let metadata: unknown
    try {
      metadata = await fs.lstat(path)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        if (allowMissingTail) return
        throw directoryNotFound(error)
      }
      throw directoryChainError(error)
    }
    if (!isDirectory(metadata)) throw directoryChainError()
  }
}

function differentFile(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false
  const leftDevice = left.dev
  const rightDevice = right.dev
  const leftInode = left.ino
  const rightInode = right.ino
  return (
    typeof leftDevice === 'number' &&
    typeof rightDevice === 'number' &&
    typeof leftInode === 'number' &&
    typeof rightInode === 'number' &&
    (leftDevice !== rightDevice || leftInode !== rightInode)
  )
}

/**
 * Read from an already-open regular file. The initial and post-open lstat
 * checks protect platforms without O_NOFOLLOW; once the handle is open, a
 * later path swap cannot redirect the bytes returned by handle.readFile().
 */
async function readOpenedRegularFile(
  fs: FileSystem,
  path: string,
  missingCode: 'SNAPSHOT_NOT_FOUND' | 'SNAPSHOT_CORRUPT',
  message: string,
): Promise<Buffer> {
  let handle: FileHandle | undefined
  try {
    const beforeOpen = await fs.lstat(path)
    if (!isRegularFile(beforeOpen)) throw new SnapshotError('SNAPSHOT_CORRUPT', message)

    try {
      handle = await fs.open(path, READ_ONLY_FLAGS)
    } catch (error) {
      if (O_NOFOLLOW === 0 || !unsupportedNoFollowFlag(error)) throw error
      handle = await fs.open(path, fsConstants.O_RDONLY)
    }

    const openedMetadata = await handle.stat()
    if (!isRegularFile(openedMetadata)) throw new SnapshotError('SNAPSHOT_CORRUPT', message)
    const afterOpen = await fs.lstat(path)
    if (
      !isRegularFile(afterOpen) ||
      differentFile(beforeOpen, openedMetadata) ||
      differentFile(openedMetadata, afterOpen)
    ) {
      throw new SnapshotError('SNAPSHOT_CORRUPT', message)
    }

    const raw = await handle.readFile()
    return Buffer.from(raw)
  } catch (error) {
    if (error instanceof SnapshotError) throw error
    if (missingCode === 'SNAPSHOT_NOT_FOUND' && isNodeError(error) && error.code === 'ENOENT') {
      throw new SnapshotError('SNAPSHOT_NOT_FOUND', message, { cause: error })
    }
    throw new SnapshotError('SNAPSHOT_CORRUPT', message, { cause: error })
  } finally {
    if (handle !== undefined) await handle.close()
  }
}

export class SnapshotRepository {
  readonly #dshHome: string
  readonly #fs: FileSystem
  readonly #now: SnapshotRepositoryOptions['now']
  readonly #randomHex: SnapshotRepositoryOptions['randomHex']

  constructor(options: SnapshotRepositoryOptions) {
    this.#dshHome = options.dshHome
    this.#fs = options.fs ?? nodeFileSystem
    this.#now = options.now
    this.#randomHex = options.randomHex
  }

  createId(): string {
    return `${formatSnapshotTimestamp(toDate(this.#now))}-${selectRandomHex(this.#randomHex)}`
  }

  async readManifest(snapshotId: string): Promise<Manifest> {
    validateSnapshotId(snapshotId)
    const directory = snapshotDirectory(this.#dshHome, snapshotId)
    await ensureDirectoryChain(this.#fs, this.#dshHome, snapshotRoot(this.#dshHome))
    await ensureDirectoryChain(this.#fs, this.#dshHome, directory)
    const manifestPath = join(directory, 'manifest.json')
    const raw = await readOpenedRegularFile(
      this.#fs,
      manifestPath,
      'SNAPSHOT_NOT_FOUND',
      'Snapshot manifest could not be read',
    )

    let value: unknown
    try {
      value = JSON.parse(raw.toString('utf8'))
    } catch (error) {
      throw invalidManifest(error)
    }
    return validateManifest(value, snapshotId)
  }

  async publish(manifestValue: Manifest, payloadCollection: SnapshotPayloads): Promise<void> {
    let manifest: Manifest
    try {
      manifest = validateManifest(manifestValue)
    } catch (error) {
      if (error instanceof SnapshotError) throw error
      throw payloadMismatch(error)
    }

    const presentEntries = manifest.entries.filter(
      (entry): entry is PresentManifestEntry => entry.status === 'present',
    )
    const payloadByLogicalPath = new Map<LogicalPath, Buffer>()
    try {
      const entriesByLogicalPath = new Map<string, ManifestEntry>(
        manifest.entries.map((entry) => [entry.logicalPath, entry]),
      )
      const entriesByStoredName = new Map(presentEntries.map((entry) => [entry.storedName, entry]))

      for (const [key, payload] of payloadEntries(payloadCollection)) {
        const logicalEntry = entriesByLogicalPath.get(key)
        const storedEntry = entriesByStoredName.get(key)
        const entry = logicalEntry ?? storedEntry
        if (!entry || entry.status !== 'present' || (logicalEntry && storedEntry && logicalEntry !== storedEntry)) {
          throw payloadMismatch()
        }
        if (payloadByLogicalPath.has(entry.logicalPath)) throw payloadMismatch()
        if (payload.byteLength !== entry.bytes || sha256(payload) !== entry.sha256) {
          throw payloadMismatch()
        }
        payloadByLogicalPath.set(entry.logicalPath, payload)
      }

      if (payloadByLogicalPath.size !== presentEntries.length) throw payloadMismatch()
    } catch (error) {
      if (error instanceof SnapshotError) throw error
      throw payloadMismatch(error)
    }

    const root = snapshotRoot(this.#dshHome)
    const finalDirectory = snapshotDirectory(this.#dshHome, manifest.snapshotId)
    let temporaryDirectory: string | undefined
    let temporaryDirectoryCreated = false

    try {
      await ensureDirectoryChain(this.#fs, this.#dshHome, root, true)
      await this.#fs.mkdir(root, { recursive: true, mode: 0o700 })
      await this.#fs.chmod(root, 0o700)
      await ensureDirectoryChain(this.#fs, this.#dshHome, root)
      try {
        await this.#fs.lstat(finalDirectory)
        throw new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot id already exists')
      } catch (error) {
        if (error instanceof SnapshotError) throw error
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot destination is unavailable', { cause: error })
        }
      }

      temporaryDirectory = join(root, `.tmp-${selectRandomHex(this.#randomHex)}`)
      await this.#fs.mkdir(temporaryDirectory, { mode: 0o700 })
      temporaryDirectoryCreated = true
      await this.#fs.chmod(temporaryDirectory, 0o700)
      const filesDirectory = join(temporaryDirectory, 'files')
      await this.#fs.mkdir(filesDirectory, { mode: 0o700 })
      await this.#fs.chmod(filesDirectory, 0o700)

      for (const entry of presentEntries) {
        const target = payloadPath(temporaryDirectory, entry)
        await this.#fs.writeFile(target, payloadByLogicalPath.get(entry.logicalPath) as Buffer, {
          flag: 'wx',
          mode: 0o600,
        })
        await this.#fs.chmod(target, 0o600)
        await this.syncFile(target)
      }

      const manifestPath = join(temporaryDirectory, 'manifest.json')
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')
      await this.#fs.writeFile(manifestPath, manifestBytes, { flag: 'wx', mode: 0o600 })
      await this.#fs.chmod(manifestPath, 0o600)
      await this.syncFile(manifestPath)

      await this.#fs.rename(temporaryDirectory, finalDirectory)
      temporaryDirectory = undefined
    } catch (error) {
      if (temporaryDirectory !== undefined && temporaryDirectoryCreated) {
        try {
          await this.#fs.rm(temporaryDirectory, { recursive: true, force: true })
        } catch {
          // Preserve the publication error. Operators can inspect the private cause.
        }
      }
      if (error instanceof SnapshotError) throw error
      throw new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot publication failed', { cause: error })
    }
  }

  async preflight(snapshotId: string): Promise<Manifest> {
    const manifest = await this.readManifest(snapshotId)
    const directory = snapshotDirectory(this.#dshHome, snapshotId)
    try {
      await ensureDirectoryChain(this.#fs, this.#dshHome, join(directory, 'files'))
    } catch (error) {
      throw payloadMismatch(error)
    }

    for (const entry of manifest.entries) {
      if (entry.status !== 'present') continue
      const target = payloadPath(directory, entry)
      try {
        const bytes = await readOpenedRegularFile(
          this.#fs,
          target,
          'SNAPSHOT_CORRUPT',
          'Snapshot payload could not be read',
        )
        if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw payloadMismatch()
      } catch (error) {
        if (error instanceof SnapshotError && error.code === 'SNAPSHOT_CORRUPT') throw payloadMismatch(error)
        throw payloadMismatch(error)
      }
    }

    return manifest
  }

  async list(_profile?: string): Promise<SnapshotSummary[]> {
    const profile = _profile === undefined ? undefined : validateProfile(_profile)
    const root = snapshotRoot(this.#dshHome)
    try {
      await ensureDirectoryChain(this.#fs, this.#dshHome, root)
    } catch (error) {
      if (error instanceof SnapshotError && error.code === 'SNAPSHOT_NOT_FOUND') return []
      throw error
    }

    let rawEntries: unknown[]
    try {
      rawEntries = (await this.#fs.readdir(root, { withFileTypes: true })) as unknown[]
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return []
      throw new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot directory could not be listed', { cause: error })
    }

    const summaries: SnapshotSummary[] = []
    for (const rawEntry of rawEntries) {
      const name = entryName(rawEntry)
      if (name === undefined || name.startsWith('.tmp-') || !SNAPSHOT_DIRECTORY_PATTERN.test(name)) continue
      if (entryIsSymbolicLink(rawEntry)) {
        if (profile === undefined) summaries.push(corruptSummary(name))
        continue
      }
      if (!entryMayBeDirectory(rawEntry)) continue

      const directory = snapshotDirectory(this.#dshHome, name)
      try {
        await ensureDirectoryChain(this.#fs, this.#dshHome, directory)
      } catch {
        if (profile === undefined) summaries.push(corruptSummary(name))
        continue
      }

      let manifest: Manifest
      try {
        manifest = await this.readManifest(name)
      } catch {
        if (profile !== undefined) continue
        summaries.push(corruptSummary(name))
        continue
      }

      if (profile !== undefined && manifest.profile !== profile) continue
      let available = true
      try {
        await ensureDirectoryChain(this.#fs, this.#dshHome, join(directory, 'files'))
      } catch {
        available = false
      }
      for (const entry of manifest.entries) {
        if (!available || entry.status !== 'present') continue
        try {
          const metadata = await this.#fs.lstat(payloadPath(directory, entry))
          if (!isRegularFile(metadata) || !isRecord(metadata) || metadata.size !== entry.bytes) {
            available = false
            break
          }
        } catch {
          available = false
          break
        }
      }

      const presentEntries = manifest.entries.filter(
        (entry): entry is PresentManifestEntry => entry.status === 'present',
      )
      const summary: SnapshotSummary = {
        snapshotId: manifest.snapshotId,
        createdAt: manifest.createdAt,
        profile: manifest.profile,
        kind: manifest.kind,
        pluginVersion: manifest.pluginVersion,
        fileCount: presentEntries.length,
        totalBytes: presentEntries.reduce((total, entry) => total + entry.bytes, 0),
        status: available ? 'available' : 'corrupt',
      }
      if (manifest.label !== undefined) summary.label = manifest.label
      summaries.push(summary)
    }

    summaries.sort(compareSummaries)
    return summaries
  }

  private async syncFile(path: string): Promise<void> {
    const handle = await this.#fs.open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

function entryName(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.name === 'string') return value.name
  return undefined
}

function entryMayBeDirectory(value: unknown): boolean {
  if (!isRecord(value) || typeof value.isDirectory !== 'function') return true
  try {
    return value.isDirectory() as boolean
  } catch {
    return false
  }
}

function entryIsSymbolicLink(value: unknown): boolean {
  if (!isRecord(value) || typeof value.isSymbolicLink !== 'function') return false
  try {
    return value.isSymbolicLink() as boolean
  } catch {
    return true
  }
}

function isDirectory(stat: unknown): boolean {
  if (!isRecord(stat)) return false
  if (typeof stat.isDirectory === 'function') {
    try {
      return stat.isDirectory() as boolean
    } catch {
      return false
    }
  }
  return typeof stat.mode === 'number' && (stat.mode & 0o170000) === 0o040000
}

function corruptSummary(snapshotId: string): SnapshotSummary {
  return {
    snapshotId,
    createdAt: '',
    profile: '',
    kind: 'normal',
    pluginVersion: '',
    fileCount: 0,
    totalBytes: 0,
    status: 'corrupt',
  }
}

function compareSummaries(left: SnapshotSummary, right: SnapshotSummary): number {
  if (left.status !== right.status) return left.status === 'available' ? -1 : 1
  if (left.status === 'available') {
    const byCreatedAt = right.createdAt.localeCompare(left.createdAt)
    if (byCreatedAt !== 0) return byCreatedAt
  }
  return left.snapshotId.localeCompare(right.snapshotId)
}
