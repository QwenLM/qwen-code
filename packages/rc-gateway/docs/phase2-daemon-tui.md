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

**Build environment (what's verifiable where).** Earlier notes claimed the whole
feature was "not verifiable in the dev sandbox" because a spawned `qwen serve`
"times out under WSL." That was **wrong, and disproven empirically**: a real
`qwen serve` boots in ~0.5s on the WSL sandbox box and answers `/health` 200 over
loopback (a research pass ruled out WSL loopback, the undici `::1` trap, and
sandbox netns isolation by direct test; the old "timeout" was a supervisor bug —
no `child.on('error')` + a port-0 readback gap in `daemonSupervisor.ts` — not the
environment). So the layers verify like this:

- **Hook logic** (frame→history projection, optionId mapping) — unit-test against a
  **stub** `DaemonSessionClient`, here.
- **Live daemon round-trip** (attach→prompt→events over loopback SSE) — **PROVEN
  here** end-to-end (`scripts/capture-daemon-frames.mts`): spawn a real
  `qwen serve`, `createOrAttach` a session, `prompt`, and the real frame sequence
  streams back over `events()`. Ground-truth captured for a text turn:
  `replay_complete` → `session_update/available_commands_update` →
  `session_update/user_message_chunk` (echo) → N× `session_update/agent_thought_chunk`
  → N× `session_update/agent_message_chunk` (the terminal chunk carries `_meta.usage`)
  → top-level `turn_complete {stopReason, promptId}`. Envelope:
  `{type:'session_update', id, data:{sessionId, update:{sessionUpdate,
content:{type,text}, _meta?}}}`. (Driven by the operator's configured
  OpenAI-compatible model endpoint, reachable from the daemon; qwen self-injects
  the provider key from `settings.env`.) A **tool turn** was also captured
  (`CAPTURE_PROMPT=… npx tsx scripts/capture-daemon-frames.mts`, which
  auto-DECLINES any approval so nothing executes): `session_update/tool_call`
  (`{toolCallId, _meta.toolName, kind, title, rawInput, status:'in_progress'}`)
  → `session_update/tool_call_update` (`{status:'completed', content:[…], rawOutput}`).
  Notably **no `permission_request` fired** — this daemon config auto-approves
  builtin reads (the tool executed directly). So the permission gate is built
  against the SDK's typed `DaemonPermissionRequestData`/`…ResolvedData` shapes and
  exercised with synthetic frames.
- **Headless TUI render** — `ink-testing-library` renders the TUI to a string for
  assertions; no TTY needed, here.
- **Interactive acceptance** (the rich TUI feel + the phone handoff) — this is the
  **only** part that genuinely needs a human at a real terminal + phone. It's UX
  acceptance, not correctness. A `pty` harness can cover some of it; the final
  "does handoff feel right" is you.

So: build and unit/integration-verify the hook **here**; reserve a real terminal
(your workstation; SSH-TTY into a Linux box also works) for interactive acceptance.

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

## ✅ Milestone 1 — VERIFIED on a real machine (pkix)

Text turns render in the **rich** terminal TUI driven by a daemon-hosted session:
`qwen --attach-daemon <url> --daemon-token <tok>` attaches via `DaemonAppContainer`
→ `AppContainer` with the `useDaemonStreamAdapter` (B-prime) → real `<App/>`.
Streamed thought + reply render, the turn completes, **multi-turn works on the same
session**, and the frames are daemon SSE frames (not a local agent).

**Critical protocol finding (cost us a stuck spinner):** this codebase's daemon
(**0.17.x**) signals turn completion via the **`prompt()` HTTP response**
(`stopReason`), NOT a `turn_complete` **SSE frame** — the frame is a 0.18+ addition
(our earlier capture used the global `qwen 0.18.1`, which misled us). The hook
**synthesizes** a `turn_complete` when `prompt()` resolves (and re-subscribes when
the SSE idle-closes between turns). Verification recipe: run the TUI attached with
`QWEN_DAEMON_STREAM_DEBUG=<file>`; the log shows
`prompt() resolved → frame type=turn_complete -> state=idle committed=1`.

## ✅ Milestone 2 — VERIFIED on a real machine (pkix)

Tool calls render live AND their approval prompts are answerable in the rich TUI:
a daemon-hosted `run_shell_command`/`write_file` shows its tool box during the turn,
and when the daemon gates it the TUI renders an answerable prompt. Selecting **Yes,
allow once** executed the tool **in the daemon** (`echo "Test" > test.txt`,
`printf …` — Exit 0), the turn ran on to `read_file` and a final reply, the spinner
stopped, and `cat test.txt` → `Test`. Round-trip (render → input → vote → execute →
complete) confirmed on a real 0.17.x daemon.

**Findings that shaped the wiring (ground-truthed via
`scripts/capture-daemon-frames.mts` against a live daemon):**

- **Edits send NO `tool_call` frame** — a `write_file` gate arrives _only_ as a
  `permission_request` carrying its own `toolCall` (`toolCallId`, `title`, `kind`,
  diff). The reducer **seeds the tool from the request** so it renders; a
  `run_shell_command` _does_ send a prior `tool_call`, so there `upsertTool` just
  refreshes it.
- **Options carry an ACP `kind`** (`allow_once`/`allow_always`/`reject_once`
  /`reject_always`); the outcome→optionId map keys on `kind`, never the opaque id.
- **Universal `info` confirmation** — its rendered outcomes (`ProceedOnce` /
  `ProceedAlways{Project,User}` / `Cancel`) all map to a daemon `kind`, and it omits
  `ModifyWithEditor` (no remote round-trip). The project/user always-scopes collapse
  onto the daemon's single `allow_always`.
- **`default` mode auto-approves read-ish shell** (`du`, `ls`) but gates
  `write_file`; the capture harness forces the mode (`CAPTURE_APPROVAL_MODE`) and can
  attach to a running daemon (`CAPTURE_ATTACH_URL`) to record real gates.

### Handoff finding — 0.17.x didn't broadcast remote prompts/turn-end (NOW FIXED in-fork)

Verified live (terminal TUI + browser `/ui` on ONE shared daemon session): both
directions DRIVE the session — a prompt from either client runs the turn and the
**agent's reply streams to both clients**. But a watching client never sees the
_other_ client's PROMPT TEXT: across a real cross-client turn the TUI logged
`agent_message_chunk=95, user_message_chunk=0`. The 0.17.x daemon emits no
`user_message_chunk` for any client (each echoes its OWN input locally; 0.18.x adds
the broadcast — same version gap as `turn_complete`). Two distinct needs fall out:

- **Live co-watching** (both screens, each sees the other's prompts as typed) →
  ✅ **DONE + verified live.** The fork's `qwen serve` now broadcasts, on the SSE
  bus, TWO frames it omitted natively (both surgical to the HTTP bridge's
  `sendPrompt`, tagged with the submitter's `originatorClientId`, in the ring
  buffer for re-subscribers):
  - `user_message_chunk` on prompt-accept (before the agent frames) — the
    submitter drops its own echo (originatorClientId === ownClientId), other
    clients render the prompt text. Verified: a browser-typed prompt appears in
    the watching terminal; terminal-typed prompts render exactly once.
  - `turn_complete` on prompt-resolve (after the agent frames) — a REMOTE client
    that didn't call `prompt()` gets no HTTP `stopReason`, so without this its
    spinner ran forever. Verified: browser-driven turns now finalize in the
    terminal. The originator already finalized on its HTTP response → idempotent.
- **Pick-up handoff** (step away → drive from phone → return to terminal and catch
  up on the whole conversation) → needs **replay-on-attach (Slice 3)**. The session
  TRANSCRIPT already contains every prompt (incl. the phone's), so replay surfaces
  them with no daemon change. Still the high-value next step.

## Phasing inside Phase 2 ("grows")

Built + unit-tested here (now 37 daemon tests):

- `projectDaemonEvent.ts` (18 tests) — the pure reducer folding daemon frames
  into the UI's history/streaming/tool/permission shapes (incl. seed-gated-tool
  -from-`permission_request`).
- `useDaemonStream.ts` (10 tests) — the React hook: subscribes to
  `driver.events()` (AbortController cleanup + retry on the daemon's
  single-subscription race), folds frames through the reducer, attaches the
  approval `confirmationDetails`, and exposes the `useGeminiStream` contract.
  Decoupled via a structural `DaemonSessionDriver` (no `@qwen-code/sdk` dep).
- `daemonConfirmation.ts` (9 tests) — the pure outcome→optionId mapper (by ACP
  `kind`) + `info` confirmation builder, tested against the real captured options.

1. **Slice 1 — text round-trip.** ✅ **DONE + rendered + verified on pkix** (see
   Milestone 1 above). Origin-aware user echo, streamed thought + message,
   completion via `prompt()`-resolution synthesis, multi-turn re-subscribe, the
   `--attach-daemon` flag, `DaemonAppContainer`, and the `useStream` swap in
   `AppContainer` all working in the rich TUI.
2. **Slice 2 — tools + approval.** ✅ **DONE + rendered + verified on pkix** (see
   Milestone 2 below). Live tool boxes render during the turn
   (`tool_call`/`tool_call_update` → `tool_group` in `pendingHistoryItems`); a
   `permission_request` seeds the gated tool **from its own `toolCall`** (edits send
   no preceding `tool_call` frame) and the hook attaches a `confirmationDetails`
   whose `onConfirm` maps the chosen `ToolConfirmationOutcome` → daemon `optionId`
   **by ACP `kind`** and posts the vote. Approve → the tool executes in the daemon
   and the turn completes; Esc declines; `permission_resolved` folds state back.
3. **Slice 3 — model switch + catch-up.** `setModel`; `Last-Event-ID`/`resume` on
   re-attach so a mid-conversation join (terminal _or_ phone) replays history.
4. **Then** the Phase-3 launcher (`qwen --remote-control`) is small glue: spawn one
   daemon, start the gateway attached (Phase 1), run the TUI attached (this), print
   the `/ui` URL + pairing code.

**Where the interactive boundary now falls:** slices 1–2 are verified end-to-end in
the rich TUI on pkix (text round-trip, live tools, answerable approval). What
remains is **slice 3** (model switch + resume/replay catch-up) and the **Phase-3
launcher**. One real-terminal lesson worth keeping: always `npm run build` after a
`git pull` before testing — a stale build silently runs old client code (it cost us
a "nothing renders" red herring that a rebuild fixed with no code change).

**Slice-3 note — idempotent commit on resume/replay.** The hook retries its
subscription (StrictMode race) and slice 3 adds `Last-Event-ID`/`resume`. Because
`stateRef` persists across a remount, a replay from the daemon's ring would re-run
`turn_complete` and **re-`addItem` already-committed turns** → duplicate history.
The fake driver doesn't replay, so the unit tests can't see this. Design the
defense in when wiring resume: **dedup committed items by daemon event id**
(idempotent commit), rather than discover the double-render at the terminal.

## Verification plan

**Automated (here, every slice):** the hook's logic against a stub
`DaemonSessionClient`, plus an integration test against a **real** loopback
`qwen serve` (it boots in the sandbox), plus `ink-testing-library` render
assertions. From `packages/cli/` (NOT repo root) run the package's own
`tsc`/`eslint`/`vitest`; advisor() at approach-commit and done-gate; explicit
`git add <paths>`; push.

**Interactive acceptance (a real terminal + phone — the only human-gated part):**

- Slice 1: `qwen --attach-daemon … --daemon-token …` against a hand-started
  `qwen serve`; type a prompt; see streamed text + thoughts; Ctrl+C cancels.
- Slice 2: trigger a tool (e.g. a file edit); approve in the terminal; confirm the
  daemon executed it; then approve from `/ui` on the phone and confirm the terminal
  reflects `permission_resolved` without a double-execute.
- Slice 3: detach the terminal mid-turn, re-attach, confirm replay; switch model.

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
