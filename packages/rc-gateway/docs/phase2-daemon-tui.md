# Phase 2 — `useDaemonStream`: the rich terminal TUI as a daemon client

**Goal (the user's words).** _"Same conversation in a rich terminal."_ Keep the
full qwen terminal TUI locally; make it render a **daemon-hosted** session so the
**same** conversation is reachable from the phone when you step away. The browser
is the away surface; the terminal stays the primary experience.

**Locked decisions (from the user).**

- **Grows.** Ship a focused first slice (text + tool approval + model switch) and
  expand toward parity — not a big-bang full-parity rewrite.
- **Opt-in.** Default `qwen` is untouched (`useGeminiStream`, in-process agent).
  The daemon-client path is reached only behind an explicit flag.
- **Fork-first.** Build in this fork now; the hook is shaped to be
  upstream-proposable later (it's how qwen-code would build `qwen attach`).

**Build environment (non-negotiable).** This is an interactive TUI driving a live
daemon over loopback SSE. It is **not verifiable in the dev sandbox** (no TTY; the
spawned `qwen serve` health-probe times out under WSL). It must be **built and
exercised on a real machine** — real terminal + a working `qwen serve`. This doc
is the spec to build _from_ there; do not bash the implementation out blind here.

This is the first substantial diff in `packages/cli/` (Phase 1, the gateway
attach-mode, shipped entirely inside `packages/rc-gateway/`). The user explicitly
relaxed the zero-edit boundary for this feature ("fork", "option 2").

---

## Why this is a real feature and not a config flag

The TUI today runs a **private, in-process agent**, tightly coupled with no seam
to swap a remote backend in:

- `AppContainer.tsx:1393-1414` calls `useGeminiStream(config.getGeminiClient(), …)`.
- `useGeminiStream.ts` streams from `geminiClient.sendMessageStream(...)`, schedules
  tools **in-process** via `useReactToolScheduler` → `CoreToolScheduler`, and answers
  permission with a **synchronous-returning `onConfirm(outcome)` closure** that
  mutates scheduler state (`ToolConfirmationMessage.tsx` → `confirmationDetails.onConfirm`).

For handoff this _must_ invert: tools have to run **in the daemon** (the phone
cannot execute local shell/file ops — only the daemon can, and any client just
votes), and permission becomes an **HTTP round-trip**, not an in-process callback.
The daemon already does all of this multi-client today (Phase 1 doc, "the daemon
already supports handoff"). The missing piece is purely **client-side**: a TUI hook
that renders a daemon session instead of owning an agent.

---

## The seam (verified against the code)

`useDaemonStream` is a **parallel hook** that matches `useGeminiStream`'s public
contract exactly, so `AppContainer` plugs it in with no downstream UI changes.

### Output contract it must reproduce (`useGeminiStream.ts:2624-2639`)

```ts
{
  streamingState, submitQuery, initError, pendingHistoryItems, thought,
  cancelOngoingRequest, retryLastPrompt, pendingToolCalls,
  handleApprovalModeChange, activePtyId, loopDetectionConfirmationRequest,
  streamingResponseLengthRef, isReceivingContent,
}
```

`AppContainer` (`:1393-1414`) feeds these into `UIStateContext` / `UIActionsContext`
and renders `pendingHistoryItems` (`<PendingHistorySection>`), `pendingToolCalls`
(`<ToolGroupMessage>`), and `thought` (`<LoadingIndicator>`). A replacement hook
that returns the same shape and calls the same `addItem(item, timestamp): number`
needs **zero** changes in those components.

### What is reused unchanged

- **History projection.** `addItem` + the `HistoryItemWithoutId` union
  (`types.ts:575-617`) are the output sink either way. The hook just projects daemon
  frames into the same item shapes (`{type:'gemini',text}`,
  `{type:'gemini_thought',text}`, `{type:'tool_group',tools:[…]}`, `{type:'error',…}`).
- **Tool-call display.** `IndividualToolCallDisplay` / `HistoryItemToolGroup`
  (`useReactToolScheduler.ts:281-382`) is the same struct; we populate it from daemon
  frames instead of the in-process scheduler.
- **Confirmation UI.** `ToolGroupMessage.tsx:504-516` / `ToolConfirmationMessage.tsx`
  render whenever a tool's `status === 'Confirming'` and `confirmationDetails` is set.
  We reuse the components; only what `onConfirm` _does_ changes.

### The three inversions (the actual work)

| Concern        | In-process (today)                                                  | Daemon-client (this hook)                                                             |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Streaming**  | `geminiClient.sendMessageStream()` → `GeminiEvent`s                 | `sessionClient.events()` → `DaemonEvent`s; read text from the RAW iterator (see trap) |
| **Tool calls** | `ToolCallRequestInfo[]` → `CoreToolScheduler` → `WaitingToolCall`   | `session_update` frames with `update.sessionUpdate: 'tool_call' / 'tool_call_update'` |
| **Permission** | sync `onConfirm(ToolConfirmationOutcome)` closure mutates scheduler | `respondToSessionPermission(requestId, {outcome:'selected', optionId})` — HTTP POST   |

### Daemon source API (`DaemonSessionClient`)

- `DaemonSessionClient.createOrAttach(client, req?, clientId?)` (`:78`) — attach to
  the workspace's existing session (or `resume` `:148` to replay prior turns on
  mid-conversation join).
- `prompt(req, signal?)` (`:191`) — submit user input. `cancel()` (`:198`) backs
  `cancelOngoingRequest`. `setModel(id)` (`:213`) backs the **model switch**
  (distinct from `handleApprovalModeChange`, which is the YOLO/default/auto-edit
  approval mode — that maps to the daemon's own `approval_mode_changed` event and is
  deferred to a later slice).
- `events(opts?)` (`:269`) — the async-iterator the hook drives. `lastEventId` /
  `setLastEventId` for `Last-Event-ID` catch-up on re-attach.
- `respondToSessionPermission(requestId, response)` (`:243`) — the vote.

### Frame decoding (`events.ts` + `DaemonChannelBridge.ts:476-539`)

Tool calls and text are **nested inside `session_update` frames**, not top-level
events. The hook's reducer maps `update.sessionUpdate`:

- `agent_message_chunk` → append `update.content.text` to the streaming gemini item.
- `agent_thought_chunk` → `thought` / `gemini_thought` item.
- `tool_call` / `tool_call_update` → upsert an `IndividualToolCallDisplay` keyed by
  `update.toolCallId` (`kind`/`title`/`status`/`rawInput`).
- Top-level `permission_request` (`events.ts:73-84`) → set the matching tool's
  `status:'Confirming'` + a `confirmationDetails` whose `onConfirm(outcome)` maps the
  chosen `ToolConfirmationOutcome` to a daemon `optionId` and POSTs the vote.
- Top-level `permission_resolved` → clear `Confirming` (covers first-responder-wins:
  the phone may have voted; the terminal reflects it).

### Two traps to encode in the spec (already burned us / found in code)

1. **Reduce-clobber.** Read streaming agent text from the **raw `events()` iterator**,
   not from `reduceDaemonSessionEvent` reduced state — the reducer clobbers
   `lastSessionUpdate` to the latest frame (`events.ts:866`), dropping interim text.
2. **Opaque permission options.** The in-process `ToolConfirmationOutcome`
   (`ProceedOnce/ProceedAlways/Cancel`) is **not** 1:1 with daemon `optionId`s — the
   `options` array is request-defined and opaque (`events.ts:73-84`,
   `types.ts:926-942`). Store the `options` from each `permission_request`; map the
   user's selection to the right `optionId`; send `{outcome:'selected', optionId}`.

---

## Opt-in wiring (the flag)

Default `qwen` is untouched. Reuse the Phase-1 attach vocabulary:

- `config.ts` (args interface ~`:145`, `$0` cmd ~`:615`, mirror the `acp` option
  pattern ~`:674-679`): add `--attach-daemon <url>` + `--daemon-token <tok>` (env
  `QWEN_RC_DAEMON_URL` / `QWEN_RC_DAEMON_TOKEN`, same names Phase 1 uses).
- `gemini.tsx` (`startInteractiveUI` ~`:235`, the stdin/acp guard ~`:558-566`,
  `isInteractive` ~`:967`): when attach is set, take an **attached** interactive
  branch that builds a `DaemonClient` + `DaemonSessionClient.createOrAttach` and
  renders the **attached container** (below) instead of the default one.

**The split is at the component boundary, NOT the hook-call site.** You cannot write
`attached ? useDaemonStream(...) : useGeminiStream(...)` at `AppContainer.tsx:1393` —
that's two different hook-call sequences across renders, which
`react-hooks/rules-of-hooks` (enabled via `reactHooks.configs['recommended-latest']`
in `eslint.config.js:36`) **errors** on, failing the package's own `eslint` gate.
The React-correct shape: `gemini.tsx` renders either the existing container (calls
`useGeminiStream` **unconditionally**) or an attached variant (calls
`useDaemonStream` **unconditionally**), and **both share the presentational subtree**
(`PendingHistorySection`, `ToolGroupMessage`, `UIStateContext`/`UIActionsContext`).

This makes the AppContainer change **larger than "one branch"**: the presentational
shell must be **factored out** of the 3711-line `AppContainer.tsx` (or carefully
duplicated) so two stream-owning containers can each wrap it. This is the part that
makes Phase 2 medium–large, and it's why it's a real-machine project, not a sandbox
edit.

When the flag is absent, **none** of this code path is reached — same binary, same
default behavior.

## Phasing inside Phase 2 ("grows")

1. **Slice 1 — text round-trip.** Attach → `prompt` → render `agent_message_chunk` +
   `agent_thought_chunk` into history; `cancel`. No tools yet. _Verifies the seam._
2. **Slice 2 — tool approval.** Project `tool_call`/`tool_call_update`; wire
   `permission_request` → reuse `ToolConfirmationMessage` → `respondToSessionPermission`;
   honor `permission_resolved` (first-responder-wins with the phone).
3. **Slice 3 — model switch + catch-up.** `setModel`; `Last-Event-ID`/`resume` on
   re-attach so a mid-conversation join (terminal _or_ phone) replays history.
4. **Then** the Phase-3 launcher (`qwen --remote-control`) is small glue: spawn one
   daemon, start the gateway attached (Phase 1), run the TUI attached (this), print
   the `/ui` URL + pairing code.

## Verification plan (on the real machine)

- Slice 1: `qwen --attach-daemon … --daemon-token …` against a hand-started
  `qwen serve`; type a prompt; see streamed text + thoughts; Ctrl+C cancels.
- Slice 2: trigger a tool (e.g. a file edit); approve in the terminal; confirm the
  daemon executed it; then approve from `/ui` on the phone and confirm the terminal
  reflects `permission_resolved` without a double-execute.
- Slice 3: detach the terminal mid-turn, re-attach, confirm replay; switch model.
- Each slice: from `packages/cli/` (NOT repo root) run the package's own
  `tsc`/`eslint`/`vitest`; advisor() at approach-commit and done-gate; explicit
  `git add <paths>`; push.

## Risks

- **Parity creep.** Slash commands, memory ops, approval-mode toggles, etc. Some are
  daemon-backed (`available_commands_update`, `setModel`), some client-local. Keep the
  first slices narrow; let the table of "reused unchanged" grow deliberately.
- **Fork divergence.** This is a genuine `packages/cli` diff. Mitigation: keep it a
  clean _parallel_ hook (no edits to `useGeminiStream` itself) so it's an additive,
  upstream-proposable `qwen attach`.
- **PTY/focus.** `activePtyId` drives embedded-shell focus; in daemon mode the PTY
  lives in the daemon. Slice 1/2 can return `undefined`; revisit when remote shell
  output rendering lands.
