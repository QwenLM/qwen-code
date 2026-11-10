# Mod reply rows

[English](2026-11-10-mod-assistant-message-rows.md) | [简体中文](2026-11-10-mod-assistant-message-rows.zh-CN.md)

Status: proposed. This adds the `AssistantMessage` render site to the Ink terminal, tracked in #13749. The OpenTUI terminal follows in its own change.

## Problem and current behavior

A Mod can draw only the band above the prompt. It cannot change how the model's reply reads in the transcript, so a Mod that shows replies in another language, hides boilerplate or highlights terms has nowhere to do it. `$.model.complete` (#16737) gives such a Mod the completion it needs; this change gives it the row.

`ui.render` hooks today hear every site the host draws, and a host draws only `AbovePrompt`.

## Goals and non-goals

Goals:

- A `ui.render` site for each block of an assistant reply in the Ink transcript, whose hooks can rewrite the text the row shows.
- The stored message, what the model reads, `/copy` and exports keep the original text.
- A Mod that awaits a model call inside the hook works without stalling the session's other Mod hooks behind every row.

Non-goals:

- Trees drawn in place of a row. A row draws its own message, with the text its hooks passed down.
- The OpenTUI terminal, thinking rows and ACP hosts (later stages).
- Rows in the terminal scrollback (non-virtualized Ink), which cannot be drawn again once printed.

## Compatibility contract

These parts follow the Mod author contract:

- The component name `AssistantMessage`, and its props `text` (the block's markdown) and `isFirstOfReply` (true on the block that opens a reply).
- A hook rewrites what the row shows with `next({ ...e, props: { ...e.props, text } })`; `next(e)` leaves it as it is. The row's stored message does not change.
- The envelope (`surface`, `component`, `requestId`, `viewport`) and `isFirstOfReply` are pinned. A hook that changes them, or writes a `text` that is not a string, fails like a thrown error: it is skipped or its `.catch` runs.
- A matcher on `component` selects the site, as on any event.

## Qwen design decisions

### When a row is raised

A row is raised once its block is complete, never while it streams. A streaming block changes on every chunk, and a hook that calls a model would pay for each version; a complete block is asked once. In Ink a reply is stored as a `gemini` item followed by `gemini_content` items, split at safe points while it streams so the live region stays small. Each committed item is one row: `requestId` is the item's id, and `isFirstOfReply` is true for the `gemini` item.

### Only where a row can be drawn again

Ink offers the site only in the virtualized viewport (`ui.useTerminalBuffer`, on by default in interactive terminals). In the scrollback mode a committed item is printed once and cannot change, so the site is not offered there and hooks for it are skipped, as on any host that does not draw a site. The mode is fixed for the session, so the site list read at load stays right.

Only the main transcript is offered. Subagent views reuse the same item component with their own ids, which could collide with the main transcript's.

### Raising a site only for hooks that may hear it

At load each plugin reports, per site the host draws, whether one of its `ui.render` registrations may hear it: an unnarrowed hook hears every site; one whose matcher names a `component` hears the sites that value matches. The host raises a row only when some plugin may hear it, so a band-only Mod costs no dispatch per row. `$.ui.invalidate('ui.render')` re-runs only the sites the calling plugin may hear.

### Props only, for now

The chain's answer must be the engine node `next` resolved to. The row then draws its own message component with the `text` that last reached the bottom of the chain. A hook that answers its own tree leaves the row as it was, and the debug log says so once per load. A rewritten `text` keeps the rules a tree's text keeps: at most 100,000 characters and no control characters other than tab and line breaks. The reply's own text is not checked, so a hook that passes it down unchanged never fails on it.

### One row at a time

A session runs one Mod dispatch at a time. A row render that awaits a model call holds the queue for seconds, so rows render one by one: the next row is queued only when the previous one settles, and a `tool.call` or `turn.start` arriving meanwhile waits behind at most one row. A row that scrolls away before its turn leaves the queue. Answers are kept per row and input, so a row that scrolls back into view draws its answer without a new dispatch; up to 1,000 rows no longer shown are kept. A failed render keeps the row as it is. A row asked again, by `$.ui.invalidate('ui.render')` or after an abandoned switch, draws its previous answer until the new one arrives, so it does not flash its original text.

A row whose input is larger than half a Mod payload is not raised, rather than handing the hooks a cut text.

### Session changes

Rows belong to a session. `/clear`, `/resume` and `/branch` forget every row's answer; a row still shown after the switch, as after `/branch`, renders again for the session that follows. If a switch is abandoned, rows answered while dispatches were cancelled render again.

### Copy hints

The `/copy mermaid N` and `/copy latex N` hints under a block are numbered from the stored text, and `/copy` copies the stored text: it reads the conversation history, which a row's rewrite never reaches. A rewrite that keeps code blocks, as a translation does, keeps the numbers right.

## Validation and acceptance

Core runtime tests with the real QuickJS worker:

- Per-site hook lists for narrowed, unnarrowed, pattern, regex and array matchers, and none on a host that draws only the band.
- A rewritten `text` is drawn; a tree, a changed `isFirstOfReply` and a control character leave the row as it was, said once.
- A hook that awaits `$.model.complete`, answered by another Mod, rewrites the row.
- A dispatch abandoned while its hook awaits a model call settles, cancels the host call, and the next dispatch runs.

CLI tests for the row scheduler: one row at a time with another dispatch waiting behind one row, hidden rows skipped, answers kept for a remount, invalidate and clear.

Acceptance: in the Ink terminal with the virtualized viewport, a Mod that rewrites each reply block shows the rewritten text once the block is complete, and the original before; `/copy` still copies the original.

## Risks and open questions

- While a row's hook waits on a model, other Mod hooks wait for that row. Concurrent dispatches are a separate stage.
- A row's height changes when its text is rewritten above the bottom of the viewport; the list re-measures it.
- Whether hooks should later draw trees in rows, and how a tree would hold the engine's own row.
