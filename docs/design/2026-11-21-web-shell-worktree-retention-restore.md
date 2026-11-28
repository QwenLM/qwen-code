# Managed session worktree retention and restore (P6 U4/U5)

[English](2026-11-21-web-shell-worktree-retention-restore.md) | [简体中文](2026-11-21-web-shell-worktree-retention-restore.zh-CN.md)

- Status: U4/U5 is delivered on `main` in [PR #18009](https://github.com/QwenLM/qwen-code/pull/18009) as squash commit `ed5d033e813f90ecb12153ae3307fd035d4b3741`; U4/U5 acceptance remains tracked in [#17237](https://github.com/QwenLM/qwen-code/issues/17237). Follow-up validation on the pre-squash head of that PR (`68a4074b60a4a161e94eb8eaa9e7a467f9977653`, not a `main` commit) covered retention guards, snapshot moves, restore fencing, and isolated primary+secondary HTTP/Chromium restore. GitHub CI results for the merge commit remain separate from these facts. Later P6/P7 remains out of scope.
- Investigated on: `01b7e92f61b1593517acd1e4afe752d431280e90`.
- Tracks: [#17237](https://github.com/QwenLM/qwen-code/issues/17237), P6 U4/U5 only.
- Builds on: `2026-11-17-worktree-carry-metadata.md` and `2026-11-17-worktree-retention-snapshots.md`.
- E2E plan: `.qwen/e2e-tests/2026-11-21-web-shell-worktree-retention-restore.md`.
- Progress on 2026-11-21: core snapshot, binding, and pin-store suites passed 167 checks; the affected CLI route suites passed 380; archive lifecycle passed 123; the DaemonClient SDK suite passed 579; the SessionOverviewPanel suite passed 182. The filtered lifecycle tests also passed 71. After fixing stale live/cache lifecycle projection, the expanded restoration-preview suite passed 10/10 and the existing session-list suite passed 64/64. The real primary and secondary HTTP/browser validation has also completed; it is not inferred from those suites or the earlier baselines.
- The mode deviation found by the baseline is fixed at the archive extraction boundary: node-tar did not apply the captured mode to reused HEAD files. Replacing those files on restore retains the snapshot's owner-executable bit. This is not a blanket checkout-wide permission normalization or a claim that untested platforms are covered.

## Problem and pre-change state

The snapshot and dirty-overlay primitives already exist. `captureWorktreeSnapshot`, `buildWorktreeSnapshotMeta`, and `restoreWorktreeSnapshot` in `packages/core/src/services/worktree-snapshot-service.ts` preserve raw file bytes, owner-executable bits, symlinks, hardlinks, and tracked deletions, while excluding `.git`, the session marker, and ignored regenerable output. The protected cleanup path in `packages/cli/src/serve/server/worktree-orphan-cleanup.ts` already refuses removal on hidden index bits, pending operations, initialized submodules, drift, or an unverifiable checkout.

The remaining gap is orchestration, not tar support:

- `worktree.maxRetained` is declared but still reserved, has no retention reader, is not exposed through the daemon settings allowlist, and its Chinese description explicitly says that the sweep is not applied (`packages/cli/src/config/settingsSchema.ts`, `packages/cli/src/config/config.ts`, `packages/core/src/config/config.ts`, `packages/cli/src/serve/routes/workspace-settings.ts`).
- There is no retention sweep, no per-session archive selector, and no production caller of snapshot restore.
- A `WorktreeSession` has no removed-plus-snapshot state. More importantly, `restoreWorktreeContext` can clear the binding when the directory is unavailable (`packages/core/src/services/worktreeSessionService.ts`).
- Ordinary archive/unarchive relocates transcripts and worktree sidecars, but not the snapshot pairs stored beside them. Snapshot state can therefore become detached from its owner.
- `executeWorktreeCleanup` returns no removal outcome and assumes its session record has already been deleted. It cannot be used wholesale by a retained-chat sweep.
- The pin store deliberately degrades an unreadable store to an empty store for ordinary UI reads. That behavior must not authorize retention deletion: the raw reader `readStoreDocument()` is available in `packages/core/src/services/session-organization-service.ts` and must be the basis for a strict, scoped pin check.
- The only supported restore target of `restoreWorktreeSnapshot` is fresh reconstruction. It does not select an archive, create a Git worktree or its owner marker, verify repository objects, or atomically update its sidecar. Calling it directly against a nonempty directory is unsafe.

P7/configurable worktree roots, the existing age-based tool/agent sweep, arena/managed-agent session storage, Java lifecycle code, archive-expiry knobs, and the separately tracked R5/coverage suggestions are out of scope.

## Decisions and boundaries

### 1. Count only a uniquely owned management root

A sweep belongs to its selected workspace runtime, its own `SessionService`, and its own persisted stores. It does not enumerate the primary workspace by default or move resources into a different runtime. A candidate must pass the existing strict ownership and containment checks, including the route-owned `workspaceCwd`, source root, slug, marker, and expected managed-root derivation.

**Coverage is daemon-wide**: every active, eligible, non-internal runtime returned by `workspaceRegistry.list()` is included, whether primary or secondary. Each runtime uses its own settings, session/pin stores, bridge, lifecycle generation, and in-flight bookkeeping; a non-primary runtime's operations are never redirected to the primary runtime's settings or storage. Internal/scratch runtimes must stay out unless they are explicitly within the requested worktree scope.

For a linked checkout, raw `cwd`/transcript cwd and `originalCwd` alone do not establish daemon workspace ownership. `originalCwd` locates the creating worktree service/repository, while `workspaceCwd`, the marker, runtime-local storage, the current registry, and the session-owner index prove the owner. Parent/containment relationships use canonical realpaths, and where parent candidates are exposed by workspace discovery, the most specific matching registered parent scope applies rather than the outer primary by default. That relationship must agree with the current runtime owner, not merely a string prefix or `$QWEN_CODE_PROJECT_DIR`. A legacy record without attested `workspaceCwd`, or another record/root whose unique owner cannot be proven, is preserved and reported rather than being swept by assumption.

The count is scoped by the canonical managed root resolved from the validated source root and `getUserWorktreesDir()`, not by an arbitrary path prefix or only by a repository name. Different independently owned roots sweep independently.

If two runtimes claim the same canonical management root, or their effective settings conflict, automatic sweeping of that root stops with a diagnostic. Unknown workspace ownership, an untrusted workspace, a draining runtime, or an unreadable root has the same result. There is no cross-runtime aggregate count and no fallback to the primary runtime. This is the user-selected conservative boundary, rather than inventing a distributed lock or an implicit settings winner.

The ownership map is computed across eligible sibling runtimes before cleanup proceeds. An unreadable root, environment, or settings entry pauses automatic sweeping until that evidence is restored: otherwise an unattested sibling could share the supposedly unique candidate root. Each workspace's settings, storage and limit still apply independently, but independence does not authorize deletion from an incomplete ownership map. This is a deliberate conservative pause, not a bridge for quietly ignoring secondary workspaces.

Only eligible, ownership-verified records count toward `N`. Active and pinned chats receive additional protection and do not consume the deletion-eligible quota: the recent `N` eligible records plus protected extras survive. A session whose runtime-status record in the selected or candidate runtime bases names a live owner process in another process (for example a TUI that resumed it) is treated as active and preserved, and so is any record that exists there but cannot be verified from this process (corrupt, unreadable, newer schema, another PID namespace, or another host sharing the runtime base). Checkouts that contain any registered daemon workspace are also preserved. Sessions created by the daemon normally have no runtime record, and treating that absence as active would disable retention. Select older eligible records first after protecting the newest `N`. Chat records and sidecars survive; only the eligible checkout is reclaimed.

Last activity comes from the existing persisted session/transcript timestamps, with live activity taking the newer value where already available. When there is no readable session timestamp but ownership of a sidecar is established, a validated sidecar/snapshot timestamp is the defined fallback. Raw directory mtime is not activity. Unreadable or invalid timestamps do not silently become the oldest item to delete.

### 2. Preserve orphan archives rather than guess their ownership

Without a verifiable surviving record and sidecar, an archive is not automatically deleted by count, age, or restore probing. There is no new TTL setting and no automatic “orphan cleanup” in this phase.

Likewise, an orphan archive must not manufacture a new live chat or guess a repository from its filename. Its snapshot header carries capture metadata, not a complete repository/workspace ownership proof. Recovery without a valid owner remains a separate later policy decision. This does not delete the artifact or assert that it is useless to a human.

### 3. Every retention removal has a snapshot

Before a retention sweep deletes any eligible checkout, it captures that checkout. This applies even when a pristine carried overlay could otherwise be bare-collected under the existing session-deletion rules. The source may change after cleanup; the retained chat must have a usable snapshot for later restoration.

The existing U3 bare-delete outcome for other lifecycle paths remains unchanged. U3's hydrated `needsSnapshot` value, `worktreeHasWork`, pre/post content digests, hidden-index checks, pending-operation checks, carried-source verification, populated-gitlink checks, and `checkoutMatchesCapture` remain shared safety behavior. An unreadable or non-representable state preserves the checkout rather than weakening these invariants.

A removal that is refused or preserved may already have created a pair for that attempt. Only that attempt's exact, selected pair may be discarded, after ownership, marker, liveness, runtime state, hidden-index, pending-operation, populated-gitlink, and actual checkout contents are revalidated against it. An unchanged checkout is then sufficient evidence that the redundant copy is not needed. A newly pinned session always keeps its checkout, but that pin does not require accumulating another identical, unbound pair on every sweep once the intact checkout has been verified. Any ambiguity, changed state, or partial/mismatched checkout preserves the pair. Pre-existing and other-session/orphan archives are neither promoted nor pruned by this bounded same-attempt cleanup; there is no TTL or general orphan sweep, and no claim that multiple filesystem unlink operations form a larger atomic transaction.

### 4. The removed state is explicit and keyed to its archive pair

Proposed optional sidecar state, retaining the existing back-compatible fields:

```text
worktreeRemoved?: { archiveKey: string }
```

`archiveKey` is the validated tar basename only, with no directory component, traversal, or platform separator substitution. Its JSON header filename is the corresponding `.json` basename. The stable key permits relocation of the pair during archive/unarchive instead of recording a path that goes stale when the location changes.

For an eligible retention attempt, the exact validated snapshot pair is bound and the surviving sidecar is written and re-read before the destructive remove is called. If this persistence fails, the removal must not happen. The binding can therefore describe a removal already in progress, not only a completed historical removal; ordinary load must never turn it back into an active checkout by itself. Snapshot creation, an HTTP `removed` response, or `removeUserWorktree().success` alone still is not proof of physical removal. `branchPreserved`, `keptBranch`, and partial-removal diagnostics remain distinct and determine the subsequent branch policy. `removeUserWorktree`'s unmerged-commit and ref-ownership guards remain unchanged.

A later refusal or non-removal clears that attempt binding only when no remove was attempted, or the checkout still strictly matches this snapshot including bytes, tracked deletions, HEAD/branch, and markers. An attempted partial or mismatched removal retains both the binding and pair for recovery; it is not treated as an intact active checkout nor is its archive silently discarded. Transcript activity read failures remain a conservative pause, not an instruction to delete unrelated healthy work.

The 64 KiB sidecar cap still applies. Existing `fitSidecarToReadCap` may discard `carriedEntries` to preserve the binding, but it must preserve the removal record. A sidecar with a malformed removal record is invalid, not silently “clean.” Strict readers use the current `readWorktreeSessionStrict` contract; new state is not accepted through permissive parsing.

Creation provenance such as `originalCwd`, `workspaceCwd`, `originalHeadCommit`, and `worktreeBase` is not rewritten to make later history look like the original creation. Capture-time `headCommit` and `branch` govern snapshot recovery; a mutable `worktreeBranch` reflects the reconstructed checkout, so a detached restoration cannot accidentally acquire ownership of the old slug-derived ref. Existing carry metadata is retained where valid, but restoration must not invent a new carry exemption.

An accepted capture must also pass the same bounded decompression/readability checks that restoration uses. A created archive which cannot be read under those limits must fail before publication, rather than allow loss of the checkout with no usable recovery pair. Readable large payloads remain supported by real extraction and byte checks; this does not weaken archive or decompression limits.

Capture, comparison and archive inspection reject a symlink target containing U+FFFD. The filesystem/tar string bridge cannot distinguish a raw target that was not valid UTF-8 from a literal replacement code point. Re-encoding it and calling that byte-for-byte recovery would be false evidence; the conservative boundary also refuses the literal U+FFFD target. Other valid UTF-8 symlink targets retain their existing behavior.

### 5. Snapshot pairs follow archive/unarchive, with failure visibility

Archive/unarchive must move every owned matching snapshot pair with its transcript and sidecar, across `chats/` and `chats/archive/`. Pair identity is checked against `sessionId`, `slug`, basename/header correspondence, and the removal record; arbitrary same-prefix files are not promoted to owned archives. Ordinary archive of a valid, existing checkout remains non-destructive and does not create a snapshot.

A partial move, unreadable pair, duplicate/conflicting destination, or ambiguous active/archived location fails visibly and preserves recoverable artifacts. It must not make a reader silently select an unrelated older copy in the other directory. Reads use the pair belonging to the current validated archive state. The selector never follows a directory-level or file-level symlink to escape the owned location.

A missing or unreadable legacy sidecar is not evidence of an owned pair and grants no move authority: neither it nor unassociated files are altered. Reconciliation without a pre-existing removal binding is limited to the historical post-checkout-removal case verified by runtime ownership, managed coordinates, and one selected valid same-session/slug pair across the two archive-state directories. Multiple legitimate generations within one directory still use the established selector's newest-valid policy. Valid candidate pairs on both sides are ambiguous and must not be promoted or overwritten. Existing strict valid removal bindings retain the same handling. If a caller cannot establish whether an older tombstone owner is live, that owner remains a blocker. Mutated records and already-archived/already-active records share that reconciliation. Snapshot relocation and scheduled-task maintenance are attempted independently after a committed record mutation so a failure cannot silently skip the other one; multiple failures are reported as an aggregate without erasing the history of the applied mutation.

Each destination link newly created by a move is registered by path and `(dev, ino)` immediately after `link()` succeeds, before a later target-identity probe can fail. A transient probe failure therefore uses the same identity-checked rollback when the retry of that read succeeds; an identity that remains unverifiable is retained and reported rather than deleted as an unowned or pre-existing file. On failure, only that invocation's proven targets are rolled back: a source with the same identity permits removal of its duplicate target alias; a missing source is first restored with a non-clobbering link and then that target is removed. Replaced entities and pre-existing destination conflicts are never overwritten. Any rollback failure is retained in an aggregate with the original failure; this is recoverable replay of these known links, not a claim that arbitrary process crashes or two directory merges are atomic. After moving, the selector's return value must be checked against both expected destination paths. A missing or mismatched pair is an explicit move failure, never a successful migration with a dangling removal binding.

A restored chat whose worktree was removed must still have its archive operations coordinated with restoration. Existing archive coordination order is preserved; snapshots are never moved while a restore is selecting or extracting them without that coordination.

### 6. A missing directory is not itself permission to restore

`worktreeRemoved` must be handled before the generic missing-directory cleanup, so a recognized removed state is not erased as stale state. The after-removal record-write failure described below may also reconcile a missing binding from a strictly matching historical pair. Other, older non-daemon cases without a qualifying pair keep their existing behavior unless separately reviewed; generic CLI/agent worktrees are not pulled into this feature.

A valid retained binding is excluded from the TUI's active-worktree projection. Ordinary clearing moves the existing record into a private staging directory under the owning parent. A retained record is restored through a non-clobbering `fs.link` and rejected with `WorktreeRestoreRefusedError`; retry failures preserve the staged artifact and/or the recovered original rather than discard its only owner pointer. A binding published after the rename is not the staged entry and is not unlinked by this operation. Directory errors retain their previous behavior, and no global multi-process atomicity is claimed. The durable variant uses the same protection. Resume surfaces the existing `onWarn` warning after filtering it from the active projection.

The TUI also re-reads after the filesystem watcher is installed, so a binding written between the first read and watcher registration cannot remain an indefinitely stale active indicator. Older asynchronous reads still cannot overwrite a newer retained state.

A write failure after a successful physical removal can leave the old sidecar plus a new archive. Recovery may reconcile this only when the record belongs to the selected runtime, its ownership is valid, the expected location is no longer a verified live checkout, and a complete pair matches the same session/slug. That candidate can offer restoration, but must not be described as proof of an atomic historical removal. Snapshot production and sidecar mutation are not an atomic transaction.

An absent directory alone, a stale `.git` pointer, a random snapshot with a matching prefix, or an error saying only “not found” is not sufficient evidence. The existing load/reset paths must distinguish an accepted restoration candidate from unrecognizable stale state. Read-only enumeration does not silently repair state; a recognized write is part of owned retention reconciliation or restore.

## Shared capture/removal helper

Refactor narrowly inside the existing cleanup implementation, rather than create a second deletion pipeline:

- Keep the existing ordering and guard conditions in `worktree-orphan-cleanup.ts`.
- Extract an internal execution seam that returns structured `removed`/`preserved` outcomes, snapshot information, and the true branch/removal result.
- Keep `executeWorktreeCleanup` as a compatible wrapper that discards the result for existing callers.
- Give retention an explicit `requireSnapshot` option and an optional protection callback. With a binding callback, the full guard runs once before binding and again after it is persisted. Scope, pin, live and cron reads start each pass; content digest, hidden-index, carried-source, gitlink and exact-pair comparisons still follow. Pending-Git verification is the last check after those Git-reading checks, so a bisect started after archive verification cannot slip through without changing bytes.
- Reuse `preclassifyWorktreeCleanup`/`verifyWorktreeCleanupOwnership` for an existing checkout, with the selected runtime's storage and bridge. Never call session-deletion entry points that would remove the surviving chat or its attachments.

This is not an abstract repository of cleanup algorithms. There are two call sites sharing the same safety-critical execution path, with no change to the stricter conditions already exercised by U3.

## U4: runtime-scoped retention orchestration

Add a focused daemon module beside the existing worktree cleanup code, with collocated tests. Do not place the scheduler in ACP bridge idle-turn reaping. Start it only for eligible, trusted workspace runtimes and stop it through the same per-runtime lifecycle used for scheduled work. Enumerate every active, trusted, non-internal runtime returned by the registry, not only the primary. The same coverage applies to runtime additions, draining/cancel paths, removals, and generations: a closed, blocked, removed, or untrusted runtime receives no new destructive retention action. In particular, a missing scope is not a reason to use `resolveWorkspaceCwd(undefined)` as a primary fallback when it cannot be proven to own this request.

Relevant existing seams are `server.ts` per-runtime start/stop maps and `scheduledActivity`, plus the workspace add/drain hooks in `run-qwen-serve.ts` and `captureRuntimeGenerationAssertion` before ownership attestation or destructive mutation. A positively identified ordinary non-Git workspace has no managed-worktree root and must not veto an independent repository's sweep; before treating one as non-Git, the runtime directory and its ancestors must all lack `.git` without a metadata-read failure. A `.git` entry combined with failed root discovery, or an unreadable directory, remains an unknown root and pauses the affected root rather than being filtered out. A sibling's unreadable settings also remain preserved evidence: they block only an attested shared management root, not an unrelated repository, and must never become a default quota. A `.worktree.json` filename alone does not let a sweep choose between active and archived state: use the existing maintainable-location classification, and if it conflicts or differs from the sidecar being scanned, or if the other archive state also has a sidecar for that session, retain the checkout instead of selecting one copy by directory order. Cleaning ownership scans every sidecar in both the active and archived stores for the same canonical checkout, not only the current session's directory. The current filename is excluded by full path, never by copying the same basename from the other archive state. A non-tombstone or unreadable record in either state must preserve the checkout. A direct reset tombstone retains its existing exception; older tombstones still require the established liveness proof.

Only a trusted runtime is the target of an automatic sweep. An active but untrusted sibling is never swept by that call, yet it is not discarded from collision proof: an attested shared management root still refuses automatic reclamation, because the selected runtime's storage never examined the other runtime's records. The scheduler must:

1. evaluate configuration for this runtime, not a process-global primary profile;
2. enumerate the runtime's own active and archived session sidecars with strict reads;
3. classify only uniquely owned roots and eligible candidates, avoiding duplicate sweeps for one root;
4. acquire `acquireWorktreeOwnershipOp` using its canonical-path/raw-fallback key rule and keep the existing ownership-lock → archive-coordinator ordering;
5. revalidate ownership, strict liveness/pinned state, and all U3 conditions immediately before destructive steps;
6. capture, validate and atomically persist/re-read its snapshot binding, then remove and confirm the filesystem outcome; and
7. account for in-flight work so workspace stop/drain waits for the scheduled operation without killing a Git or metadata write halfway through.

Cancellation between candidates is allowed. Cancellation after a Git/metadata mutation starts must follow the existing `removeUserWorktree` finish-preserving semantics rather than force-killing the writer. Recovery on restart follows the ownership rules above, not blind resumption of an old in-memory snapshot.

A workspace-scoped stop also returns its in-flight promise to the runtime-removal disposer. Workspace removal and trust reconfiguration must await it before bridge shutdown; the daemon-global close keeps its separate aggregate drain and retained stop errors. Existing cleanup logging and logical force-removal convergence remain, but completion cannot overtake an operational retention Git/filesystem mutation.

For live checks, only an explicit not-found answer from a session that is not closing can count as absent; query absence, failure, or closing state remains protective. Enabled, session-bound durable scheduled tasks are protected by the same binding semantics as the keepalive, before their offline bridge sessions are rehydrated. Read those bindings from the selected runtime's own cron store and recheck them after capture, before destructive removal; a task enabled during capture must veto deletion. Disabled or unbound tasks have no protection effect, and another runtime's store is not a substitute. An unreadable or corrupt store is an unknown state and pauses retention, never evidence that no tasks exist. For pin checks, a small strict getter should reuse `readStoreDocument()` and the same storage and store-lock semantics, while distinguishing a genuinely absent entry from an unreadable/corrupt store. Do not change the ordinary UI's degraded pin display semantics. A later pin change after a committed physical removal still leaves the archive and the retained chat recoverable, but is not represented as protected before that removal. No claim is made of a cross-process distributed pin or task-binding transaction.

## U5: deterministic archive selection

Extend `worktree-snapshot-service.ts` with a small session selector, using the existing header reader and root/package exports rather than a new archive format.

For each qualified pair in the validated current archive directory, it:

- restricts enumeration to exact session-prefixed snapshot names and header pairs;
- rejects a pair whose basename violates the no-directory-component key rule or whose explicitly keyed JSON header names another session/slug;
- without an explicit key, considers only complete pairs whose headers match the requested session and slug. A different slug is not adopted as a candidate; a different session, unreadable metadata or unsafe member remains a refusal;
- requires supported schema version 2, a complete nonempty expected pair, and complete valid header content, including a nonnegative safe-integer `createdAt` in epoch milliseconds;
- requires regular files and the established no-symlink/link-ownership constraints on its own inputs; and
- orders by header `createdAt`, then archive `mtimeNs`, then the full archive path deterministically, never by directory enumeration order. Compare the filesystem `mtimeNs` as `bigint` without converting it to `Number`; serialize it to a decimal string if it must appear in JSON evidence.

An unreadable or malformed competing header, an unknown version, or an unreadable directory rejects selection; it does not silently fall back to an older valid-looking archive. Unrelated files are not invented as session snapshots. An explicitly bound `archiveKey` selects only that exact pair for lookup and validation. A missing member returns no match, and unrelated pairs cannot mask or replace the requested pair. During unkeyed selection, `ENOENT` while checking a pair member skips that candidate and allows the search to continue. A readable complete pair whose header proves another slug is also skipped, and prefix alone never transfers ownership. Different session ids, unreadable or malformed headers, unknown versions, unsafe members, and other filesystem errors still reject selection.

The existing `checkoutMatchesCapture` is a capture-time result, not durable authentication embedded in the archive. Selection does not claim that the pair is signed or that a prior deletion was inevitably committed. It establishes structure, ownership binding, and a deterministic choice for a subsequent guarded restore.

## U5: guarded restoration orchestration

Add a restore operation beside the current worktree flow in `packages/cli/src/serve/routes/session.ts`, rather than changing reset into a different ownership-transfer feature. A natural route shape is `POST /session/:id/worktree-restore`, using the same runtime resolver/owner-activity model as reset. The endpoint accepts no raw target directory or arbitrary archive path; snapshot choice is owned and revalidated by the server.

The operation proceeds as follows:

For a secondary or linked-workspace call, the client must explicitly provide the registered workspace `cwd` that owns the session. The request must not rely on the resolver's default primary when `cwd` is absent. The restore operation itself enforces this requirement using whether the caller actually supplied that scope, rather than relying on a resolver-only `runtime.primary` check. Only genuinely primary-owned state may use default-primary normalization. That `cwd` must agree with the sidecar's registered owner, the marker, and the live-owner resolution. Missing, noncanonical, wrong-runtime, untrusted, ambiguous, or mismatched owner evidence is rejected rather than retargeted to primary. The existing default-primary normalization is preserved only for genuinely primary-owned flows.

1. Resolve the selected workspace runtime and the stored session id (`resolveRuntimeForSessionRestore`, `createWorkspaceRuntimeSessionService`, and the stored-id resolver). The concrete workspace-qualified scope must match the sidecar's `workspaceCwd`; no primary-workspace fallback for an absent or ambiguous scope.
2. Strictly read the worktree record and validate root/source/slug containment for the currently selected runtime. Reuse ownership resolution with a missing-checkout variant: a missing expected target under the owned managed root is not the failure that the existing reset's `realpathSync` rule must report, and it must never be redirected to a primary workspace.
3. Acquire the worktree ownership lock and archive coordination in their established order. Under that coordination, an archived record is rejected with an instruction to explicitly unarchive first; do not reconstruct the checkout, extract the archive, or clear its removal binding and only then let ordinary load reject it as archived. Re-read the sidecar under the lock, distinguish an accepted restoration candidate from stale state, and revalidate that its class has not changed. Before creating a missing target, strictly inspect the selected runtime's active and archived sidecars. A direct reset tombstone naming this session is allowed; other tombstones require their named old owners to be definitely not live. A non-tombstone competing claim or an unreadable record prevents reconstruction instead of manufacturing a new owner merely because the directory is absent.
4. Select the newest valid pair. Require `headCommit` to be a full hexadecimal object id of the repository's actual object format (40 hex characters for SHA-1, 64 for SHA-256), never an empty value, option-looking string, or merely a ref fallback. Verify that exact commit object exists in the **same source repository**. Missing objects fail before creating or unpacking anything; archives do not contain the Git object database or promise remote fetch recovery.
5. For a captured named branch, attach it only if the intended ref still resolves to the captured head and is not an unsafe/out-of-scope reference. If the ref is missing, moved ahead, or ambiguous, restore detached at `headCommit`, report that the named ref was untouched, and update the current branch field to its actual value. `createUserWorktree(..., { detached: true })` is the no-ref-rewrite path; never use a reset/rebase to force a user's branch to an older point.
6. Require a fresh, owned target. Merely calling `mkdir` or restore is not reconstruction: `createUserWorktree` and `getUserWorktreePath` must be used so the checkout, its administrative Git registration, and its managed root remain consistent. An existing or unexpected nonempty/alien directory is refused, never cleared or overwritten.
7. Call `restoreWorktreeSnapshot` with the selected header, then create the marker via `createWorktreeSessionMarkerExclusive` for the selected stored session id. `.git` and the marker stay outside the snapshot.
8. Verify restored content against the selected archive: raw bytes, owner executable bits, real link targets, recorded deletions, and expected commit, including unsafe/non-regular late entries. Compare the capture-selected commit and the actual reconstructed branch state (empty when intentionally detached), rather than mechanically rejecting a valid detached fallback because it differs from the captured branch name. Reuse the existing comparison duties in the snapshot area instead of a weaker path-existence check. Compare after extraction and again before final sidecar mutation where needed. Regenerable ignored output stays outside the unchanged U1 promise. Archive membership takes precedence for a force-added ignored file: reconstructing the checkout's index may make that file look ignored again, but the verifier must still compare its captured bytes and detect late changes rather than dropping it from the current-file set. Directory membership is part of the comparison too, including empty directories: a captured empty directory that is later missing, or an empty directory created after capture, invalidates the integrity proof. Existing disposable ignored-output exclusions remain unchanged. A directory must not be treated as a regular-file hardlink target.
9. Atomically update the surviving sidecar to clear the removed state, with actual current branch/path/carry identity, and confirm the marker and checkout still validate. Only then permit ordinary `restoreSessionCore` to relocate/open the session's checkout and expose the restored state to clients.

A symlink or hardlink whose archive name ends in `/` is not a directory. Directory identity comes from the member type and actual ancestors; file/link names canonicalize their logical identity without that suffix. Two members that would hide the same logical path, including a directory alias hiding a link, invalidate the comparison. A real `Directory` member and a matching empty directory remain valid. Comparing only the path suffix would let a damaged archive authenticate the wrong object.

A recreated HEAD can also recreate the parent directories of deleted tracked files. After files and links are restored, inspect the deleted paths deepest-first and `rmdir` only a parent directory that is absent from the archive and currently empty. An explicitly captured empty directory, every parent with other content, and every non-directory entry are preserved. If new content arrives during cleanup, the directory removal fails instead of deleting that content.

After both content comparisons and the runtime-generation checks, marker ownership is checked again before writing the active sidecar. A moved, missing, foreign or unreadable marker prevents the recovery binding from being cleared; the directory and selected pair remain protected. Restoration therefore does not authenticate a checkout merely because its file bytes match.

The worktree ownership lease continues after the archive exclusive finishes, into the ordinary session load. The archive exclusive must finish before the load enters archive shared coordination. Ordinary load verifies that the handoff key matches the current sidecar checkout and then participates in normal bridge registration. Retention cannot acquire that worktree's ownership lock during the restored-but-not-yet-live handoff and cannot undo a successful registration already accepted. The handoff is internal, not an HTTP-provided bypass or a synthetic pin; an idempotent outer finally releases it on completion, error, cancellation or bridge failure.

### Failure and retry behavior

Restore is not a promise of an all-or-nothing Git and filesystem transaction. On failure, retain the archive and any pre-existing work, and report an explicit failure state rather than claiming success. If extraction or marker setup fails, or runtime generation closes before marker creation, in a target which this restore attempt newly created, during error compensation, read the marker's current strict state: only a marker that is still missing permits removal of that new target and pruning of its Git registration. A committed marker, a marker owned by another session, or an invalid/unreadable marker preserves the whole target; no recursive delete is justified. A genuinely marker-less newly created target keeps its bounded cleanup so a later retry can start cleanly. This is not permission to clear an existing/partial restore directory. The archive and removal binding remain available; after repairing the archive, a retry is allowed to reconstruct it and bind the session. An original extraction failure remains distinguishable from cleanup failure rather than becoming a marker error.

- A malformed archive, hostile member, missing commit, unexpected target, or failing marker blocks further recovery and preserves existing/user-owned files. Only a newly created target from the failed attempt may be cleaned as described above.
- A failure after extracting/marker creation but before the sidecar flip retains a removal record as conservative state. A later retry may be binding finalization **only** when the owned marker, expected target, and content are proven to match the selected pair. Otherwise it fails without re-extracting over the directory.
- Late user changes, corrupt or partial snapshot content, extra unknown files, and target drift must not be cleared to produce a successful-looking result. A preserved snapshot and a visible failure reason remain available.
- Invalid archive metadata or unreadable source/competing headers never falls back to a different archive or a different repository.

Continuation of ordinary load still verifies realpath containment, marker owner, and the real target, as it does today in `session-restore.ts`. A successful 2xx response is returned only after that proof, not after an archive read or a directory-creation call. When the authoritative strict sidecar under the ownership lock carries `worktreeRemoved`, ordinary load/resume rejects before the bridge restore with a typed 409 (`worktree_restore_unavailable`) and points to `/session/:id/worktree-restore`; an unbound legacy checkout without a qualifying same-session/slug pair keeps its existing validation/error behavior. An exact historical candidate is offered for explicit restoration rather than ordinary reopening of a missing checkout, while retention can durably reconcile its missing binding under the ownership checks. Regular ignore/regenerable-output and index-state limitations are unchanged: staged-vs-unstaged index state is not restored, and states which previously failed closed must remain preserved rather than being “fixed” by a sweep.

## Configuration, SDK, API, and UI

### Settings

Use `worktree.maxRetained` as the sole count setting, default 15, with `0` disabling sweeping. Add non-negative safe-integer validation based on the existing settings machinery: negatives, fractions, non-finite values, and wrong types are not accepted or silently coerced into 0 or 15. `0` must take effect before enumeration, rather than being lost through a truthiness check. It disables only automatic sweeping, not an explicit, ownership-checked restore.

The retention settings reader must use `preserveInvalidWorkspaceSettings: true` from the existing `LoadSettingsOptions`, or equivalent strict error propagation. Malformed workspace configuration must not be rewritten to an empty/default object and then authorize deletion. Refresh effective settings between root-level runs and keep one validated settings snapshot per run; hot updates affect the next run rather than retroactively redefining a deletion already in flight. Other settings and unrelated daemon UI behavior must retain their current degradation/compatibility behavior.

Complete every existing boundary instead of bypassing it:

- keep the retention quota out of the static worktree-creation Config: its strict runtime settings reader owns `worktree.maxRetained`, while the core worktree-creation settings contain only their existing symlink-directory options;
- the effective precedence already provided by `packages/cli/src/config/settings.ts` (system defaults, user, workspace, system);
- `WEB_SHELL_SETTINGS` and its public settings alias, type and drift tests;
- the generated VS Code settings schema; and
- the schema description and relevant Web Shell settings messages, including removing “not yet applied” only once the consumer and restore surface both exist.

`showInDialog`/allowlist behavior must follow the current number-row pattern rather than add a parallel number editor. The description must name the default, protected active/pinned behavior, the `0` opt-out, and the unique-root/ownership restrictions rather than promise a global N across unrelated workspaces.

### Session metadata and restore API

Expose semantic recovery state, not local archive paths or arbitrary archive keys, through the existing session-summary/worktree projection in `packages/cli/src/serve/server/session-list.ts` and `packages/sdk-typescript/src/daemon/types.ts`. Only meaningful removal/recovery fields are added; ordinary legacy records preserve their existing shape. Do not default an absent field to “restorable.”

A recoverable record retains its branch/slug binding through `deriveSessionCards`. Do not drop it merely because the physical directory or old marker is gone. Extend `DaemonClient`/`DaemonSessionClient` using the existing request/workspace scoping pattern and encode the session id with the current helper; add the corresponding SDK method and compatibility/invalid-scope tests. The restore client must wait for final server completion before calling the ordinary reopen/load path. `RestoreWorktreeSessionRequest` is exported from the TypeScript SDK root as well as its daemon submodule. The overview uses the existing action layer and `DaemonSessionClient.restoreWorktree` to obtain a hydrated client with its replay, epoch, history flags, artifacts and owner context, then passes that same client through `PendingSessionLoad` into the provider. The provider consumes it instead of issuing another `/session/load`, preserving the server registration under one lifecycle and its original replay semantics. A cancelled, timed-out, superseded or unmounted pre-adoption restore detaches only that pending client. After adoption, normal replay and cleanup rules own it; the restore flow must not manufacture a second registration or decrement another active attach reference.

For secondary/linked calls, the browser and SDK must obtain the **selected registered owner workspace `cwd`** from the current runtime/discovery context rather than blindly reuse transcript cwd, which may identify a child worktree directory rather than the registered workspace root. Omitting or substituting an unverified scope is a refusal, not permission to fall back to primary.

If the endpoint is promoted into the supported public REST integration surface, update **all** of `GUIDE_OPERATIONS`, `SDK_METHOD_BY_OPERATION`, `docs/developers/daemon-rest-api.openapi.json`, the existing operation IDs/types, and the existing integration-guide tables. Test them with `rest-integration-docs-contract.test.ts`; no new operation may be added to only one layer. Choosing that promoted surface is an explicit compatibility decision; keeping the endpoint internal/capability-gated must not be described as expanding the stable public integration contract. The separate `check-contract-version.js` tool applies to the **Managed Agent public API contract**, not automatically to this daemon REST document.

### Web Shell

Use `SessionOverviewPanel.tsx` and its current busy/error/open model and workspace-scoped client calls. Keep the entry in Session Overview rather than adding a phantom row to `GitWorktreesDialog`, which only lists real Git worktrees.

- A valid record with a removed checkout exposes a restore affordance, with loading, pending, unavailable, and read-failure distinctions.
- Opening a removed record must not silently fall back to the source checkout. The explicit restore flow completes first, then calls the normal open path.
- Disable the action during its own operation and while incompatible lifecycle actions are running; use the existing busy/error behavior rather than another watcher subsystem.
- Failure exposes the conservative reason without hiding the retained archive or a partial restored target.
- Do not reuse `ManagedSessionWorktrees.tsx` or the separate arena/provider API as a model for this local daemon sidecar data.

Use current `sessionsOverview.*`/`gitWorktrees.*` i18n placement and English/Chinese (and other applicable locale fallback) conventions. Tests must use complete state-bearing fixtures, not only a snapshot-free `worktreeRemoved: true` flag, and prove that unavailable scopes do not become actionable.

## Proposed file groups

| Area                     | Existing files to extend, with focused additions where needed                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot and sidecar     | `packages/core/src/services/worktree-snapshot-service.ts`, `worktreeSessionService.ts`, `sessionService.ts`, `session-organization-service.ts`                                                  |
| Protected removal        | `packages/cli/src/serve/server/worktree-orphan-cleanup.ts`, plus a focused retention module and its collocated tests                                                                            |
| Restore/load/activity    | `packages/cli/src/serve/routes/session.ts`, `server/session-restore.ts`, `server.ts`, `run-qwen-serve.ts`, runtime-scoped storage/resolution helpers                                            |
| Settings                 | `packages/cli/src/config/settingsSchema.ts`, `config.ts`, `settings.ts`, `packages/core/src/config/config.ts`, `packages/cli/src/serve/routes/workspace-settings.ts`, generated settings schema |
| Public/client projection | `packages/cli/src/serve/server/session-list.ts`, `packages/sdk-typescript/src/daemon/{types,DaemonClient,DaemonSessionClient}.ts`, index exports as required                                    |
| Web Shell                | `components/SessionOverviewPanel.tsx`, `client/i18n.tsx`, `client/settings/messages.ts`, relevant settings alias/drift/UI tests                                                                 |

Every added optional field requires an explicit producer, validator, projection, and consumer check across these layers. An unused optional flag is not an implementation.

## Catalog lifecycle freshness

Persisted worktree sidecars, together with their exact same-session/slug archive pairs, are authoritative for `worktreeRemoved.archiveKey` and `canRestore`. A historical missing binding is inferred only after the ownership and coordinate checks; an arbitrary missing legacy record does not become restorable. When a live summary still carries an older checkout, its complete worktree object must not overwrite a newer removal or resurrect that removal after a successful restore. Other live worktree fields retain their existing merge behavior. Concurrent PR/artifact metadata de-duplication must not freeze this lifecycle state: each catalog view verifies the current sidecar and, when applicable, validates its keyed snapshot pair. Preview uses the restore operation's actual ownership, original-CWD, and supersession classification rather than trusting only `workspaceCwd`. An inconclusive revalidation cannot convert a removal binding into an ordinary active checkout or confirm restorability: cached removal information may be retained, while `canRestore` is false until the current record is valid again.

Presence and corruption are distinct during preview. The same identity-checked lenient read invokes `onInvalid` for a present but unusable sidecar. That preserves the cached removal binding while forcing `canRestore=false`; beware that genuinely absent (`ENOENT`) records keep the ordinary missing-state behavior. Unexpected read failures are also not permission to reopen an active checkout. For one enrichment call with eligible candidates, the selected runtime's root and Git-derived source roots are attested at most once and shared by its read-only previews, rather than spawning Git separately for every retained row. Quiet preview suppresses delete-action advisory logging, not workspace/source/supersession checks. Preview is an availability hint only: the actual restore route revalidates ownership, the management root, and the exact pair.

## Acceptance and verification

Implementation must satisfy the detailed cases in `.qwen/e2e-tests/2026-11-21-web-shell-worktree-retention-restore.md`, including at least:

1. Real Git/tar/filesystem archives containing dirty tracked/untracked content, tracked deletions, file-directory swaps, executable bits, links, and the intended regenerated-output exclusions.
2. Root retention keeps exactly the newest N eligible worktrees, with `0` disabling and active/pinned records protected separately. Invalid settings, unknown pin store state, root collisions, and unknown ownership preserve rather than delete.
3. The retained chat/transcript/sidecar survive retention; checkout removal is confirmed on the filesystem; every accepted removal has the keyed archive pair. Ordinary archive/unarchive still preserves existing checkout content and bindings.
4. Restore recreates the managed target with the captured HEAD and real dirty/deleted/mode/link content. No existing nonempty target is overwritten, and a moved named branch is never reset.
5. Missing objects required by a restore, malformed headers, hostile archive members, and a stale or wrong workspace fail closed without moving ownership or discarding archives. Unkeyed selection skips a candidate with a missing pair member. A keyed restore requires the exact bound pair.
6. After-remove sidecar-write failure is reconciled from strict ownership and valid pairs; after-restore/before-binding failure is completed only by a strictly matching verification, not a blind re-extraction.
7. Scheduled activity prevents shutdown from stranding in-flight work, while retention, archive, reset, and restore serialize their ownership-critical sections.
8. A supported API selection preserves old responses, the SDK method actually invokes the correct scoped route, and a real Session Overview restore click causes the actual HTTP restoration followed by successful load.

On Linux/Node 26, the completed isolated run used real primary and secondary runtime homes, storage, Git repositories, and filesystem state, with a mock model provider and real Chromium. Both retained targets restored through their own registered owner `cwd`, with content, deletion, `0755`, detached HEAD, owner-marker, and archive checks. A later primary removal produced a fresh binding agreed by storage and the owner-scoped preview. Corrupting that selected tar produced a visible UI error and an actual `TAR_BAD_ARCHIVE`/500 response without creating an owner marker or overwriting the bound archive or removal state. Evidence is under `/tmp/qwen-u45-baseline3-B2sRuw/evidence/` (`report.json`, `ui-done.json`, `overview-after-restore.png`, and `restore-failure-visible.png`). This is that environment's integration result, not a claim that every CI lane or another platform has passed.

## Out of scope and residual limits

- P7/custom root semantics and coordinated changes to `worktree.root`, root migration, or shell-guard policy.
- Deleting orphan archives, a retention TTL, a global cross-runtime aggregate counter, a new distributed locking layer, or production debug sweep/remove endpoints.
- Restoring a vanished orphan archive into a guessed workspace, arbitrary user-selected archive directories, or recovering an unrelated manual `git worktree remove` solely because the path is absent.
- A byte-for-byte transactional guarantee covering Git object stores, external process crashes, archive/header write pairs, and arbitrary concurrent raw filesystem edits. The selected-runtime safeguards and the partial-state recovery above are the limits of this phase.
- Detecting a surviving child process that still holds a checkout but never wrote a runtime-status record, such as an ACP child orphaned by a killed daemon; the sweep only sees owners visible to the cross-process liveness oracle.
- Changing archive `jobs: 1`, sparse/index rules, branch ownership guards, the accepted older-Git compatibility path, or broad lifecycle conventions to make feature tests easier.
