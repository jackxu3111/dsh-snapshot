# dsh-snapshot

Local, reversible configuration snapshots for DeepSeek Harness (`dsh`) profiles.

> **Publication status:** this repository is prepared for review only. The package is
> intentionally private and has not been published to npm or to a public GitHub
> release. The instructions below use a local tarball unless you already have an
> authorized package spec.

## Compatibility

The implementation targets the public DSH rc.6 interfaces:

- `@deepseek-ai/dsh` `0.1.0-rc.6`
- `@deepseek-ai/dsh-tools` `0.1.0-rc.6`
- `@deepseek-ai/dsh-llm` `0.1.0-rc.6`
- `@deepseek-ai/cordis` `4.0.1`
- Node.js `^22.19.0 || >=24.0.0` on macOS, Linux, or Windows

The public `defineTool` import was checked against rc.6. The packed, real-profile
loader smoke is a release gate and must pass in a network-enabled environment;
see [`docs/compatibility.md`](docs/compatibility.md) for the recorded evidence
and remaining verification status.

## Install, restart, and uninstall

The package is not currently available from npm. From this checkout, create the
local package and add its absolute tarball to an existing or newly initialized
Profile:

```sh
npm ci
npm pack
dsh plugin --profile work add /absolute/path/to/dsh-snapshot-0.1.0.tgz
```

`dsh plugin --profile <profile> add <npm-or-git-spec>` is the rc.6 command for an
authorized npm, Git, or tarball spec. `dsh plugin` forwards the remaining
arguments to pnpm in the Profile directory; it also initializes a non-default
Profile on first use.

Restart the Profile after installing or removing the bundle:

```sh
dsh --profile work
```

For a one-shot headless task, rc.6 also accepts:

```sh
dsh --profile work "run the requested task"
```

Remove the bundle with the exact package name, then restart the Profile:

```sh
dsh plugin --profile work remove dsh-snapshot
dsh --profile work
```

## Tool examples

The plugin registers exactly three model-callable tools. These are tool calls,
not shell commands:

```text
snapshot_create({"profile":"work","label":"before upgrade"})
```

```text
snapshot_list({"profile":"work"})
```

```text
snapshot_restore({"snapshotId":"20260820T104530123Z-a1b2c3"})
```

The first tool's label is optional, and the snapshot ID above is illustrative;
use the ID returned by create or list. Create records missing whitelist files as
`absent`. Restore first creates a protection snapshot and reports it in the
result.

## What is captured

Only these six logical paths are read, with paths derived from the fixed
whitelist:

| Logical path | File under `$DSH_HOME` |
| --- | --- |
| `home/settings.yaml` | `settings.yaml` |
| `home/cordis.patch.yml` | `cordis.patch.yml` |
| `profile/package.json` | `profiles/<profile>/package.json` |
| `profile/cordis.patch.yml` | `profiles/<profile>/cordis.patch.yml` |
| `profile/pnpm-lock.yaml` | `profiles/<profile>/pnpm-lock.yaml` |
| `profile/pnpm-workspace.yaml` | `profiles/<profile>/pnpm-workspace.yaml` |

Absent files remain absent when restored. Each present file is stored with its
size, SHA-256 digest, and portable Unix mode metadata. A single file is limited
to 10 MiB and a snapshot to 30 MiB.

The plugin never captures `.credentials.yaml`, `.env` files, sessions, caches,
logs, `node_modules`, or arbitrary/custom files. It does not provide cloud
sync, encryption, retention, import/export, or cross-device migration.

## Storage and safety

Snapshots are local only, under:

```text
$DSH_HOME/snapshots/dsh-snapshot/v1/<snapshotId>/
```

Each completed snapshot contains `manifest.json` and a `files/` directory.
Writes use a sibling `.tmp-*` directory and publish by atomic rename. A writer
lock lives at:

```text
$DSH_HOME/snapshots/dsh-snapshot/v1/.writer-lock/
```

`DSH_HOME` follows DSH's precedence: an explicit home used by the host, a
non-blank `DSH_HOME`, then `~/.dsh`. Snapshot content can include sensitive
configuration values. The directory is permission-restricted where the
platform supports it, but snapshots are **not encrypted** and are not protected
by a cloud service. Do not commit or publicly share them.

Run `snapshot_restore` only while the Profile is idle. A restore spans multiple
configuration directories, so it is rollback-safe but not one globally
observable atomic commit. DSH may hot-reload patch files; restart the Profile
after every restore. If `package.json` or `pnpm-lock.yaml` changed, run the
following command yourself, then restart:

```sh
dsh plugin --profile <profile> install --frozen-lockfile
dsh --profile <profile>
```

The plugin never runs the package manager automatically and never synchronizes
`node_modules` for you. If the process crashes during the multi-file commit,
the generated protection snapshot may be needed for manual recovery; inspect
the result and do not assume that an interrupted process completed successfully.

### Manual lock recovery

The lock is fail-closed: it is never reclaimed by age. If an operation reports
`BUSY`, first verify that the owner process is stopped and inspect:

```text
$DSH_HOME/snapshots/dsh-snapshot/v1/.writer-lock/owner.json
```

Only after that verification, remove the exact lock directory manually. On
macOS/Linux:

```sh
rm -r "$DSH_HOME/snapshots/dsh-snapshot/v1/.writer-lock"
```

On Windows PowerShell:

```powershell
Remove-Item -LiteralPath "$env:DSH_HOME/snapshots/dsh-snapshot/v1/.writer-lock" -Recurse -Force
```

Never remove a lock held by an active writer. Windows relies on the current
user's directory ACL; this is access control, not encryption.

## Development and verification

From the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run smoke:loader
npm pack --dry-run
```

The loader smoke uses the real rc.6 CLI, installs the packed tarball into an
isolated Profile, and checks that the installed bundle's `apply` function runs.
It needs the published DSH dependencies and pnpm available on `PATH`.

This project makes no claim that an npm package or GitHub release exists. Any
publication requires explicit authorization and a fresh, successful release
gate.
