# Managed Session rename: single display authority

[简体中文](2026-11-12-managed-rename-single-authority.zh-CN.md)

Status: implemented; focused H2 regression verified locally, real-MySQL and
fault-profile qualification pending CI. Date: 2026-11-12.

## Problem

A manual Session rename is delivered as a cross-store saga. Java admits the
command, claims a delivery under a lease, attaches the Hosted Harness, sends a
revisioned title, waits for the Harness to commit a `session_metadata` journal
record, and only then settles the public SQL receipt. A background coordinator
redelivers unfinished titles, a parked-operation reconciler settles unanswered
submissions from journal evidence (D7-2), and close/archive/delete/cwd/workspace
migration all refuse admission while a title delivery is unfinished. The
revision watermark is implemented three times: the Java store, the Java SDK, and
the TypeScript journal authority.

The guarantee this machinery buys is "HTTP 200 means the title is durable in
both the public SQL row and the private journal." That guarantee is
**self-imposed and asymmetric**:

- The Harness is an active title producer. Child sessions
  (`packages/cli/src/serve/create-sub-session.ts`) and scheduled tasks
  (`packages/cli/src/serve/scheduled-task-keepalive.ts`) write `titleSource:
'auto'` metadata into the journal.
- There is **no journal-to-SQL title projection**. The only two
  `UPDATE ma_session SET title` sites in the persistence module are both inside
  the rename saga (`AgentSessionCommands` settlement and the D7-2 reconciler in
  `AgentExecutionOperations`). Auto titles therefore never reach the public SQL
  row; the list shows the creation title while the transcript shows the auto
  title, and the system already tolerates that divergence indefinitely.

So the expensive path protects a consistency property that the cheap path does
not provide, for a field that is pure display metadata. The session title is not
consumed by the main model context, by child naming (which uses the child's own
name/prompt), or by automation execution. The saga is a complexity ratchet: it
originated as a follow-up to #13163, and each race fix (stale sibling write, lost
reply, unanswered submission) added another fence — revision, claim/lease,
redelivery, parked evidence — that a single-authority design would not need.

## Current state

Verified flow (manual rename):

1. `ManagedAgentService.renameSession` validates the idempotency key, replays a
   completed command, applies actor/role/visibility gates, requires a Harness
   advertising title protocol version 1 (`supportsFencedTitles`), and calls
   `store.beginSessionRename`.
2. The request claims the delivery (`claimRename`), attaches the Harness,
   `markRenameSubmitted`, calls `harness.rename(tenant, session, title,
revision)`, then `completeSessionRename`.
3. The SDK `HostedHarnessClient.updateSessionTitle` posts
   `/session/:id/title` with `managedRenameRevision`.
4. The Harness route commits a `session_metadata` domain record with
   `commandId: hosted-title:${revision}`; the journal authority compares the
   persisted watermark inside its serial transaction
   (`packages/core/src/managed-runtime/managed-session-authority.ts`) and refuses
   older revisions with `ManagedSessionTitleSupersededError`.
5. On failure the request abandons and retries the delivery;
   `SessionRenameCoordinator` scans `deliverableRenames` every second and
   redelivers under a lease; an unanswered submission parks `recovery_blocked`
   and `RenameEvidence` lets `OperationReconciler` settle it from the journal.

Schema: `ma_session.title_revision` (monotonic counter) and the generic
`ma_operation.delivery_state / claim_owner / claim_until` columns. The
`ma_delivery` table is unrelated (CHANNEL / SESSION_MESSAGE / CHILD_RESULT).

## Goals

- Make a manual rename a **synchronous local SQL mutation**, following the
  existing `changeSessionModel` pattern (`AgentSessionPolicies`): lock the row,
  apply gates, compare-and-set the revision, update `ma_session`, insert a
  COMPLETED idempotency receipt, append a public event, return the confirmed
  title.
- Keep the journal as the **execution-side title copy**, updated by a
  **best-effort notification** that reuses the existing idempotent
  `hosted-title:${revision}` command identity and watermark. No new TS or SDK
  behavior.
- Delete the delivery saga: the background coordinator, the parked-rename
  evidence, the rename delivery store operations, and the lifecycle/migration
  title-delivery gates.
- Keep the public OpenAPI rename route and the WebShell rename contract
  unchanged (`sessionId`, `title`, `idempotencyKey` → `sessionId`, `title`,
  `replayed`).

## Non-goals

- No change to auto-naming, the journal record format, or cold-load title
  projection (`projectManagedSessionTitleInfo`).
- No new journal-to-SQL title projection. SQL is the public display authority;
  the journal copy serves transcript/cold-load display only.
- No change to other operation kinds' use of the shared `ma_operation` delivery
  columns.
- No change to the TypeScript journal authority, the SDK title API, or the
  Harness `/session/:id/title` route.

## Proposed solution

### Synchronous settlement

`renameSession` keeps its existing admission (idempotency replay, actor/role,
visibility, worktree readiness, title validation) and replaces the delivery
claim with a single store call, `settleRenameSync`, modeled on
`changeSessionModel`:

1. `requireLegacySessionForUpdate` (row lock shared with lifecycle admission).
2. Read `title_revision`, increment, refuse overflow.
3. `UPDATE ma_session SET title = ?, title_revision = ?, version = version + 1`
   with a revision CAS.
4. Insert the `SESSION_COMMAND` / `RENAME_SESSION` receipt as COMPLETED with the
   request digest; a duplicate key replays the recorded outcome.
5. Append the existing rename mutation event so other clients refresh.
6. Return the confirmed title synchronously.

The SQL transaction is the only durability boundary. There is no PENDING
command, no delivery row, no claim, and no lease.

### Best-effort journal notification

After the SQL transaction commits, the request calls
`harness.rename(tenant, session, title, revision)` once. The revision is the
`title_revision` just committed, so the journal watermark orders concurrent and
late notifications exactly as today.

- Success: the journal copy matches; nothing further.
- Failure (Harness unavailable, generation mismatch, sealed journal, transport
  error): log at debug and return the confirmed SQL title anyway. The journal
  copy lags until a later rename carries a higher revision. This is the same
  divergence the system already tolerates for auto titles, in reverse.

The notification is deliberately not retried by a background worker and is not
coupled to the receipt. A late notification that reaches a closed Session fails
against the sealed journal; the public SQL title is already correct, so the
failure is harmless.

### Capability gate

A rename no longer refuses admission when the Harness is unavailable or does not
advertise title protocol version 1. The SQL mutation always succeeds for an
authorized caller; the notification is sent only when the Harness supports
fenced titles, and skipped (logged) otherwise. This removes an availability
coupling that existed only to protect the dual-store guarantee.

### Deletions

- `control-plane/.../session/SessionRenameCoordinator.java` (whole class).
- `control-plane/.../session/RenameEvidence.java` (whole class) and its
  registration in the operation reconciler's evidence set.
- The RENAME arm of `OperationReconciler` / parked-operation handling.
- Store operations: `beginSessionRename`, `claimRename`, `markRenameSubmitted`,
  `completeSessionRename`, `abandonSessionRename`, `retryRename`,
  `deliverableRenames`, `renameAcceptance`, `settleParkedRename`, and the
  `RenameDelivery` model. `settleRenameSync` replaces them.
- The lifecycle admission gate that blocks on a pending rename command, and the
  workspace-migration idle gate that counts unfinished title deliveries.
- The `supportsFencedTitles` admission refusal in `renameSession` (retained only
  as a notification precondition).

`title_revision` stays (journal ordering). The shared `ma_operation` delivery
columns stay (other kinds use them). `harness.rename`, the SDK API, and the TS
route/watermark stay.

## Design decisions and rationale

- **SQL is the display authority, journal is a copy.** The public list/get reads
  SQL; making SQL authoritative removes the dual-write receipt coupling. The
  journal keeps the title because the Harness produces auto titles and cold-load
  projection restores them — that role is unchanged.
- **Best-effort, not at-least-once.** A display field does not justify a retry
  queue. The existing watermark makes any later notification converge, and a
  lost notification only delays the transcript copy, never the public title.
- **Reuse `changeSessionModel`.** It is the proven synchronous idempotent
  mutation shape in this codebase (row lock, revision CAS, COMPLETED receipt,
  public event). Matching it keeps rename consistent with model/approval
  selection and minimizes new code.
- **Keep the revision and the journal command identity.** They already provide
  ordering and idempotency on the execution side; reusing them means zero TS/SDK
  change and no new protocol.

## Constraints

- Module policy: edit the V1 schema baseline in place; recreate development
  catalogs. This change removes no column and adds none, so the baseline is
  unchanged; only Java behavior changes.
- The public OpenAPI document, `SurfaceRegistry`, and contract tests must stay
  consistent. The rename route and response shape are unchanged, so the spec is
  unchanged; contract tests continue to pass.
- SQL/transaction changes require real MySQL evidence in CI; H2 unit tests alone
  do not establish transaction behavior.
- The change is confined to `packages/managed-agent-server` (Java). It does not
  touch `packages/core` or other core-gated TypeScript paths.

## Risks

- **Journal title lag after a failed notification.** The transcript/cold-load
  copy shows the previous title until a later rename. Mitigation: the
  notification is attempted synchronously within the request, so lag occurs only
  on Harness failure; the public title is always correct. Accepted because the
  system already tolerates auto-title divergence.
- **In-flight deliveries at upgrade.** A catalog with PENDING rename deliveries
  from the old binary is not migrated by this change. Under the current
  fresh-schema alpha policy, development catalogs are recreated; a deployment
  carrying live deliveries must drain them with the old binary before cutover.
  This is called out in the release note.
- **Loss of the dual-store durability guarantee at HTTP 200.** Explicitly
  downgraded for a display field; documented here and in the README rename
  section.
- **Rename no longer establishes a Harness boot attachment.** The old saga
  attached the Harness (`createOrLoad`) to deliver the title and persisted
  `harness_boot_id`; the synchronous path does not. A renamed empty-input
  Session therefore closes through the `java_durable` admission stage rather
  than `harness_confirmed`, because no durable Harness attachment exists to
  confirm. Close still asks the Harness to close; only the admission-stage
  evidence differs. This is a visible consequence to call out in the PR.

## Validation plan

- Focused Java unit tests (H2): synchronous rename returns the confirmed title;
  same-key replay returns the original outcome; changed content under the same
  key conflicts; concurrent renames increment `title_revision` and the journal
  notification carries the committed revision; a failed notification still
  returns the SQL title and does not create a delivery or parked operation;
  close/delete are no longer blocked by a rename.
- Contract: `ManagedAgentApiContractTest` and `SurfaceRegistryGateTest` (route
  unchanged).
- Architecture: ArchUnit gates after deleting the coordinator/evidence classes.
- Real MySQL (CI `mysql-integration`): the settlement transaction and receipt
  replay under concurrency.
- TypeScript regression: the unchanged `/session/:id/title` route and watermark
  (`hosted-harness-session` tests) continue to pass; no TS change is expected.
- Removed: rename-specific delivery/redelivery/parked-recovery fault assertions,
  which no longer describe the behavior.

The exact affected test inventory is enumerated in the implementation plan.

## Acceptance criteria

- An authorized rename returns the confirmed title synchronously, with no
  PENDING operation, delivery row, claim, or lease.
- Same-key replay returns the original result; changed content or a different
  Session under the same key conflicts.
- Concurrent and late journal notifications are ordered by the committed
  revision; an older notification cannot overwrite a newer journal title.
- A failed or skipped journal notification does not fail the rename and does not
  schedule background redelivery.
- Close, archive, delete, cwd change, and workspace migration are not blocked by
  a rename.
- No background rename coordinator or parked-rename evidence remains.
- The public OpenAPI contract, WebShell types, and SurfaceRegistry are unchanged.

## Open questions

- None blocking. The execution-side consumer check found no model-context,
  child-naming, or automation dependency on the parent journal title; if a future
  feature adds one, the notification can be upgraded to a bounded at-least-once
  retry without restoring the dual-store receipt saga.
