# Live review follow-up and integration

[English](2026-09-10-live-review-follow-up.md) | [简体中文](2026-09-10-live-review-follow-up.zh-CN.md)

This follow-up addresses PR #11369's second review against `5136b2713f` and
publishes the user's accumulated local Subagents controls, selected-display
capture, audio continuity and debug Monitor archives. Preserve the existing PR
and merge history; no force push or unrelated refactor is needed.

## Correctness boundaries

- A stale PID is not proof that the recorded daemon URL is unavailable. Host
  first attempts authenticated Quit. Only a matching receipt, or actual
  connection refusal together with ESRCH for the original PID, permits success.
  Failed shared Quit remains terminal for incoming media/state, but can retry
  its stop action. Never redirect a retry to an unverified replacement daemon.
- A joined handoff may recover a missing job reference only from the exact
  message ID in its injection acknowledgement, scoped to the same session.
  Handle signals arriving before or after the receipt without orphaning the
  returned handle. Ordinary missing refs, conflicting refs and historical work
  cannot be guessed into a completed task; no-signal outcomes remain unknown.
- Slow successful visual capture may warm by continuous elapsed observation,
  but a hole longer than three nominal frame intervals (at least one second)
  breaks continuity. This preserves slow-capture progress without allowing a
  stale start timestamp to qualify one isolated frame.
- Reduced-motion rules must actually win the CSS cascade. Stopping is a muted
  state. Truncated status text must have a real interactive hover target without
  changing orb drag/layout geometry.
- Unknown visual configuration keys fail loudly, including typos that would
  otherwise silently capture Screen. Keep the newly supported display selector.
- Memory endpoint derivation failure cannot take down daemon setup or local
  memory. Use the established unavailable endpoint sentinel, not a fabricated URL.
- HTTP Quit cleanup failures preserve the authenticated retry route and owned
  discovery. SIGINT/SIGTERM exit cannot retry, so it releases only its own record.
  Log bounded, redacted resource/cause details without changing HTTP error text.
- Fixed Proactive repair rules share symbols across producer and exact-match
  renderer. Never expose arbitrary raw errors or loosen matching to prefixes.

## Verification

Reproduce before fixing using isolated loopback daemons, synthetic inputs and
hidden test-owned Electron windows. Cover both positive and negative identity,
permission and retry cases. Keep independent literal assertions for the
documented 16 kHz input / 24 kHz output contract, and test the evaluation budget
across multiple Monitor transport recycles. Mutation checks must use isolated
copies, not the user's working files.

Run package-local tests and the Live integration suites on the integrated tree,
then build/typecheck/bundle and build/typecheck Host separately. Review the entire
pending diff, including untracked production/tests, in two clean passes. Keep
physical Bluetooth playback and real screen-condition triggering explicitly
outside synthetic verification claims.

## Deliberate deferrals

Do not cap backend event retries based on 404 or the text `session not found`:
the SDK documents that runtime draining/replacement may produce the same
recoverable response. A permanent retirement policy requires authoritative
backend/session closure, not a guessed timeout. Preserve the fully ported Monitor
prompt as requested; its non-executable Func_call behavior remains diagnosed.
Schema/JPEG deduplication suggestions stay separate from correctness fixes.
