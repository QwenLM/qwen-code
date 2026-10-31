# Native Skill archive installation

[English](2026-10-29-skill-archive-installation.md) | [简体中文](2026-10-29-skill-archive-installation.zh-CN.md)

## Status and baseline

Implementation approved on 2026-10-29, with expanded limits restricted to the new raw/file sources. The implementation starts from main `06fbfc9951c0a0833e57eb84a9b3625bb84f2853`, which includes [PR #15030](https://github.com/QwenLM/qwen-code/pull/15030) at `2415b12329b1bb0ef1b5beb6bfc0bd0535b9ee7b`.

## Current behavior and remaining need

| Dimension         | Current main                                                                    | Remaining need                                                                      |
| ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| ZIP transport     | Base64 JSON, at most 7,864,071 compressed bytes                                 | Transfer a real 20 MiB archive without raising the shared JSON limit                |
| HTTP JSON body    | 10 MiB                                                                          | Keep this limit for existing JSON routes                                            |
| Extracted package | 64 MiB total, 32 MiB per file, 2000 files                                       | Expand only the new raw/file archive sources; preserve all existing source policies |
| Extraction        | A complete compressed Buffer, followed by streamed entry writes and byte guards | Open a ZIP already on disk without buffering the entire archive                     |
| Sources           | GitHub URL, local folder, base64 ZIP                                            | Add a daemon-host ZIP file reference                                                |
| Publication       | Staging, validation, backup/rename/rollback, existing route mutex               | Reuse the current path for new transports                                           |
| Identity          | Existing name/path contract and manifest-name matching                          | Keep it unchanged in the first delivery                                             |

Two caller situations require different entry points: a browser has a File that must be uploaded; an integration may already have uploaded the archive onto the daemon host. Requiring the second caller to read and base64-encode that file would repeat the transport work.

The required behavior is large-file transport with bounded memory. Maximum accepted package size and complete compatibility with an external installer are separate requirements. The first delivery will not claim that every package accepted by another system can be installed by Qwen.

## Reference lessons

The inspected Codex snapshot is `a29c7b97e88367044ae84c28c85451ec3e72af9f`.

| Reference                    | Useful lesson                                        | Limit of the analogy                                                                       |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Python Skill installer       | Acquire content before installation                  | It buffers the repository ZIP and does not establish a bounded-memory design               |
| Rust remote plugin installer | Account for compressed and expanded bytes separately | Its 100 MiB / 512 MiB numbers are not Qwen requirements; compressed data is still buffered |
| Plugin sharing               | Send bulk bytes separately from JSON metadata        | A local daemon does not need the hosted upload-URL/finalize protocol                       |
| Plugin store                 | Give staging and publication explicit ownership      | It does not make a store rewrite necessary for a new ZIP input                             |

Existing application upload flows also show why an already-uploaded local file is a useful input. Product-specific chunking, object storage, publication, ownership policy, and error envelopes remain outside the native daemon protocol.

## Scope

This feature includes file-backed ZIP installation, raw HTTP upload, SDK and Web Shell integration, owned inputs, cancellable waiting, bounded attempt receipts, and focused publication/recovery safeguards. New archives use 200 MiB / 4096 entries; legacy-source limits, naming rules, GitHub fetching, folder copying, and the publisher structure remain unchanged.

Extending the new policy to legacy sources, redesigning identities or the publisher, cross-process locking, persistent transactions, automatic retries, and resumable uploads are outside this change.

## Installation contracts

### Already-uploaded ZIP

Extend the existing JSON source union:

```json
{
  "name": "example-skill",
  "scope": "global",
  "attemptId": "c72732d3-7e2e-4b91-8c39-ec0f5ed45176",
  "source": { "type": "zip-file", "path": "/absolute/path/example.zip" }
}
```

The path belongs to the daemon host, not the browser. Apply the existing authentication, trust, runtime ownership, and name validation. Require an absolute regular file, reject a symlink source and special files, validate the opened handle, and retain compressed-byte bounds. Qwen borrows the source and never deletes or renames it.

Copy a borrowed ZIP into an installer-owned disk file before waiting for the mutation lock. Extract only from that copy. The caller must keep the source stable during acquisition; it no longer needs to retain it unchanged throughout lock waiting and extraction. See the lifecycle decisions below for the limits of copying and optional `source.sha256` verification.

### Browser ZIP

Use one raw request with `Content-Type: application/octet-stream`:

| Route                                                                              | Ownership and activation                                                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `POST /workspace/config/skills/install-archive?name=...&attemptId=...`             | Global configuration; preserve the existing global owner/trust resolver and reconciliation |
| `POST /workspaces/:workspace/config/skills/install-archive?name=...&attemptId=...` | The selected trusted runtime, workspace scope; reconcile that runtime                      |

The route fixes scope. Resolve authentication, name, runtime, trust, content type, and admission before intake. Stream bytes into a private temporary file, enforcing the actual byte count with or without Content-Length. Reject HTTP content encoding. Unknown, untrusted, bootstrapping, draining, or removed runtimes retain their failure semantics and never fall back to the primary runtime.

After intake, use the same mutation mutex/key and installation path as existing requests. Keep the existing mutation result and activation behavior. The normal operation remains one synchronous POST, without upload sessions, a second commit request, resumable transfer, or a background-job service. Read-only attempt lookup confirms the outcome after a lost response.

The request owns and cleans its temporary file on every settled outcome. Do not use the generic workspace file-upload destination: it publishes a user file and has different scope and collision semantics. Reusing the shared SDK transport does not mean reusing a buffering HTTP parser.

### SDK and Web Shell

Add thin global and workspace archive-install methods. Generate an `attemptId` before sending new archive requests, retain it in client errors, and expose attempt lookup. Reuse existing binary-upload authentication, error handling, AbortSignal, and optional progress conventions. Preserve existing file-upload behavior.

Advertise `skill_archive_install`, `skill_zip_file_source`, and `maxSkillArchiveBytes` only where supported. Web Shell sends File/Blob directly when the raw capability is present. Otherwise, retain the 7,864,071-byte base64 path and report an upgrade requirement for larger input before uploading. Keep the current configuration/runtime split and activation handling.

The UI retains its busy state through installation and result lookup. Upload progress reaching 100% means intake has completed, not that installation succeeded. A lost response or timeout leaves the result unconfirmed until an attempt lookup supplies evidence. Do not automatically retry through another transport or treat an existing name/path as proof of this revision. Listing refresh remains useful for current inventory, independently of the historical attempt result.

### Approved source-policy and API boundaries

Only modern config installation routes accept `zip-file`; legacy runtime routes reject it with a config-route-required error. Old SDK runtime source types remain unchanged. Both new archive sources use 50 MiB compressed / 200 MiB retained expanded bytes / 4096 ZIP records. Ordinary resources have no separate cap below the remaining expanded budget. Validate all new-source entry paths/types before filtering, create retained files exclusively, then apply the 32 MiB limit to the effective root SKILL.md after the existing single-wrapper normalization and before reading it as text. Nested resource manifests remain ordinary resources. Do not introduce a full metadata planning framework.

SDK archive calls default to 130 seconds; timeoutMs=0 disables only the client timer. After uncertain completion, Web Shell makes one independent lookup with a 5-second timeout and offers a manual check if still running/unknown; never retransmit automatically. Committed content remains successful when activation fails, with a separate activation warning. Historical receipt reads follow config-read authorization and workspace identity, without entering the mutation coordinator or requiring the old generation to remain active. Removed/inaccessible owners never fall back to primary.

## Resource and lifecycle policy

| Budget                            | Fixed policy                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| New raw/file ZIP compressed bytes | 50 MiB                                                                                       |
| Legacy base64 compressed bytes    | 7,864,071 bytes, unchanged                                                                   |
| Expanded package                  | 200 MiB for new raw/file archives                                                            |
| Effective root SKILL.md           | 32 MiB, unchanged                                                                            |
| ZIP records                       | 4096 ZIP records for new sources, counted before filtering; legacy sources retain 2000 files |
| Paths                             | Existing 512-character / 16-depth rules                                                      |
| New local archive operations      | At most two admitted per daemon; reject excess before intake                                 |

50 MiB is the fixed transport ceiling, not a promise that every 50 MiB ZIP is installable. A ZIP must also satisfy all expanded-size, per-file, path, and manifest rules. Folder and GitHub policy remains unchanged.

Use one 120-second pre-publication budget covering intake/copying, lock waiting, and extraction; phases do not restart the clock. Check elapsed monotonic time again at publication admission. The SDK default is 130 seconds, but this is a client waiting budget, not proof of server rollback. Publication, rollback, and outstanding filesystem cleanup may outlast these budgets. The cancellation and receipt contract below explains that boundary.

A single owned archive plus candidate adds up to 250 MiB of temporary disk; two active operations add up to 500 MiB. Raw uploads are not recopied. Existing installations, backups, filesystem metadata, and crash leftovers are additional. Prefer passing an already-owned raw-upload file to the same internal file-opening extractor, without recopying it or exposing a public ownership-transfer flag. A borrowed file is copied once; its caller-owned original is outside the installer temporary-disk budget.

## Lifecycle decisions

### Borrowed-file changes

**Recommendation: an owned disk copy, normal change detection, and optional expected-content verification.** A read-only file descriptor binds the opened file identity, but another process can still modify or truncate that same file. A hard link has the same problem. Waiting for a lock while reading the borrowed ZIP later extends the exposure unnecessarily.

Open and validate a regular file handle without following the final symlink; check that the handle matches the validated input. Capture identity, size, and modification/change metadata, stream through a compressed-byte counter and SHA-256 hasher into a private exclusive file, then compare source metadata again. Fail on observed changes, a byte-count mismatch, or a limit violation. Close the writer and use only the owned copy for ZIP parsing and extraction. Once acquisition has finished, replacement or deletion of the original path must not affect this attempt; Qwen must never clean up that original path. A caller cannot infer completion of acquisition from elapsed time or upload progress: normally it retains the original until the request settles, unless server-reported phase evidence confirms acquisition has completed.

Copying is not an atomic snapshot of a concurrently written source. Before/after metadata checks detect ordinary races, not every hostile or undetectable edit. If the producer already knows the digest of the completed upload, it can supply optional `source.sha256`; reject a different acquired digest before extraction. This binds accepted bytes to the producer's expected content, not to a trusted author or a filesystem instant. Without that digest, the supported contract still requires a stable source during copying. The hash Qwen computes by itself identifies the acquired bytes and cannot prove what the producer intended.

| Option                                          | Guarantee / cost                                                 | Decision                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| Direct read-only handle                         | No copy; vulnerable to in-place edits throughout extraction      | Not the default                                          |
| Hard link or advisory lock                      | Hard links share writes; locks require every writer to cooperate | Does not establish the required isolation                |
| Owned copy plus checks                          | Stable extraction input after acquisition; one bounded disk copy | Recommended                                              |
| Owned copy plus producer digest                 | Also verifies the expected archive bytes                         | Optional for integrations with an existing upload digest |
| Filesystem snapshot or immutable upload service | Stronger source ownership, but platform/protocol dependencies    | Separate future requirement                              |

The copy costs up to one 50 MiB local read/write and temporary file. Hash while copying, rather than performing another complete read. For raw HTTP input, the completed private upload file is already the owned input. This removes source lifetime dependence during potentially long lock waits.

Codex's remote bundle path first owns the downloaded bytes, then extracts into its own TempDir. Its store copies into staging and checks manifest bytes before publication. These are useful ownership patterns, but neither proves point-in-time consistency of a borrowed local ZIP or all files in a mutable source directory. [Remote acquisition](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/core-plugins/src/remote_bundle.rs#L257-L301), [store staging](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/core-plugins/src/store.rs#L555-L638).

### Cancellation while waiting for the lock

**Recommendation: add optional cancellation to the existing mutex wait, preserve its ordering, and establish one publication admission boundary.** Keep the existing registry/key shared by old and new installs/deletes. Do not introduce a second archive-only lock or move the current critical section as part of this work. Callers without a signal keep their behavior; the shared filesystem consumers need regression coverage. Immediate busy rejection would avoid queue cancellation but change existing waiting behavior; leaving a cancelled request queued would retain files/admission capacity and could execute unexpectedly. The additive waiter change is the recommended tradeoff.

A waiter cancelled before admission must promptly stop waiting, must never call the installation callback, and must detach its abort listener and release its owned input after real I/O stops. For the current Promise-tail implementation, a cancelled waiter's ordering link must remain behind its predecessor until that predecessor settles. The callback and package payload need not remain attached. Do not delete the key merely because the cancelled caller returned. With A holding the lock and B waiting, cancelling B must not allow C to overlap A. Cleanup of the map tail happens only once its ordering chain has actually settled and it is still the current tail.

Check the signal both before joining the queue and immediately after admission. During intake/extraction, cancellation stops actual streams and prevents further work; retain the lock and admission lease until active work settles. A race against the acquisition wait is valid only if the losing waiter is safely retired. Racing the entire installation Promise against a timer is insufficient because installation may continue after the client is told it was cancelled.

Immediately before the first destination-changing rename, synchronously check cancellation, deadline, and runtime eligibility and enter the publishing phase without an intervening await. Cancellation processed first prevents publication. Publication admitted first finishes commit or rollback without being interrupted by an HTTP abort or client deadline. Runtime-generation checks and filesystem failures still follow the existing consistency/rollback path; shielding is not permission to publish into a removed runtime.

| Phase                              | Cancellation semantics                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| Intake / owned-copy preparation    | Stop I/O, await closure, clean owned files; no publication                        |
| Waiting for mutation lock          | Retire this waiter; never invoke its callback; preserve other waiters' ordering   |
| Extracting / validating under lock | Stop real work, clean staging, then release the lock                              |
| Publishing / restoring backup      | Finish the consistent outcome; cancellation can no longer promise no installation |

A client AbortSignal expresses a cancellation request. Only server-observed disconnect/cancellation or its own deadline can enforce the fence; a proxy may delay disconnect propagation. A client-side AbortError alone is not cancellation confirmation. There is no separate cancellation endpoint; attempt lookup reports whether publication happened.

Codex's plugin synchronization gate has a separate 120-second acquisition timeout. Its enterprise-login flow explicitly races gate acquisition with cancellation and shares cancellation/commit admission state. Its goal writer keeps ownership of a lock through background I/O even if the RPC disappears. The latter two are different subsystems, cited as lifecycle patterns, not plugin API guarantees. [Plugin gate](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/core-plugins/src/manager.rs#L1723-L1735), [cancellable wait](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/app-server/src/request_processors/account_processor/enterprise_login.rs#L161-L174), [commit admission](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/app-server/src/request_processors/account_processor/enterprise_login.rs#L262-L293), [I/O ownership](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/app-server/src/request_processors/thread_goal_user_context.rs#L24-L50).

### Confirming the result after a timeout

**Recommendation: a client-generated attempt ID and a bounded, in-memory receipt per attempt.** This adds real protocol scope, but ordinary Skill inventory cannot distinguish an old installation, this attempt, and a later overwrite. A synchronous POST remains the normal API; receipts are for reconciliation after an uncertain response, not a task scheduler.

For new raw/file calls, generate a UUID `attemptId` before transmission: a JSON field for file sources and a query parameter for raw upload. The SDK preserves it even when no response arrives. After authorization and admission, reserve a receipt before reading the body. Bind it to the resolved global/workspace owner, runtime generation where applicable, target name, and acquired archive SHA-256 once available. Possession of an ID grants no additional access.

Read-only lookup routes are `GET /workspace/config/skills/install-attempts/:attemptId` and `GET /workspaces/:workspace/config/skills/install-attempts/:attemptId`. They obey the same ownership, authentication, and visibility boundary. An unavailable/removed runtime must not fall back to another owner. Query with a new bounded read request, not the already-aborted installation signal.

| Receipt result                 | What the client can conclude                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`                      | The attempt is still active; include its phase, and do not resubmit                                                                           |
| `committed`                    | This attempt completed publication of the recorded archive bytes; runtime activation and current inventory remain separate                    |
| `not_committed`                | The attempt never published, or restoration of the prior state was confirmed; include the failure/cancellation reason                         |
| `recovery_required`            | Publication/rollback failed to establish a confirmed restored state; do not claim cancellation or retry automatically                         |
| Unknown / no accessible record | No conclusion about success or failure; the request may not have arrived, the record may have expired, or the daemon/runtime may have changed |

Record `committed` at the installer’s final commit boundary, after its last possible generation-driven rollback decision, before returning through service/HTTP layers. Do not derive it from an HTTP 200 alone. Later runtime, activation, or refresh failures must not relabel committed content as absent; retain the committed outcome alongside those errors. Best-effort backup cleanup can continue while ownership of active work is retained. A receipt is historical: another install, deletion, or external edit can change the current directory afterwards. The archive digest identifies the input, not a verified hash of the current expanded tree. A checked lookup of current inventory answers a different question.

Keep active receipts until work settles; retain terminal outcomes for 10 minutes and a total capacity of 256 receipts. Reserve capacity before mutation and reject new attempts when full rather than evict an unexpired promised receipt. These are fixed defaults, not public configuration knobs. Duplicate IDs within the same owner/retention window must never execute again; return a conflict and direct the caller to lookup, even if a different payload is supplied. This is bounded duplicate suppression, not durable exactly-once execution or an automatic replay contract. New raw/file calls require the ID; existing-source requests retain their old contract.

A daemon restart loses these receipts. Unknown must stay unknown, never become “failed, safe to retry.” Do not add automatic retry, cross-restart deduplication, or persistence in the first delivery. A separate receipt file written after rename leaves a crash gap; a marker inside the candidate changes package metadata and does not cover later legacy/external writers; a durable transaction journal is a separate design. If recovery across restart is mandatory, this bounded receipt design is insufficient and that stronger requirement must be designed before promising it.

The focused rollback change distinguishes confirmed restoration from `recovery_required` and preserves recoverable backups across later installs. Failure to clean an unpublished candidate must not prevent restoration of the previous installation. Tests cover lost responses, late abort during commit, failed restore, later overwrite, duplicate IDs, receipt capacity/expiry, and restart/owner disappearance.

Codex defines `installAttemptId` as a client-generated correlation identifier and forwards it to the remote install request, checking the returned plugin identity and enabled state. The inspected client code does not establish a query-by-attempt endpoint, backend idempotency, or crash-durable results. The Qwen receipt above is this design’s addition, not a Codex feature claim. [Protocol definition](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs#L956-L975), [remote request](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/core-plugins/src/remote.rs#L1641-L1683).

## Reuse and correctness boundaries

The current ZIP opening helper is the Buffer-specific boundary. The remaining extraction path consumes a ZIP reader, so a file-opening branch reuses lazy entry traversal, path checks, declared-size checks, actual-byte guards, wrapper flattening, manifest checks, and publication. Keep the owned PassThrough for stream teardown and the existing inflater.

Implementation validation found that yauzl 2.10's fd-slicer dependency marks a file stream destroyed before its buffered compressed bytes drain on current Node versions. A valid 70 MiB entry stalled after 60,071,690 output bytes with 58,163 compressed bytes stranded; the same archive completed through 2.10's Buffer input and yauzl 3.4's file input. The CLI therefore upgrades to yauzl 3.4, already present elsewhere in the repository, with the legacy installer suite retained as regression coverage. No custom file reader or inflater is introduced.

Do not move the mutation lock, add cross-process locking, rewrite folder copying, or build an archive framework merely to add the new input. New routes must participate in the existing lock; this design does not claim cross-daemon serialization.

A failed rollback reports `recovery_required` with retained paths. Subsequent installs must preserve abandoned backups; successful installs still remove the backup they created. This protection applies to every source, including legacy base64, directories and GitHub: after receipt expiry or process restart, an installer cannot safely distinguish disposable backups from the only recoverable copy. Fault-injection tests cover failed restoration followed by another install. No automatic recovery program or publisher rewrite is introduced.

## Validation and acceptance

The completed baseline used the global `qwen 0.22.0`, not the merged main bundle. Small ZIP and folder requests succeeded with identical bytes; a real 20 MiB ZIP in a 27,962,121-byte JSON request received 413; zip-file received 400 and raw upload received 404. That version lacks the modern configuration routes, so these results do not verify their current-main behavior. Temporary inputs were retained and the test daemon was cleaned up.

The unmodified main bundle at the pinned baseline was also verified: modern config routes installed small ZIP and folder inputs with identical bytes; the real 20 MiB base64 request returned 413, `zip-file` returned 400, and raw upload returned 404. This is the baseline for the implementation checks below:

- A real 20 MiB archive installed through both raw and file inputs, with byte-for-byte comparison and no whole-archive Buffer on the new paths.
- New-source 50 MiB compressed / 200 MiB expanded / 4096-entry boundaries and effective-root 32 MiB manifest checks; preserve 64 MiB / 32 MiB / 2000-file boundaries for legacy sources.
- Shared old/new path behavior for traversal, symlinks, duplicates, wrapper directories, manifests, GitHub fallback, and base64 compatibility.
- Interrupted intake, malformed declared sizes, staging write failure, timeout while waiting for a lock, closed runtime generation, and replacement failure; real work settles, temporary files close/clean up, and the old installation is preserved where the operation has not committed.
- Correct global and selected-runtime activation; no primary fallback in rejected workspace states.
- SDK fetch/XHR behavior, old-daemon fallback, and unchanged generic file upload.
- Measured memory and temporary disk during two large operations, plus rejection of a third.

The new 4096 limit counts every explicit ZIP record, including directories and ignored metadata; implicit parent directories are not counted again. Expanded bytes count only retained files. Keeping this policy on the new sources avoids tightening legacy directory layouts. Name compatibility and managed ownership need separate acceptance, not a claim based on upload success.

## Verification boundaries

Use the fixed policies above without adding configuration knobs. Measure memory and temporary disk, exercise cancellation and recovery faults, and run independent real HTTP and browser acceptance against the built bundle. Record the actual operating system and browser; source inspection and unit tests do not imply cross-platform or browser acceptance. The E2E report records execution evidence separately from this design.

## Sources

- [Merged Qwen installer](https://github.com/QwenLM/qwen-code/blob/2415b12329b1bb0ef1b5beb6bfc0bd0535b9ee7b/packages/cli/src/serve/workspace-skill-management.ts), [Skill routes](https://github.com/QwenLM/qwen-code/blob/2415b12329b1bb0ef1b5beb6bfc0bd0535b9ee7b/packages/cli/src/serve/routes/workspace-skills.ts), [JSON middleware](https://github.com/QwenLM/qwen-code/blob/2415b12329b1bb0ef1b5beb6bfc0bd0535b9ee7b/packages/cli/src/serve/server/error-handlers.ts).
- [Codex Python installer](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/skills/src/assets/samples/skill-installer/scripts/install-skill-from-github.py), [remote bundle](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/core-plugins/src/remote_bundle.rs), [plugin store](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/core-plugins/src/store.rs), [plugin sharing](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/core-plugins/src/remote/share.rs).
