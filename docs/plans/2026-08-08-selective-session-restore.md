# Selective session restore implementation plan

- Status: Proposed; implementation must wait for design approval and #8691
- Design: `docs/design/2026-08-08-selective-session-restore.md`
- Tracks: #8678

## Delivery rule

Implement one end-to-end daemon fix. Do not merge an unused projection API, do
not change TUI/export/fork loading, and do not add checkpoint persistence in this
PR.

The implementation is complete only when the cold daemon path no longer calls
`SessionService.loadSession()`, constructs one fresh transcript index in the
correct startup-frozen writer mode, restores every named runtime consumer, and
returns the requested replay semantics.

## Phase 1: Shared selective projection

- Extend the existing `SessionTranscriptReader` index with separate runtime and
  replay UUID chains plus the minimum projection hints named in the design.
- Add a single cold restore-projection read that selects and deduplicates runtime,
  replay, file-history, artifact, goal, telemetry, attribution, recorder, and ACP
  state records.
- Add a narrow live restore result backed by the same index/selected-read
  internals: replay plus artifacts for live load, artifacts only for live resume.
  Do not express this as optional flags on the complete cold runtime result.
- Reuse existing fragment aggregation, chain walking, page alignment, cursor
  snapshot checks, artifact reducers, goal recovery, and error classes.
- Preserve the 256 MiB index cap, 4 MiB recent-page source budget, 16 MiB bounded
  expansion ceiling, and a shared 32 MiB serialized bulk-replay ceiling.
- Reuse the exact prompt-id/turn helper semantics, stream every active
  file-history batch through the existing reducer while retaining only its final
  100-snapshot state, and sort selected segment reads by physical offset.
- Normalize Goal inputs while dispatching selected records: retain parsed v2
  lifecycle state and only the raw legacy `goal_status` candidates needed by the
  existing reducers, including malformed candidates that affect precedence;
  discard unrelated slash-command output.
- Dispatch aggregated records directly to consumer reducers instead of building
  a catch-all selected-record array. Stream artifact inputs into an incremental
  form of the existing reducer and retain only the rebuilt snapshot.
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
  transcript with the old loader in either mode.
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
- Make projection handoff one-shot. Force lazy file-history consumption, then
  release API history, goal records, telemetry arrays, replay records, artifact
  inputs, and other pending projection payloads on success, failure, and
  `startNewSession()`.

## Phase 3: Migrate every load/resume consumer

- Initialize Gemini model history, token counts, UI telemetry, and attribution
  from runtime state.
- Restore file history exactly once through its lazy Config owner. Restore turn
  parents, initial turn, background notification ids, goal runtime/hooks, and
  artifact state from their explicit projection fields;
  feed the normalized minimal Goal records through the existing recovery and
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
- Extend the internal load-replay envelope only as needed to populate the
  existing public history anchor.
- For cold loads, enforce the shared serialized byte cap and existing
  10,000-update cap on explicitly recent bulk replay before transport and before
  session registration. Any individual or collective overflow returns ACP
  `errorKind: transcript_page_too_large`, which REST maps to
  `413 transcript_page_too_large`; preserve the typed limit error past the
  collector's ordinary `partial`/`replayError` downgrade and do not add
  transformed-update trimming.
- Apply the same explicit-page envelope limits to direct-ACP live loads without
  mutating, unregistering, or closing the already-live Session on overflow. Keep
  the daemon bridge's existing live-attach fallback to in-memory replay instead
  of surfacing that direct-ACP error as REST 413.

## Phase 4: Errors and observability

- Map selective reader failures through existing ACP error kinds and REST
  responses.
- Assert that transcripts over 256 MiB return request-scoped ACP
  `errorKind: transcript_too_large`, map to REST `413 transcript_too_large`,
  never call the old loader, and do not affect a sibling session.
- Call out the 256 MiB limit as an intentional daemon compatibility change in
  the implementation PR and obtain maintainer sign-off.
- Call out the new 32 MiB transformed-replay ceiling for explicitly paged bulk
  loads as an intentional compatibility change and obtain maintainer sign-off.
- Verify oversized cold transformed replay cleans up the unregistered Config and
  leaves sibling sessions healthy.
- Verify replay overflow after legacy Goal migration leaves only the expected v2
  migration record, invalidates the old projection cache key, and still does not
  register a Session.
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
- Run `npm run build && npm run typecheck` from the repository root.
- Run the opt-in approximately 80 MiB/30,000-record benchmark with a live
  sibling and report wall time, peak and settled memory, event-loop lag,
  selected bytes, replay bytes, compression fallback, and sibling continuity.
- Read the complete diff and all untracked files in open-ended audit passes.
  Fix every actionable finding, rerun affected verification, reset the clean
  pass count, and stop only after two consecutive clean passes.
- Run the Codex `/review` workflow when available; do not invoke Qwen Review
  unless explicitly requested.

## Acceptance checklist

- [ ] #8691 is merged or the implementation branch is rebased onto its final
      restore lifecycle.
- [ ] One fresh cold-restore snapshot scan occurs after lease acquisition when
      the recorder will acquire it, or before `Config` construction otherwise.
- [ ] No selective cold or live `session/load`/`session/resume` path calls the
      old full loader.
- [ ] Compressed and uncompressed API histories match current behavior.
- [ ] Rewind, fork, side-task, gap, fragment, artifact, file-history, goal,
      telemetry, attribution, and interruption fixtures pass parity tests.
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
- [ ] Goal projection retains no unrelated slash-command history items while
      preserving malformed-candidate precedence and legacy hook state.
- [ ] Goal precedence matches `recoverGoalFromRecords()`: newer malformed v2
      records do not hide an earlier valid v2, but unsupported-only v2 history
      blocks legacy fallback.
- [ ] Active file-history batches preserve last-write-wins, first-insertion,
      100-snapshot cap, and whole-record malformed-skip semantics.
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
- [ ] Both intentional caps (256 MiB transcript index and 32 MiB transformed
      explicit-page replay) have maintainer sign-off.
- [ ] Restore trace phases and bounded attributes are present.
- [ ] Build, typecheck, focused tests, E2E result, benchmark report, self-audit,
      and code review are complete.
