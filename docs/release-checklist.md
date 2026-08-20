# v0.1.0 release checklist

Reviewed locally and in GitHub Actions on 2026-08-21. The approved candidate is
published as [GitHub Release v0.1.0](https://github.com/jackxu3111/dsh-snapshot/releases/tag/v0.1.0).
`package.json` remains `private: true` and npm publication is disabled.

The attached `dsh-snapshot-0.1.0.tgz` contains 41 reviewed files. Its SHA-256 is
`3482e26469ea8b974b3a3e24a934639a2d453741eb8cf7f8677c96507084259e`,
verified again after downloading the published asset from GitHub.

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
| Compatibility import and packed loader smoke | Public `defineTool` probe is recorded in `docs/compatibility.md`. | Pass: local and GitHub real packed-loader smoke. |
| Three tools | Unit tests cover create, list and restore registrations, strict schemas and redaction. | Pass in clean local install and CI. |
| Six-file present/absent round trip | `acceptance.test.ts` covers bytes, modes and absent deletion. | Pass in clean local install and CI. |
| Protection reversal | `acceptance.test.ts` restores the generated protection snapshot. | Pass in clean local install and CI. |
| Tamper rejection before mutation | Repository and restore preflight tests cover digest, manifest and symlink tampering. | Pass in clean local install and CI. |
| Rollback and manual recovery | Fault-injection restore tests cover stage/rename/sync/chmod failures and recovery material. | Pass in the 98-test suite. |
| Three operating systems | `.github/workflows/ci.yml` covers Ubuntu, macOS and Windows for Node 22/24. | Pass: [GitHub Actions run 32389906039](https://github.com/jackxu3111/dsh-snapshot/actions/runs/32389906039). |
| Package contents | Normal `npm pack --dry-run` listed 41 files: `dist`, patch, READMEs, LICENSE and metadata; no source, tests, snapshots or credentials. | Pass locally and in GitHub Actions. |

## Final verification command set

The release candidate passed this command set locally and in clean GitHub
runners:

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

Terra High reviewed the complete release candidate after these gates and issued
an explicit approval with no Critical, High, or Medium findings. GitHub Release
publication is authorized; npm publication remains disabled.
