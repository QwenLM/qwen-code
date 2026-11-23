# Mod thinking rows

[English](2026-11-16-mod-thinking-rows.md) | [简体中文](2026-11-16-mod-thinking-rows.zh-CN.md)

Status: implemented in the Ink and OpenTUI terminals, and in the Web Shell by [Mod thinking rows in the Web Shell](2026-11-20-mod-thinking-rows-in-web-shell.md). This adds the `Thinking` render site, tracked in #13749. It builds on the reply rows of [Mod reply rows](2026-11-10-mod-assistant-message-rows.md).

## Problem and current behavior

A Mod can rewrite how each block of a reply reads (`AssistantMessage`), but not the model's thinking. A Mod that shows the model's English output in another language translates the reply and leaves the thinking as the model wrote it.

The author contract has no thinking site. Its only route to thinking text is rewriting thinking chunks as they stream, which needs the whole streaming middleware, works only live, and leaves a resumed session showing the original.

## Goals and non-goals

Goals:

- A `ui.render` site for each complete block of thinking in the Ink and OpenTUI transcripts, whose hooks can rewrite the text the expanded block shows.
- A thought that is never expanded costs no hook run, so a translating Mod spends a model call only on the thoughts a person opens.
- The stored thought and what the model reads keep the original text.

Non-goals:

- The collapsed line (`Thought for 12s`), which the host draws.
- Thoughts while they stream, subagent views, the session preview, headless runs and ACP hosts. The Web Shell's ACP sessions gained the site later.
- Trees drawn in place of a row, as with reply rows.

## Contract

`Thinking` is a Qwen Code site, with no counterpart in the author contract, and the user docs say so. Its event follows the reply row's shape:

```js
{ surface: 'terminal', component: 'Thinking', requestId: '41', props: { text } }
```

- `text` is the block's markdown, without trailing whitespace, as the row draws it. A hook passes rewritten props down with `next(...)`; `next(e)` leaves the block as it is.
- The envelope is pinned and the props keep their keys, so a hook cannot add one. A rewritten `text` follows the reply row's rules: at most 100,000 characters and no control characters other than tabs and line breaks, checked only when the text changed.
- A hook that answers a tree of its own leaves the block as it was, and the debug log says so once.

There is no `isExpanded` prop: the site is raised only for an expanded block, so it would always be `true`. There is no first-block flag either. A Mod translating a thought has no use for it, and one can be added later without breaking hooks that pass `...e.props` on, as the user docs tell authors to.

## Qwen design decisions

### Raised only when complete and expanded

Both terminals collapse thinking by default. A row offers its block when it is complete, expanded, and intersects the transcript viewport. Rows mounted beyond the viewport wait until they scroll into view. Collapsing or scrolling a block out of view withdraws the offer. The reply-row cache also stores thinking answers for reopening and scrolling back. A blank thought is not raised.

### Same rows machinery

`AssistantMessage` and `Thinking` are both row sites, which a hook rewrites only by props. Core treats them as one set for the worker's answer (`{ tree, props }`), the props checks and the settled-tree check, so a later row site needs only its name and pinned props. The CLI's row scheduler, session ownership, 30-second deadline and per-site hook gating are reused unchanged.

### Where it is offered

The site is offered where reply rows are: Ink with the virtualized history (`ui.useTerminalBuffer`), where an expanded thought can be drawn again, and OpenTUI in both screen modes. Ink can split a long thought into a head block and continuation blocks, each offered on its own; OpenTUI keeps a live thought as one block. Ink omits Mermaid and LaTeX source-copy hints from thinking because `/copy` reads assistant replies.

## Validation and acceptance

Core runtime tests with the real QuickJS worker: hooks that name `Thinking` or no component hear it, and hooks that name `AssistantMessage` do not; a rewritten `text` is drawn; a tree, an added prop and a control character leave the block as it was.

CLI tests cover committed, expanded thoughts in both terminals and verify that a mounted thought outside the viewport waits until it scrolls into view. Ink tests also cover continuation blocks and check that Mod-added math displays without a `/copy` source hint.

The PTY test runs in both terminals. A model replies with thinking and text, and a Mod numbers each render. It checks that the collapsed thought is not raised and that `ctrl+o` shows the rewritten text from the first render. Collapsed and opened again, the thought still shows that first render. The stored transcript keeps the original thought.

Acceptance: in both terminals, a Mod that rewrites each thought shows the rewritten text once a complete thought is expanded, and never runs for a thought that stays collapsed.

## Risks and open questions

- Opening a thought whose hook awaits a model call shows the original until it answers, then the block changes height.
- `ctrl+o` expands every thought in view at once, so a translating Mod may run a model call for each; rows still render one at a time.
