# Selective session restore implementation plan

- Status: Proposed; implementation must wait for design approval and #8691
- Design: `docs/design/2026-08-08-selective-session-restore.md`
- Tracks: #8678

## Delivery rule

Implement one end-to-end daemon fix. Do not merge an unused projection API, do
not change TUI/export/fork loading, and do not add checkpoint persistence in this
PR.

The implementation is complete only when the cold daemon path no longer calls
`SessionService.loadSession()`, constructs one transcript index after acquiring
the writer lease, restores every named runtime consumer, and returns the
requested replay semantics.

## Phase 1: Shared selective projection

- Extend the existing `SessionTranscriptReader` index with separate runtime and
  replay UUID chains plus the minimum projection hints named in the design.
- Add a single restore-projection read that selects and deduplicates runtime,
  replay, file-history, artifact, goal, telemetry, attribution, recorder, and ACP
  state records.
- Reuse existing fragment aggregation, chain walking, page alignment, cursor
  snapshot checks, artifact reducers, goal recovery, and error classes.
- Preserve the 256 MiB index cap, 4 MiB recent-page source budget, 16 MiB bounded
  expansion ceiling, and 32 MiB serialized response ceiling.
- Add parity tests against the current full loader and reducers before changing
  ACP lifecycle code, plus separate safe-fallback tests for malformed
  compression.

## Phase 2: Deferred daemon resume under the writer lease

- Add an internal ACP-only deferred-resume descriptor, including replay options,
  through `newSessionConfig()` and `loadCliConfig()`; ordinary CLI callers
  remain unchanged.
- Keep lease ownership in `Config.activateChatRecording()` and create the
  projection only after acquisition, bypassing any index build that began before
  the lease and publishing the completed authoritative index for later pages.
- Assert lease/transcript identity after projection creation and before recorder
  activation.
- Activate `ChatRecordingService` from reduced recorder state. Skip the
  constructor's ordinary goal restore in deferred mode, then initialize or
  replace goal runtime from selected goal records after recorder activation.
- Expose the completed projection to ACP initialization without changing
  `ResumedSessionData` semantics.

## Phase 3: Migrate every daemon consumer

- Initialize Gemini model history, token counts, UI telemetry, and attribution
  from runtime state.
- Restore file history, turn parents, initial turn, background notification ids,
  goal runtime/hooks, and artifact state from their explicit projection fields;
  retain the legacy goal cards needed for iterations, start time, and last
  terminal state.
- Replay only the requested recent page for explicit `historyPageSize` clients.
- Preserve full visible replay when the field is omitted and no replay for
  `resumeSession`.
- Replace live load/resume full reloads with consumer-limited projections under
  the existing drain and write barrier.
- Move `qwen/session/loadUpdates` to the full visible replay projection.
- Replace the post-rewind full reload with an artifact-only projection under the
  existing recorder write barrier.
- Extend the internal load-replay envelope only as needed to populate the
  existing public history anchor.

## Phase 4: Errors and observability

- Map selective reader failures through existing ACP error kinds and REST
  responses.
- Assert that transcripts over 256 MiB return request-scoped
  `413 transcript_too_large` without calling the old loader or affecting a
  sibling session.
- Preserve successful runtime registration with explicit partial replay for an
  individually oversized UI record.
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
  sibling and report wall time, peak memory, event-loop lag, selected bytes,
  replay bytes, compression fallback, and sibling continuity.
- Read the complete diff and all untracked files in open-ended audit passes.
  Fix every actionable finding, rerun affected verification, reset the clean
  pass count, and stop only after two consecutive clean passes.
- Run the Codex `/review` workflow when available; do not invoke Qwen Review
  unless explicitly requested.

## Acceptance checklist

- [ ] #8691 is merged or the implementation branch is rebased onto its final
      restore lifecycle.
- [ ] One cold restore snapshot scan occurs after lease acquisition.
- [ ] No selective cold, live restore, loadUpdates, or rewind-artifact path calls
      the old full loader.
- [ ] Compressed and uncompressed API histories match current behavior.
- [ ] Rewind, fork, side-task, gap, fragment, artifact, file-history, goal,
      telemetry, attribution, and interruption fixtures pass parity tests.
- [ ] Explicit initial replay is count- and byte-bounded.
- [ ] Omitted `historyPageSize` still returns full visible replay.
- [ ] Oversized individual replay records degrade the display without losing the
      runnable runtime.
- [ ] Over-256 MiB cold restore returns structured 413 and preserves siblings.
- [ ] Restore trace phases and bounded attributes are present.
- [ ] Build, typecheck, focused tests, E2E result, benchmark report, self-audit,
      and code review are complete.
