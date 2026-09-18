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
as leg-neutral. The turn-done marker (a single-token match, insensitive to
the mechanism) stays a visible-transcript oracle, on the `waitForScreen`
channel: after the request-body count confirms the second request was sent,
the spec waits for the fake model's completion marker to reach the rendered
transcript, so the gate proves a render and not merely a send.

## Decision 3 — U-36: config initialization is a shared once-guard, not a swallowed retry

The OpenTUI leg hung on `Chat not initialized`: `config.initialize()` is
asynchronous while the first render is not, so a prompt submitted before
initialization settles reached the chat before the chat existed — and the
old `try { await config.initialize() } catch {}` in `livePromptEvents`
swallowed the failure, leaving no screen signal. Core joins callers onto an
in-flight initialize and only rejects once initialization has settled, so a
plain await is already race-safe; what it cannot do is own one boot flight or
preserve a failure.

`ensureConfigInitialized(config)` in `live-session.ts` keeps a
`WeakMap`-keyed shared promise: the entry starts one flight before the first
render and the turn path awaits the same settlement, and when initialization
fails the rejected promise stays cached — core never retries a settled
initialization, so re-entering would report core's "Config was already
initialized", be swallowed, and degrade into the bounded wait's "Chat not
initialized"; keeping the rejection cached surfaces the real cause on every
later submit instead. A genuine failure propagates to the screen instead of
hanging.

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

U-6/G-1 (landed — Decision 8), U-7/G-2 (landed — Decision 11),
U-9 (landed — Decision 10), G-3 (landed —
Decision 9), U-33 (landed — Decision 15), U-34 (landed — Decision 14), U-32
(landed — Decision 12), U-11 (landed — Decision 13), U-13 (landed —
Decision 5).
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
`handleAutoUpdate.test.ts` (deferred-then-flushed, ordering, empty queue),
and the extracted `useUpdateNoticeFlush` hook
(`packages/cli/src/ui/opentui/use-update-notice-flush.ts`, called from the
entry) carries its own suite (`use-update-notice-flush.test.ts`) that pins
registration, immediate delivery while idle, the deferred queue across
streaming rerenders, and the flush-on-idle drain. Only the entry-harness
wiring remains review-pinned (`root.render` is mocked there, so React never
runs and no effect fires — the same boundary as Decision 8). Entry suite,
typecheck, and eslint clean.

## Decision 10 — U-9: the shell owns settings sub-dialog routing and composer fill

The mount-side seams (`fillInput` / `onSelectSetting` on
`OpenTuiDialogMount`) existed since Batch 4 but nothing fed them: the shell
passed neither, so every settings sub-dialog row reported "opens a dialog
this shell does not mount" and the arena picker's fill was reported lost.
The settings dialog itself already mirrors ink (only the four sub-dialog
rows — `ui.theme`, `general.preferredEditor`, `fastModel`, `visionModel` —
fire `onSelect` with a name; everything else is handled in-dialog), so the
fix is ownership only. The shell now routes those rows exactly like ink's
DialogManager (`theme`, `editor`, and the model dialog in `fast`/`vision`
mode) and owns the composer fill, reusing `injectCapturedInput`'s
poll-until-attached injection because the picker unmounts the prompt (the
handle detaches) before remounting it. One ownership change in the mount:
with an owner present, a named selection no longer calls `onClose`
afterwards — the owner navigates by replacing the request, and a close
there would clobber the dialog it just opened (ink's owner closes for
non-sub-dialog names; here the owner's `else` does the same).

Coverage: shell tests pin all four routings (each selection's request
observed through the mount mock), the unknown-name close, and the composer
fill through a pre-attached handle (real-timer poll, 40ms budget); the
mount test pins the no-owner notify fallback (pre-existing) and that an
owner-present selection does not close. 43 tests across the two suites,
typecheck and eslint clean.

## Decision 11 — U-7/G-2: follow-up suggestions, generation at the entry, consumption at the composer

Ink splits the feature in two: AppContainer generates on the
Responding→Idle edge and InputPrompt consumes it (ghost placeholder,
Tab/Right/Enter accept, typing dismiss, submit clear). The OpenTUI split
follows the same ownership: the generation effect is ported into a new
`useFollowupSuggestionGeneration` hook called from the entry (the entry owns
`live.streaming` — the shell deliberately holds no stream state), and the
composer consumes it through the renderer-neutral
`useFollowupSuggestionsCLI` hook that ink already shares from core. The
entry publishes `promptSuggestion` + `onPromptSuggestionDismiss` through the
shell into the prompt; acceptance inserts into the edit buffer (never
submits — Enter on an empty buffer with a ghost fills it, so `/clear` cannot
execute by accident), and the ghost rides the existing placeholder slot
(`placeholder={availableSuggestion ?? placeholder}`, ink's exact shape).

Gates mirror AppContainer verbatim: unset `enableFollowupSuggestions` is
enabled (schema defaults don't apply through `mergeSettings`), plus
`isInteractive`, no SDK mode, no PLAN mode, last live item not an error, and
no parked confirmations (`waitingCalls.length === 0` ≙ ink's confirmation
requests). Two accepted deviations: ink also scans pending items for errors
— the merged live fold makes the last-item check the reachable equivalent;
and a slash dialog the shell opened mid-turn is invisible to the entry, so a
suggestion may generate while a dialog is open — the composer is unmounted
then (ghost not visible) and the next turn boundary clears it. Speculation
(`enableSpeculation`) is ink-extra and stays out. The abort semantics are
the ink ones: any turn boundary or unmount aborts the in-flight
`generatePromptSuggestion` call, and a `filterReason` result logs the
suppressed analytics event.

Coverage: `followup-generation.test.ts` (12 renderHook tests) pins the
edge trigger, the cache-sharing flag passthrough, the five gates, the
disabled-settings clear, the turn-boundary clear, the suppressed event, and
the unmount abort. `input-prompt.test.tsx` gains 7 tests (ghost placeholder
observed through the fake textarea's captured props, Enter fills-not-submits,
Tab/Right fills, typing dismisses-but-inserts, submit clears).
`opentui-app-shell.test.tsx` pins the prop pass-through. The entry-side hook
call itself is untestable in its harness (no effects run — same boundary as
Decisions 8/9) and is review-pinned against AppContainer's generation
effect.

## Decision 12 — U-32: the steering hop is recorded for /resume

`recordMidTurnUserMessage` (core) writes a steered message into the chat
recording with the `mid_turn_user_message` subtype so /resume reconstructs
the exact API shape (user parts riding the same Content as tool results).
Ink calls it from its steering `accept()`; OpenTUI's U-12 port carried the
echo but not the recording — zero callers. The fix stays in the existing
ownership: `resolveSteeredPromptParts` now collects per-message recordings
alongside the echo events (same membership as the echo: a declined message
is neither echoed nor recorded; an empty-parts one is both, matching ink's
accept()), and the drain loop records them at the commit point — after the
restore check, before the echo events yield, so a restored hop records
nothing (the all-or-nothing contract ink's restore already enforces). No
goal-permit argument: the goal command has no OpenTUI counterpart (the
already-documented not-ported list keeps only what is genuinely absent —
slash interception and the read-card deferral; the recording is now
ported).

Coverage: `live-session.test.ts` gains two tests — per-message recording
shape `([[{text:'first'}],'first'], [[{text:'second'}],'second'])` on a
two-message hop, and zero recording on the restored (aborted read) hop.

## Decision 13 — U-11: the queue pop separator, and the filters that cannot apply

The re-scoped item (both sides pop the whole queue; the "ink cancels
individually" premise was stale) left two deltas. The separator: ink joins
popped queue texts with a blank line everywhere it aggregates —
`aggregateUserMessages` (modelText and submittedPrompt alike) and
`getQueuedMessagesText` — which also matches the model-side steering join
(`resolveSteeredPromptParts` pushes `{text:'\n\n'}` between segments). That
is authoritative: OpenTUI's `popQueue` now joins with `\n\n` (was `\n`),
matching the Esc-restore-into-composer shape.

The filters: ink's `popAllMessages` keeps peer entries queued (a
peer-authored envelope re-submitted from the composer buffer would lose its
attribution through UserQuery preprocessing) and the mid-turn `drainQueue`
excludes slash commands (they chain as their own submissions). Neither can
apply here: OpenTUI's queue is plain text fed only by the composer's
plain-text submits — slash commands defer in the shell's
`deferredCommandsRef` and never reach the live queue
(`opentui-app-shell.tsx` `onSubmit`), and peer messaging has no OpenTUI
queue. Nothing to exclude; the divergence is structural absence, not a gap.
The one-per-chained-turn end-of-turn resubmit stays as adjudicated in the
re-scope: every text eventually replays, nothing is dropped.

Coverage: the existing `live-turn.test.ts` Esc-restore test pins the new
separator (restored batch + queued text, joined with blank lines).

## Decision 14 — U-34: the four command cards get structural rows, not info rows

Four history kinds written by slash commands (`advisor`, `away_recap`,
`arena_agent_complete`, `arena_session_complete`) projected to `null` in
OpenTUI — the commands ran, their output vanished. The ledger explicitly
rejected bare info rows as a fix ("pre-empts the design"), so each kind gets
the full dedicated chain, mirroring the goal/compaction/stop-hook precedent:
a structured stream event (item-projection) → a `LiveHistoryItem` kind
(live-session-model fold, settling a streaming assistant first) → a
transcript row component (transcript-view). Payloads stay structured
(`ArenaAgentCardData`) so rows can color status, not flattened strings.

Ink shapes mirrored per kind: away_recap → `AwayRecapMessage` (`※` gutter,
bold `recap:`, italic body, all secondary — attributes 1/4 on sibling text
nodes, since `<span>` has only an `fg` precedent); advisor →
`AdvisorMessage` (`/advisor` bold header + ` · model`, markdown body under
`paddingLeft={2}` — the ink round border is dropped, the transcript
separates cards by indentation); arena_agent_complete → `ArenaAgentCard`
(status line colored by status, dim Tokens/Tool Calls lines, ✓ count green
/ ✕ count red, optional red error line); arena_session_complete →
`ArenaSessionCard` (title branches Comparison Summary/Cancelled/Failed, the
four comparison sections only for idle|completed, `├─`/`└─` branches, the
4-file cap with `+N more`, hint with `/arena select` accented). The ink
component's module-private helpers are mirrored locally (`arenaDiffStats`,
`arenaAgentFiles`, `arenaFileList`, `arenaFileGroups`).

Status colors: `getArenaStatusLabel` returns ink theme hexes, which would
not track the OpenTUI theme swap (`applyThemeMode` mutates `C`), so the rows
map the core `AgentStatus` enum onto the live palette locally
(`arenaStatusColor`: idle/completed → green, cancelled → yellow, failed →
red, else dim) while still reusing the helper's icon/label text.

Still no-ops, each for a stated reason: `tool_use_summary` (written only by
ink's use-llm-stream — no OpenTUI producer), `diff_stats` (file-history
rewind flow, no OpenTUI seam), and `notification` (no writer yet).

Resume consistency: arena items are recorded via `recordSlashCommand`
outputHistoryItems but `transcribeSession` never replays them on either
renderer — a live-only projection keeps parity with ink.

Coverage: unit-level only — `item-projection.test.ts` pins each kind's
structural event payload, `live-session-model.test.ts` pins the fold, and
the former no-op test list shrinks by exactly the four kinds. No e2e leg
drives these rows (they need real `/advisor`//`arena`//`recap` command
runs); `npm run typecheck` and eslint clean on the touched files.

## Decision 15 — U-33: the `!` shell mode is the row plus the minimal writer behind it

A row-only U-33 would be dead code — nothing in OpenTUI writes `user_shell` —
so the honest scope is the full minimal shell mode, mirroring ink's five
touchpoints. Entry/exit: `!` on an empty composer buffer toggles shell mode
in both directions (ink does not gate the toggle on the mode either; a
non-empty buffer still inserts, so `echo hi!` is unaffected), Esc exits the
mode first and — when a turn is streaming — also interrupts it on the same
keypress: ink does both in one keypress (InputPrompt exits the mode with no
streaming gate while AppContainer's broadcast handler cancels the request),
so OpenTUI mirrors the pair rather than picking one. The chrome prefix
becomes `!`, overriding the approval-mode prefix and status
text. Routing: slash dispatch is checked before
shell mode exactly as in ink's use-llm-stream, so `/help` in shell mode still
dispatches; a shell-mode submission runs without a model turn — typing the
command IS the consent, matching ink's no-approval shellCommandProcessor.

Mid-turn submissions defer through the existing streaming gate as tagged
entries `{text, shell}`: the drain drops `outcome === false` dispatches, so
an entry must carry its own routing instead of relying on ambient shell-mode
state, and a shell command queued behind a turn replays after it — the drain
awaits each shell before the next entry, so queued commands cannot race each
other. Execution
is a thin OpenTUI-local executor (`shell-mode.ts`) over core's
`ShellExecutionService.execute` — ink's `handleShellCommand` core is too
ink-entangled to extract (`setPendingHistoryItem`, `themeManager`, pty id
handling), so the ~40 lines that matter are mirrored: the cwd-capture wrapper
on non-Windows, the stateless-`cd` warning prepended to the status prefix,
and the error/cancelled/signal/exit-code prefixes. Child-process text streams
as 1s-throttled deltas; pty and binary streams land once at completion
(neither replays as append deltas). The result event appends only the tail
the streamed head does not already cover (compared against the trimmed
emission, since the stream tail usually carries the final newline the trimmed
result drops).

The transcript shows ink's two rows: the `$ ` command row (`user-shell`
event; ink's link color maps to `C.accent` — the live palette has no link
key) and a synthetic `run_shell_command` tool card driven through the
existing tool-start/description/output/result/end events, so it inherits the
whole card pipeline including the Decision 7 flood bounding; the card has no
confirm field, hence no approval dialog. The command+result is injected into
the LLM history by reusing ink's exported `addShellCommandToLlmHistory`
(single authoritative copy, 10k-char truncation included).

Live-only, consistent with U-32/U-34: the OpenTUI shell run is not recorded,
and ink-recorded `user_shell` history items replay through the projection
(resume parity) — which is why `item-projection`'s `user_shell` null arm
shrank in the same commit. Documented divergences: the per-run
AbortController is aborted only on quit — Esc during a running shell cancels
the model turn, not the shell command (ink's Esc interrupts both); and ink's
shell-history extras (persistent per-project command history with up/down
recall and `(r:)` reverse search, prompt-history navigation disabled in
shell mode) are not ported — they are a self-contained feature behind
`useShellHistory`, deferred rather than silently dropped.

Coverage: unit-only. `shell-mode.test.ts` (8 tests) pins the event sequence,
the shared card id, the throttle (no delta before 1s, one delta after), the
tail dedup (streamed `hello world\n` + identical result → empty append), the
full-output and exit-code/cancelled/binary prefixes, the pwd warning plus
tmp-file cleanup, the pty no-delta path, and the execute-failure error event;
`item-projection.test.ts` pins the replay projection and the fold is pinned
in `live-session-model.test.ts`; `input-prompt.test.tsx` gains three tests
(empty-buffer `!` toggles, non-empty `!` inserts, Esc exits before the queue
restore). The submit routing lives in the shell harness where submit cannot
run (same boundary as Decisions 8/9) and is review-pinned against
AppContainer. No e2e leg drives a real `!` command. `npm run typecheck` and
eslint clean on the touched files; 181 tests green across the five suites
(shell-mode 8, item-projection 39, live-session-model 43, input-prompt 56,
opentui-app-shell 35).

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
