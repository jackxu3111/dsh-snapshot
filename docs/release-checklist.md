# v0.1.0 release checklist

Reviewed locally on 2026-08-20. This document is release evidence, not a
publication claim. `package.json` remains `private: true`; no GitHub Release or
npm publication has been created.

## Specification and adversarial review

| Requirement | Code boundary | Named evidence |
| --- | --- | --- |
| DSH compatibility and named plugin exports | `src/index.ts`, `cordis.patch.yml` | `docs/compatibility.md`; `plugin.test.ts` "registers exactly three named tools" |
| Three strict tools and stable public errors | `src/index.ts`, `src/errors.ts` | `plugin.test.ts` strict schema/redaction tests; `errors.test.ts` |
| Home, Profile, ID and six-file policy | `src/policy.ts` | `policy.test.ts` traversal and exact-whitelist tests |
| Immutable manifest, opaque payload names, hash/size validation and shallow listing | `src/repository.ts` | `repository.test.ts` schema, tamper, symlink, listing and publication tests |
| Stable whitelisted capture and exclusion of credentials/custom files | `src/capture.ts` | `capture.test.ts`; acceptance private-fixture test |
| Shared process/inter-process writer lock | `src/lock.ts` | `lock.test.ts`; acceptance concurrency test |
| Preflight, protection snapshot, staged restore and inverse journal | `src/restore.ts` | `restore.test.ts`; acceptance six-file and protection-reversal tests |

Manifest strings are parsed only as constrained metadata: `snapshotId` selects a
validated snapshot directory; `storedName` selects only a validated file under
that snapshot's `files/` directory; `logicalPath` is never joined from the
manifest and is mapped anew by `resolveWhitelist()` before every target
mutation. Restore mutations are stage write/sync/chmod, original-to-backup
rename, stage-to-target rename, backup cleanup, and directory sync. Their
inverse is respectively stage removal, installed-target removal, backup restore,
or preserved recovery material when rollback itself fails.

## Review fixes in this release review

- `restore.test.ts` "rejects a target that appears for an absent snapshot entry
  during commit without deleting it" failed against the reviewed code, then
  passed after restore rejects the appearance and leaves the external file
  intact during rollback.
- `restore.test.ts` "rejects a payload symlink swap between preflight and
  staging when no-follow is unavailable" failed against the reviewed code, then
  passed after the staged source read compares pre-open, opened-handle and
  post-open identities. Unsupported `O_NOFOLLOW` platforms use the same
  identity checks.
- `lock.test.ts` "fails closed when its owned lock directory disappears before
  release" failed against the reviewed code, then passed after an unexpectedly
  removed lock is reported for operator recovery rather than silently accepted.

The targeted lock and restore suites passed with 34 tests after all fixes.
`npm run lint` and `npm run format:check` also passed locally (24 files each).

## Required release gates

| Gate | Current evidence | Release state |
| --- | --- | --- |
| Compatibility import and packed loader smoke | Public `defineTool` probe is recorded in `docs/compatibility.md`. | Pending a real clean install and `npm run smoke:loader`. |
| Three tools | Unit tests cover create, list and restore registrations, strict schemas and redaction. | Source-reviewed; rerun in clean install required. |
| Six-file present/absent round trip | `acceptance.test.ts` covers bytes, modes and absent deletion. | Source-reviewed; clean-install rerun required. |
| Protection reversal | `acceptance.test.ts` restores the generated protection snapshot. | Source-reviewed; clean-install rerun required. |
| Tamper rejection before mutation | Repository and restore preflight tests cover digest, manifest and symlink tampering. | Source-reviewed; clean-install rerun required. |
| Rollback and manual recovery | Fault-injection restore tests cover stage/rename/sync/chmod failures and recovery material. | Targeted restore suite: pass (20/20). |
| Three operating systems | `.github/workflows/ci.yml` defines Ubuntu, macOS and Windows for Node 22/24. | Pending GitHub Actions evidence. |
| Package contents | Local `npm pack --dry-run --ignore-scripts` listed 41 files: `dist`, patch, READMEs, LICENSE and metadata; no source, tests, snapshots or credentials. | Informational only: rerun normal pack after clean build. |

## Local-cache verification status

This workspace's dependency cache cannot currently complete a trustworthy clean
install: `npm ci` left an incomplete dependency tree, and the full suite then
failed only while importing the missing
`@deepseek-ai/dsh-llm/lib/index.js` for `acceptance.test.ts` and
`plugin.test.ts` (86 passed, 2 infrastructure failures). The cached TypeScript
binary also cannot typecheck that incomplete tree because `@types/node` is
missing. This is not evidence of a code failure, but it is not a release pass.

Before release, run in a fresh GitHub runner or equivalent clean machine:

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

Release remains blocked until that clean-install gate, the real loader smoke,
and successful Ubuntu/macOS/Windows CI are recorded here. Then verify the pack
contains only the listed publishable files and obtain explicit authorization
before any GitHub Release or npm publication.
