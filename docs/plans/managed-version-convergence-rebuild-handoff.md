# Managed Agent Version Convergence — Rebuild Handoff Plan

Chinese version: [managed-version-convergence-rebuild-handoff.zh-CN.md](managed-version-convergence-rebuild-handoff.zh-CN.md)

Self-contained continuation plan for the pre-production version-compatibility
removal ("A batch") in `packages/managed-agent-server`. A new session can start
from this document alone; no prior transcript is required.

## 1. Where to work

- **Worktree:** `/Users/jinye.djy/Projects/qwen-code/.qwen/worktrees/version-convergence-rebuild`
- **Branch:** `feat/managed-version-convergence-rebuild`
- **Base:** `origin/main` @ `1de5c0b34b9` (fresh; includes the CSI cold archive).
- Start a **new session in this worktree directory** (do **not** `--resume` the
  old large-context session). Memory and branch state are on disk.

### Branches — do not confuse them

| Branch                                     | Location                             | Status                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `feat/managed-version-convergence-rebuild` | this worktree                        | **active**, verified green                                                                                                                                                                                                     |
| `feat/managed-version-convergence-a`       | main checkout                        | **obsolete** (296 commits behind main, predates CSI archive). Code superseded; design doc now migrated here. Delete only after the main checkout switches off it and the parallel B-session's uncommitted edits are preserved. |
| `worktree-d1-profile-rollout`              | `.qwen/worktrees/d1-profile-rollout` | separate **D1 (B-class)** work, unrelated to this A batch                                                                                                                                                                      |

## 2. Read first

1. This plan.
2. `docs/design/2026-11-19-managed-agent-version-convergence.md` (+ `.zh-CN.md`)
   — the canonical convergence design (now on this branch). **Still describes
   archived CSI machinery; needs the revision in §6.1.**
3. `packages/managed-agent-server/AGENTS.md` — Java verification policy
   (10-minute local budget, focused tests, MySQL/CI gates).
4. Root `AGENTS.md` — simplicity-first, bilingual design docs, self-audit.

## 3. Locked decisions

- Service is **pre-production**: pure rolling-upgrade compatibility (A class)
  is removable; no version negotiation needed.
- **Legacy execution regime is FROZEN** — only touch managed-agent paths.
- **CSI cold archive #17415** (`0c2458a3ca0`, 2026-11-16, on main) moved K8s
  Runtime / Resident Workspace / Workspace CSI / Harness Pool discovery into
  `packages/sdk-java/managed-kubernetes-archive/` and removed CSI-only
  schema/config/endpoints/maintenance entry points from the live server.
  Consequence: **A4 is dropped entirely**; the CSI-specific parts of A1/A2
  (`CsiFilesRetirementProfile.supportsStorage` fence, `CsiNativeActivationProof`,
  `WorkspaceCsiRuntimeMain`/`WorkspaceCsiWorkerAckMain`) are gone with the archive.
- A/B/C classification: A = pure rolling-upgrade compat (removable); B = dual-active
  regime selectors (product decisions, frozen — separate design doc); C = single-version
  integrity gates (keep).

## 4. Current state and commit chain

Branch commits (base `1de5c0b34b9`):

| SHA           | Content                                                               |
| ------------- | --------------------------------------------------------------------- |
| `07dcb1ae782` | A2 — drop server-side `minimumReader` negotiation                     |
| `3f6d762b11d` | A5 — unify hosted action options to a single shape                    |
| `71209ac6a39` | A1 phase 1 — strip Session storage-version negotiation (non-CSI core) |
| `ccd977bcf33` | design doc (migrated original; CSI revision pending)                  |
| `1cd82710281` | A5 implementation note in design doc                                  |

**Verified green on this base (2026-11-19):**

- Java `test-compile` clean; `ManagedSessionStoreIntegrationTest` 16,
  `ManagedSessionStoreWiringTest` 13, `ManagedSideQueryStoreTest` 9,
  `ManagedActionsTest` 50 — BUILD SUCCESS.
- Core `tsc --noEmit` clean; `http-managed-session-store.test.ts` 243.
- CLI `src/serve/hosted-tool-approval.test.ts` (A5 parser) 14.

The two earlier Java failures were environment-only (missing `-am`; live-TS test
run before dist build), not regressions.

## 5. Key structural facts (verify against current code before relying)

- **A1 `storage_version` had four roles:** ① reader fence (HTTP header
  `X-Qwen-Managed-Max-Readable-Storage-Version`, `StorageReadPolicy` /
  `ManagedSessionReaderVersion` / `ManagedStorageVersions`) — **removed**;
  ② writer-grant negotiation (`WriterGrant.supportedStorageVersion`,
  `supportedStorage()`) — **removed**; ③ CSI profile fence — **archived**;
  ④ activity-rebuild marker (`JournalCommit` `storageVersion()>=4`,
  `rebuildActivityBatch`) — **kept**. The `storage_version` column,
  `storageFloor()`, and the `needsVersionTwo` → `/transactions:commit-v2` route
  are **kept** (functional, not compat).
- **A2:** authority stopped writing `minimumReader`; shared parser
  `managed-session-records.ts` made it optional (present still validated to keep
  local standalone `/2`); Java genesis/history closed set 7→6.
- **A5:** action-options v1/v2/v3 → single v3 (optional `inputRef`/`continuationRef`)
  - v4 question; validation by field presence; continuation guards keyed on
    `continuationRef` presence; `storageFloor` promotes on `continuationRef` presence.
- Conflict-resolution principle used in the rebuild: **take main's structure +
  remove `readerVersion`**; archived CSI files auto-resolve to deletion.

## 6. Next steps (ordered)

### 6.1 Design-doc CSI-archive revision (do first; bilingual)

Update `docs/design/2026-11-19-managed-agent-version-convergence.md` **and**
`.zh-CN.md` to reflect #17415. Keep both languages complete and synchronized
(root AGENTS.md design-doc rule). Affected EN locations (line numbers approximate;
re-grep before editing):

- Title (line 1) and Problem (10–11): drop "CSI handles" / A4 from scope.
- A1 ② writer-grant (58–67): remove CSI-profile derivation of `supportedStorage`.
- A1 ③ "CSI profile capability fence" (74–80): mark moot/archived.
- A2 (149): `CsiNativeActivationProof` reference — archived.
- **A4 section (168–213)** and **Phase 4 (335–347)**: mark superseded by the
  archive (do not silently delete history; annotate as obsolete).
- Validation plan / Phasing and follow-ups: drop A4, note CSI archive.
- Add a short note recording #17415 and that the A batch is now A2/A5/A1(non-CSI).

This is a documentation-only change: formatting + reference checks, no Java rerun.

### 6.2 A1 Layer 2 — drop the `storage_version` column (needs user decision)

Open question: when an activity summary is absent but the journal holds activity
data, what durable signal drives rebuild once the column is gone? Resolve this
before removing the column. **Await user decision**; do not start unprompted.

### 6.3 A3 — tool protocol v2/v3/v4 convergence (needs user decision)

Requires unifying the encoding first. A maintainer started this in the
`bright-leaf` worktree (essentially B3). **Await user decision / coordination.**

### 6.4 Old-branch cleanup (after 6.1 lands)

Once the design doc is revised on this branch and the main checkout's parallel
B-session edits are committed/stashed by their owner, switch the main checkout
off `feat/managed-version-convergence-a` and delete it. Do not touch the
B-session's uncommitted design-doc edits or untracked B-regime docs.

## 7. Verification environment gotchas

- JDK 21; Maven `~/apache-maven-3.9.12/bin/mvn`; isolated repo
  `-Dmaven.repo.local=/tmp/verconv-m2` (APFS clone). Sibling SDK already installed
  there (`com/alibaba/qwencode-sdk/0.1.0-alpha`).
- Run Maven from `packages/managed-agent-server`. **`-pl verification` requires
  `-am`** or sibling `runtime-*` modules fail to resolve (looks like a test red,
  is not).
- **Live-TS Java integration tests need built `packages/core/dist` +
  `packages/cli/dist`** — run `npm run build` from the worktree root first
  (already done; rebuild if stale).
- Strip inherited env: `env -u QWEN_RUNTIME_DIR -u QWEN_CODE_MANAGED_NPM_PIN -u QWEN_CODE_NO_RELAUNCH`.
- CLI `tsc` OOMs at default heap: `NODE_OPTIONS=--max-old-space-size=8192`.
- Concurrent vitest shares a coverage dir → ENOENT crash (not a test failure):
  use `--coverage.enabled=false --reporter=basic`.
- Focused Java example:
  `mvn -Dmaven.repo.local=/tmp/verconv-m2 -Dcheckstyle.skip=true -Dspotbugs.skip=true -Dtest='ManagedSessionStoreIntegrationTest,ManagedActionsTest' -pl verification -am test`
- Keep full gates (Checkstyle, SpotBugs, MySQL, full suites) in CI; local budget
  is 10 minutes per change (module AGENTS.md).
