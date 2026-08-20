import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { LogicalPath, Manifest, ManifestEntry } from '../src/types.ts'
import type { FileSystem } from '../src/filesystem.ts'

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

export function faultInjectingFileSystem(
  base: FileSystem,
  options: { method: keyof FileSystem | 'write' | 'sync' | 'close'; failAtCall: number | readonly number[]; error: Error },
): { fs: FileSystem; calls: Array<{ method: keyof FileSystem | 'write' | 'sync' | 'close'; path?: string }> } {
  let matches = 0
  const calls: Array<{ method: keyof FileSystem | 'write' | 'sync' | 'close'; path?: string }> = []
  const record = (method: keyof FileSystem | 'write' | 'sync' | 'close', path?: string): void => {
    calls.push({ method, path })
    if (method === options.method && (Array.isArray(options.failAtCall) ? options.failAtCall.includes(++matches) : ++matches === options.failAtCall)) {
      throw options.error
    }
  }
  const fs = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof property !== 'string' || typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        const method = property as keyof FileSystem
        const path = typeof args[0] === 'string' ? args[0] : undefined
        record(method, path)
        const result = await Reflect.apply(value, target, args)
        if (method !== 'open') return result
        return new Proxy(result as object, {
          get(handle, handleProperty, handleReceiver) {
            const handleValue = Reflect.get(handle, handleProperty, handleReceiver)
            if (typeof handleProperty !== 'string' || typeof handleValue !== 'function') return handleValue
            return async (...handleArgs: unknown[]) => {
              const mapped = handleProperty === 'writeFile' ? 'write' : handleProperty
              if (mapped === 'write' || mapped === 'sync' || mapped === 'close') record(mapped, path)
              return Reflect.apply(handleValue, handle, handleArgs)
            }
          },
        })
      }
    },
  }) as FileSystem
  return { fs, calls }
}
