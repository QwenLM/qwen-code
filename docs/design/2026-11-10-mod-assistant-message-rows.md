# Mod reply rows

[English](2026-11-10-mod-assistant-message-rows.md) | [简体中文](2026-11-10-mod-assistant-message-rows.zh-CN.md)

Status: implemented in the Ink terminal (#16794) and the OpenTUI terminal. This adds the `AssistantMessage` render site, tracked in #13749.

## Problem and current behavior

A Mod can draw only the band above the prompt. It cannot change how the model's reply reads in the transcript, so a Mod that shows replies in another language, hides boilerplate or highlights terms has nowhere to do it. `$.model.complete` (#16737) gives such a Mod the completion it needs; this change gives it the row.

`ui.render` hooks today hear every site the host draws, and a host draws only `AbovePrompt`.

## Goals and non-goals

Goals:

- A `ui.render` site for each block of an assistant reply in the Ink and OpenTUI transcripts, whose hooks can rewrite the text the row shows.
- The stored message, what the model reads, `/copy` and exports keep the original text.
- A Mod that awaits a model call inside the hook works without stalling the session's other Mod hooks behind every row.

Non-goals:

- Trees drawn in place of a row. A row draws its own message, with the text its hooks passed down.
- Thinking rows and ACP hosts (later stages).
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

A session runs one Mod dispatch at a time. The next row is queued after the previous one settles, so a `tool.call` or `turn.start` waits behind at most one row. The host cancels each row render after 30 seconds, including time spent waiting on a model. A row that scrolls away before its dispatch starts is skipped. Answers are kept per row and input, so a row that scrolls back into view draws its answer without a new dispatch. Up to 1,000 rows no longer shown are kept. A failed render falls back to the original text. While a row waits for a new answer after `$.ui.invalidate('ui.render')` or an abandoned switch, it draws its previous answer.

A row whose input is larger than half a Mod payload is not raised, rather than handing the hooks a cut text.

### OpenTUI

OpenTUI folds consecutive text chunks into one assistant item. An image or thought can split a reply's text across several items. Replay keeps each `gemini` and `gemini_content` history item separate. Each completed text item has its own row. OpenTUI offers rows containing non-whitespace characters to Mods and uses the item id as `requestId`. The opening `gemini` block has `isFirstOfReply: true`, and `gemini_content` continuation blocks have `isFirstOfReply: false`.

The OpenTUI transcript is a retained view that mounts only the items near the viewport, so a mounted row is a shown row, as in Ink's virtualized viewport, and any mounted row draws again when its text changes. It does so in both screen modes, so OpenTUI always offers the site. A row's height is measured on each frame, so a rewrite that changes it moves the rows below. The session preview and the quit screen reuse the transcript view and do not offer rows.

### Session changes

Rows belong to the session of the displayed transcript. When `/clear`, `/resume` or `/branch` adopts another session, the host discards the old row cache and accepts rows from the new transcript once it is committed. The branch can render replies inherited from the parent once they are part of the branch transcript. If a switch is abandoned, visible rows in the original session can render again.

The two steps of a switch run in either order. Ink's `/resume` and `/branch` adopt the session for the Mods before they replace the transcript; OpenTUI's replace the transcript first, and `/clear` adopts first in both. A row whose transcript belongs to a session the Mods have not adopted yet is not raised. When the Mods adopt a session they tell every shown row, and the rows of the new transcript ask again then.

### Copy hints

`/copy` reads the stored conversation history. In Ink, a Mermaid or LaTeX block in a rewritten row shows the original block's `/copy mermaid N` or `/copy latex N` hint if it has one exact source match in the original row. New, modified or ambiguous blocks omit the hint.

## Validation and acceptance

Core runtime tests with the real QuickJS worker:

- Per-site hook lists for narrowed, unnarrowed, pattern, regex and array matchers, and none on a host that draws only the band.
- A rewritten `text` is drawn; a tree, a changed `isFirstOfReply` and a control character leave the row as it was, said once.
- A hook that awaits `$.model.complete`, answered by another Mod, rewrites the row.
- A dispatch abandoned while its hook awaits a model call settles, cancels the host call, and the next dispatch runs.

CLI tests cover serialization, skipping a row hidden while it waits, remounts, invalidation, the render deadline, session ownership and Ink's source-copy hints. The OpenTUI tests check the first-block flag and skipping whitespace-only rows for live and replayed replies. The PTY test runs in both terminals. It exercises `/branch`, checking that the inherited rows are drawn again for the branch's session, and `/clear`, checking which session receives each row.

Acceptance: in the Ink terminal with the virtualized viewport and in the OpenTUI terminal, a Mod that rewrites each reply block shows the rewritten text once the block is complete, and the original before; `/copy` still copies the original.

## Risks and open questions

- A row's hook can delay other Mod hooks until it settles or hits the 30-second deadline. Concurrent dispatches are a separate stage.
- A row's height changes when its text is rewritten above the bottom of the viewport; the list re-measures it.
- Whether hooks should later draw trees in rows, and how a tree would hold the engine's own row.
