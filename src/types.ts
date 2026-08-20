/** Version of the on-disk manifest format. */
export const SCHEMA_VERSION = 1 as const

/** Maximum size of one captured file. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024

/** Maximum aggregate size of one captured snapshot. */
export const MAX_SNAPSHOT_BYTES = 30 * 1024 * 1024

export type LogicalPath =
  | 'home/settings.yaml'
  | 'home/cordis.patch.yml'
  | 'profile/package.json'
  | 'profile/cordis.patch.yml'
  | 'profile/pnpm-lock.yaml'
  | 'profile/pnpm-workspace.yaml'

export type SnapshotKind = 'normal' | 'protection'

export interface PresentManifestEntry {
  logicalPath: LogicalPath
  status: 'present'
  bytes: number
  sha256: string
  storedName: string
  mode: number
}

export interface AbsentManifestEntry {
  logicalPath: LogicalPath
  status: 'absent'
}

export type ManifestEntry = PresentManifestEntry | AbsentManifestEntry

export interface Manifest {
  schemaVersion: typeof SCHEMA_VERSION
  snapshotId: string
  createdAt: string
  profile: string
  kind: SnapshotKind
  pluginVersion?: string
  label?: string
  dshVersion?: string
  entries: ManifestEntry[]
}

export type SnapshotAvailability = 'available' | 'corrupt'

export interface SnapshotSummary {
  snapshotId: string
  createdAt: string
  profile: string
  kind: SnapshotKind
  pluginVersion: string
  fileCount: number
  totalBytes: number
  status: SnapshotAvailability
  label?: string
}

export interface CreateResult {
  snapshotId: string
  createdAt: string
  profile: string
  kind: SnapshotKind
  present: LogicalPath[]
  absent: LogicalPath[]
  warning: string
}

export interface RestoreResult {
  snapshotId: string
  profile: string
  protectionSnapshotId: string
  restored: LogicalPath[]
  removed: LogicalPath[]
  restartRequired: boolean
  dependencyInstallCommand?: string
}

export interface ToolResult<T> {
  data: T
  text: string
}
