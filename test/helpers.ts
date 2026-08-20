import assert from 'node:assert/strict'
import { isAbsolute, relative, resolve, sep } from 'node:path'

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
