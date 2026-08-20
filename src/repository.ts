import { createHash, randomBytes } from 'node:crypto'
import { basename, isAbsolute, join } from 'node:path'

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
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      !Number.isNaN(date.getTime()) &&
      date.toISOString() === value,
  )
}

function assertSafeStoredName(value: unknown): asserts value is string {
  assertManifest(typeof value === 'string')
  assertManifest(
    value !== '.' &&
      value !== '..' &&
      !isAbsolute(value) &&
      basename(value) === value &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !/[ .]$/.test(value) &&
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
  const date = selected === undefined ? new Date() : new Date(selected)
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
    return [...payloads.entries()].map(([key, value]) => [key, toBuffer(value)])
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
    const manifestPath = join(snapshotDirectory(this.#dshHome, snapshotId), 'manifest.json')
    let raw: string | Buffer
    try {
      raw = await this.#fs.readFile(manifestPath, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new SnapshotError('SNAPSHOT_NOT_FOUND', 'Snapshot manifest was not found', { cause: error })
      }
      throw new SnapshotError('SNAPSHOT_CORRUPT', 'Snapshot manifest could not be read', { cause: error })
    }

    let value: unknown
    try {
      value = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
    } catch (error) {
      throw invalidManifest(error)
    }
    return validateManifest(value, snapshotId)
  }

  async publish(_manifest: Manifest, _payloads: SnapshotPayloads): Promise<void> {
    throw new Error('Not implemented')
  }

  async preflight(_snapshotId: string): Promise<Manifest> {
    throw new Error('Not implemented')
  }

  async list(_profile?: string): Promise<SnapshotSummary[]> {
    throw new Error('Not implemented')
  }
}
