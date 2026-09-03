# Batch 8 — OpenTUI submit/exit semantics and mid-turn coverage

Closes U-15, U-21, U-22, U-23, U-24 and U-25 from #8662. Planned in
<https://github.com/QwenLM/qwen-code/issues/8662#issuecomment-5519887822>. Registers three
gaps it deliberately leaves unfixed: U-26, U-27 and U-28.

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

### Folded in from #10831 review (R4-1) — pinning the in-loop exit latch

The deferred-command drain in `opentui-app-shell.tsx` checks `isExitInProgress()` twice:
once at the effect edge, and once per iteration before each `gateway.dispatch`, because
the exit can start while an earlier command is still awaiting its outcome. #10831's
round-4 review noted that only the edge check was pinned — deleting the in-loop check
left the suite green.

New shell test: two commands are queued mid-turn, the fake dispatcher flips the exit latch
_inside_ the first command's handler, and the assertion is that the second never runs. The
drain is already past its edge check when the latch flips, so the in-loop check is the only
thing that can keep the second command back.

### U-21 — steering text rides raw

Text drained at the sampling boundary is pushed as `{ text }` with no `@path`
expansion, while ink expands that hop.

Fix: the boundary drain stops being a synchronous `string[] → responseParts` push.
`live-session.ts` gains `resolveSteeredPromptParts(config, texts, signal, emit)`, the
port of ink's `resolveSteeredMessages`, called from the boundary loop in
`livePromptEvents` so the read cards can be yielded as events (a callback cannot yield).
Per message: `@` expansion through the same `expandAtMentions` the fresh hop uses, under a
10 s timeout. Only an abort requeues — that message and the ones behind it go back through a
new `restoreSteering` seam (ink's `midTurnRestoreRef`) so nothing the turn never sent is
lost. A timed-out or declined read is dropped with a warning instead, as ink drops it: the
failed read is that message's problem, not the turn's, and requeueing it would retry forever.
Segments are joined with a blank-line separator as ink does.

Not ported, on purpose: ink's `GOAL_COMMAND_RE` slash interception, its two-phase
`accept()` recording, and the `checkImageFormatsSupport` warning the steered hop adds
after the bridge. OpenTUI has no goal-permit seam at that boundary, and its fresh hop
already records through `handleAtCommand`; cloning the transaction would import a
mechanism the renderer does not have. The format warning is a different case: OpenTUI's
fresh hop never had it either, so adding it to the steering hop alone would make the two
hops disagree about the same parts. It stays a renderer-wide gap, registered as U-27.

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

That "for the rest of the turn" is a per-boundary read, and a pick made at the steering
boundary is the only case that can tell: a test where the image arrives on the composer
already has the selector on both sends. So the pin routes an image in through a steered
`@` mention and checks the first send carries no override while the continuation carries
the selector — and names the vision model in its own notice, which the event mapper can
only do by reading the override again.

### U-24 — the leg cannot prove any of it

`integration-tests/fake-openai-server.ts` writes every SSE chunk synchronously, so a
test cannot be sure the CLI is _mid-stream_ when it types. The handler is awaited before
the first byte, which only holds a turn pre-first-byte — the CLI is "thinking", not
streaming, and the mid-turn path a test needs is a different path.

Add `holdAfterChunks: number` + `holdUntil: Promise<void>` to `FakeOpenAIResponse`
(message-level, like `disconnectAfterContentChunks`), making `writeStreamed` async and
awaiting `holdUntil` after that many content deltas. The test owns the promise, so the
release is explicit and every case releases it in its own path. A forgotten release is
degrading, not fatal: `close()` already tears held connections down — pinned by a unit
test, since "the run cannot hang on my instrument" is exactly the claim an instrument
like this must not make untested.

New spec `integration-tests/interactive/mid-turn-submit-interactive.test.ts`, one file for
both legs (`e2e-interactive-opentui` runs the whole `interactive` directory except
`cron-interactive`):

| Case                                                                                                  | Pins                                                                                                |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/quit` while a held stream is mid-turn → process exits, the held content never appears               | U-24 (the mid-turn exit path itself)                                                                |
| bare `exit` while mid-turn → same exit                                                                | U-22 — ink passes today, OpenTUI only after this batch, so the case is differential by construction |
| a custom `/defer-probe` typed mid-turn → its expanded prompt reaches the model only after the release | the drain behind #10831's gate, end to end (not the gate's verdict — below)                         |
| `@notes.txt …` while mid-turn, then a tool call → the next request body carries the file content      | U-21 + U-25's expansion hop                                                                         |

The last two assert on captured request bodies rather than on the screen, and that is a
decision the leg forced instead of a style preference. One file runs under **both**
renderers, and OpenTUI repaints by diffing cells, so text a user can plainly see may never
reach the byte stream as a contiguous run — a positive raw-output wait is the wrong
instrument there. Batch 8 found the harder half of that sentence the hard way: OpenTUI does
not render slash command output at all (U-28, below). The first version of the
deferral case watched for `Approval mode set to`, which ink prints and OpenTUI never does, for
a reason unrelated to the gate under test. Model traffic is the channel both renderers share
and neither can fake: after the release, the held command arrives as a second request whose
body is the prompt expanded from a project command file — text no other submission path
emits, and a request the case counts, so a command that ran twice or as raw typed text is
still visible. What that channel cannot show is the ordering _while_ the stream is held; the
probe result is in "Coverage boundary".

Both boot helpers pin `QWEN_CODE_LANG=en` for the child process. The CLI inherits the
developer's language, so every English UI string a readiness wait looks for is a locale
assertion; on a Chinese settings file the entire interactive suite fails as "CLI did not start
up in interactive mode".

U-23 and the bridge's conversion half stay unit-pinned with mutation checks — background
memory tasks and a real vision-bridge model are not observable through a fake
chat-completions endpoint, and pretending otherwise would add a fake for the sake of a green
line.

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

A gate failure has to name its own cause: `both-pass` under `expectBaseFailure` adds a
`Gate:` line to `report.md` and appends the reason to the scenario's console line, so a
red run reads as "the base fixture emitted no defect" rather than an unexplained outcome
mismatch.

## Known adjacent gaps, not fixed here

### U-26 — steered text has no transcript echo

ink's `accept()` adds a `USER` item with `sentToModel: false` when the steered message
lands; OpenTUI's queue shows a count and the drained text disappears. Registered as U-26
rather than silently widening this diff.

### U-27 — no unsupported-image-format warning on either hop

ink calls `checkImageFormatsSupport` after building the request parts on both the fresh hop
and the steering hop, and adds an INFO row naming the formats the model cannot read. OpenTUI
has no equivalent on either hop, so a `@file` that expands to, say, a TIFF reaches the model
with no disclosure. Registered as U-27 — porting it belongs to one change across both hops,
not to the steering hop only.

### U-28 — OpenTUI renders no slash command output

Found while writing the deferral case, and it is a product gap, not a measurement one. The
backend keeps two histories. `OpenTuiAppHost.addItem` appends a command's invocation echo and
every `info`/`warning`/`error` it returns to `host.history`, and no view reads that array:
`renderMain` draws the live-turn transcript, and `getHistory()` has two readers — the command
context and the composer's history list — neither of which renders. So a command runs, takes
effect, and never says so. The "Queued …" notice does show, because `notify()` writes a
separate slot — which is exactly what made the gap readable as a broken test.

`item-projection.ts` already converts special history items to display text and is imported
only by its own test, so the bridge exists unfitted. Wiring it is a rendering change with its
own ordering question (command output has to interleave with the live transcript rather than
stack above or below it) and it needs the `HistoryItem` kinds enumerated rather than
falling through silently. Registered as U-28: a different seam than submission and exit.

## Verification plan

- Units, mutation-checked per behaviour: `normalizeQuitSubmission`, `exitSession` calling
  `requestShutdown` (including that a second exit cannot re-arm it), the steering hop's
  expand/restore/timeout, and each bridge gate (skip on override, skip on the bridge's own
  pick, strip images when not applied, notice on egress-after-cancel).
- `scripts/tui-parity` self-test + runner tests for `expectBaseFailure`, including that a
  `both-pass` run of the offline scenario exits non-zero.
- `npm run build && npm run typecheck`; `packages/cli` vitest for the touched files.
- Both E2E legs locally, then on CI as the backstop. The interactive legs need
  `npm run build && npm run bundle` first; the OpenTUI leg additionally needs `bun` on PATH
  (1.3.14 locally), so both renderers are covered here rather than only in CI. The PR says
  which hop was proven where.

## Coverage boundary

A new instrument has to show it can fail, so each mechanism behind the four cases was
removed in turn, the CLI re-bundled, and the whole spec run on the OpenTUI leg with
`--retry=0`, then restored. The same four mutations ran again against
`opentui-app-shell.test.tsx` and `slash-gateway.test.ts` from source, so the units column
below is a measurement rather than an assumption.

| Mutation                                     | OpenTUI leg                | Units         |
| -------------------------------------------- | -------------------------- | ------------- |
| drain returns before replaying held commands | red — the deferral case    | red — 6 cases |
| bare quit token is not rewritten             | red — the bare-`exit` case | red — 9 cases |
| mid-turn gate always answers "run now"       | **green**                  | red — 9 cases |
| quit branch drops the interrupt              | **green**                  | red — 2 cases |

Those two green cells are the leg's real limit, and they share a cause: both mechanisms change
_when_ something happens inside a turn the fake server keeps open, and every observable this
file has is a request the CLI sent. Remove the gate and the command submits mid-turn — but a
mid-turn submit in OpenTUI _is_ a steer, so its expanded prompt still reaches the model only
after the held turn ends, and the request log is unchanged. Remove the interrupt and the
process still exits: teardown closes the socket however the turn ends. What the deferral case
does pin is the drain itself, plus that the command ran exactly once, after the turn, as an
expanded prompt rather than as typed text.

U-23's shutdown path is unit-only by construction, not by omission: the exit cases set
`enableManagedAutoMemory: false`, so no background task exists for `requestShutdown` to wait
on. The `@`-steering case reads a small text file; the vision bridge's conversion half needs a
real vision-capable provider and is covered by no E2E here.

Only the bare-`exit` case is differential — ink passes it before this batch and OpenTUI just
after. On the other three an ink pass shows the instrument is renderer-neutral; U-21, U-22 and
U-23 live in OpenTUI-only code, so the OpenTUI leg is the only one that can redden for them.

One probe survived, and it is worth naming: deleting the drain effect's _pre-loop_ exit-latch
check leaves the unit suite green, because the in-loop check refuses every command the edge
check would have stopped. That redundancy is why the R4-1 test has to flip the latch inside an
in-flight dispatch rather than before the drain runs, and why the edge check itself stays
unpinned. That mutation was probed against the units only, not against the leg.
