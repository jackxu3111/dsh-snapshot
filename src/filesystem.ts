import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'

/**
 * The filesystem seam used by snapshot services.
 *
 * Keeping the boundary to the operations used by the domain makes fault
 * injection deterministic without giving services an escape hatch to run
 * arbitrary filesystem commands.
 */
export interface FileSystem {
  lstat: typeof lstat
  readFile: typeof readFile
  writeFile: typeof writeFile
  mkdir: typeof mkdir
  rename: typeof rename
  rm: typeof rm
  readdir: typeof readdir
  chmod: typeof chmod
  open: typeof open
}

/** Bound Node.js implementation used in production. */
export const nodeFileSystem: FileSystem = {
  lstat,
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  readdir,
  chmod,
  open,
}

export type { FileHandle } from 'node:fs/promises'
