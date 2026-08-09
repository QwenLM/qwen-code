# Selective session restore implementation plan

- Status: Proposed; the design may land independently, but implementation must
  land after #8691 and transactional WebUI session switching
- Design: `docs/design/2026-08-08-selective-session-restore.md`
- Tracks: #8678

## Delivery rule

The delivery order is #8691, transactional WebUI session switching, this
selective-restore implementation, and then the durable checkpoint.

Implement selective restore as one end-to-end daemon fix. Reviewable commits may
follow the phases below, but do not merge an intermediate PR that only removes a
pre-lease load or moves `historyPageSize`: the post-lease read remains
authoritative until the selective projection replaces it, and early I/O bounding
is incomplete until every runtime consumer uses that projection. Do not merge an
unused projection API, change TUI/export/fork loading, or add checkpoint
persistence in this PR.

The implementation is complete only when the cold daemon path no longer calls
`SessionService.loadSession()`, constructs one fresh transcript index in the
correct startup-frozen writer mode, restores every named runtime consumer, and
returns the requested replay semantics.

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
  state records.
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
  evidence accumulator shared with the existing Goal evidence-window builder,
  include its result in the projection, and prohibit restore-time fallback to
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
  Daemon publication does not await preparation merely for migration, while
  `getGoalRuntimeReady()` waits for both phases. Retain `restore()` as the
  non-daemon wrapper that awaits both, and make disposal prevent unfinished
  preparation or activation from committing runtime state or broadcasting.
  Reject activation before preparation has started, and make disposal settle
  any readiness waiter that would otherwise remain blocked only on activation.
- Preserve each normalized Goal candidate's source UUID and have the shared
  recovery reducer identify the determining record, so replay bootstrap checks
  page membership without duplicating Goal precedence.

## Phase 3: Migrate every load/resume consumer

- Initialize Gemini model history, token counts, and session-scoped UI telemetry
  from runtime state. Retain the process-global attribution snapshot until the
  final synchronous child commit. Guarantee that child pre-publication failures
  do not apply it; explicitly do not promise rollback after a #8691 public
  timeout whose underlying child restore later publishes and is closed.
- Build and validate the response-mode replay envelope, then prebuild modes,
  models, config options, artifact/replay metadata, and the complete ACP success
  value before hydrating the runtime FileHistoryService or constructing a
  provisional Session. Only then synchronously restore file history exactly once
  before Session publication; do not defer it until `/rewind` or the first file
  operation. Start its best-effort missing-backup validation once only after
  publication, because that validation may append a transcript record.
  Restore turn parents, initial turn, background notification ids, goal
  runtime/hooks, and artifact state from their explicit projection fields; feed
  the normalized minimal Goal records through the existing recovery and
  legacy-card helpers.
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
- Normalize the bridge in-flight key as discriminated `all`, `recent(limit)`, or
  `none` replay plus action, response/stream mode, and inherited-history policy.
  Coalesce only identical shapes; omitted versus explicit page size and unequal
  recent limits return `restore_in_progress`.
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
- Reserve a cold session id before configuration/scanning and hold it until
  atomic publication or failure. Run all fallible preparation before replacing
  the reservation with `sessions.set`. Validate reservation ownership and the
  absence of an active entry before touching attribution. Then apply attribution,
  publish the map entry, clear initializing state, and best-effort notify the
  reporter in one no-`await`, no-remaining-failure block. Use a map-independent
  teardown for provisional state: dispose Session and Goal hooks/observers,
  release MCP and telemetry ownership, then shut down Config, recorder, and lease
  without replacing the original failure.
- Make `activateAfterPublication()` synchronous, idempotent, and non-throwing.
  Enable event receivers first, switch capture-only callbacks to sending mode and
  drain them second, then schedule Goal checkpoint/continuation, file-history
  validation, restored background work, cron, and command producers. Give every
  receiver/producer an independent latch and error boundary; one failure skips
  only its dependent producer, and activation/reporting never rolls back the
  committed Session or changes its prebuilt response.

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
  no verifier or continuation before publication; successful publication
  activates it once from the projected bounded window, while failure disposes it.
- Verify activation requested before Goal preparation settles waits correctly,
  repeated preparation/activation coalesces, `getGoalRuntimeReady()` waits for
  both, disposal suppresses unfinished state/broadcast/work, and non-daemon
  `restore()` retains its current awaited semantics. Also verify activation
  before preparation starts rejects and disposal does not leave readiness
  pending while it waits for publication that will never occur.
- Verify every child pre-publication failure leaves the process-global
  attribution singleton unchanged and successful child publication applies the
  projected snapshot once. Inject a failed final reservation/active-entry guard
  and assert attribution is still untouched. Document rather than assert rollback
  for #8691 late abandoned-result cleanup.
- Verify a response-builder failure occurs before FileHistory hydration,
  provisional Session construction, or any Session map entry.
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
- Exercise both lease modes, recorder-disabled mode, same-id reservation races,
  every post-model/post-Session teardown point, and Goal migration complete or
  pending when a later step fails. A same-id retry must observe no stale hook,
  observer, pool, telemetry, Config, lease, or map state.
- Exercise pending Goal checkpoint recovery, attribution commit timing, and a
  throwing response builder. Cover prepare/activate ordering, repeated calls,
  disposal during legacy migration, and non-daemon compatibility. No restore-time
  old-loader call, pre-publication verifier/continuation, pre-publication
  attribution mutation, FileHistory hydration, or half-published Session is
  permitted.
- Exercise missing file-history backups and due autonomous work: envelope or
  prepare failure appends nothing and emits nothing; successful publication
  restores once, validates once, enables receivers before producers, and arms
  each buffered notification/cron/timer exactly once. Inject each activation
  failure independently and prove unrelated steps still activate.
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
- Read the complete diff and all untracked files in open-ended audit passes.
  Fix every actionable finding, rerun affected verification, reset the clean
  pass count, and stop only after two consecutive clean passes.
- Run the Codex `/review` workflow when available; do not invoke Qwen Review
  unless explicitly requested.

## Acceptance checklist

- [ ] #8691 and transactional WebUI session switching have landed, and the
      implementation branch is rebased onto their final restore and attach
      lifecycle.
- [ ] Projection acquisition, runtime-consumer migration, and old-loader removal
      ship as one end-to-end implementation; no intermediate production PR leaves
      an unused projection or removes the post-lease authoritative read without
      replacing it.
- [ ] One full sequential cold-restore index scan plus bounded selected-record
      seeks occurs after lease acquisition when the recorder will acquire it, or
      before `Config` construction otherwise; no projection path performs a
      second scan through paging/cache helpers.
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
      matches the production evidence-window helper, never calls the old loader,
      and activates checkpoint/continuation work only after publication.
- [ ] Active file-history batches preserve last-write-wins, first-insertion,
      100-snapshot cap, and whole-record malformed-skip semantics.
- [ ] Transcript file-history records are reduced inside the single projection;
      after envelope validation the runtime service restores exactly once before
      Session publication, and missing-backup validation starts once afterward.
      Envelope/prepare failure performs no file-history append.
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
- [ ] Session-id reservation covers scan through atomic publication; concurrent
      direct-ACP restores of one id cannot both prepare, and every failure frees
      the reservation for a clean retry.
- [ ] Provisional teardown is independent of the sessions map and leaves no
      Session/Goal hook, observer, MCP pool ownership, telemetry state, Config,
      recorder, or lease after any pre-publication failure.
- [ ] Goal preparation and activation are separately memoized; activation waits
      for preparation, readiness waits for both, disposal suppresses unfinished
      work, and non-daemon `restore()` preserves existing awaited behavior.
- [ ] Every child pre-publication failure leaves process-global attribution
      unchanged; the projected snapshot is applied once in the successful
      no-`await` child commit after final reservation validation. A failing
      validation leaves attribution untouched. Late-abandoned cleanup is
      documented as outside the rollback guarantee.
- [ ] The complete ACP success value is built before FileHistory hydration and
      provisional Session construction; a response-builder failure performs
      neither and leaves no Session.
- [ ] Goal work, notification drains, cron, command timers, file-history
      validation, and all session-visible callbacks do not execute or emit before
      publication. Receivers activate before producers; each independent step
      arms once, and one injected failure skips only its direct dependents.
- [ ] In-flight bridge coalescing distinguishes omitted/full, explicit recent
      limits, none, action, stream/response mode, and inherited-history policy;
      only identical shapes share a restore and its typed result.
- [ ] Both intentional caps (256 MiB transcript index and 32 MiB transformed
      explicit-page replay) have maintainer sign-off.
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
