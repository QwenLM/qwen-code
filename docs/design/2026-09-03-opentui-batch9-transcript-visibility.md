# Batch 9 — OpenTUI transcript visibility (U-28, U-12, U-27, U-29, U-30)

Design doc for the batch closing the visibility gaps registered after the
Batch 8 audit. Plan announced in [#8662 (comment)](https://github.com/QwenLM/qwen-code/issues/8662#issuecomment-5524674134).

## Problem

The OpenTUI backend keeps two histories and only one of them renders:

- `OpenTuiAppHost.history` — the ink-shaped command history. `addItem` is where
  every dispatcher write lands: the invocation echo, every `info`/`warning`/
  `error`/`success` a command returns, `goal_state`/`goal_status` cards, and
  the arbitrary items a `'history'` command outcome replays. Its only readers
  are the command context and the composer's history list — neither renders.
- `useOpenTuiLiveTurn.items` — the live transcript `renderMain` actually
  draws. It is folded from `OpenTuiStreamEvent`s only.

Consequences, all verified against the code (issue #10905 carries the full
repro):

- **U-28** — a slash command runs, takes effect, and never says so. The echo
  and its output are written to `host.history` and never displayed.
- **U-12** — mid-turn steered texts disappear from the transcript: the queue
  badge drops and the drain sends the parts to the model with no user row.
- **U-27** — no unsupported-image-format disclosure on either hop; ink adds an
  INFO row on both.
- **U-29** — discovered while designing the seam: `SessionSwitchHost` already
  documents `clearItems` as "Clears the command history AND the visible
  transcript" (session-switch.ts:55), but the implementation clears only the
  history. After `/clear`, `renderMain` keeps every live row on screen. The
  contract's second half was never implemented.

## Decision 1 — one ordered model: project-on-write at `addItem`

Two options were weighed:

1. **Render `host.history` alongside the live transcript.** Two models would
   have to be interleaved in one scroll, with a merge/dedupe story for the
   user rows both sides carry (composer submits never touch `host.history`;
   command echoes exist only there). Rejected: the interleaving is exactly the
   state the migration has avoided owning twice.
2. **Project at write time (chosen).** `host.addItem` converts each item it
   actually records into an `OpenTuiStreamEvent` and appends it to the live
   transcript through the existing transcript seam. One ordered model, no
   merge. This works because of three verified lifecycle facts: live items
   persist across turns (only `resetTranscript`/`foldBatch` replaces them),
   the host is the stable external store the dispatcher writes through, and
   `/resume`/`/branch` already replace the transcript wholesale _after_
   `loadHistory`, so replay order matches ink's single-history order.

Leaning announced in the plan comment; this doc pins it.

## Decision 2 — the seam grows to `{ reset, clear, append }`

`OpenTuiTranscriptController` (opentui-host.ts:64-67) is `{ reset(events) }`.
It becomes:

```ts
interface OpenTuiTranscriptController {
  reset(events: OpenTuiStreamEvent[]): void; // replay (single commit)
  clear(): void; // /clear, /reset, /new (U-29)
  append(event: OpenTuiStreamEvent): void; // one projected item (U-28)
}
```

- The shell implements `append` over a new `onTranscriptEvent` prop, which the
  entry wires to `live.applyEvent`; `clear` reuses the existing
  `onTranscriptReset` with an empty batch (an empty fold is a fresh list), so
  no second reset path is added. Absent prop → no-op, matching how
  `onTranscriptReset` already degrades in tests.
- Adding a dep to the `transcript` memo does not destabilise the host built from
  it: both callbacks are referentially stable (`apply` is a `useCallback` with no
  deps, `resetTranscript` depends only on the equally stable `setBusy`), so the
  memo — and the `host` memo that consumes it — keep one identity per session.
  A churning host would drop `host.history` and rebuild the dispatcher on every
  render, which is the failure this check rules out.
- `host.clearItems` calls `transcript.clear()` — this is U-29's fix, and it
  completes the contract comment that already promised it.
- `host.loadHistory` does **not** project: it is a replace operation and both
  `/resume` and `/branch` call `resetTranscript` immediately after it, which
  owns the visible result.
- `host.updateItem` does **not** project. Its one caller flips
  `sentToModel` on the invocation echo; `UserRow` ignores that flag, and the
  live model has no update-by-id, so re-projecting would duplicate the row.

## Decision 3 — the projection table is total, not best-effort

The plan comment commits to "nothing falls through silently". That is made
structural: the projector is a `switch` over `item.type` whose `default`
arm assigns the item to `const exhaustive: never`, so adding a history
kind without deciding its transcript fate is a compile error (the
transcript-view house pattern). The mapping:

| HistoryItem kind                                                                                                                                                                                                                                                                                     | Projection                           | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                                                                                                                                                                                                                                                                                               | `user` event, `sentToModel: false`   | the invocation echo; ink's echo is also `sentToModel: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `info`                                                                                                                                                                                                                                                                                               | `info` event                         | text goes through `projectSpecialItemText` so the `linkUrl`/`linkText` footer (ink InfoMessage parity) is preserved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `warning` / `success`                                                                                                                                                                                                                                                                                | `warning` / `info` event             | success has no live-model kind; under this renderer only `/arena` can produce one (ink's model dialog and extensions views write it too; no OpenTUI dialog writes a history item at all — the model dialog's replacement reports through the mount's `notify`, the extensions dialog renders its own status rows). Known divergence: ink's green SuccessMessage row renders as the info row here — pinned in the table and the tests                                                                                                                                                                                                                                                                                                                                                   |
| `error`                                                                                                                                                                                                                                                                                              | `error` event                        | `hint` carried structurally (ErrorMessage parity)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `goal_state`                                                                                                                                                                                                                                                                                         | `goal` event                         | snapshot + cause, as the stream's own goal cards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `goal_status`                                                                                                                                                                                                                                                                                        | `goal-legacy` event                  | fields map 1:1 (the `/goal` command path ink renders as the kind-form GoalStatusMessage)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `stop_hook_system_message`                                                                                                                                                                                                                                                                           | `stop-hook-message` event            | message carried structurally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `stop_hook_loop`                                                                                                                                                                                                                                                                                     | `info` event                         | same text the event adapter builds for the stream's own `stop_hook_loop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `user_prompt_submit_blocked`                                                                                                                                                                                                                                                                         | `warning` event                      | same text shape the event adapter builds (reason + sanitized prompt echo)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `help`                                                                                                                                                                                                                                                                                               | explicit no-op                       | `/help` resolves to a dialog and the OpenTUI overlay renders it from `help-content.ts`; no command returns a `HELP` message, so nothing writes this item in either renderer. An earlier draft of this batch minted a `projectHelp` formatter plus a host-side registry field to feed it — both dropped as unreachable, and the row's fate is now the same explicit no-op decision the rest of that group carries                                                                                                                                                                                                                                                                                                                                                                       |
| the 16 special kinds `projectSpecialItemText` already covers (`about`, `tools_list`, `model_stats`, `tool_stats`, `skill_stats`, `stats`, `summary`, `insight_progress`, `context_usage`, `doctor`, `mcp_status`, `extensions_list`, `skills_list`, `memory_saved`, `quit`, `compression`) and `btw` | `info` event with the projected text | this is the bridge the Batch 8 audit found "unfitted"; `ItemProjectionContext` is assembled by the host, which already holds config/stats/settings/extension state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tool_group`                                                                                                                                                                                                                                                                                         | explicit no-op                       | tool cards come from the live stream's own tool events; a dispatcher-produced group would duplicate them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `retry_countdown`, `vision_notice`, `gemini*` (4 kinds), `notification`, `user_shell`, `advisor`, `arena_agent_complete`, `arena_session_complete`, `away_recap`, `tool_use_summary`, `diff_stats`                                                                                                   | explicit no-op                       | stream-internal duplicates (`retry_countdown` has its own live fold), or kinds ink renders through dedicated components for which this renderer has no row shape. Four of the latter **are written here**: `/advisor` adds an `advisor` item directly (advisor-command.ts:221-224), `/arena start` writes `arena_agent_complete` and `arena_session_complete` from its event handlers (arenaCommand.ts:322,335), and `/recap` writes `away_recap` whenever `executionMode` is `interactive` (recapCommand.ts:63-69) — which the OpenTUI command context always sets (commands-context.ts:119). Their output is invisible after this batch exactly as it was before; that is registered as U-34 rather than claimed fixed. Each kind is named so the gap is a decision, not an accident |

The projector lives next to `projectSpecialItemText` in `item-projection.ts`
so the kind knowledge stays in one file.

## Decision 4 — U-12: echo at the drain, per surviving message

ink pins the semantics (use-llm-stream.ts:3349-3368): `accept()` adds a
`USER` item with `sentToModel: false` for each message that survived
resolution, at accept time — after the read cards/notices, and nothing for
messages dropped by a decline or restored by an abort (the whole hop restores
all-or-none).

Port:

- The echo rides `SteeredPromptResolution.events` rather than a separate
  channel. A first cut carried `echoes: string[]` alongside `events` and the
  drain yielded all events then all echoes; the audit caught that this groups
  the rows, while ink's `accept()` runs each message's side effects and then
  adds _that_ message's `USER` row — so a two-message steer reads
  cards₁ row₁ cards₂ row₂ there, and cards₁ cards₂ row₁ row₂ under the first
  cut. One ordered list removes the divergence and the extra field.
  `renders each steered message with its own cards before its own echo` pins
  it; measured — restoring the grouped order turns exactly that test red and
  leaves the two pre-existing echo tests green.
- Echo text is the raw queued message, not the expanded parts, as in ink.
- The existing all-or-none restore path is untouched: `restore()` returns an
  empty event list, so a restored hop yields no echo and no cards, under the
  Batch 8 divergence already documented on `resolveSteeredPromptParts`.
- Residual divergence, narrowed by the audit. `accept()` echoes every message it
  recorded, so the echo must not be coupled to that message's own parts — the
  first cut coupled them, and the audit found ink's caller drops the _whole_ hop
  when the joined parts come out empty (use-llm-stream.ts:3394), a guard this
  drain does not model. Three cases, for a batch of steered messages: all
  resolve to content (both ports echo all — the common case), a mix of empty and
  non-empty (ink echoes all; the coupled cut echoed only the non-empty ones, so
  a steered message vanished — the exact defect U-12 exists to remove), and all
  empty (ink echoes none; the port echoes all). The shipped shape decouples the
  echo, matching ink in the first two and over-showing only in the third. Not
  porting the guard is deliberate: reaching the third case needs every message
  to resolve to an empty part list, and this drain already emits accept-gated
  read cards unconditionally, so gating the echo alone would be inconsistent
  with the hop it rides. `echoes a steer whose expansion resolved to no parts`
  pins the decoupling; measured — re-coupling it turns exactly that test red and
  leaves the other 41 in the file green.

## Decision 5 — U-27: format check at both hop exits

ink's shape (use-llm-stream.ts:322-371, :3316-3327, :3834-3850): a
`checkImageFormatsSupport(parts)` helper runs after the request parts are
final, on both hops, and an INFO item with
`getUnsupportedImageFormatWarning()` lists the formats the pipeline supports.
Two ink facts kept exactly:

- The check uses the wide acceptance list (`isSupportedImageMimeType`) while
  the warning text lists the narrower pipeline set — a core-semantics quirk
  ported as-is, not "fixed" here.
- The fresh hop checks only `UserQuery`-type submits, not tool-result
  continuations; so in `livePromptEvents` the check runs once, on the initial
  `nextPrompt` after the bridge, not inside the send loop. No submit-type guard
  is ported because ink's `UserQuery | Cron | Teammate` condition is satisfied
  by construction here: the OpenTUI live turn has no Cron/Teammate/Goal submit
  path, its fresh hop is always `SendMessageType.UserQuery` (live-session.ts:638)
  and its continuations are `ToolResult` (:645), which the check sits outside of.

Port:

- `checkImageFormatsSupport` is ported as a private helper in
  `live-session.ts` (it is private in ink too; extracting a shared module
  would touch the ink hook for no shared behavior). The port is narrowed to
  `hasUnsupportedImageFormat(parts): boolean`: ink's version also returns
  `hasImages` and the offending mime list, and no caller reads either — in ink
  or here — so carrying them would add two dead fields to the diff.
- Fresh hop: after `nextPrompt = bridged.parts`, before the send loop.
- Steering hop: inside `resolveSteeredPromptParts`, after the bridge, per
  surviving message — following the Batch 8 convention that this hop's events
  are produced as they are produced.
- The event rides the existing `{type: 'info'}` channel (precedent: the
  bridge's own egress notice).

## Decision 6 — Batch 8 design-doc corrections ride the first commit

Two wording errors in `2026-09-03-opentui-batch8-submit-exit-parity.md`,
found while writing this doc:

1. The U-26 gap section says "Registered as U-26" — U-26 was retired the same
   day and folded into U-12 (ledger re-confirmation). The section now
   references U-12 as the authoritative record.
2. The U-27 section says ink "names the formats the model cannot read" — ink
   names the formats the pipeline **supports**. The sentence is corrected so
   this batch's port is not "fixing" a claim that was never true.

## Decision 7 — `/clear`'s detached host method (found by the smoke)

The first OpenTUI smoke of this batch threw before it cleared anything:

```
✖︎ undefined is not an object (evaluating 'this.deps.startNewSession')
```

`clearCommand` re-keys the session (`context.session.startNewSession(id)`)
_before_ it calls `context.ui.clear()`, and `commands-context.ts` handed the
host's prototype method out as a bare reference — so `this` was the context's
`session` object and `this.deps` was undefined. The transcript stayed on
screen: U-29's own acceptance case was unreachable end to end.

Pre-existing (this batch does not otherwise touch that wiring) but in scope,
because the batch's claim is "a command's effect is visible" and this is a
command whose visible effect was an error row. Fixed by binding the receiver at
the seam (`host.startNewSession?.bind(host)`) rather than by making the host
method receiver-free, which would leave the same trap for every other method
the context hands out. The regression test's fake host uses a shorthand method
that reads `this`, so a detached reference fails there too. Measured — dropping
the `bind` turns exactly that test red with `TypeError: Cannot read properties
of undefined (reading 'push')` and leaves the file's other six green.

The mechanism was swept, not just the instance: every other `session`/`ui`/
`extension` entry the context hands out is an arrow wrapper closing over `host`
or a plain data field, so the fixed line was the only detached host-method
reference in `ui/opentui/`. The hook-provided `startNewSession` the entry passes
down is a `useCallback` closure, which is safe to destructure.

Worth recording that the row was readable at all only because U-28 now projects
dispatcher writes; before this batch the failure would have been silent, with
`/clear` simply appearing to do nothing.

## Coverage boundary

- **Unit (projection)**: the total table is the compile-time guard; tests pin
  the row-producing mappings (echo, notices with link footer, goal pair, hook
  texts, a `projectSpecialItemText` delegation), the `clear` wiring, and that
  `updateItem`/`loadHistory` do not append.
- **Unit (U-12)**: fake-client drain tests asserting echo events for surviving
  texts, no echo on abort/restore or on a declined expansion, echo-after-cards
  order for one message, and per-message interleaving for two.
- **Unit (U-27)**: unsupported-mime part on each hop yields exactly one info
  event listing supported formats; supported/absent images yield none. The fresh
  hop pins placement and not just presence: the stream mock records at call time
  whether the disclosure has already been yielded, so the row is proven to
  precede the request. Measured — moving the check to just after
  `client.sendMessageStream(...)` turns exactly that test red
  (`expected false to be true`) and leaves the other 41 in the file green; the
  presence-only assertion it replaces did not catch that move.
- **E2E**: the harness does have a screen-text channel —
  `InteractiveSession.screen()`/`waitForScreen()` reconstruct the rendered
  screen through `@xterm/headless` (interactive-session.ts:182-217), and the
  session honours the renderer matrix, so a spec built on it runs on both legs.
  An earlier draft of this doc declared that channel nonexistent; the claim was
  wrong, and correcting it changed what this batch could honestly claim.
  - `interactive/command-output-visibility.test.ts` (new) pins U-28's headline:
    `/about` puts a field label on the rendered screen that the boot screen
    does not contain, and the model is never called, so the row can only have
    come from the command. Measured 1:1 — with the projection's
    `transcript.append` neutered (`append: () => {}` in
    opentui-app-shell.tsx:259), the OpenTUI leg exits 1 after 69.49 s across
    vitest's 3 attempts and the ink leg exits 0. The failure surfaces from the
    re-send helper below (spec:51), not from a generic timeout, and the failing
    screen dump is the OpenTUI composer — independent evidence the leg ran
    OpenTUI. The matrix also pins `QWEN_TUI_RENDERER_STRICT`, so a silent ink
    fallback would fail the boot rather than pass as a false green.
  - **The ink leg needed a bounded re-send, and the reason is not this batch.**
    `InteractiveSession.start()` waits only for the composer placeholder
    (interactive-session.ts:128), and ink loads the slash-command registry in an
    async effect that gates nothing (slashCommandProcessor.ts:759), so a command
    sent the moment the prompt appears can land on an empty registry and print
    `Unknown command: /about`. It did, 3/3 attempts, once a parallel spec file
    was booting a second CLI; the spec alone passed in 5.1 s. No readiness signal
    exists to wait for on either leg: `(shift + tab to cycle)` is ink's
    approval-mode suffix and OpenTUI deliberately does not render it
    (input-prompt.tsx:1096), and the footer's `Initializing...` tracks
    `isConfigInitialized`, not the registry (useConfigInitMessage.ts:53).
    OpenTUI covers itself by reloading the registry and re-parsing whenever
    nothing matched (commands-dispatch.ts:471), which is why the same send
    renders there. So the spec waits for _either_ the row or ink's unknown-command
    text and re-sends on the latter, inside a 90 s window. The wait stays
    discriminating: a projection regression produces neither string, so
    `waitForScreen` throws and leaves the loop instead of spinning it — that is
    the mutation measurement above. The recovery branch is measured too, not
    inferred: forcing the first send to miss (a temporary `/about-not-a-command`
    probe, since reverted) made the ink leg log one unknown-command iteration and
    then render the row on the second send, green in 8.6 s — the loop recovers
    rather than spins, and ink's unknown-command text is treated as "not yet"
    rather than as success. In the shipping runs the race did not fire: ink
    rendered on the first send in 5.17 s alone and 8.89 s inside the two-spec
    gate run, OpenTUI in 5.28 s. All three measurements are transcribed in
    `.qwen/e2e-tests/2026-09-03-opentui-batch9-command-visibility.md`.
  - The mid-turn spec still covers the drain path end-to-end (4/4 green in CI
    on main as of run 33740217426). U-12's echo rides that path, but no case
    asserts the echo row: that spec reads request bodies, and an echo is a
    transcript row, not a request.
  - Unasserted in CI: U-29 and U-27. `screen()` returns the whole xterm buffer
    including scrollback, so "the row is gone after `/clear`" is not
    expressible through it — U-29 rests on the unit wiring plus the local smoke
    below. U-27 would need an unsupported image inside a submitted prompt,
    which the fake server's scripted turns do not model.
- **Adjacent finding, not fixed here**: no OpenTUI path calls
  `recordMidTurnUserMessage`. ink records each steered message to the chat log
  inside `accept()` (use-llm-stream.ts:3352-3358) and the ACP session does the
  same; a grep over `packages/` finds those two callers and none under
  `ui/opentui/`. So U-12 makes a steer visible without making it durable — a
  session resumed from the recording would not contain it. Recording is a
  different seam from the transcript and was not measured here, so it is
  registered as a follow-up rather than folded in.
- **Adjacent finding, not fixed here**: `external-context-mem0-write.test.ts`
  spawns its own PTY without the renderer matrix, so on the OpenTUI leg it
  exercises ink — a false green inside the gating leg, and the only interactive
  spec that self-spawns. Wiring it up may well turn it red for reasons unrelated
  to this batch (it has never actually run under OpenTUI), so it is registered
  as a follow-up instead of being folded in.
- **Adjacent finding, not fixed here**: OpenTUI's help overlay advertises `!` as
  "Run shell commands" (help-content.ts:70), but nothing under `ui/opentui/`
  implements a shell mode — no `!`-prefix handling, no shell-command processor,
  so a `!ls` submission is handed to the model as text. That is also why
  `user_shell` is correctly a projection no-op: its only producer is ink's
  `shellCommandProcessor` (shellCommandProcessor.ts:100). Registered rather than
  folded in — closing it means either implementing bash mode or correcting the
  help list, and neither is a transcript-visibility decision.
- **Adjacent finding, not fixed here**: four kinds ink renders through dedicated
  components are written under this renderer too, and stay invisible.
  `/advisor` writes an `advisor` item straight through `ui.addItem`
  (advisor-command.ts:221-224), `/arena start` writes `arena_agent_complete` and
  `arena_session_complete` from its emitter handlers (arenaCommand.ts:322,335),
  and `/recap` writes `away_recap` whenever `executionMode` is `interactive`
  (recapCommand.ts:63-69) — which the OpenTUI command context always sets
  (commands-context.ts:119). They are one follow-up rather than four quick
  projections: each needs a row shape this transcript does not have, and arena's
  items carry structured agent-card data with no text field at all. Projecting
  the two text-only ones as bare info rows now would pre-empt that design and
  have to be undone by it. The replay path had the same hole first —
  `resumeEventsFromSession` never mentions these kinds either — so leaving all
  four out keeps live and replay consistent. Registered as U-34.
- **Local interactive smoke** (measured against the final bundle, OpenTUI +
  strict): `/about` renders the full projected status block, including the
  `Memory Usage` field the new spec waits on; `/clear` then empties the
  transcript, leaving only the composer (4 non-blank pane lines) and no error
  row — the Decision 7 symptom is gone. The mid-turn steer echo was not smoked:
  holding a stream open needs a scripted turn, and the unit drain test is the
  evidence there.
