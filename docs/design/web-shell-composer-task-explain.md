# Web Shell composer task explanation

[English](web-shell-composer-task-explain.md) | [简体中文](web-shell-composer-task-explain.zh-CN.md)

Status: implemented and verified locally (unit, E2E, visuals, live-model run) on 2026-11-16; click and focus contracts updated on 2026-11-23.

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

- A single-task chip gets a "?" button beside the chip, styled as a matching pill. The chip itself keeps opening the task; the "?" only asks. Every chip sits in a stable wrapper whether or not its "?" is rendered, so a group crossing the 1↔2 task boundary reconciles the chip node instead of remounting it and dropping keyboard focus onto another chip. The "?" itself does unmount when its group grows; the focus-reclaim effect then lands on the owning group's chip (tagged by kind), not on whichever group sorts first and not on a different group whose list happens to be open.
- A multi-task chip has no "?" of its own; each row of its list gets one, after the row's open button. Tab order per row is: open, then explain. Every painted point of the row belongs to one of its two buttons — the open button owns the row padding and its hover fill, the "?" stretches to the full row height, and the row gap is zero — so no handler-less strip is left lit, and the row keeps the accent only as the ancestor focus cue. Escape on a row "?" closes the list back to its chip, exactly like the row's open button. The app-level btw dismiss shortcut yields to surfaces that own the keyboard, using the same centralized markers the app-level handlers trust: an open modal (dialog/alertdialog/drawer, including component-local confirms portaled into the shell root), the waiting minigame, and keyboard-scoped subtrees. These surfaces own only the keys they actually consume, and the guard trusts the centralized markers rather than a hand-classified surface name. A drawer — and any dialog that does not mark itself a keyboard scope — owns Escape only: Enter/Space on its body still dismiss a settled explanation, and on a control still activate it. The waiting minigame (Space pauses, Enter restarts), the keyboard-scoped status cards (Enter/Space open/close detail and run server actions), and dialogs built on the shared DialogShell (which marks its content a keyboard scope so its forms and lists keep Enter/Space) all consume Enter/Space as well as Escape, so the guards yield those keys to them too. The cancel chords are never owned by these surfaces — Ctrl+C/Ctrl+D still abort a pending side question even while a modal/drawer is open (the drawer-hosted detail panel below 1001px makes an open modal surface permanently present). The sole exception is Ctrl+C's copy role on a real text surface (input/textarea/select, any contenteditable other than `false`, or a CodeMirror editor) under a guard; Ctrl+D never copies, and a keyboard-scoped subtree is not itself a text surface, so a button inside a status card still cancels. Enter/Space on an activatable control — button, link, field, menu item, tab, grid/tree row, and the like — activate that control; Escape inside the chip row or an open menu/listbox belongs to that widget. Grids and trees activate rows on Enter/Space but do not universally own Escape (the trajectory grid claims it only with a row selection), so they are not Escape owners — exempting their Escape would leave the key unconsumed and arm a surprise turn-cancel behind the panel. The app-level Escape handler likewise yields to keyboard-scoped subtrees before deciding its intent, so it does not arm the two-press turn cancel behind a status card whose own delayed handler owns Escape. Escape anywhere else — including the panel header "?" that holds focus after a click — dismisses or cancels as the panel's key hints advertise, and Ctrl+C/Ctrl+D cancel a pending side question (Ctrl+C yields to copy on a real text surface under a guard). The composer editor is never exempted. The chip-adjacent "?" shares the chip keyboard handling (arrows between chips, Down/Escape/printable back to the composer), except ArrowLeft steps back to its own chip rather than past it. Both "?" variants draw the same keyboard focus ring as the chip; a fill alone would be indistinguishable from hover in the light theme.
- The affordance is an optional component prop; hosts that do not wire it render no "?" (headerless embeds and host-provided footers are unaffected).
- The same explanation is also available from the task's detail panel: when the active right-panel tab shows a shell, monitor, or subagent task, the shared panel header offers a "?" beside its actions. Shell and monitor tabs carry their task snapshot; a subagent tab resolves its task through the registry under the same id domain the open path registers (`toolUseId ?? id`), so an agent evicted from the registry offers no "?". Workflow tabs name no run and keep the chip-list entry only.

### Chip activation and list-row selection

A direct single-task activation forwards the task with an explicit toggle intent (`onSelectTask(task, true)`). If its current detail panel is already open, another activation closes it. A list-row selection forwards the task without that intent (`onSelectTask(task)`); it selects or switches to the detail but never collapses an already-selected panel. When reopening a hidden or inactive task, the app reuses the existing detail tab and id rather than adding a duplicate canonical tab alongside a background or pending tab. Reuse follows ordinary tab activation, so failed or loading pending details resume or retry hydration. A repeat activation tests the active compatible alias rather than the first matching tab, so coexisting canonical and background aliases cannot hide the open panel from the toggle.

A Workflow without a usable transcript row opens the tasks dialog. Its task id and tool-call identity are attached to this chip-origin request from before the fetch resolves, so a rapid second activation of the same target can cancel the pending open. A subsequent activation carrying a different tool-call identity is still allowed to navigate rather than being mistaken for the dialog's old target. The visible dialog itself stays modal and closes through its own controls, not by implying that the obscured chip remains clickable. A plan/tasks dialog opened through another entry never assigns an expanded state to this Workflow chip. Workflow rows that exist in the transcript retain the existing reveal/navigation behavior; local inline graph expansion is not conflated with a right-panel or modal surface.

For a multi-task list, mouse presses on its buttons preserve the current focus, preventing a browser's button-focus behavior from unmounting the row before its click. A pointer gesture survives an unresolved blur target until pointer release. A concrete DOM focus destination outside the component, outside pointer presses and window blur close the list. On release, the existing shadow-aware focus helper determines whether focus remained inside; otherwise the list closes and gesture state is cleared. Task polling may replace the task objects without tearing down this gesture protection, which follows the real open/closed boolean rather than their identity.

Question composition (pure client function):

- Facts come from the task snapshot the chips already read: kind, label, status, elapsed; per kind the command and working directory (shell), command and event count (monitor), agent type, prompt excerpt and the last five activities (agent), current phase, agent progress, pending approvals and the last five log lines (workflow).
- The daemon synthesizes a shell's label and description from its command, and a monitor's label from its description. The builder therefore drops the shell `Label:` line when it equals the command (the `Command:` line carries it) and the `Description:` line whenever it repeats the kind's display label, so the same text never spends the budget twice or crowds out the kind-specific facts.
- Fact labels stay English — they are model input, not UI text. The instruction follows the UI language (EN/ZH catalogs; other locales fall back to EN), which also steers the answer language alongside the session's output-language preference.
- Per-field excerpt caps (label 400, description 400, command 500, prompt 1200, activity 160, log 200) keep any single field from swamping the question; a final guard keeps the whole question within 4096 characters, mirroring core's `BTW_MAX_INPUT_LENGTH` (the daemon rejects longer side questions). Both cuts drop a trailing high surrogate so the JSON payload never strands a surrogate pair.

Answer path:

- Clicking "?" composes the question and hands it to the existing visible-btw flow with a separate display string: the model receives the full composed prompt, while the panel echoes only a short localized line ("Explain what this task is doing: <label>"). The display label — and the "?" aria label — are excerpted at 120 characters, so a shell whose label is a multi-KB command cannot paint the panel either. The fact dump is model input and never paints the panel. Typed `/btw` keeps echoing the user's own words — the display override defaults to the raw question. The answer streams into the existing btw panel above the composer. Asking about another task aborts the previous side question, the same semantics as asking two `/btw` questions in a row. The task list stays open. A task explanation is tagged with its task id, so it also mirrors in place above the detail panel body whenever that task's tab is active — regardless of which entry point asked. The mirror is keyed by the btw message id, so a new ask remounts it and restores answer auto-follow. Neither copy renders the `/btw ` slash-command prefix: a button press is not a typed command. The mirror also omits the composer panel's key-hint footer — it has no focusable surface of its own, so those keys would act on whatever control holds focus (Enter on the header "?" re-asks). Typed `/btw` carries no tag, keeps the prefix, and never mirrors.

## Decisions and rationale

- **Reuse the btw channel instead of a dedicated explain route.** The forked agent already shares the full conversation history, so it knows why the task was started — context the client snapshot cannot carry. A dedicated route would need cross-package changes (daemon, SDK, capability baselines, protocol table) for a strictly smaller context. Reuse keeps the diff inside the Web Shell and inherits the proven non-interrupting semantics.
- **Per-task granularity, not one "?" for the whole row.** Explanations stay targeted; a whole-row question produces a vague digest and still costs one model call.
- **Existing answer panel, not a new popover.** Zero new floating UI, consistent with `/btw`, and the panel sits right above the composer where the chips are.

## Constraints and risks

- Facts are snapshot-only: no shell output tail or agent transcript is fetched. Elapsed time is the snapshot's runtime, which can lag a running task. Task snapshots come from the daemon serializer, which writes label/description/command/cwd unconditionally; the builder trusts that contract rather than defending shapes no producer emits.
- Explanation quality depends on the launch being present in the conversation context; a task started outside this session's history is explained from its facts alone.
- Each click costs one side query under the btw channel's model policy (the configured fast model, otherwise the session model) and its usual stream-retry behavior. Answer length is steered by the 2-4 sentence instruction, not a special token budget; the fork inherits the main chat's generation config. Write-blocked sessions silently no-op, identical to `/btw`.
- Trust boundary unchanged: task facts are model-authored text, and the answer renders through the same btw surface as any `/btw` answer.

## Validation

- Unit: question builder (per-kind facts, label cap and duplicate-fact omission, excerpt caps, 4096 budget in EN/ZH, surrogate safety at both cut sites, UI-language instruction); component (placement, click, keyboard including ArrowLeft from the chip "?", focus return, chip node identity across the 1↔2 boundary, single- and multi-task opt-out); App wiring into the btw stream with the display/question split pinned.
- E2E: the existing composer-task-chips spec updated to the two-action row contract (locators and Tab order) plus a "?" side-question case (display line, no fact dump), an Escape case (list closes while the explanation panel survives), and gating assertions for the row hit box (`elementFromPoint` in the lit gutter resolves to the open button) and the "?" focus ring (computed style equal to the chip's own ring); a visuals scenario captures chips, keyboard-focused "?", list, and streamed answer in light and dark with anchored assertions.
- Locale renders: the zh aria label, tooltip, and panel display line are rendered by tests (component and App), so deleting a zh key cannot silently fall back to English.
- Detail panel: ArtifactPanel unit cases (header "?" click, in-place mirror matched by task id, no mirror for another task or without a task, excerpted aria); an App case pins the chip→panel→explain wiring through the panel props; an E2E case opens the shell panel from its chip and asserts the in-place answer.
- Live-model confirmation on the local daemon: a real session started real background shell tasks; clicking "?" sent the composed question (intercepted, 354 chars) and the model answered in the conversation language, naming the command, the cwd, the user's background launch request, and the earlier finished task — while the task kept running.

## Acceptance criteria

- Single-task chips show one adjacent "?"; multi-task lists show one per row; no "?" appears without the host wiring.
- Clicking "?" streams an explanation into the btw panel without opening the task, without a transcript prompt turn, and without stopping the task. The panel shows the short display line, not the composed prompt.
- The composed question never exceeds the daemon's side-question cap in any shipped UI language, and an oversized label or command cannot crowd out the kind-specific facts.
- Keyboard and focus behavior of the chip row is preserved, extended by the documented per-row Tab stops: the focused chip node survives group-size changes, Escape inside the chips is not swallowed by the panel shortcut, and both "?" variants show the chip's focus ring.
- The detail panel of a shell, monitor, or registry-resolved subagent task offers the same "?" in its header and mirrors the explanation in place; a typed `/btw` answer never mirrors.

## Follow-ups (deliberately deferred)

- A server-side explain route aggregating richer context (output tails, recent transcript) if snapshot-only explanations prove too thin.
- A chip-adjacent popover instead of the shared answer panel, if users want the explanation pinned to the task.
- Persisting or refreshing explanations; today each click asks anew.
