import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { join } from 'node:path'

import { HarnessError } from '@deepseek-ai/dsh-llm'

import * as pluginModule from '../src/index.ts'
import {
  apply,
  createServices,
  registerSnapshotTools,
  type RegisteredTool,
  type SnapshotServices,
} from '../src/index.ts'
import { snapshotDirectory, snapshotRoot } from '../src/policy.ts'
import type { SnapshotSummary } from '../src/types.ts'
import { withTemporaryDshHome } from './helpers.ts'

interface ToolRegistryFixture {
  tools: RegisteredTool[]
  register(definition: RegisteredTool): () => void
}

function fakeRegistry(): ToolRegistryFixture {
  const tools: RegisteredTool[] = []
  return {
    tools,
    register(definition) {
      tools.push(definition)
      return () => undefined
    },
  }
}

function executionStub(): never {
  throw new Error('execution context must not be consulted by snapshot tools')
}

async function seedProfile(home: string): Promise<void> {
  const profile = join(home, 'profiles', 'work')
  await mkdir(profile, { recursive: true })
  await writeFile(join(home, 'settings.yaml'), 'private setting body\n')
  await writeFile(join(profile, 'package.json'), '{"name":"work","version":"1.0.0"}\n')
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
}

function registeredTools(services: SnapshotServices): ToolRegistryFixture {
  const registry = fakeRegistry()
  registerSnapshotTools(registry, services)
  return registry
}

test('registers exactly three named tools with strict input and output schemas', () => {
  const registry = fakeRegistry()
  apply({ tools: registry })

  assert.equal(Object.hasOwn(pluginModule, 'default'), false)
  assert.deepEqual(registry.tools.map((tool) => tool.name), [
    'snapshot_create',
    'snapshot_list',
    'snapshot_restore',
  ])

  const create = registry.tools[0]
  const list = registry.tools[1]
  const restore = registry.tools[2]
  assert.ok(create)
  assert.ok(list)
  assert.ok(restore)

  assert.deepEqual(create.parameters.required, ['profile'])
  assert.deepEqual(Object.keys(create.parameters.properties), ['profile', 'label'])
  assert.equal(create.parameters.additionalProperties, false)
  assert.deepEqual(list.parameters.required, [])
  assert.deepEqual(Object.keys(list.parameters.properties), ['profile'])
  assert.equal(list.parameters.additionalProperties, false)
  assert.deepEqual(restore.parameters.required, ['snapshotId'])
  assert.deepEqual(Object.keys(restore.parameters.properties), ['snapshotId'])
  assert.equal(restore.parameters.additionalProperties, false)

  for (const tool of registry.tools) {
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, false)
    assert.deepEqual(Object.keys(tool.output.schema.properties ?? {}), ['data', 'text'])
    assert.match(tool.description, /snapshot/i)
  }
  assert.match(create.description, /sensitive|private/i)
  assert.match(restore.description, /protection|rollback|restore/i)
})

test('rejects additional properties before any tool service executes', async () => {
  const services = createServices({ dshHome: '/tmp/dsh-snapshot-plugin-unused' })
  const registry = registeredTools(services)
  const cases = [
    ['snapshot_create', { profile: 'work', unexpected: true }],
    ['snapshot_list', { unexpected: true }],
    ['snapshot_restore', { snapshotId: '20260820T104530123Z-a1b2c3', unexpected: true }],
  ] as const

  for (const [toolName, args] of cases) {
    const tool = registry.tools.find((candidate) => candidate.name === toolName)
    assert.ok(tool)
    await assert.rejects(
      tool.execute(args, executionStub as never),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'INVALID_ARGS')
        return true
      },
    )
  }
})

test('create result includes id, counts, and sensitivity warning without payload data', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home)
    const services = createServices({ dshHome: home })
    const registry = registeredTools(services)
    const create = registry.tools.find((tool) => tool.name === 'snapshot_create')
    assert.ok(create)

    const result = await create.execute({ profile: 'work', label: 'before update' }, executionStub as never)
    assert.equal(result.data.profile, 'work')
    assert.equal(result.data.present.length, 3)
    assert.equal(result.data.absent.length, 3)
    assert.match(result.text, new RegExp(result.data.snapshotId))
    assert.match(result.text, /3.*captured|captured.*3/i)
    assert.match(result.text, /sensitive|private|do not share/i)
    assert.equal(result.text.includes('private setting body'), false)
  })
})

test('list returns corrupt rows and does not expose paths, hashes, or payload bodies', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home)
    const services = createServices({ dshHome: home })
    const created = await services.capture.capture({ profile: 'work' })
    const manifestPath = join(snapshotDirectory(home, created.snapshotId), 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      entries: Array<{ status: string; storedName?: string }>
    }
    const present = manifest.entries.find((entry) => entry.status === 'present')
    assert.ok(present?.storedName)
    await rm(join(snapshotDirectory(home, created.snapshotId), 'files', present.storedName), { force: true })

    const registry = registeredTools(services)
    const list = registry.tools.find((tool) => tool.name === 'snapshot_list')
    assert.ok(list)
    const result = await list.execute({}, executionStub as never)
    const row = result.data.snapshots.find(
      (summary: SnapshotSummary) => summary.snapshotId === created.snapshotId,
    )
    assert.equal(row?.status, 'corrupt')
    assert.match(result.text, /corrupt/i)
    assert.equal(result.text.includes(home), false)
    assert.equal(result.text.includes('private setting body'), false)
    assert.equal(result.text.includes('sha256'), false)
  })
})

test('restore result includes protection/counts and only adds dependency command when needed', async () => {
  await withTemporaryDshHome(async (home) => {
    await seedProfile(home)
    const services = createServices({ dshHome: home })
    const snapshot = await services.capture.capture({ profile: 'work' })
    await writeFile(join(home, 'profiles', 'work', 'package.json'), '{"name":"changed"}\n')
    await writeFile(join(home, 'profiles', 'work', 'pnpm-lock.yaml'), 'lockfileVersion: 8\n')

    const registry = registeredTools(services)
    const restore = registry.tools.find((tool) => tool.name === 'snapshot_restore')
    assert.ok(restore)
    const result = await restore.execute({ snapshotId: snapshot.snapshotId }, executionStub as never)
    assert.equal(result.data.snapshotId, snapshot.snapshotId)
    assert.match(result.data.protectionSnapshotId, /T\d{9}Z-/)
    assert.equal(result.data.restored.includes('profile/package.json'), true)
    assert.equal(result.data.restored.includes('profile/pnpm-lock.yaml'), true)
    assert.equal(result.data.dependencyInstallCommand, 'pnpm install --frozen-lockfile')
    assert.match(result.text, /protection/i)
    assert.match(result.text, /2|package|lock/i)
    assert.match(result.text, /pnpm install --frozen-lockfile/)
    assert.equal(result.text.includes(home), false)
    assert.equal(result.text.includes('private setting body'), false)
  })
})

test('tool failures expose only public SnapshotError data while retaining the cause', async () => {
  const services = createServices({ dshHome: '/tmp/dsh-snapshot-plugin-invalid' })
  const registry = registeredTools(services)
  const create = registry.tools.find((tool) => tool.name === 'snapshot_create')
  assert.ok(create)

  await assert.rejects(
    create.execute({ profile: '../secret' }, executionStub as never),
    (error: unknown) => {
      assert.equal(error instanceof HarnessError, true)
      assert.equal(typeof error, 'object')
      const candidate = error as { code?: string; message?: string; cause?: unknown; toPublic?: () => unknown }
      assert.equal(candidate.code, 'INVALID_PROFILE')
      assert.equal(candidate.message?.includes('/tmp'), false)
      assert.equal(candidate.message?.includes('secret'), false)
      assert.equal(typeof candidate.cause, 'object')
      assert.deepEqual(candidate.toPublic?.(), { code: 'INVALID_PROFILE', message: candidate.message })
      return true
    },
  )
})
