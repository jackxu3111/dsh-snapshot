import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('typecheck configuration includes source and test TypeScript files', async () => {
  const config = JSON.parse(await readFile(new URL('../tsconfig.json', import.meta.url), 'utf8')) as {
    include?: string[]
  }

  assert.ok(config.include?.some((pattern) => pattern === 'src/**/*.ts'))
  assert.ok(config.include?.some((pattern) => pattern === 'test/**/*.ts'))
})

test('build configuration emits only source files', async () => {
  const config = JSON.parse(
    await readFile(new URL('../tsconfig.build.json', import.meta.url), 'utf8'),
  ) as {
    include?: string[]
    compilerOptions?: { rootDir?: string }
  }

  assert.deepStrictEqual(config.include, ['src/**/*.ts'])
  assert.equal(config.compilerOptions?.rootDir, 'src')
})
