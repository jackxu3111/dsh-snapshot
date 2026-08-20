import { writeFileSync } from 'node:fs'

export const name = 'dsh-snapshot'
export const inject = ['tools']
export function apply(_ctx: unknown): void {
  const smokeMarker = process.env.DSH_SNAPSHOT_SMOKE_MARKER
  if (!smokeMarker) return

  writeFileSync(smokeMarker, `${name} apply\n`, { encoding: 'utf8', flag: 'wx' })
  setImmediate(() => process.exit(0))
}
