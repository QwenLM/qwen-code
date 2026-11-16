# Web Shell composer task explanation

[English](web-shell-composer-task-explain.md) | [简体中文](web-shell-composer-task-explain.zh-CN.md)

Status: implemented and verified locally (unit, E2E, visuals, live-model run) on 2026-11-16.

## Problem

The chips above the composer say what kind of background work is unfinished (`1 shell`, `2 local agents`), and clicking one opens raw detail: a shell's output, a subagent transcript, a workflow graph. A user who just wants to know "what is this task actually doing, and why is it running?" must open the surface and interpret it. There is no one-click plain-language explanation.

## Current state

- Chip behavior is specified in [Background agent status and details](background-agent-status-and-details.md): one chip per kind of unfinished work, single-task chips open the task directly, multi-task chips list their tasks above the row.
- The daemon already hosts a side-question channel (`POST /session/:id/btw/stream`, capability `session_btw_stream`): it forks a lightweight agent that shares the full main conversation context, has no tools, streams its answer, and does not interrupt the main turn. The Web Shell exposes it through `/btw` and the composer add menu, rendering the answer in a panel above the composer.
- `POST /session/:id/recap` is a second precedent for a best-effort model summary without a prompt turn.

## Goals and non-goals

Goals:

- A "?" affordance per background task that asks the model to explain the task in 2-4 sentences, using both the task snapshot and the conversation context.
- The explanation must not interrupt the main turn or the task itself, and must not add a prompt turn to the transcript.

Non-goals:

- No new daemon route, SDK surface, or capability tag.
- No change to the task lifecycle, chip membership rules, or polling.
- No persisted explanation history, no automatic explanations, no server-side aggregation of richer context (output tails, transcripts) — see follow-ups.

## Design

UI (all in the Web Shell client):

- A single-task chip gets a "?" button beside the chip, styled as a matching pill. The chip itself keeps opening the task; the "?" only asks.
- A multi-task chip has no "?" of its own; each row of its list gets one, after the row's open button. Tab order per row is: open, then explain. Escape on a row "?" closes the list back to its chip, exactly like the row's open button; the chip-adjacent "?" shares the chip keyboard handling (arrows between chips, Down/Escape/printable back to the composer).
- The affordance is an optional component prop; hosts that do not wire it render no "?" (headerless embeds and host-provided footers are unaffected).

Question composition (pure client function):

- Facts come from the task snapshot the chips already read: kind, label, status, elapsed; per kind the command and working directory (shell), command and event count (monitor), agent type, prompt excerpt and the last five activities (agent), current phase, agent progress, pending approvals and the last five log lines (workflow).
- Fact labels stay English — they are model input, not UI text. The instruction follows the UI language (EN/ZH catalogs; other locales fall back to EN), which also steers the answer language alongside the session's output-language preference.
- Per-field excerpt caps keep any single field from swamping the question; a final guard keeps the whole question within 4096 characters, mirroring core's `BTW_MAX_INPUT_LENGTH` (the daemon rejects longer side questions). Both cuts drop a trailing high surrogate so the JSON payload never strands a surrogate pair.

Answer path:

- Clicking "?" composes the question and hands it to the existing visible-btw flow: the answer streams into the existing btw panel above the composer. Asking about another task aborts the previous side question, the same semantics as asking two `/btw` questions in a row. The task list stays open.

## Decisions and rationale

- **Reuse the btw channel instead of a dedicated explain route.** The forked agent already shares the full conversation history, so it knows why the task was started — context the client snapshot cannot carry. A dedicated route would need cross-package changes (daemon, SDK, capability baselines, protocol table) for a strictly smaller context. Reuse keeps the diff inside the Web Shell and inherits the proven non-interrupting semantics.
- **Per-task granularity, not one "?" for the whole row.** Explanations stay targeted; a whole-row question produces a vague digest and still costs one model call.
- **Existing answer panel, not a new popover.** Zero new floating UI, consistent with `/btw`, and the panel sits right above the composer where the chips are.

## Constraints and risks

- Facts are snapshot-only: no shell output tail or agent transcript is fetched. Elapsed time is the snapshot's runtime, which can lag a running task.
- Explanation quality depends on the launch being present in the conversation context; a task started outside this session's history is explained from its facts alone.
- Each click costs one side query under the btw channel's model policy (the configured fast model, otherwise the session model) and its usual stream-retry behavior. Answer length is steered by the 2-4 sentence instruction, not a special token budget; the fork inherits the main chat's generation config. Write-blocked sessions silently no-op, identical to `/btw`.
- Trust boundary unchanged: task facts are model-authored text, and the answer renders through the same btw surface as any `/btw` answer.

## Validation

- Unit: question builder (per-kind facts, excerpt caps, 4096 budget in EN/ZH, surrogate safety, UI-language instruction); component (placement, click, keyboard, focus return, opt-out); App wiring into the btw stream.
- E2E: the existing composer-task-chips spec updated to the two-action row contract (locators and Tab order) plus a new "?" side-question case; a visuals scenario captures chips, list, and streamed answer in light and dark with anchored assertions.
- Live-model confirmation on the local daemon: a real session started real background shell tasks; clicking "?" sent the composed question (intercepted, 354 chars) and the model answered in the conversation language, naming the command, the cwd, the user's background launch request, and the earlier finished task — while the task kept running.

## Acceptance criteria

- Single-task chips show one adjacent "?"; multi-task lists show one per row; no "?" appears without the host wiring.
- Clicking "?" streams an explanation into the btw panel without opening the task, without a transcript prompt turn, and without stopping the task.
- The composed question never exceeds the daemon's side-question cap in any shipped UI language.
- Keyboard and focus behavior of the chip row is preserved, extended by the documented per-row Tab stops.

## Follow-ups (deliberately deferred)

- A server-side explain route aggregating richer context (output tails, recent transcript) if snapshot-only explanations prove too thin.
- A chip-adjacent popover instead of the shared answer panel, if users want the explanation pinned to the task.
- Persisting or refreshing explanations; today each click asks anew.
