# DSH compatibility evidence

Verified on 2026-08-21 locally and in GitHub Actions with Node.js 22 and 24.

## Published packages

The installed npm releases are pinned as development dependencies:

- `@deepseek-ai/dsh` `0.1.0-rc.6` — published CLI; its package manifest exposes the `dsh` binary.
- `@deepseek-ai/dsh-tools` `0.1.0-rc.6` — public root export contains `defineTool`.
- `@deepseek-ai/cordis` `4.0.1` — published Cordis runtime required by the DSH tool package.

The public import was proven with:

```sh
node --input-type=module -e "import('@deepseek-ai/dsh-tools').then(m=>{if(typeof m.defineTool!=='function')throw Error('not public');console.log('defineTool verified')})"
```

Result: `defineTool verified`.

## Bundle format

The published `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-headless` bundles use an `insert` patch containing an `id` and package `name`. This package follows the same public bundle mechanism:

```yaml
- insert:
    - id: dsh-snapshot
      name: 'dsh-snapshot'
```

`package.json` declares that patch at `dsh.bundle.patch`; the plugin entry point intentionally uses named `name`, `inject`, and `apply` exports, rather than a default export.

## Reproduction commands

```sh
npm install --package-lock-only
npm install
npm run build
npm pack
node --input-type=module -e "import('@deepseek-ai/dsh-tools').then(m=>{if(typeof m.defineTool!=='function')throw Error('not public');console.log('defineTool verified')})"
npm run smoke:loader
```

`smoke:loader` builds a tarball, creates an isolated `DSH_HOME`, installs the absolute tarball via `dsh plugin --profile smoke add`, checks that the resulting profile bundle list contains `dsh-snapshot`, and boots the real headless profile with a non-interactive task argument. During this dedicated smoke invocation, `apply` writes a one-time marker and exits successfully; the script fails unless that runtime marker is present. This proves the installed bundle's `apply` executed, rather than merely parsing YAML or displaying CLI help. It uses argument arrays, a 60-second timeout per child process, and always deletes its temporary directory.

## Verification status

A clean local `npm ci`, TypeScript 6 build, 98-test suite, pack inspection,
and real packed-loader smoke all passed. The same clean-install gates passed in
[GitHub Actions](https://github.com/jackxu3111/dsh-snapshot/actions/runs/32389095727)
on Ubuntu, macOS, and Windows with Node.js 22 and 24. The packed-loader job
installed the generated tarball into an isolated real DSH rc.6 Profile and
observed the plugin's runtime marker.

## Deviation from source snapshot `141eb6f...`

The source snapshot describes `dsh.bundle.patch`, named plugin exports, and `dsh plugin --profile <name> add <spec>`. The published `0.1.0-rc.6` package matches those interfaces. The compatibility boundary is therefore the actual public npm package exports above, not a repository-internal import path.
