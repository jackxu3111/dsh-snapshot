# DSH Snapshot MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an open-source `dsh-snapshot` v0.1.0 Cordis plugin that safely creates, lists, and transactionally restores local DSH configuration snapshots for one validated Profile.

**Architecture:** Cordis registration is a thin adapter over a filesystem core. Policy derives every allowed path, the repository owns immutable snapshots, capture performs stable reads, and restore uses one writer lock plus a rollback journal; filesystem calls are injected for deterministic fault tests.

**Tech Stack:** Strict TypeScript ESM, current Node LTS, npm, Vitest, ESLint, Prettier, Node `fs/promises`/`path`/`crypto`, and verified public DSH/Cordis packages.

**Spec:** `docs/superpowers/specs/2026-08-20-dsh-snapshot-design.md`

## Global Constraints

- Package/version/license: `dsh-snapshot`, `0.1.0`, MIT.
- Task 1 must verify actual npm versions, public `defineTool`, and the Bundle self-reference loader before implementation.
- Tools: `snapshot_create`, `snapshot_list`, `snapshot_restore`; stable JSON plus short text.
- Only six logical paths are allowed: `home/settings.yaml`, `home/cordis.patch.yml`, `profile/package.json`, `profile/cordis.patch.yml`, `profile/pnpm-lock.yaml`, `profile/pnpm-workspace.yaml`.
- Never capture credentials, `.env`, sessions, `node_modules`, cache, logs, or arbitrary files.
- `lstat` must accept only regular files; default limits are 10 MiB/file and 30 MiB/snapshot.
- Root is `$DSH_HOME/snapshots/dsh-snapshot/v1/`; writes use sibling `.tmp-<random>` then atomic rename.
- ID regex is `^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{6}$`; manifest strings never choose target paths.
- Home precedence: explicit, nonblank `DSH_HOME`, then `~/.dsh`; Profile rejects blank, `.`, `..`, `node_modules`, `/`, `\\`.
- Create/restore use a process mutex and fail-closed lock directory; list is concurrent and ignores temporary directories.
- Restore verifies every digest before mutation, creates protection under the same lock without reacquisition, stages beside targets, commits, and rolls back every touched target on failure.
- Error codes: `INVALID_PROFILE`, `SNAPSHOT_NOT_FOUND`, `SNAPSHOT_CORRUPT`, `UNSAFE_FILE_TYPE`, `SIZE_LIMIT`, `BUSY`, `PROTECTION_FAILED`, `RESTORE_FAILED_ROLLED_BACK`, `RESTORE_FAILED_MANUAL_RECOVERY`.
- POSIX directories/files target `0700`/`0600`; Windows uses current-user ACL. Snapshots are not encrypted.
- Use Node path/filesystem APIs only, UTF-8/LF manifests, UTC ISO timestamps, same-directory temporary files, no runtime shell.
- Logs/errors never expose configuration bodies; model-facing errors hide absolute paths.
- CI runs test/typecheck/lint/build on Ubuntu, macOS, Windows current Node LTS.
- Do not claim or perform npm/GitHub publication until it actually succeeds with authorization.

## File Structure

```text
.github/workflows/ci.yml       cross-platform gate
cordis.patch.yml               Bundle self-reference
docs/compatibility.md          verified API/loader evidence
docs/release-checklist.md      review/release evidence
scripts/smoke-loader.mjs       real packed-plugin loader probe
src/index.ts                   named exports and tool adapters
src/types.ts                   stable domain contracts
src/errors.ts                  safe coded errors
src/filesystem.ts              injectable filesystem boundary
src/policy.ts                  Home/Profile/ID/whitelist policy
src/repository.ts              immutable storage/list/preflight
src/capture.ts                 stable capture
src/lock.ts                    process and cross-process lock
src/restore.ts                 staged transaction and rollback
test/{helpers,errors,policy,repository,capture,lock,restore,plugin,acceptance}.test.ts
README.md / README.zh-CN.md / LICENSE
package.json / package-lock.json / tsconfig.json / vitest.config.ts / eslint.config.js
```

---

### Task 1: Verify Published DSH Compatibility `[Owner: Luna Max]`

**Files:**
- Create: `package.json`, `package-lock.json`, `cordis.patch.yml`
- Create: `scripts/smoke-loader.mjs`, `docs/compatibility.md`, `src/index.ts`

**Interfaces:**
- Consumes: npm registry, installed public DSH CLI/tool API, installed Bundle syntax.
- Produces: exact dependency versions; verified `defineTool` import; named `name`, `inject`, `apply`; loader-proven self-reference.

- [ ] **Step 1: Discover exact public packages before choosing ranges**

Run:
```bash
npm search --json deepseek-harness
npm view @deepseek-ai/agent-core version exports peerDependencies --json
npm view cordis version exports --json
```
Expected: identify the published CLI/tool package and Cordis versions. If the guessed scope is absent, inspect the package imported by DSH commit `141eb6f...`; never import a repository-internal path.

- [ ] **Step 2: Create the minimal ESM manifest and install exact versions**

Create `package.json` with `name: dsh-snapshot`, `version: 0.1.0`, `type: module`, `main: ./dist/index.js`, `types: ./dist/index.d.ts`, `exports`, `files`, MIT, exact dev dependency versions, compatible peer ranges, and:
```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```
Run: `npm install --package-lock-only && npm install`. Expected: no unresolved peer.

- [ ] **Step 3: Prove `defineTool` is publicly importable**

Run with the package found above:
```bash
node --input-type=module -e "import('@verified/dsh-tool-api').then(m=>{if(typeof m.defineTool!=='function')throw Error('not public');console.log('defineTool verified')})"
```
Expected: `defineTool verified`; otherwise inspect installed `exports` and `.d.ts` and use only the real public specifier.

- [ ] **Step 4: Add the minimal named-export probe**

Create:
```ts
export const name = 'dsh-snapshot'
export const inject = ['tools']
export function apply(_ctx: unknown): void {}
```
Create `cordis.patch.yml` from the installed release's own Bundle examples, pointing at package name `dsh-snapshot`, not `src` and not a default export.

- [ ] **Step 5: Prove packed self-reference through the real loader**

Implement `scripts/smoke-loader.mjs` using `mkdtemp`, `spawnSync` argument arrays, and `finally rm`. It must create the minimum isolated Profile indicated by `dsh --help`, run `npm pack`, execute `dsh plugin --profile smoke add <absolute-tarball>` with `DSH_HOME` set, invoke the release's boot/load command, assert status 0, and assert the installed patch references `dsh-snapshot`. Run `npm run smoke:loader`. Expected: real loader imports named exports; a YAML-text-only test is insufficient.

- [ ] **Step 6: Record and commit evidence**

Write `docs/compatibility.md` with date, Node/npm, exact package names/versions, public import, exact patch node, commands/results, and deviations from commit `141eb6f...`.
```bash
git add package.json package-lock.json cordis.patch.yml scripts/smoke-loader.mjs docs/compatibility.md src/index.ts
git commit -m "chore: verify dsh plugin compatibility"
```

### Task 2: Establish Tooling and Domain Contracts `[Owner: Luna Max]`

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`
- Create: `src/types.ts`, `src/filesystem.ts`, `src/errors.ts`, `test/errors.test.ts`

**Interfaces:**
- Produces: `LogicalPath`, `ManifestEntry`, `Manifest`, `SnapshotSummary`, `CreateResult`, `RestoreResult`, `ToolResult<T>`, `FileSystem`, `nodeFileSystem`, `SnapshotError`, size/schema constants.

- [ ] **Step 1: Configure strict repeatable tooling**

Install exact compatible TypeScript/Vitest/ESLint/typescript-eslint/Prettier/@types-node versions. Scripts: `build`, `typecheck`, `test`, `test:watch`, `lint`, `format:check`. Use NodeNext ESM, strict, `noUncheckedIndexedAccess`, declarations, `src`→`dist`.

- [ ] **Step 2: Write failing safe-error tests**

Assert `new SnapshotError('BUSY','Writer lock is held',{privatePath:'/secret'}).toPublic()` is exactly `{code:'BUSY',message:'Writer lock is held'}`, cause is preserved privately, and all nine codes typecheck. Run `npm test -- test/errors.test.ts`; expect missing module failure.

- [ ] **Step 3: Define exact types**

Define `SCHEMA_VERSION=1`, 10/30 MiB constants, six-literal `LogicalPath`, `SnapshotKind='normal'|'protection'`, discriminated present/absent `ManifestEntry`, manifest fields from the spec, summaries with `available|corrupt`, create/restore results, and `ToolResult<T>={data:T;text:string}`. Define only filesystem methods actually used (`lstat`, `readFile`, `writeFile`, `mkdir`, `rename`, `rm`, `readdir`, `chmod`, `open`) and bound Node wrappers.

- [ ] **Step 4: Implement safe errors and verify**

Implement the exact nine-code union and `SnapshotError` with private details/cause excluded from `toPublic`. Run `npm test -- test/errors.test.ts && npm run typecheck && npm run lint && npm run build`; expect PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.js .gitignore src/types.ts src/filesystem.ts src/errors.ts test/errors.test.ts
git commit -m "chore: establish snapshot contracts"
```

### Task 3: Implement Path Policy `[Owner: Luna Max]`

**Files:**
- Create: `src/policy.ts`, `test/policy.test.ts`, `test/helpers.ts`

**Interfaces:**
- Produces: `resolveDshHome({explicitHome?,env?,userHome?}): string`, `validateProfile(string): string`, `validateSnapshotId(string): string`, `snapshotRoot(string): string`, `profileRoot(string,string): string`, `resolveWhitelist(string,string): ReadonlyMap<LogicalPath,string>`, `snapshotDirectory(string,string): string`.

- [ ] **Step 1: Write failing tables**

Test Home precedence/blank env; invalid Profiles `''`, whitespace, `.`, `..`, `node_modules`, `a/b`, `a\\b`; valid and traversal IDs; exactly six mappings. Run `npm test -- test/policy.test.ts`; expect missing exports.

- [ ] **Step 2: Implement enum-only derivation**

Use `path.resolve/join`, validate before joining, derive filenames only from literal maps, and reject both separators. Never consume target paths from manifest.

- [ ] **Step 3: Add containment invariants and commit**

Assert POSIX/Windows traversal strings cannot yield an outside path. Run `npm test -- test/policy.test.ts && npm run typecheck`; expect PASS.
```bash
git add src/policy.ts test/policy.test.ts test/helpers.ts
git commit -m "feat: enforce snapshot path policy"
```

### Task 4: Implement Immutable Repository `[Owner: Luna Max]`

**Files:**
- Create: `src/repository.ts`, `test/repository.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Produces: `sha256(Buffer): string`; `SnapshotRepository({dshHome,fs?,now?,randomHex?})`; `createId()`, `publish(manifest,payloads)`, `readManifest(id)`, `preflight(id)`, `list(profile?)`.

- [ ] **Step 1: Write failing schema/hash/ID tests**

Assert deterministic ID `20260820T104530123Z-a1b2c3`, SHA-256 of `abc`, and rejection of duplicate/missing/unknown entries, invalid stored basenames, malformed digest, bad modes/sizes, extra keys, mismatched ID, invalid JSON. Run repository test; expect failure.

- [ ] **Step 2: Implement strict unknown-data parser**

Require schema 1, exact fields, all six unique entries, safe generated stored basename, integer sizes, 64-lowercase-hex digests, mode `0..0o777`, and aggregate limit.

- [ ] **Step 3: Write failing publication tests**

Assert `0700/0600`, payloads before manifest, LF, file sync, one final rename, cleanup on error, immutable existing ID, no absolute target paths/content in manifest.

- [ ] **Step 4: Implement publication and preflight**

Use sibling `.tmp-<random>`, opaque stored names, exact payload-entry equality, byte/digest checks, regular-file `lstat`, full preflight rehash, cleanup in failure.

- [ ] **Step 5: Test and implement resilient shallow list**

Fixtures: valid, malformed, missing payload, payload symlink, `.tmp-*`. List must not read payload bodies/recompute hashes; mark bad rows corrupt, retain siblings, filter Profile, sort available by creation descending and corrupt deterministically.

- [ ] **Step 6: Verify and commit**

Run `npm test -- test/repository.test.ts && npm run typecheck && npm run lint`; expect PASS.
```bash
git add src/repository.ts test/repository.test.ts test/helpers.ts
git commit -m "feat: add immutable snapshot repository"
```

### Task 5: Implement Stable Capture `[Owner: Luna Max]`

**Files:**
- Create: `src/capture.ts`, `test/capture.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Produces: `CaptureService({dshHome,repository,fs?,now?,pluginVersion,dshVersion?,writerLock})`; `capture(input): Promise<CreateResult>`; internal `captureUnlocked(input)` for restore.

- [ ] **Step 1: Write failing present/absent tests**

Test six canonical entries, correct Buffer/hash/mode, absent metadata omission, result partition, 120-code-point trimmed label, local-sensitive-do-not-share warning. Expect missing service.

- [ ] **Step 2: Implement stable read**

Use `lstat-read-lstat`; compare dev/ino/size/mtime/ctime and byte length; retry once; fail after second change. Only ENOENT means absent. Reject links/non-regular types.

- [ ] **Step 3: Test failures and limits**

Test missing Profile, per/aggregate limit, symlink/directory, EACCES/EPERM safe remediation, twice-changing metadata, and zero published/temp residue.

- [ ] **Step 4: Implement capture assembly**

Validate Profile directory, process canonical order, enforce running size, construct complete manifest, then publish only after every read succeeds. `capture` wraps writer lock; `captureUnlocked` never locks.

- [ ] **Step 5: Verify and commit**

Run `npm test -- test/capture.test.ts && npm run typecheck && npm run lint`; expect PASS.
```bash
git add src/capture.ts test/capture.test.ts test/helpers.ts
git commit -m "feat: capture whitelisted dsh configuration"
```

### Task 6: Add Writer Lock `[Owner: Terra]`

**Files:**
- Create: `src/lock.ts`, `test/lock.test.ts`
- Modify: `src/capture.ts`, `test/capture.test.ts`

**Interfaces:**
- Produces: `WriterLock({root,fs?}).runExclusive<T>(()=>Promise<T>): Promise<T>`; `<root>/.writer-lock`; `lockRecoveryMessage(root): string` for operators only.

- [ ] **Step 1: Write failing mutex tests**

Two deferred operations must enter FIFO; rejection must release queue. Run lock test; expect missing class.

- [ ] **Step 2: Implement per-instance promise queue**

Each caller awaits predecessor and releases its gate in `finally`; no process-global lock.

- [ ] **Step 3: Write cross-process tests**

Test atomic lock-dir creation, `owner.json` PID/UTC/no secrets, removal in finally, pre-existing lock→BUSY/no callback, no age guessing/deletion, actionable manual verification/removal text.

- [ ] **Step 4: Implement fail-closed directory lock**

Create root `0700`, nonrecursive `mkdir(lockPath)`, map EEXIST to BUSY, owner file `0600`, remove exact owned lock only. Preserve EPERM/EACCES remediation.

- [ ] **Step 5: Integrate capture and verify**

Make public capture call `runExclusive(()=>captureUnlocked(input))`; test restore-style unlocked capture under an already-held lock. Run lock/capture tests, typecheck, lint; expect PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lock.ts src/capture.ts test/lock.test.ts test/capture.test.ts
git commit -m "feat: serialize snapshot writers"
```

### Task 7: Implement Restore Transaction and Fault Injection `[Owner: Terra]`

**Files:**
- Create: `src/restore.ts`, `test/restore.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Produces: `RestoreService({dshHome,repository,capture,writerLock,fs?,randomHex?,platform?}).restore(snapshotId): Promise<RestoreResult>`; `faultInjectingFileSystem(base,{method,failAtCall,error})`.

- [ ] **Step 1: Write failing preflight/protection tests**

Test invalid/missing ID, corrupt digest/symlink/size/schema before target calls, enum-regenerated targets, and published protection inside one lock before staging. Expect missing service.

- [ ] **Step 2: Implement preflight/protection**

Validate ID; acquire lock; repository preflight; validate manifest Profile; regenerate targets; call `captureUnlocked({kind:'protection',label:'Before restore <id>'})`; map failure to PROTECTION_FAILED.

- [ ] **Step 3: Write successful transaction tests**

Cover present restoration, absent deletion, POSIX mode/Windows no chmod, sibling stage/backup names, sync before rename, artifact cleanup. Dependency guidance appears iff package.json or pnpm-lock changes and gives exact frozen-lockfile command then Profile restart; all restores advise restart.

- [ ] **Step 4: Implement stage and commit**

Exclusive-open sibling stages, write/sync/close/chmod, reread/hash. Move regular existing targets to backups, reject unsafe targets, rename stages, keep absent missing, sync directories where supported, remove backups only after full success.

- [ ] **Step 5: Add deterministic failure helper**

Proxy every `FileSystem` method; fail the configured Nth call with supplied errno; record method/path order but never Buffer contents.

- [ ] **Step 6: Write exhaustive failure tests**

Parameterize every write/sync/backup rename/install rename/chmod/cleanup boundary. Precommit failure preserves originals. Commit failure restores all six original bytes/presence and throws ROLLED_BACK with protection ID. Second rollback failure throws MANUAL_RECOVERY, retains recovery material, and gives residual guidance without claiming success.

- [ ] **Step 7: Implement reverse rollback journal**

Per logical path track original state, backup/stage, and commit state. Reverse: remove installed target, restore backup, enforce originally absent. Clean safe artifacts. If any inverse fails, preserve needed backups and return manual-recovery error/private residual paths.

- [ ] **Step 8: Verify platform/failure behavior and commit**

Test EPERM/EACCES/Windows busy messages, unrelated old artifacts untouched, lock released even after rollback failure. Run restore/lock/capture tests, typecheck, lint; expect PASS.
```bash
git add src/restore.ts test/restore.test.ts test/helpers.ts
git commit -m "feat: restore snapshots with rollback"
```

### Task 8: Register Three Cordis Tools `[Owner: Luna Max]`

**Files:**
- Modify: `src/index.ts`
- Create: `test/plugin.test.ts`

**Interfaces:**
- Produces: named `name='dsh-snapshot'`, `inject=['tools']`, `apply(ctx)`; exact create/list/restore schemas and `ToolResult` handlers.

- [ ] **Step 1: Write failing registration/schema tests**

Fake `tools.register`; assert exactly three registrations, no default export, required/optional fields per spec, `additionalProperties:false`, risk descriptions, structured results.

- [ ] **Step 2: Implement service factory/adapters**

Use verified public context and `defineTool`. `createServices({dshHome?,fs?})` wires one repository/lock/capture/restore graph. Handlers validate, invoke, render concise text, expose only `SnapshotError.toPublic`; wrap unknown failures safely with cause retained for host diagnostics.

- [ ] **Step 3: Test result copy/error redaction**

Create text includes ID/counts/sensitivity; list keeps corrupt rows; restore includes protection/counts/conditional command; no path, body, or hash leaks.

- [ ] **Step 4: Verify loader and commit**

Run `npm test -- test/plugin.test.ts && npm run typecheck && npm run build && npm run smoke:loader`; expect PASS.
```bash
git add src/index.ts test/plugin.test.ts
git commit -m "feat: expose snapshot cordis tools"
```

### Task 9: Add End-to-End Acceptance `[Owner: Luna Max]`

**Files:**
- Create: `test/acceptance.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Consumes: `createServices` and temporary DSH Home fixtures.
- Produces: executable six-file, absence, protection, concurrency, and residue acceptance evidence.

- [ ] **Step 1: Test six-file round trip**

Capture six distinct binary-safe files, mutate, restore, compare exact Buffers/modes; list normal+protection descending; prove credential/session/cache fixtures absent from manifests.

- [ ] **Step 2: Test absent state and protection reversal**

Capture alternating absences, later create them, restore removes them, then restore protection and recover immediate pre-restore state byte-for-byte.

- [ ] **Step 3: Test real concurrency/residue**

Concurrent create/restore through one graph serialize. A child process holding `.writer-lock` causes parent BUSY; after clean child exit operation succeeds. `.tmp-*`, stage, backup, lock never become list rows.

- [ ] **Step 4: Full gate and commit**

Run `npm test && npm run typecheck && npm run lint && npm run build && npm run smoke:loader`; expect PASS/no open handles/artifacts.
```bash
git add test/acceptance.test.ts test/helpers.ts
git commit -m "test: cover snapshot acceptance flows"
```

### Task 10: Add Documentation, License, and CI `[Owner: Luna Max]`

**Files:**
- Create: `README.md`, `README.zh-CN.md`, `LICENSE`, `.github/workflows/ci.yml`
- Modify: `.gitignore`, `package.json`, `package-lock.json`

**Interfaces:**
- Produces: bilingual verified instructions, MIT license, npm metadata, cross-platform gate.

- [ ] **Step 1: Write bilingual READMEs**

Include compatibility; verified install/restart/uninstall; three exact examples; included/excluded files; storage; restore-at-idle warning; dependency command; manual lock recovery; ACL/no encryption/no cloud/no custom files/no automatic node_modules sync; crash-mid-commit limitation; development commands. Never claim publication.

- [ ] **Step 2: Add license/package hygiene**

Canonical MIT text with owner from git config; add remote metadata only if real; keep `private:true` until authorized npm preparation. Ignore node_modules/dist/coverage/tarballs/local `.dsh`.

- [ ] **Step 3: Add matrix CI**

Push/PR workflow, `ubuntu-latest`, `macos-latest`, `windows-latest`, current Node LTS, npm cache; run `npm ci`, test, typecheck, lint, format check, build. Separate Ubuntu packaging/loader smoke job after matrix.

- [ ] **Step 4: Verify package and commit**

Run `npm run format:check && npm pack --dry-run && npm test && npm run typecheck && npm run lint && npm run build && npm run smoke:loader`; package must contain only dist/patch/READMEs/license/metadata, no source tests/snapshots/credentials.
```bash
git add README.md README.zh-CN.md LICENSE .github/workflows/ci.yml .gitignore package.json package-lock.json
git commit -m "docs: prepare dsh snapshot release"
```

### Task 11: Final Independent Review `[Owner: Terra High]`

**Files:**
- Review: entire repository
- Create: `docs/release-checklist.md`
- Modify: only files needed for verified findings

**Interfaces:**
- Produces: zero unresolved critical/high findings, named regression tests, release evidence, approval or explicit rejection.

- [ ] **Step 1: Map spec to code/tests**

Map every spec section to modules/named tests; trace every manifest string to prove it cannot select target paths and every mutation exit to cleanup/rollback.

- [ ] **Step 2: Adversarial security review**

Exercise Profile/ID/storedName traversal, duplicate entries, symlink swaps, unsafe targets, size/hash tampering, malformed JSON, locks, redaction, temp listing, tarball exclusions. For each confirmed gap: failing regression test first, then smallest fix.

- [ ] **Step 3: Transaction review**

Enumerate every filesystem mutation and tested inverse; rerun all fault rows; verify protection shares the writer lock and rollback failure preserves recovery material.

- [ ] **Step 4: API/quality review**

Check strict ESM/types, named exports, verified import, stable shapes/codes, platform branches, docs commands, YAGNI. Reject UI/cloud/encryption/retention/import/export/scheduler/package-manager execution.

- [ ] **Step 5: Record evidence**

`docs/release-checklist.md` records compatibility smoke; three tools; six-file present/absent; protection reversal; pre-mutation tamper rejection; rollback/manual recovery; three-OS CI; pack contents; publication pending state.

- [ ] **Step 6: Clean-room gate and commit**

Run:
```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run smoke:loader
npm pack --dry-run
git status --short
```
Expected: all PASS; status contains only intentional review changes before commit.
```bash
git add docs/release-checklist.md src test README.md README.zh-CN.md package.json package-lock.json
git commit -m "chore: complete v0.1.0 release review"
```

### Task 12: Publish GitHub v0.1.0 `[Owner: Luna Max, after Terra High approval]`

**Files:**
- Modify: `package.json`, `docs/release-checklist.md` only if real remote evidence requires it

**Interfaces:**
- Produces: public `jackxu3111/dsh-snapshot`, pushed `main`, annotated `v0.1.0`, GitHub Release; no npm publication.

- [ ] **Step 1: Verify identity/state/absence**

Run `gh auth status`, `git status --short`, `git log -5 --oneline`, `gh repo view jackxu3111/dsh-snapshot`, `gh release view v0.1.0 --repo jackxu3111/dsh-snapshot`. Expected: intended account, clean tree, no conflicting release; inspect and stop rather than overwrite existing state.

- [ ] **Step 2: Re-run final gate**

Run `npm ci && npm test && npm run typecheck && npm run lint && npm run format:check && npm run build && npm run smoke:loader && npm pack --dry-run`; expect PASS.

- [ ] **Step 3: Create/connect and push public repo**

If absent: `gh repo create jackxu3111/dsh-snapshot --public --source=. --remote=origin --description "Local, safe configuration snapshots for DeepSeek Harness"`; otherwise verify origin exactly. Run `git push -u origin main`.

- [ ] **Step 4: Tag/release**

Run:
```bash
git tag -a v0.1.0 -m "dsh-snapshot v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --repo jackxu3111/dsh-snapshot --title "dsh-snapshot v0.1.0" --generate-notes --verify-tag
```
Expected: public release URL. Do not run `npm publish`.

- [ ] **Step 5: Record actual URLs without moving tag**

Add repository/release/CI URLs to checklist, commit `docs: record v0.1.0 release`, push main; never recreate/move the tag.

## Ownership and Gates

- Luna Max: Tasks 1–5, 8–10, and 12.
- Terra: Tasks 6–7 (cross-process lock, restore transaction, rollback, fault injection).
- Terra High: Task 11 independent review and release approval.
- Every owner reads the spec, complete plan, and task files; chat summaries are not interface definitions.
- Every code task follows failing test → observed failure → minimal implementation → passing test → stated commit.
- No product implementation starts until Task 1 passes all three compatibility checks.
- No release starts until Terra High approval and a clean final gate.
