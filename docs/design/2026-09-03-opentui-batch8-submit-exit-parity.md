# Batch 8 — OpenTUI submit/exit semantics and mid-turn coverage

Closes U-15, U-21, U-22, U-23, U-24 and U-25 from #8662. Planned in
<https://github.com/QwenLM/qwen-code/issues/8662#issuecomment-5519887822>.

## What this batch is about

#10831 put the OpenTUI interactive E2E leg back and closed the four gaps that leg
exposed. Everything left in the submit/exit area shares one property: **ink has the
mechanism, and the port carried the shadow of it.** The composer accepts input, the
turn runs, the transcript looks right — and one semantics hop is missing underneath.
That class of gap is invisible to the current leg precisely because no case exercises
it mid-turn, so this batch ships the instrument and the fixes together.

Ink's mid-turn pipeline is one function:
`use-llm-stream.ts` `resolveSteeredMessages` resolves the steered hop — `@` mentions
with a read timeout and a queue restore, then the prompt-side vision bridge, then a
format-support warning — and `prepareQueryForLlm` runs the same bridge on the fresh
hop. OpenTUI's counterparts are `live-session.ts` `expandAtMentions` (fresh hop only,
no bridge) and the raw `drainSteering` push (steering hop, nothing).

## Gap by gap

### U-22 — bare quit tokens are submitted to the model

ink checks the raw submission against
`['/quit', '/exit', 'exit', 'quit', ':q', ':q!', ':wq', ':wq!']` in
`AppContainer.handleFinalSubmit` and routes it to `/quit` **ahead of** reminders and
the message queue. OpenTUI only recognized the slash forms, so `exit` mid-turn became
a prompt.

Fix in the shell's `onSubmit`, before the mid-turn gate and before dispatch: a pure
`normalizeQuitSubmission(text)` in `slash-gateway.ts` maps every token in ink's list to
`/quit`, exactly as ink compares (trimmed, case-sensitive). Normalizing before the gate
matters — a quit must never be deferred to idle.

### U-23 — exits never signal the client to stop background work

`GeminiClient.requestShutdown()` sets `shutdownRequested` and cancels the pending memory
prefetch, so extract/dream/skill-review work is not spawned during the exit window. ink
calls it in its quit action. OpenTUI never calls it anywhere, so every OpenTUI exit
(quit, Ctrl+C/Ctrl+D double press, render-error bailout) can spawn agent work while the
process drains cleanup.

Fix inside `exitSession()` rather than in one handler: the three exits are three call
sites of one drain, and the ledger's own reading is right — this belongs to the drain.
`exitSession(config, code)` calls `config.getLlmClient()?.requestShutdown()` before
`await runExitCleanup()`.

**Deliberate over-parity.** ink calls it on the quit path only, not on its Ctrl+C exit.
The signal means "this process is going down", which is true of all three exits, and
gating it to one handler would reproduce the shape of the bug. Recorded here so the
difference is not read as an accident.

### U-21 — steering text rides raw

Text drained at the sampling boundary is pushed as `{ text }` with no `@path`
expansion, while ink expands that hop.

Fix: the boundary drain stops being a synchronous `string[] → responseParts` push.
`live-session.ts` gains `resolveSteeredPromptParts(config, texts, signal, emit)`, the
port of ink's `resolveSteeredMessages`, called from the boundary loop in
`livePromptEvents` so the read cards can be yielded as events (a callback cannot yield).
Per message: `@` expansion through the same `expandAtMentions` the fresh hop uses, under
a 10 s timeout; on timeout or abort, that message and the ones behind it go back through
a new `restoreSteering` seam (ink's `midTurnRestoreRef`) so nothing is lost; segments are
joined with a blank-line separator as ink does.

Not ported, on purpose: ink's `GOAL_COMMAND_RE` slash interception and its two-phase
`accept()` recording. OpenTUI has no goal-permit seam at that boundary, and its fresh hop
already records through `handleAtCommand`; cloning the transaction would import a
mechanism the renderer does not have.

### U-25 — no prompt-side vision bridge

With a vision bridge configured and a primary model that cannot take images, an image
reaching the model as raw `inlineData` should be converted, with an egress notice. ink
runs `applyVisionBridgeIfNeeded` on both hops; OpenTUI has only the tool-result side
(`event-adapter.ts` renders `visionBridgeNotice`), so the transcript can display a notice
that nothing on the prompt side produces.

Fix: `applyPromptVisionBridge` in `live-session.ts`, called on both hops. Shape follows
the existing non-ink port — `Session.#applyBridgeConversionsIfNeeded` — not ink's hook:
`hasImageParts` + `shouldRunVisionBridge` gate, the agent-capable full-turn branch, then
`runVisionBridge`, notices as neutral events, and on a non-applied result
`splitImageParts(...).nonImageParts` so images are never forwarded to a text-only model.

The full-turn branch needs a per-turn model override, which OpenTUI carries as
`LivePromptOptions.modelOverride` read once per turn. `livePromptEvents` keeps it in a
local now, so the bridge can set `getFullTurnVisionModelSelector(...)` for the rest of the
turn and the mapper's model name follows. Gates map one-to-one: a `submit_prompt`
override is ink's _inline_ override (the outcome is produced by the same code path that
sets `isInline: true`), so an active override skips the bridge, and the bridge's own pick
skips re-bridging at later boundaries.

### U-24 — the leg cannot prove any of it

`integration-tests/fake-openai-server.ts` writes every SSE chunk synchronously, so a
test cannot be sure the CLI is _mid-stream_ when it types. The handler is awaited before
the first byte, which only holds a turn pre-first-byte — the CLI is "thinking", not
streaming, and the mid-turn path a test needs is a different path.

Add `holdAfterChunks: number` + `holdUntil: Promise<void>` to `FakeOpenAIResponse`
(message-level, like `disconnectAfterContentChunks`), making `writeStreamed` async and
awaiting `holdUntil` after that many content deltas. The test owns the promise, so the
release is explicit; a case must always release it, or the fake server keeps the socket
open past `close()`.

New spec `integration-tests/interactive/mid-turn-submit-interactive.test.ts`, one file for
both legs (`e2e-interactive-opentui` runs the whole `interactive` directory except
`cron-interactive`):

| Case                                                                                             | Pins                                                                                                |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `/quit` while a held stream is mid-turn → process exits, the held content never appears          | U-24 (the mid-turn exit path itself)                                                                |
| bare `exit` while mid-turn → same exit                                                           | U-22 — ink passes today, OpenTUI only after this batch, so the case is differential by construction |
| `/stats` while mid-turn → "Queued" notice, runs after release                                    | the gate #10831 added, end to end                                                                   |
| `@notes.txt …` while mid-turn, then a tool call → the next request body carries the file content | U-21 + U-25's expansion hop                                                                         |

The last one asserts on the captured request body, not the screen: what a steered `@`
mention must change is what reaches the model. U-23 and the bridge's conversion half stay
unit-pinned with mutation checks — background memory tasks and a real vision-bridge
model are not observable through a fake chat-completions endpoint, and pretending
otherwise would add a fake for the sake of a green line.

### U-15 — the offline gate accepts a base that does not fail

`scripts/tui-parity/runner.mjs` counts both `base-fails-fixed-passes` and `both-pass` as
passing. In the offline no-flicker scenario the base side is a fixture emitter that
injects clears and unbalanced DEC 2026, so `both-pass` there means the fixture lost its
defect — the gate would keep reporting pass while quietly proving nothing.

Fix per scenario, not globally: an `expectBaseFailure` flag in the scenario schema, honoured
by `harnessPass`, set on `opentui-noflicker-offline` only. Two scenarios must keep
tolerating `both-pass`, and for a reason worth stating: `opentui-noflicker` (with
credentials) uses **ink** as its base side, where both-pass is the parity result the
scenario exists to measure; and the `self-test` override path runs identical emitter
argvs on both sides and asserts `both-pass` on purpose. A global tightening would have
broken the instrument in order to fix one fixture.

## Known adjacent gap, not fixed here

Mid-turn steering text has no transcript echo. ink's `accept()` adds a `USER` item with
`sentToModel: false` when the steered message lands; OpenTUI's queue shows a count and
the drained text disappears. Registered as a new U-xx when this batch lands rather than
silently widening the diff.

## Verification plan

- Units, mutation-checked per behaviour: `normalizeQuitSubmission`, `exitSession` calling
  `requestShutdown` (including that a second exit cannot re-arm it), the steering hop's
  expand/restore/timeout, and each bridge gate (skip on override, skip on the bridge's own
  pick, strip images when not applied, notice on egress-after-cancel).
- `scripts/tui-parity` self-test + runner tests for `expectBaseFailure`, including that a
  `both-pass` run of the offline scenario exits non-zero.
- `npm run build && npm run typecheck`; `packages/cli` vitest for the touched files.
- Both E2E legs on CI. Locally the interactive legs need `npm run build && npm run bundle`
  and `bun` on PATH; the OpenTUI leg cannot run here without a Bun ≥ 1.3.0 runtime, so a
  local ink-leg run plus CI is the plan, and the PR says which hop was proven where.

## Coverage boundary

The mid-turn cases are new instruments, not restated expectations: a case that passes on
both legs on its first run proves nothing about the fix it is supposed to guard, so each
one is checked red-then-green against the head before its own fix commit. The `@`-steering
case exercises a read of a small text file; the bridge's conversion half needs a real
vision-capable provider and is not covered by any E2E here.
