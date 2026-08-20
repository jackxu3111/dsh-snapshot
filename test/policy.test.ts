import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'

import {
  profileRoot,
  resolveDshHome,
  resolveWhitelist,
  snapshotDirectory,
  snapshotRoot,
  validateProfile,
  validateSnapshotId,
} from '../src/policy.ts'
import type { LogicalPath } from '../src/types.ts'
import { assertPathContained } from './helpers.ts'

const userHome = '/tmp/dsh-user'
const dshHome = '/tmp/dsh-home'
const profile = 'work'
const snapshotId = '20260820T104530123Z-a1b2c3'

test('explicit home takes precedence over DSH_HOME and the user home', () => {
  assert.equal(
    resolveDshHome({
      explicitHome: '/tmp/explicit-dsh-home',
      env: { DSH_HOME: '/tmp/environment-dsh-home' },
      userHome,
    }),
    resolve('/tmp/explicit-dsh-home'),
  )
})

test('non-blank DSH_HOME takes precedence over the user home', () => {
  assert.equal(
    resolveDshHome({ env: { DSH_HOME: '/tmp/environment-dsh-home' }, userHome }),
    resolve('/tmp/environment-dsh-home'),
  )
})

test('blank DSH_HOME falls back to the user home .dsh directory', () => {
  const blankValues = ['', ' ', '\t', '\n', ' \t\n ']

  for (const value of blankValues) {
    assert.equal(resolveDshHome({ env: { DSH_HOME: value }, userHome }), resolve(userHome, '.dsh'))
  }
})

test('blank explicit home is treated as unset', () => {
  assert.equal(
    resolveDshHome({
      explicitHome: ' \t',
      env: { DSH_HOME: '/tmp/environment-dsh-home' },
      userHome,
    }),
    resolve('/tmp/environment-dsh-home'),
  )
})

test('profile validation accepts portable profile names and returns the name', () => {
  for (const value of ['default', 'work_1', 'profile-name']) {
    assert.equal(validateProfile(value), value)
  }
})

test('profile validation rejects blank, reserved, and separated names', () => {
  const invalidProfiles = ['', ' ', '\t', '.', '..', 'node_modules', 'a/b', 'a\\b']

  for (const value of invalidProfiles) {
    assert.throws(() => validateProfile(value), /invalid profile/i, value)
  }
})

test('snapshot ID validation accepts the fixed timestamp and suffix format', () => {
  for (const value of [snapshotId, '19700101T000000000Z-000000']) {
    assert.equal(validateSnapshotId(value), value)
  }
})

test('snapshot ID validation rejects traversal and malformed IDs', () => {
  const invalidIds = [
    '../outside',
    '..\\outside',
    `${snapshotId}/..`,
    `${snapshotId}\\..`,
    '20260820T104530123Z-A1B2C3',
    '20260820T104530123Z-a1b2c',
  ]

  for (const value of invalidIds) {
    assert.throws(() => validateSnapshotId(value), /invalid snapshot id/i, value)
  }
})

test('snapshot and profile roots are derived beneath the DSH home', () => {
  assert.equal(snapshotRoot(dshHome), resolve(dshHome, 'snapshots', 'dsh-snapshot', 'v1'))
  assert.equal(profileRoot(dshHome, profile), resolve(dshHome, 'profiles', profile))
  assert.equal(snapshotDirectory(dshHome, snapshotId), resolve(snapshotRoot(dshHome), snapshotId))

  assertPathContained(dshHome, snapshotRoot(dshHome))
  assertPathContained(dshHome, profileRoot(dshHome, profile))
  assertPathContained(snapshotRoot(dshHome), snapshotDirectory(dshHome, snapshotId))
})

test('path builders reject POSIX and Windows traversal strings before joining', () => {
  for (const traversal of ['../outside', '..\\outside', '/outside', '\\outside', 'C:outside']) {
    assert.throws(() => profileRoot(dshHome, traversal), /invalid profile/i, traversal)
    assert.throws(() => snapshotDirectory(dshHome, traversal), /invalid snapshot id/i, traversal)
    assert.throws(() => resolveWhitelist(dshHome, traversal), /invalid profile/i, traversal)
  }
})

test('whitelist contains exactly the six fixed logical paths and targets', () => {
  const whitelist = resolveWhitelist(dshHome, profile)
  const expected: ReadonlyArray<readonly [LogicalPath, string]> = [
    ['home/settings.yaml', resolve(dshHome, 'settings.yaml')],
    ['home/cordis.patch.yml', resolve(dshHome, 'cordis.patch.yml')],
    ['profile/package.json', resolve(dshHome, 'profiles', profile, 'package.json')],
    ['profile/cordis.patch.yml', resolve(dshHome, 'profiles', profile, 'cordis.patch.yml')],
    ['profile/pnpm-lock.yaml', resolve(dshHome, 'profiles', profile, 'pnpm-lock.yaml')],
    ['profile/pnpm-workspace.yaml', resolve(dshHome, 'profiles', profile, 'pnpm-workspace.yaml')],
  ]

  assert.equal(whitelist.size, 6)
  assert.deepEqual([...whitelist.entries()], expected)
})
