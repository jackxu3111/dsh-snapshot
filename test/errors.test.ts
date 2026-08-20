import assert from 'node:assert/strict'
import test from 'node:test'

import { SnapshotError } from '../src/errors.ts'
import type { SnapshotErrorCode } from '../src/errors.ts'

const allErrorCodes = [
  'INVALID_PROFILE',
  'SNAPSHOT_NOT_FOUND',
  'SNAPSHOT_CORRUPT',
  'UNSAFE_FILE_TYPE',
  'SIZE_LIMIT',
  'BUSY',
  'PROTECTION_FAILED',
  'RESTORE_FAILED_ROLLED_BACK',
  'RESTORE_FAILED_MANUAL_RECOVERY',
] as const satisfies readonly SnapshotErrorCode[]

test('toPublic exposes only the stable error code and message', () => {
  const cause = new Error('private cause')
  const error = new SnapshotError('BUSY', 'Writer lock is held', {
    cause,
    privatePath: '/secret',
  })

  assert.deepStrictEqual(error.toPublic(), {
    code: 'BUSY',
    message: 'Writer lock is held',
  })
  assert.equal(error.cause, cause)
  assert.equal('privatePath' in error.toPublic(), false)
})

test('JSON serialization excludes private diagnostics', () => {
  const error = new SnapshotError('BUSY', 'Writer lock is held', {
    cause: 'private-cause',
    privatePath: '/secret',
  })

  const serialized = JSON.stringify(error)

  assert.equal(serialized.includes('private-cause'), false)
  assert.equal(serialized.includes('privatePath'), false)
  assert.equal(serialized.includes('"cause"'), false)
  assert.equal(error.diagnostics?.cause, 'private-cause')
  assert.equal(error.diagnostics?.privatePath, '/secret')
})

test('SnapshotError accepts every stable error code', () => {
  assert.equal(allErrorCodes.length, 9)

  for (const code of allErrorCodes) {
    assert.equal(new SnapshotError(code, 'message').code, code)
  }
})
