# Batch 10 — OpenTUI parity closeout (dialogs, entry, composer, transcript, recording, resume)

Design doc for the merged Batch 10/11 closeout. The two seam cuts were merged
into one PR on 2026-09-04 (author call, recorded in the ledger): U-33 and U-34
both fill the `item-projection.ts` null arm and U-32/U-11 both touch the
steering drain path, so a seam split would open the same file to two reviews.
One item per commit keeps each round readable. Plan paragraph in the
[#8662 ledger](https://github.com/QwenLM/qwen-code/issues/8662).

## Problem

Three groups of gaps, all verified against main `9c320cb0cc` before planning:

1. **Entry/composer gates (G-1, G-2, G-3)**: the auth dialog never auto-opens
   (only the trigger is missing — the dialog itself is already mounted), no
   follow-up suggestions exist under `ui/opentui/`, and the reserved
   update-notification banner slot is unfilled.
2. **Projection/recording gaps (U-33, U-34, U-32, U-11)**: the `!` shell mode
   is advertised but nonexistent, four dedicated-component history kinds
   project to nothing, steered messages are visible (Batch 9) but not recorded
   to the chat log, and the mid-turn queue lifecycle needs an authoritative
   separator decision.
3. **The harness the batch's acceptance runs against** (U-31): the mem0-write
   interactive spec self-spawns its PTY and never picks up the renderer
   matrix, so its OpenTUI leg exercised ink — a false green inside the gating
   leg, registered as an adjacent finding in the Batch 9 doc.

U-31 was dispatched first because every other item's e2e acceptance runs
through that spec; the wiring immediately surfaced two app defects (U-36,
U-37) and two more behavioral divergences (all-cancelled continuation,
confirming-card flood), all fixed inside this batch rather than deferred —
the harness leg cannot go green while any of its five scenarios hangs or
floods.

## Decision 1 — U-31: wire the self-spawning spec to the renderer matrix

`external-context-mem0-write.test.ts` now calls `pickE2eRenderer` /
`resolveE2eCliCommand` / `e2eRendererEnv` like every matrix-aware spec, and
keeps its own `runInteractive` PTY harness (it drives scenarios
`InteractiveSession` cannot express: mid-turn hook confirmations with
content-visible bodies). The opentui leg carries `QWEN_TUI_RENDERER_STRICT`,
so a silent ink fallback fails the boot instead of passing as a false green.

The wiring's first run turned the prediction from the Batch 9 doc into
measured fact: two app defects and an observation-channel trap, each covered
by the decisions below.

## Decision 2 — the observation channel is the reconstructed screen, not raw PTY bytes

OpenTUI redraws by cell diff: over a previously-blank background it emits the
glyph cell without the space cells a full-width row would carry, so
`waitForText` (a `stripAnsi(...).includes(...)` match on the raw byte stream,
with no whitespace normalization) on a multi-word row is a coin flip — four
scenarios timed out in the first wired run on strings the same code path had
rendered, and one passed only because diff history happened to align. The
spec's flow-gating assertions moved to xterm-headless screen reconstruction
(`waitForScreen` over the 110×38 viewport, polling 200 ms), the same channel
`InteractiveSession.screen()` uses, which is faithful on both legs. The ink
leg passed 5/5 with the screen-based spec unchanged, which pins the channel
as leg-neutral. Single-token matches (the suite-wide canary, the turn-done
marker) stay on `waitForText` deliberately: they are insensitive to the
mechanism and keep a second independent channel in the spec.

## Decision 3 — U-36: config initialization is a shared once-guard, not a swallowed retry

The OpenTUI leg hung on `Chat not initialized`: `config.initialize()` is
asynchronous while the first render is not, so a prompt submitted before
initialization settles reached the chat before the chat existed — and the
old `try { await config.initialize() } catch {}` in `livePromptEvents`
swallowed the failure, leaving no screen signal. Command loading already
calls `initialize()` concurrently and a second concurrent call rejects, so
"call it again and wait" was not available.

`ensureConfigInitialized(config)` in `live-session.ts` keeps a
`WeakMap`-keyed shared promise: first caller wins, everyone awaits the same
settlement, a loser that observes `isInitialized()` proceeds. The entry calls
it fire-and-forget before the first render (so boot overlaps initialization
without serializing startup), and the turn path awaits the same promise. The
swallow is removed: a genuine initialization failure now propagates to the
screen instead of hanging.

## Decision 4 — U-37: the MCP confirmation asks ink's question

ink's MCP confirmation renders the question line
`Allow execution of MCP tool "{{tool}}" from server "{{server}}"?`
(`ToolConfirmationMessage.tsx` builds its own question; core supplies only
the title). OpenTUI showed title + display name + `server · tool` and no
question. The mcp case in `dialogs-confirm.tsx` gained the question line
through `t()`. The wired spec gates on exactly this row, so the fix is
e2e-observed on both legs.

## Decision 5 — U-13: TextBody keeps its head and offers ctrl-s (scope widened from the notice)

Registered as a cosmetic one-liner (add the `... N lines hidden ...` notice
`DiffBody` already has), the ledger's 2026-09-04 verification found the real
ink behavior is richer and OpenTUI's was worse than "no notice":
`TextBody` used a **tail** window (`tailWindow`) while ink's info confirmation
uses MaxSizedBox `overflowDirection 'bottom'` — it keeps the **head** and
hides the tail, with ShowMoreLines' hardcoded `Press ctrl-s to show more
lines` hint and a ctrl-s expand. A tail window also hides exactly the rows
that make a confirmation reviewable.

`TextBody` now mirrors ink: `headWindowPhysical` in `messages.tsx`, the
hidden-tail indicator, the hint row, and a one-way ctrl-s expand
(`setExpanded(true)`, no collapse — ink's ShowMoreLines has no collapse
either). The window is **physical-height** aware: the mem0 confirmation's
`renderMemoryContentForConfirmation` is `JSON.stringify`, which collapses 142
content lines into ONE logical row (~3.9k chars) that wraps to ~36 physical
rows — a logical-row window (the original `headWindow` draft) counts it as 1
row and never fires. `headWindowPhysical` estimates `ceil(len/cols)` per
logical row and slices an over-budget row's head. Unit tests pin both the
multi-row and single-mega-row shapes.

## Decision 6 — a whole-batch cancellation ends the turn without a follow-up request

Found by scenario 2 of the wired spec: after the user rejects the hook
confirmation with Esc, OpenTUI sent a **second model request** where ink sends
none (`AssertionError: expected fakeModel.requests to have length 1 but got
2`). Debug-log forensics (token-count provenance lines 350 ms apart, +71
tokens = the cancelled tool response) pinned the mechanism: the continuation
loop built `responseParts` from the cancelled call's `responseParts` and
submitted them as a ToolResult hop.

ink pins the semantics (use-llm-stream.ts:5328-5358): when
`llmTools.every((tc) => tc.status === 'cancelled')` (and no duplicate
responses are pending), the cancelled functionResponses go to history via
`addHistory` and the turn ends. Ported into `livePromptEvents` as an
early-return **before** the steering drain, so steered texts that queued
during a cancelled batch stay parked for the post-turn queue instead of
riding a request that will never be sent. This is a pre-existing OpenTUI
behavioral difference, never observable before the wiring because scenario 2
always died at the MCP gate first.

Measured twice: the new unit test (fake scheduler honors `__cancelled`,
asserts one `sendMessageStream` call and one `addHistory` with
`role: 'user'`) goes red with `called 1 times, but got 2 times` when the
early-return is disabled, green when restored — the e2e failure's exact
signature.

## Decision 7 — the confirmation is one surface: the dialog carries the payload

Found by scenario 5: the MCP tool card's description is the tool's full args
JSON (core `mcp-tool.ts` returns `safeJsonStringify(this.params)` — ink
renders the same through ToolMessage), which wrapped to ~50 physical rows and
pushed the content-confirmation dialog off the 38-row viewport. Three root
layers, each discriminated by a progressively richer failure dump
(`.qwen/u31-opentui-fix{8,9,10,11*}-scenario5.log`):

1. **The confirm transcript event never fired on the real path.**
   `livePromptEvents` never emitted `type: 'confirm'` — only event-adapter's
   pipeline did — so no card ever had `confirm: 'pending'`, and the pending
   `(awaiting approval)` marker never rendered either. The fix emits
   `type: 'confirm'` once per `awaiting_approval` entrance (deduped through
   the same `waitingSeen` set that gates `onWaitingCall`, so a PreToolUse
   'ask' bounce re-marks the card), plus `type: 'confirm-resolved'` when a
   call leaves the state — without the latter the card would keep claiming
   "awaiting approval" while the call executes. A/B measured: without the
   event the collapsed step times out on the full JSON flood; with it the
   dialog appears.
2. **The expanded body overflowed.** ctrl-s worked but a full render
   (~40 rows) inside a fixed alt-screen viewport clips at the bottom —
   ink reaches the tail through terminal scrollback, which alt-screen does
   not have. The expanded branch now renders a **tail** window
   (`tailWindowPhysical`, the mirror of `headWindowPhysical`) budgeted as
   terminal height minus `EXPANDED_BODY_RESERVE_ROWS` (dialog chrome plus the
   transcript region that stays put above the dialog), with no hidden-lines
   label — ink's observable expanded contract is "tail on screen, no
   indicator". Unit tests pin the tail window's fits/mega-row/whole-row
   shapes and the collapsed→expanded transition on the JSON payload.
3. **The card duplicates the payload the dialog already carries.** With the
   dialog machinery working end-to-end, the only remaining predicate
   violator was the card's own capped description and its
   `... last N lines hidden ...` label lingering on screen after the body
   expanded (ink renders the confirmation as ONE inline surface; its
   expansion scrolls the card away). While `confirm === 'pending' && !done`
   the card therefore renders **no description at all** — the dialog below
   is the payload surface.

The cap survives in generalized form: ink bounds EVERY tool card through the
static-area height distribution (MaxSizedBox), while OpenTUI's per-item
budget (`maxHistoryItemRows` = terminalHeight×4) never engages on a
single-logical-row JSON wrapping to dozens of physical rows — the resolved
card flooded all 38 rows and pushed the post-approval turn's output out of
the viewport (fix11 dump: `✓ mcp__external-context__…` + full JSON rows 02-37,
nothing else visible, despite `providerRequests=1 modelRequests=2` proving
the turn had completed). `capToolCardDescription` + `TOOL_CARD_DESCRIPTION_ROWS`
now bound every card description head to 5 wrapped rows with
`hiddenTailLinesLabel` summarizing the tail — the same character-based wrap
estimate as before, applied unconditionally instead of only when pending. The
per-item height distribution itself stays open as transcript-region work.

## The nine ledger items (to be recorded as they land)

U-6/G-1 (landed — Decision 8), U-7/G-2 (follow-up suggestions),
U-9 (settings sub-dialog routing + `fillInput` owner), G-3 (landed —
Decision 9), U-33 (the `!` shell row), U-34 (four row shapes), U-32 (steer
recording), U-11 (queue separator decision), U-13 (landed — Decision 5).
Each lands as its own commit in this PR with its decision recorded here.

## Decision 8 — U-6/G-1: the auth auto-open trigger

The registered "the entry receives no initialization result" shrank again on
inspection: ink's `InitializationResult.shouldOpenAuthDialog` is dead in
production code. The dialog's boot auto-open is exactly two triggers —
`config.getAuthType() === undefined` (useAuth's `isAuthDialogOpen` initial
state) and the one-shot startup `authError` (`useInitializationAuthError`) —
so the entry computes that once at boot and hands the shell an
`initialDialog` request (`{ dialog: 'auth', initialError? }`, an additive
extension of the auth variant of `OpenTuiDialogRequest`). The shell seeds its
`dialog` state from it; every later `setDialog` stays slash-dispatch owned.
The auth dialog seeds its existing local error surface with `initialError`,
so a failed startup login opens showing the message ink shows, while the
no-provider open carries no error (same as ink). One-shot semantics hold by
construction: the request is computed once before the renderer exists, not in
a re-rendering hook.

The wiring's first test run also exposed two latent regressions of the U-31
commit: the entry-test's mock config lacked `initialize`, so
`ensureConfigInitialized`'s synchronous `config.initialize()` call threw
before the runtime sidecar — both fallback-contract tests had been failing
since `f6213a18cd` (the 138-test verification ran four files but not this
one).

Coverage: unit-only. The three boot shapes (unauthenticated → open without an
error; startup authError → open with the message; authenticated → no
auto-open) are pinned by asserting the rendered element tree in
`start-opentui-ui.test.tsx` — 70 tests across the five touched files, plus
typecheck and eslint clean. No real-terminal boot scenario was exercised;
the dialog's own flows are covered by the existing dialogs-auth suite.

## Decision 9 — G-3: update wiring was mostly there; the gap was flush-on-idle

The ledger's "update-check wiring" gap shrank on inspection. Most of the
chain was already in place on main: the check bootstrap is renderer-neutral
(`startPostRenderPrefetches`' `update_check` task, gated on
`enableAutoUpdate` / skip / sandbox env, called by the OpenTUI entry), the
entry registers `setUpdateHandler` with an idle ref synced from
`live.streaming` and maps its item types onto the transcript, and the shell
renders the banner slot (suppressed while a dialog, modal, or tool call is
active). The actual delta vs ink was the drain: `handleAutoUpdate` defers
notifications that arrive mid-turn into `pendingNotifications`, and `flush`
is the only drain — ink calls it when the turn returns to `Idle`
(AppContainer), but the OpenTUI entry destructured only `{ cleanup }`, so a
mid-turn update notice would sit queued forever. The entry now holds
`{ cleanup, flush }` in a ref and flushes when `live.streaming` flips false.

Coverage: the deferral/flush mechanism itself is pinned by
`handleAutoUpdate.test.ts` (deferred-then-flushed, ordering, empty queue).
Both the entry-side registration and the flush-on-idle effect cannot execute
in the entry harness (`root.render` is mocked, so React never runs and no
effect fires — the same boundary as Decision 8); they are review-pinned
against AppContainer's idle effect. Entry suite, typecheck, and eslint
clean.

## Coverage boundary

Verified on the final state (both legs, `QWEN_CODE_LANG=en`):

- `interactive/external-context-mem0-write.test.ts` — **5/5 on OpenTUI and
  5/5 on ink** (`.qwen/u31-opentui-final.log`, `.qwen/u31-ink-final.log`).
  Scenario 5 exercises the whole Decision 7 chain on the OpenTUI leg:
  collapsed head + literal markdown + `lines hidden` + ctrl-s → expanded tail
  with `CONFIRM_TAIL` and no indicator → approval → turn completes. Each
  fix layer was mutation-verified by a distinct red: no confirm event
  (fix8), expanded clip (fix9), card label on screen (fix10), resolved-card
  flood (fix11); the request counters inside the fix11 error message
  (`providerRequests=1 modelRequests=2`) are what separated the render flood
  from a real stall.
- **Post-approval sync changed on both legs**: `rig.waitForText`
  reads the raw pty stream, which the OpenTUI leg redraws by cell diff —
  rendered transcript rows never reliably appear there (the test already
  used screen-based waits for the confirmation itself). The approve-branch
  now polls request bodies (`fakeModel.requests.length >= 2`) —
  renderer-independent, and the load-bearing post-approval semantics stay
  pinned by the server-side assertions (`providerRequests`,
  request-path/body). Ink behavior is unchanged in outcome.
- Unit: 138 tests across `messages.test.tsx` / `dialogs-confirm.test.tsx` /
  `live-session.test.ts` / `live-session-model.test.ts` pin the window
  arithmetic, the confirm/confirm-resolved sequence (incl. the hook-bounce
  re-entrance), and the cap math — mock-level evidence only; the end-to-end
  claim rests on the two e2e runs above. `npm run typecheck` and
  `npm run lint` clean.
- Not covered: transcript per-item height distribution (the cap is the
  interim bound), OpenTUI transcript autoscroll, and any renderer not in the
  two tested legs.
