import { writeFileSync } from 'node:fs'

import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  defineTool,
  ToolArgsError,
  validateJsonSchemaValue,
  type ObjectJsonSchema,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'

import { CaptureService } from './capture.ts'
import { SnapshotError } from './errors.ts'
import { nodeFileSystem, type FileSystem } from './filesystem.ts'
import { WriterLock } from './lock.ts'
import { resolveDshHome, snapshotRoot, validateProfile, validateSnapshotId } from './policy.ts'
import { SnapshotRepository } from './repository.ts'
import { RestoreService } from './restore.ts'
import type { CreateResult, RestoreResult, SnapshotSummary, ToolResult } from './types.ts'

const PLUGIN_VERSION = '0.1.0'
const logicalPathSchema = {
  type: 'string',
  enum: [
    'home/settings.yaml',
    'home/cordis.patch.yml',
    'profile/package.json',
    'profile/cordis.patch.yml',
    'profile/pnpm-lock.yaml',
    'profile/pnpm-workspace.yaml',
  ],
} as const
const createDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    snapshotId: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    profile: { type: 'string', required: true },
    kind: { type: 'string', enum: ['normal', 'protection'], required: true },
    present: { type: 'array', items: logicalPathSchema, required: true },
    absent: { type: 'array', items: logicalPathSchema, required: true },
    warning: { type: 'string', required: true },
  },
} as const
const summarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    snapshotId: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    profile: { type: 'string', required: true },
    kind: { type: 'string', enum: ['normal', 'protection'], required: true },
    pluginVersion: { type: 'string', required: true },
    fileCount: { type: 'integer', required: true },
    totalBytes: { type: 'integer', required: true },
    status: { type: 'string', enum: ['available', 'corrupt'], required: true },
    label: { type: 'string' },
  },
} as const
const restoreDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    snapshotId: { type: 'string', required: true },
    profile: { type: 'string', required: true },
    protectionSnapshotId: { type: 'string', required: true },
    restored: { type: 'array', items: logicalPathSchema, required: true },
    removed: { type: 'array', items: logicalPathSchema, required: true },
    restartRequired: { type: 'boolean', required: true },
    dependencyInstallCommand: { type: 'string' },
  },
} as const

export interface SnapshotServices {
  repository: SnapshotRepository
  writerLock: WriterLock
  capture: CaptureService
  restore: RestoreService
}

export interface CreateServicesOptions {
  dshHome?: string
  fs?: FileSystem
}

export interface RegisteredTool {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly required?: readonly string[]
    readonly properties: Record<string, unknown>
    readonly additionalProperties?: boolean
  }
  readonly output: {
    readonly schema: {
      readonly type?: unknown
      readonly properties?: Record<string, unknown>
      readonly additionalProperties?: boolean
    }
    readonly render: (...args: any[]) => unknown
  }
  readonly execute: (args: any, execution: any) => Promise<any>
  readonly [key: string]: unknown
}

export interface ToolRegistry {
  register(definition: RegisteredTool): unknown
}

export interface SnapshotPluginContext {
  tools: ToolRegistry
}

interface ListData {
  snapshots: SnapshotSummary[]
}

export const name = 'dsh-snapshot'
export const inject = ['tools']

export function createServices(options: CreateServicesOptions = {}): SnapshotServices {
  const dshHome = resolveDshHome({ explicitHome: options.dshHome })
  const fs = options.fs ?? nodeFileSystem
  const repository = new SnapshotRepository({ dshHome, fs })
  const writerLock = new WriterLock({ root: snapshotRoot(dshHome), fs })
  const capture = new CaptureService({ dshHome, repository, fs, pluginVersion: PLUGIN_VERSION, writerLock })
  const restore = new RestoreService({ dshHome, repository, capture, writerLock, fs })
  return { repository, writerLock, capture, restore }
}

class SnapshotToolError extends HarnessError {
  constructor(message: string, code: string, cause: unknown) {
    super(message, code, { cause })
    this.name = 'SnapshotToolError'
  }

  toPublic(): { code: string; message: string } {
    return { code: this.code, message: this.message }
  }
}

function publicFailure(error: unknown, fallback: string): SnapshotToolError {
  if (error instanceof SnapshotError) {
    const publicError = error.toPublic()
    return new SnapshotToolError(publicError.message, publicError.code, error)
  }
  return new SnapshotToolError(fallback, 'SNAPSHOT_CORRUPT', error)
}

function requireProfile(value: string): string {
  try {
    return validateProfile(value)
  } catch (error) {
    throw new SnapshotError('INVALID_PROFILE', 'Profile name is invalid', { cause: error })
  }
}

function requireSnapshotId(value: string): string {
  try {
    return validateSnapshotId(value)
  } catch (error) {
    throw new SnapshotError('SNAPSHOT_NOT_FOUND', 'Snapshot was not found', { cause: error })
  }
}

function createText(result: CreateResult): string {
  return `Snapshot ${result.snapshotId} created for Profile ${result.profile}: ${result.present.length} captured, ${result.absent.length} absent. ${result.warning}`
}

function listText(snapshots: readonly SnapshotSummary[]): string {
  if (snapshots.length === 0) return 'No snapshots found.'
  const corrupt = snapshots.filter((snapshot) => snapshot.status === 'corrupt').length
  return `Found ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}${corrupt > 0 ? `, including ${corrupt} corrupt` : ''}.`
}

function restoreText(result: RestoreResult): string {
  const dependency = result.dependencyInstallCommand
    ? ` Run ${result.dependencyInstallCommand}, then restart the Profile.`
    : ' Restart the Profile.'
  return `Restored snapshot ${result.snapshotId}: ${result.restored.length} restored, ${result.removed.length} removed. Protection snapshot: ${result.protectionSnapshotId}.${dependency}`
}

function toolOutput<T extends object>(schema: T) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        data: { ...schema, required: true },
        text: { type: 'string', required: true },
      },
    } as const,
    render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
  }
}

function withStrictParameters(tool: ToolDefinition): RegisteredTool {
  const parameters = {
    ...tool.parameters,
    required: Array.isArray(tool.parameters.required) ? tool.parameters.required : [],
    additionalProperties: false,
  } as ObjectJsonSchema
  const execute = tool.execute.bind(tool)
  return {
    ...tool,
    parameters,
    async execute(args: unknown, execution: Parameters<ToolDefinition['execute']>[1]) {
      const violations = validateJsonSchemaValue(parameters, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return execute(args, execution)
    },
  } as unknown as RegisteredTool
}

export function registerSnapshotTools(registry: ToolRegistry, services: SnapshotServices): void {
  registry.register(withStrictParameters(defineTool({
    name: 'snapshot_create',
    description: 'Create a local snapshot of the six whitelisted DSH configuration files. Snapshots may contain sensitive or private configuration; do not share them.',
    parameters: {
      profile: { type: 'string', required: true, description: 'DSH Profile name.' },
      label: { type: 'string', description: 'Optional short label for this snapshot.' },
    },
    output: toolOutput(createDataSchema),
    async execute(args): Promise<ToolResult<CreateResult>> {
      try {
        const data = await services.capture.capture({
          profile: requireProfile(args.profile),
          ...(args.label === undefined ? {} : { label: args.label }),
        })
        return { data, text: createText(data) }
      } catch (error) {
        throw publicFailure(error, 'Snapshot creation failed')
      }
    },
  })))

  registry.register(withStrictParameters(defineTool({
    name: 'snapshot_list',
    description: 'List local DSH configuration snapshots, including isolated corrupt rows, without reading configuration contents.',
    parameters: {
      profile: { type: 'string', description: 'Optional DSH Profile name filter.' },
    },
    output: toolOutput({
      type: 'object',
      additionalProperties: false,
      properties: {
        snapshots: { type: 'array', items: summarySchema, required: true },
      },
    } as const),
    async execute(args): Promise<ToolResult<ListData>> {
      try {
        const snapshots = await services.repository.list(
          args.profile === undefined ? undefined : requireProfile(args.profile),
        )
        const data = { snapshots }
        return { data, text: listText(snapshots) }
      } catch (error) {
        throw publicFailure(error, 'Snapshot listing failed')
      }
    },
    isConcurrencySafe: () => true,
  })))

  registry.register(withStrictParameters(defineTool({
    name: 'snapshot_restore',
    description: 'Restore one verified DSH configuration snapshot. Creates a protection snapshot first and rolls back on failure; run only while the Profile is idle.',
    parameters: {
      snapshotId: { type: 'string', required: true, description: 'Snapshot ID returned by snapshot_create or snapshot_list.' },
    },
    output: toolOutput(restoreDataSchema),
    async execute(args): Promise<ToolResult<RestoreResult>> {
      try {
        const data = await services.restore.restore(requireSnapshotId(args.snapshotId))
        return { data, text: restoreText(data) }
      } catch (error) {
        throw publicFailure(error, 'Snapshot restore failed')
      }
    },
  })))
}

export function apply(ctx: SnapshotPluginContext): void {
  registerSnapshotTools(ctx.tools, createServices())

  const smokeMarker = process.env.DSH_SNAPSHOT_SMOKE_MARKER
  if (!smokeMarker) return

  writeFileSync(smokeMarker, `${name} apply\n`, { encoding: 'utf8', flag: 'wx' })
  setImmediate(() => process.exit(0))
}
