import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { LogicalPath, Manifest, ManifestEntry } from '../src/types.ts'

export function assertPathContained(root: string, candidate: string): void {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  const relativePath = relative(rootPath, candidatePath)

  assert.equal(
    relativePath === '' ||
      (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)),
    true,
    `${candidatePath} must remain within ${rootPath}`,
  )
}

export const allLogicalPaths: readonly LogicalPath[] = [
  'home/settings.yaml',
  'home/cordis.patch.yml',
  'profile/package.json',
  'profile/cordis.patch.yml',
  'profile/pnpm-lock.yaml',
  'profile/pnpm-workspace.yaml',
]

export function fixtureManifest(
  snapshotId: string,
  entries: ManifestEntry[],
  overrides: Partial<Omit<Manifest, 'entries' | 'snapshotId'>> = {},
): Manifest {
  return {
    schemaVersion: 1,
    snapshotId,
    createdAt: '2026-08-20T10:45:30.123Z',
    profile: 'work',
    kind: 'normal',
    pluginVersion: '0.1.0',
    entries,
    ...overrides,
  }
}

export async function temporaryDshHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-snapshot-capture-'))
}

export async function withTemporaryDshHome<T>(operation: (home: string) => Promise<T>): Promise<T> {
  const home = await temporaryDshHome()
  try {
    return await operation(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

export function immediateWriterLock(): { calls: number; runExclusive<T>(operation: () => Promise<T>): Promise<T> } {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      calls += 1
      return operation()
    },
  }
}
