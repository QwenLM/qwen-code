# Selective session restore implementation plan

- Status: Proposed; as of 2026-08-12, #8691, #8833, #8882, and exact-shape
  restore coalescing in #8933 are merged; selective implementation starts from
  fresh `main` containing #8933 merge commit `962dc8e`
- Design: `docs/design/2026-08-08-selective-session-restore.md`
- Tracks: #8678

## Delivery rule

The delivery order is merged #8691, #8833, and #8882; exact-shape restore
coalescing in #8933; this selective-restore implementation; and then the durable
checkpoint. #8824 was superseded by this split series. #8883's legacy watchdog
retry fix and the later PR3c/PR3d resync/repair and branch-adoption slices are not
prerequisites for this bounded-hydration implementation.

Create a separate Draft branch from fresh `main`, confirm its history contains
#8882 and #8933, and rerun their transactional and request-shape regressions
before adding projection code. Do not add selective commits to #8743, #8882, or
#8933.

Implement selective restore as one end-to-end daemon fix. Reviewable commits may
follow the phases below, but do not merge an intermediate PR that only removes a
pre-lease load or moves `historyPageSize`: the post-lease read remains
authoritative until the selective projection replaces it, and early I/O bounding
is incomplete until every runtime consumer uses that projection. Do not merge an
unused projection API, change TUI/export/fork loading, or add checkpoint
persistence in this PR. Keep daemon live-task read/wait/startup lookup and
realtime startup-context full-content reads outside this slice as well: they do
not consume the ACP restore result and need a separate bounded-content contract
before migration.

The implementation is complete only when the cold ACP daemon restore path no
longer calls `SessionService.loadSession()`, constructs one fresh transcript
index in the correct startup-frozen writer mode, restores every named runtime
consumer, and returns the requested replay semantics.

This is a feature spanning core, CLI, ACP bridge, and daemon consumers. Before
implementation, report its production-logic line count and cross-package/core
ownership to maintainers and obtain an explicit scope review. Do not disguise a
large refactor as this feature: if the implementation becomes a 500+
production-line core `refactor`, the repository's maintainer-only gate applies.

## Phase 1: Shared selective projection

- Extend the existing `SessionTranscriptReader` index with separate runtime and
  replay UUID chains plus the minimum projection hints named in the design.
- Extend `estimateIndexCacheBytes()` for all newly retained index metadata,
  including container, key, value, and base-object overhead. Add hint-heavy
  cache-budget tests that exercise every new category and prove that an index
  whose own estimate exceeds the entire cache budget may serve requests sharing
  its in-flight build, but its completed value is not cached and its byte-budget
  admission does not evict already-cached values. Retain existing pending
  coalescing and entry-count or aggregate LRU behavior.
- Keep a cold fresh index request-local until selected-record validation and the
  final signature/lease checks succeed, then offer it to the cache only if the
  key is still empty and admission does not evict existing values. Use pending
  identity checks on resolve/reject so a stale pending build cannot overwrite or
  delete a newer entry.
- Add a single cold restore-projection read that selects and deduplicates runtime,
  replay, file-history, artifact, goal, telemetry, attribution, recorder, and ACP
  state records. Return no projection only for an empty/all-unparseable active
  file, preserving the current empty-resume behavior; project, snapshot, selected
  record, and size failures remain typed errors rather than empty fallbacks.
- Add a narrow live restore result backed by the same index/selected-read
  internals: replay plus artifacts for live load, artifacts only for live resume.
  Do not express this as optional flags on the complete cold runtime result.
- Reuse existing fragment aggregation, chain walking, page alignment, cursor
  snapshot checks, artifact reducers, goal recovery, and error classes.
- Preserve the 256 MiB index cap, 4 MiB recent-page source budget, 16 MiB bounded
  expansion ceiling, and a shared 32 MiB explicitly recent serialized
  bulk-replay ceiling.
- Reuse the exact prompt-id/turn helper semantics, stream every active
  file-history batch through the existing reducer while retaining only its final
  100-snapshot state, and derive a side-task source boundary from the completed
  active chain rather than the last physical source record.
- Normalize Goal inputs while dispatching selected records: retain parsed v2
  lifecycle state and only the raw legacy `goal_status` candidates needed by the
  existing reducers, including malformed candidates that affect precedence;
  discard unrelated slash-command output.
- Treat a pending Goal checkpoint as a restore consumer. Extract a bounded
  evidence selector and accumulator shared with the existing Goal
  evidence-window builder. Retain bounded eligibility, lineage, preview,
  proof-kind, catalog-byte, malformed-context, and turn-reentry hints without
  content; after Goal recovery fixes the permit and cursor, use those
  active-chain hints to select the production-equivalent bounded evidence UUIDs
  or reproduce the helper's fail-closed error, materialize only that union, and
  include the accumulated window in the projection. Prohibit all-record
  selection, a second scan, or restore-time fallback to
  `readActiveTranscriptChain()` or the old loader.
- Dispatch aggregated records directly to consumer reducers instead of building
  a catch-all selected-record array. Stream artifact inputs into an incremental
  form of the existing reducer and retain only the rebuilt snapshot.
- Process the deduplicated UUID union in consumer logical order, reading only one
  UUID's segments in physical-offset order at a time. Release its aggregate
  after dispatch and use only a fixed tiny glued-line cache; do not globally
  physical-sort selected segments, hold multiple unfinished aggregates, spill,
  or rescan. Extract and share the existing artifact adjacency/blocker selector
  and stateful reducer rather than approximating artifact activity from UUID
  membership.
- Add cooperative scheduling to the shared full-scan primitive and to selected
  dispatch when cumulative selected work can be transcript-proportional. Track
  fixed internal source-byte and monotonic elapsed-processing budgets; after a
  complete physical line or aggregate exhausts either budget, await
  `setImmediate` and reset both. Do not add a setting or protocol field. Preserve
  one-scan semantics and document that one large synchronous JSON parse remains
  indivisible.
- Add parity tests against the current full loader and reducers before changing
  ACP lifecycle code, including the existing malformed-compression selection and
  failure behavior.

## Phase 2: Projection acquisition and Config initialization

- Add an internal ACP-only projection source, including replay options, through
  `newSessionConfig()` and one final named `loadCliConfig()` host-options object;
  do not add another positional parameter, and keep ordinary CLI callers
  unchanged.
- Use the startup-frozen writer and chat-recording settings. When the recorder
  will acquire the lease, keep ownership in `Config.activateChatRecording()` and
  create the projection only after acquisition. Otherwise preload one fresh
  frozen projection before `Config` construction so the default daemon path is
  also fixed.
- Never implicitly enable the experimental writer protocol and never read the
  transcript with the old loader in either writer mode or behind a
  small-transcript threshold. Parity tests and benchmark-only baselines may
  invoke the old loader; no production cold or live restore path may do so.
- Preserve selected-runtime ownership: cold reads use the route-pinned runtime
  and live reads use the owning session Config, with no primary-runtime or
  latest-settings fallback.
- Assert lease/transcript identity after projection creation and before recorder
  activation.
- Activate `ChatRecordingService` from reduced recorder state. In leased mode,
  skip constructor restore and initialize or replace Goal runtime after recorder
  activation. In preloaded mode, construct the legacy active recorder and Goal
  runtime directly from the ready projection.
- Expose the completed projection to ACP initialization without changing
  `ResumedSessionData` semantics.
- Make projection handoff one-shot and clear it on consume, success, failure,
  shutdown, and `startNewSession()`. Add memoized
  `prepareRestore(records, checkpointWindow?)` and
  `activateRestoredWork()`: preparation restores state and performs legacy
  migration without starting autonomous work; activation latches idempotently,
  waits for preparation, and then starts pending checkpoint/continuation work.
  Daemon Session creation does not await preparation merely for migration, while
  `getGoalRuntimeReady()` waits for both phases. Retain `restore()` as the
  non-daemon wrapper that awaits both, and make disposal prevent unfinished
  preparation or activation from committing runtime state or broadcasting.
  Reject activation before preparation has started, and make disposal settle
  any readiness waiter that would otherwise remain blocked only on activation.
- Preserve each normalized Goal candidate's source UUID and have the shared
  recovery reducer identify the determining record, so replay bootstrap checks
  page membership without duplicating Goal precedence.

## Phase 3: Migrate every load/resume consumer

- Initialize Gemini model history, token counts, and UI telemetry from runtime
  state with the existing telemetry replay timing and process-aggregate behavior.
  Retain process-global attribution until the narrow non-throwing
  selective-restore finalizer after the existing fallible Session setup and
  rewriter installation but before cron/command startup. Guarantee that a child
  path returning a restore failure does not apply attribution;
  explicitly do not promise rollback after a #8691 public timeout whose
  underlying child restore later succeeds and is closed.
- Build and validate the response-mode replay envelope before runtime
  FileHistoryService hydration or Session construction. Keep
  `GeminiClient.initialize()` in `createAndStoreSession()`, then add one narrow
  synchronous preparation slot after Gemini initialization, the second managed
  admission check, and the active-id conflict check but before `new Session(...)`
  and `sessions.set()`. Build modes, models, config options, artifact/replay
  metadata, and the complete ACP success value in that slot so active-runtime
  model selection matches current behavior and a builder failure leaves no
  Session. Only then synchronously restore file history exactly once in the
  existing creation sequence; do not defer it until `/rewind` or the first file
  operation. Start its best-effort missing-backup validation once only from
  successful restore finalization, because that validation may append a
  transcript record. When file checkpointing is disabled, neither hydrate nor
  validate the reduced snapshots and release the unused projection field.
  Restore turn parents, initial turn, background notification ids, goal
  runtime/hooks, and artifact state from their explicit projection fields; feed
  the normalized minimal Goal records through the existing recovery and
  legacy-card helpers. With no projection, construct an empty requested runtime
  whose recorder parent is `null`; a non-empty system/metadata-only chain keeps
  its real final record UUID.
- Remove daemon attempts to rebuild recorder boundaries or ACP state from the
  recent replay page.
- Replay only the requested recent page for explicit `historyPageSize` clients.
- Bootstrap a still-active v2 or legacy goal when its determining record is
  older than the recent page, without duplicating in-page or terminal goals.
- Preserve full visible replay when the field is omitted and no replay for
  `resumeSession`.
- Replace live load/resume full reloads with consumer-limited projections under
  the existing drain and write barrier.
- Keep internal load-replay envelope version 1, add optional
  `anchorRecordId?: string`, validate/strip it in the bridge, and use it only as
  the last fallback for the existing public history anchor.
- Consume, but do not reimplement, prerequisite #8933. It normalizes the bridge
  in-flight key as discriminated `all`, `recent(limit)`, or `none` replay plus
  action, response/stream mode, and inherited-history policy; only identical
  shapes coalesce, while omitted versus explicit pages and unequal limits return
  `restore_in_progress`.
- Preserve #8933's #8882 coordinator correction. The operation and effective
  page are captured with the intent, `load/all`, `load/recent(limit)`, or
  `resume/none` participates in its normalized key, and a non-identical shape
  permanently fences the obsolete raw result while retaining same-shape timeout
  retry within the same lifecycle. Explicit lifecycle cancellation also fences
  an old raw result when a later intent returns to the same shape. Selective
  implementation must not add another coordinator.
- Preserve #8933's bridge ingress validation before live lookup, admission, or
  coalescing. Meaningful response-load `historyPageSize` uses the REST/ACP integer
  range; streamed load and resume ignore the unused field for warm and cold
  Sessions. The bridge request type correctly documents omitted `historyReplay`
  as streamed load. Selective code adds the projection-mode mapping and replay
  limits behind this established normalized shape.
- Audit every production restore caller. Change scheduled-task startup
  rehydration/keepalive and both direct and daemon-backed channel restoration to
  ACP/SDK resume because they ignore replay. Preserve all replay for generic
  REST/ACP load compatibility and branch/side-task callers that actually return
  prior history. Keep parent notification, live task/coordinator, and
  sub-session parent recovery on their existing resume path.
- For cold loads, enforce the shared serialized byte cap and existing
  10,000-update cap on explicitly recent bulk replay before transport and before
  session registration. Any individual or collective overflow returns ACP
  `errorKind: transcript_page_too_large`, which REST maps to
  `413 transcript_page_too_large`; preserve the typed limit error past the
  collector's ordinary `partial`/`replayError` downgrade and do not add
  transformed-update trimming.
- Put both internal protocol constants in shared bridge types. Incrementally
  account each serialized update, then exactly verify UTF-8 bytes for the final
  version-1 envelope including every optional field, delimiter, bootstrap,
  synthetic, and finalization update. Accept exactly 32 MiB and 10,000 updates;
  reject the first extra byte or the 10,001st update with a dedicated typed
  reason while preserving the existing public error kind/code.
- Treat the shared 32 MiB explicitly recent serialized replay ceiling as a fixed
  transformed-envelope policy in this PR; do not add a configuration knob,
  transformed-update trimming, or server-side auto-paging. A caller may retry
  collective overflow with a smaller `historyPageSize`, but recovery requires
  the resulting aligned selection to fit. A single source record or minimum
  aligned group that remains oversized keeps the typed failure. Omitted
  `historyPageSize` retains its legacy compatibility semantics.
- Apply the same explicit-page envelope limits to direct-ACP live loads without
  mutating, unregistering, or closing the already-live Session on overflow. Keep
  the daemon bridge's existing live-attach fallback to in-memory replay instead
  of surfacing that direct-ACP error as REST 413.
- Reuse #8691's `startingSessionIds`/`reserveStartingSessionId()` reservation;
  do not create a parallel preparation set. Hold the existing reservation from
  before settings/existence I/O through the existing Session creation attempt or
  failure. Keep the current handler `finally` release and conflict checks; do not
  add reservation-to-map conversion, a provisional unregistered Session, or a
  second publication protocol.
- Preserve `createAndStoreSession()`'s current early map insertion, reporter
  notification, fallible replay/worktree/Goal/rewriter setup, and
  `discardStoredSessionIfCurrent()`/`removeStoredSessionEntry()` rollback. New
  projection and envelope failures happen before the call; response-builder
  failures happen in its post-Gemini/pre-construction slot. Both leave no map
  entry. Failures at the existing guarded setup points use their current
  stored-session cleanup. Do not add map-independent teardown, gate every Session
  constructor callback, or claim to repair unrelated pre-existing cleanup edges.
- Add one narrow ACP-only selective-restore finalizer after
  `session.installRewriter()` and before `session.startCronScheduler()` and the
  available-command timer. It is called exactly once, is synchronous, and does
  not throw, with independent error boundaries around best-effort attribution
  application, scheduling `GoalRuntime.activateRestoredWork()`, and starting
  idempotent FileHistory missing-backup validation. Attach rejection handlers
  immediately to both async actions and independently contain synchronous
  invocation failures, so one action cannot skip another or produce an
  unhandled rejection. Do not await async completion or change
  existing background/worktree, callback, reporter, cron, command, publication,
  or rollback timing. Keep every fallible/awaited setup step before this
  finalizer; the existing cron start and command timer remain internally
  best-effort after it.

## Phase 4: Errors and observability

- Add one restore-error mapper used after cleanup by preloaded/deferred cold
  projection, cold replay collection, and direct-ACP live projection/collection:
  snapshot unavailable becomes ACP -32010/REST 409, transcript over 256 MiB
  becomes ACP -32011/REST 413 `transcript_too_large`, and recent envelope
  overflow becomes ACP -32012/REST 413 `transcript_page_too_large`. Preserve
  typed data for coalesced waiters and do not expand the public success schema.
- Assert that transcripts over 256 MiB return request-scoped ACP
  `errorKind: transcript_too_large`, map to REST `413 transcript_too_large`,
  never call the old loader, and do not affect a sibling session.
- Call out the 256 MiB limit as an intentional daemon compatibility change in
  the implementation PR and obtain maintainer sign-off.
- Call out the new 32 MiB transformed-replay ceiling for explicitly paged bulk
  loads as an intentional compatibility change and obtain maintainer sign-off.
- Boundary-test the exact serialized `qwen.session.loadReplay` value at or below
  32 MiB and at the first byte above it. Cover one individually oversized source
  record and collectively oversized individually valid updates, including
  object, array, comma, bootstrap, synthetic, and finalization overhead.
- Verify oversized cold transformed replay cleans up the unregistered Config and
  leaves sibling sessions healthy.
- Verify replay overflow after legacy Goal migration leaves only the expected v2
  migration record, invalidates the old projection cache key, and still does not
  register a Session.
- Verify a pending Goal checkpoint performs no restore-time full load and starts
  no verifier or continuation before successful restore finalization; the
  finalizer activates it once from the projected bounded window, while failure
  disposes it.
- Verify activation requested before Goal preparation settles waits correctly,
  repeated preparation/activation coalesces, `getGoalRuntimeReady()` waits for
  both, disposal suppresses unfinished state/broadcast/work, and non-daemon
  `restore()` retains its current awaited semantics. Also verify activation
  before preparation starts rejects and disposal does not leave readiness
  pending while it waits for finalization that will never occur.
- Verify every child path that returns a restore failure leaves process-global
  attribution unchanged, while successful restore finalization applies the
  projected snapshot once. Inject failures at every existing fallible setup point
  before the finalizer and assert attribution is still untouched. Document that a #8691 late-abandoned
  child can briefly apply attribution and run activated Goal, file-history,
  background, cron, or command work before cleanup. Treat that as an existing
  child-lifecycle residual rather than a new prerequisite unless implementation
  evidence shows this slice expands it. Verify newly activated Goal work is
  suppressed by Goal disposal; FileHistory validation retains its existing
  service/callback lifecycle and gains no detached owner or new cancellation
  protocol.
- Verify a response-builder failure occurs after Gemini initialization but
  before FileHistory hydration, Session construction, or any Session map entry;
  model/mode/config fields match the existing post-initialization response.
- Verify live projection and envelope-limit failures release the close gate and
  preserve the registered Session, client accounting, and runtime services.
- Add #8691 child restore phases for index, state selection, selected reads,
  replay, runtime initialization, and post-replay services.
- Record only bounded counts, byte totals, booleans, durations, and cache state.

## Phase 5: Verification

- Dry-run the baseline with the installed global `qwen` CLI and record an E2E
  plan/result under `.qwen/e2e-tests/`.
- Run focused core reader/service/config/client/recording/goal tests from
  `packages/core`.
- Run focused ACP agent/session and daemon route/bridge tests from their package
  directories.
- Instrument reader tests to prove one full sequential index scan plus bounded
  selected seeks, no internal public-page/cache read, at most one aggregate
  record in progress plus the fixed line cache and declared final outputs, and
  no second scan for recent replay, Goal bootstrap, or pending-checkpoint
  evidence. Cover a dead-branch side-task source, glued fragments, concurrent
  fresh/cached builds, stale pending completion, and failed-read cache admission.
- Add deterministic cooperative-scheduling coverage: force the byte budget with
  a multi-record fixture, prove a queued timer/sibling callback runs before the
  scan settles, and verify yields occur only after complete physical lines or
  selected aggregates without changing order or projection parity. Keep the
  approximately 2 MiB single-record parse as an explicit residual rather than a
  timing assertion.
- Exercise both lease modes, recorder-disabled mode, same-id reservation races,
  every new pre-creation failure and existing stored-session rollback point, and
  Goal migration complete or pending when a later step fails. A same-id retry
  must observe no stale hook, observer, Config, lease, reservation, or map state.
- Exercise pending Goal checkpoint recovery, attribution finalization timing, and a
  throwing response builder. Cover prepare/activate ordering, repeated calls,
  disposal during legacy migration, and non-daemon compatibility. No restore-time
  old-loader call, pre-finalization verifier/continuation, failed-restore
  attribution mutation, FileHistory validation, or stale Session entry is
  permitted. Compare the hint-based evidence UUID selection and materialized
  checkpoint window with the production helper across entry/byte truncation,
  cursor, malformed-context, and turn-reentry errors, prior checkpoint claims,
  and mixed eligible or ineligible records; assert that unselected payloads are
  never read.
- Exercise missing file-history backups and the targeted finalizer: envelope or
  setup failure appends nothing; success hydrates once, then runs the finalizer
  once after rewriter installation and before cron/commands. Inject independent
  attribution, Goal activation, and FileHistory validation failures and prove
  the other two actions still run, the prebuilt response is unchanged, and
  existing Session constructor callback timing is unchanged. With file
  checkpointing disabled, prove snapshots are neither hydrated nor validated
  and the one-shot projection releases them.
- Exercise scheduled-task rehydration/keepalive and direct/daemon channel
  restoration through resume/none. Scheduled-task rehydration must restore cron
  and Goal runtime state; both channel adapters must remain promptable and
  receive post-resume updates, including available-command refresh. None may
  collect historical replay frames. Generic load and branch clients retain
  their explicit replay behavior.
- With #8933 merged, create the implementation from fresh `main` containing the
  final #8882 and #8933 code, review the selective-only diff, and run their
  integration coverage with selective-restore 409, 413, timeout/504,
  cancellation, and staging failures on the modern `client_identity` path.
  Assert the committed session-id and workspace-cwd source tuple remains
  attached and usable, and successful adoption changes transcript, connection,
  metadata, and ownership atomically. Preserve #8882's legacy detach-first
  behavior when that capability is explicitly absent.
- Run `npm run build && npm run typecheck` from the repository root.
- Record a benchmark-only full-loader baseline and run the selective projection
  on 64 KiB, 1 MiB, and 4 MiB fixtures under the same runtime. Report absolute
  wall time and peak and settled memory; treat the results as evidence rather
  than a machine-independent latency gate. If they justify a small-file
  optimization, keep it inside the selective reader rather than routing
  production back to `SessionService.loadSession()`.
- Run the opt-in approximately 80 MiB/30,000-record benchmark with a live
  sibling and report wall time, peak and settled memory, event-loop lag,
  selected bytes, replay bytes, compression fallback, and sibling continuity.
  Use the results to tune the fixed cooperative byte/time budgets and report the
  largest indivisible-record interval, but do not convert either measurement
  into a machine-independent CI threshold.
  Report #8882's overlapping source-plus-staged-target WebUI peak separately from
  ACP child index/projection memory; do not add cross-process samples into one
  peak.
- Read the complete diff and all untracked files in open-ended audit passes.
  Fix every actionable finding, rerun affected verification, reset the clean
  pass count, and stop only after two consecutive clean passes.
- Run the Codex `/review` workflow when available; do not invoke Qwen Review
  unless explicitly requested.

## Acceptance checklist

- [x] #8691 has landed.
- [x] #8833 attachment-identity hardening has landed.
- [x] #8882 transactional WebUI session switching has landed with green CI and
      maintainer approval.
- [x] #8933 implements exact-shape WebUI and bridge coalescing, effective-page
      snapshotting, ingress validation, and focused real-daemon regression
      coverage without adding selective runtime code.
- [x] #8933 has landed as merge commit `962dc8e`; fresh `main` contains both
      #8882 and #8933.
- [ ] The selective implementation branch is created from that fresh `main`.
- [ ] Projection acquisition, runtime-consumer migration, and old-loader removal
      ship as one end-to-end implementation; no intermediate production PR leaves
      an unused projection or removes the post-lease authoritative read without
      replacing it.
- [ ] One full sequential cold-restore index scan plus bounded selected-record
      seeks occurs after lease acquisition when the recorder will acquire it, or
      before `Config` construction otherwise; no projection path performs a
      second scan through paging/cache helpers.
- [ ] Full scanning and transcript-proportional selected dispatch cooperatively
      yield after a fixed internal source-byte or elapsed-processing budget at
      complete physical-line/aggregate boundaries. Functional tests prove
      scheduler and sibling progress without changing scan count, order, or
      parity; a single large synchronous parse remains a documented residual.
- [ ] No production selective cold or live `session/load`/`session/resume` path
      calls the old full loader, including under a small-transcript threshold;
      benchmark-only comparisons are the only exception.
- [ ] All newly retained index metadata, including container, key, value, and
      base-object overhead, is included in cache-byte accounting; hint-heavy
      tests prove an index whose own estimate exceeds the entire cache budget has
      no retained completed value and its byte-budget admission does not evict
      cached values, while pending coalescing and existing LRU behavior remain
      unchanged.
- [ ] Cold cache offer occurs only after all selected-read and final snapshot or
      lease checks, never replaces an existing pending/completed entry, and
      cannot be overwritten or deleted by a stale pending completion.
- [ ] Compressed and uncompressed API histories match current behavior.
- [ ] Rewind, fork, side-task, gap, fragment, artifact, file-history, goal,
      telemetry, attribution, and interruption fixtures pass parity tests.
- [ ] Empty/all-unparseable files produce no projection and do not manufacture a
      recorder parent. Non-empty system/metadata-only chains preserve their real
      final record UUID, while project/snapshot/selected-record/limit failures
      never degrade into the empty path.
- [ ] A dead-branch side-task source cannot replace the source boundary derived
      from the active runtime chain; artifact adjacency/blocker selection and
      incremental accumulation match the existing batch reducer.
- [ ] Explicit initial replay is count- and byte-bounded.
- [ ] Cold collective transformed replay byte and update-count expansion is
      bounded and fails before session registration.
- [ ] Typed envelope-limit failures cannot be downgraded to a successful
      `partial` replay response.
- [ ] Replay overflow after legacy Goal migration permits only that migration
      write and never appends replay data or registers the failed Session.
- [ ] Omitted `historyPageSize` still returns full visible replay.
- [ ] Oversized individual cold replay records return the typed ACP error, map
      to REST 413, and never leave a half-registered runtime.
- [ ] Active goals older than a recent page get one correct bootstrap update.
- [ ] Goal recovery returns the determining source UUID so bootstrap membership
      uses the shared precedence result rather than a second implementation.
- [ ] Goal projection retains no unrelated slash-command history items while
      preserving malformed-candidate precedence and legacy hook state.
- [ ] Goal precedence matches `recoverGoalFromRecords()`: newer malformed v2
      records do not hide an earlier valid v2, but unsupported-only v2 history
      blocks legacy fallback.
- [ ] Pending Goal checkpoint evidence is reduced during the single projection,
      uses bounded active-chain hints to select only the UUIDs chosen by the
      production evidence-window helper or reproduce its fail-closed lineage
      errors, never selects every active payload, performs a second scan, or
      calls the old loader, and activates checkpoint/continuation work only from
      successful restore finalization.
- [ ] Active file-history batches preserve last-write-wins, first-insertion,
      100-snapshot cap, and whole-record malformed-skip semantics.
- [ ] Transcript file-history records are reduced inside the single projection;
      after envelope validation the runtime service restores exactly once during
      existing Session setup, and missing-backup validation starts once from the
      successful finalizer. Envelope/prepare failure performs no file-history
      append. With file checkpointing disabled, snapshots are neither hydrated
      nor validated and their projection payload is released.
- [ ] Selected-read tests prove file-history and artifact inputs are reduced
      incrementally and are not retained in a transcript-sized intermediate
      array.
- [ ] Over-256 MiB cold restore returns the typed ACP error, maps to REST 413,
      and preserves siblings.
- [ ] Default lease-off and experimental lease-on restore modes both pass, and
      #8691 abandoned/condemned-channel cleanup remains intact.
- [ ] Chat recording disabled with the writer setting enabled still preloads the
      projection and never attempts lease acquisition.
- [ ] Lease-off concurrent append/growth is detected before registration; the
      documented same-identity/same-mtime adversarial residual remains explicit.
- [ ] Live projection and explicit-page overflow failures preserve the existing
      Session, attach/client counts, and close-gate usability; direct ACP returns
      the typed error while daemon live attach retains its in-memory fallback.
- [ ] Cross-workspace and unavailable-runtime tests prove projection resolution
      never falls back to the primary runtime or another request's settings.
- [ ] A selected record with a conflicting session id fails the restore instead
      of being accepted from an otherwise valid transcript file.
- [ ] ACP-only restore inputs use named host options; existing positional
      `loadCliConfig()` callers cannot accidentally populate the projection.
- [ ] Successful load, failed load, and `startNewSession()` release all pending
      projection payloads; Config does not become a second lifetime history
      cache.
- [ ] #8691's existing session-id reservation, without a second preparation set,
      covers settings/existence I/O through the existing Session creation
      attempt; concurrent direct-ACP restores of one id cannot both prepare, and
      every failure frees the reservation for a clean retry.
- [ ] New failures before `createAndStoreSession()` or in its
      post-Gemini/pre-construction response slot leave no map entry; failures at
      its currently guarded setup points use the existing stored-session rollback
      and leave no stale Session/Goal hook, observer, Config, or map entry.
- [ ] Goal preparation and activation are separately memoized; activation waits
      for preparation, readiness waits for both, disposal suppresses unfinished
      work, and non-daemon `restore()` preserves existing awaited behavior.
- [ ] Every child path that returns a restore failure leaves process-global
      attribution unchanged; the projected snapshot is applied once by the
      successful non-throwing finalizer after existing fallible setup. The
      broader late-abandoned window remains documented as existing lifecycle
      behavior rather than a new prerequisite unless implementation evidence
      shows this slice expands it. Goal activation remains disposal-owned, while
      FileHistory validation retains existing service/callback lifetime without
      a new detached owner or cancellation protocol.
- [ ] The complete ACP success value is built after Gemini initialization and
      before FileHistory hydration, Session construction, or map insertion; a
      response-builder failure performs none of the latter three and preserves
      the existing post-initialization model/mode/config response semantics.
- [ ] The selective finalizer runs once after rewriter installation and before
      cron/command startup. Attribution, Goal activation, and FileHistory
      validation synchronous failures and asynchronous rejections are
      independently contained, produce no unhandled rejection, and do not
      replace the prebuilt response; no fallible/awaited setup follows the
      finalizer, and existing Session callback timing is unchanged.
- [ ] #8882 integration proves that, on the modern `client_identity` path,
      selective-restore 409, 413, timeout/504, cancellation, and staging failures
      preserve the committed session-id and workspace-cwd source tuple, while a
      successful switch commits transcript, connection, metadata, and ownership
      atomically. Explicitly unsupported-capability fallback retains legacy
      detach-first behavior.
- [x] #8933 in-flight bridge coalescing distinguishes omitted/full, explicit
      recent limits, none, action, stream/response mode, and inherited-history
      policy; only identical shapes share a restore and its typed result.
- [x] #8933's WebUI coordinator snapshots and keys the effective replay shape:
      identical target/mode/page requests coalesce, while load versus resume and
      unequal page sizes remain distinct and never reuse a superseded result;
      explicit lifecycle cancellation also fences a later same-shape retry from
      adopting the cancelled raw result.
- [x] #8933 bridge ingress rejects invalid/non-finite/out-of-range page sizes
      before live lookup or coalescing when meaningful. Streamed load and resume
      ignore the field consistently for warm and cold Sessions. The bridge type
      documents omitted `historyReplay` as streamed load.
- [ ] Scheduled-task rehydration/keepalive and direct/daemon channel restoration
      use resume/none and collect no historical replay. Scheduled tasks retain
      cron/Goal recovery; channels retain prompt/live-update and
      available-command behavior; generic and branch loads keep their required
      replay.
- [ ] Both intentional caps (256 MiB transcript index and 32 MiB transformed
      explicit-page replay) have maintainer sign-off.
- [ ] Maintainers have reviewed the core/cross-package scope and production-logic
      line count. The implementation remains a feature; it has not expanded into
      an externally authored 500+ production-line core refactor.
- [ ] The fixed 32 MiB explicit-replay policy has no configuration, transformed
      update trimming, or server-side auto-paging path. Exact serialized-envelope
      boundary tests accept values within the cap and reject the first value
      above it for individual and collective expansion; omitted-`historyPageSize`
      compatibility remains unchanged.
- [ ] Exact limit tests accept 10,000 updates and reject 10,001; envelope byte
      accounting includes version, arrays/delimiters, optional metadata, anchor,
      bootstrap, synthetic, and finalization updates.
- [ ] Collective transformed-replay overflow permits an explicit smaller-page
      retry without server auto-paging, but recovery is not promised when the
      minimum aligned replay group remains oversized; a single oversized source
      record remains a typed failure.
- [ ] The 64 KiB, 1 MiB, and 4 MiB benchmark report compares the projection with
      the benchmark-only full-loader baseline; any accepted small-file
      optimization remains on the projection path.
- [ ] Restore trace phases and bounded attributes are present.
- [ ] Build, typecheck, focused tests, E2E result, benchmark report, self-audit,
      and code review are complete.
