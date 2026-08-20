export type SnapshotErrorCode =
  | 'INVALID_PROFILE'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_CORRUPT'
  | 'UNSAFE_FILE_TYPE'
  | 'SIZE_LIMIT'
  | 'BUSY'
  | 'PROTECTION_FAILED'
  | 'RESTORE_FAILED_ROLLED_BACK'
  | 'RESTORE_FAILED_MANUAL_RECOVERY'

export interface SnapshotErrorDetails {
  cause?: unknown
  [key: string]: unknown
}

export interface PublicSnapshotError {
  code: SnapshotErrorCode
  message: string
}

/**
 * Stable model-facing error with optional diagnostics retained for operators.
 * Private details are deliberately not included in `toPublic()`.
 */
export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode
  readonly cause?: unknown
  readonly #details?: SnapshotErrorDetails

  constructor(code: SnapshotErrorCode, message: string, details?: SnapshotErrorDetails) {
    super(message)
    this.name = 'SnapshotError'
    this.code = code
    this.cause = details?.cause
    this.#details = details
  }

  toPublic(): PublicSnapshotError {
    return { code: this.code, message: this.message }
  }
}
