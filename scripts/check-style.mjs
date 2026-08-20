import { readdir, readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const mode = process.argv[2]
const sourceExtensions = new Set(['.cjs', '.js', '.mjs', '.ts'])
const ignoredDirectories = new Set(['.git', '.superpowers', 'dist', 'node_modules'])

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await collect(new URL(`${entry.name}/`, directory))))
      }
      continue
    }

    const file = new URL(entry.name, directory)
    if (sourceExtensions.has(file.pathname.slice(file.pathname.lastIndexOf('.')))) {
      files.push(file)
    }
  }

  return files
}

function display(file) {
  return relative(fileURLToPath(root), fileURLToPath(file))
}

async function checkFormatting(files) {
  const failures = []
  for (const file of files) {
    const contents = await readFile(file, 'utf8')
    if (contents.includes('\r\n')) failures.push(`${display(file)} uses CRLF line endings`)
    if (contents.split('\n').some((line) => /[ \t]+$/.test(line))) {
      failures.push(`${display(file)} has trailing whitespace`)
    }
    if (!contents.endsWith('\n')) failures.push(`${display(file)} does not end with a newline`)
  }
  return failures
}

async function checkSyntax(files) {
  const failures = []
  await Promise.all(
    files.map(
      (file) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ['--check', fileURLToPath(file)], {
            stdio: ['ignore', 'ignore', 'pipe'],
          })
          let stderr = ''
          child.stderr.setEncoding('utf8')
          child.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          child.on('close', (code) => {
            if (code !== 0) failures.push(`${display(file)} failed syntax check: ${stderr.trim()}`)
            resolve()
          })
        }),
    ),
  )
  return failures
}

const files = await collect(root)
const failures = mode === '--format' ? await checkFormatting(files) : await checkSyntax(files)
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`${mode === '--format' ? 'format' : 'syntax'} check passed (${files.length} files)`)
}
