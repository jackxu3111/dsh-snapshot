import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { LogicalPath } from './types.ts'

export interface ResolveDshHomeOptions {
  explicitHome?: string
  env?: Readonly<Record<string, string | undefined>>
  userHome?: string
}

const SNAPSHOT_ID_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/
const WINDOWS_RESERVED_PROFILE_NAMES = new Set(['', '.', '..', 'node_modules'])

const HOME_TARGETS: ReadonlyArray<readonly [LogicalPath, string]> = [
  ['home/settings.yaml', 'settings.yaml'],
  ['home/cordis.patch.yml', 'cordis.patch.yml'],
]

const PROFILE_TARGETS: ReadonlyArray<readonly [LogicalPath, string]> = [
  ['profile/package.json', 'package.json'],
  ['profile/cordis.patch.yml', 'cordis.patch.yml'],
  ['profile/pnpm-lock.yaml', 'pnpm-lock.yaml'],
  ['profile/pnpm-workspace.yaml', 'pnpm-workspace.yaml'],
]

function isNonBlank(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

export function resolveDshHome(options: ResolveDshHomeOptions = {}): string {
  const { explicitHome, env = process.env, userHome = homedir() } = options

  if (isNonBlank(explicitHome)) return resolve(explicitHome)

  const configuredHome = env.DSH_HOME
  if (isNonBlank(configuredHome)) return resolve(configuredHome)

  return resolve(userHome, '.dsh')
}

export function validateProfile(profile: string): string {
  if (typeof profile !== 'string') throw new TypeError('Invalid profile')

  const withoutWindowsTrailingDotsOrSpaces = profile.replace(/[ .]+$/g, '')
  const windowsComparableProfile = withoutWindowsTrailingDotsOrSpaces.toLowerCase()

  if (
    profile.trim().length === 0 ||
    withoutWindowsTrailingDotsOrSpaces !== profile ||
    WINDOWS_RESERVED_PROFILE_NAMES.has(windowsComparableProfile) ||
    profile.includes('/') ||
    profile.includes('\\') ||
    profile.includes(':')
  ) {
    throw new TypeError('Invalid profile')
  }

  return profile
}

export function validateSnapshotId(snapshotId: string): string {
  if (typeof snapshotId !== 'string' || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new TypeError('Invalid snapshot id')
  }

  return snapshotId
}

export function snapshotRoot(dshHome: string): string {
  return resolve(dshHome, 'snapshots', 'dsh-snapshot', 'v1')
}

export function profileRoot(dshHome: string, profile: string): string {
  return resolve(dshHome, 'profiles', validateProfile(profile))
}

export function resolveWhitelist(dshHome: string, profile: string): ReadonlyMap<LogicalPath, string> {
  const root = resolve(dshHome)
  const profilePath = profileRoot(root, profile)
  const targets = new Map<LogicalPath, string>()

  for (const [logicalPath, filename] of HOME_TARGETS) {
    targets.set(logicalPath, join(root, filename))
  }
  for (const [logicalPath, filename] of PROFILE_TARGETS) {
    targets.set(logicalPath, join(profilePath, filename))
  }

  return targets
}

export function snapshotDirectory(dshHome: string, snapshotId: string): string {
  return resolve(snapshotRoot(dshHome), validateSnapshotId(snapshotId))
}
