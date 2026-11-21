# Mod thinking rows in the Web Shell

[English](2026-11-20-mod-thinking-rows-in-web-shell.md) | [简体中文](2026-11-20-mod-thinking-rows-in-web-shell.zh-CN.md)

Status: implemented. This draws the Mods' rewrites of thinking rows in the Web Shell, tracked in #13749. It follows [Mod reply rows in the Web Shell](2026-11-18-mod-rows-in-web-shell.md) and brings the terminals' `Thinking` site from [Mod thinking rows](2026-11-16-mod-thinking-rows.md) to the Web Shell.

## Problem and current behavior

A Web Shell session's Mods rewrite the reply blocks a person sees, but not the model's thinking. The bridge declares only `AssistantMessage`, so the session offers no `Thinking` site and its hooks never run. A Mod that translates the model's English output translates replies in the Web Shell and leaves every thought as the model wrote it, while both terminals translate a thought once it is expanded.

The Web Shell draws a thought in two places. A thought with no tool beside it is a row of its own, collapsed to "Done thinking". A thought next to tool calls is folded into the compact tool summary as one of its lines. Compact view is always on, so most thoughts are drawn there. A subagent's thoughts are drawn in its tool card. Once that card has left the transcript window, they are drawn as ordinary thoughts.

## Goals and non-goals

Goals:

- The `Thinking` site in the Web Shell, for both thought rows and thought lines folded into a tool summary, with the terminals' contract.
- A thought costs a hook run only once someone expands it and it is on screen. Expanding it again, reloading or opening a second tab reuses the answer while it remains cached.
- The stored thought and what the model reads keep the original.

Non-goals:

- The collapsed line ("Done thinking", "Thought for 12s"), which the host draws.
- A subagent's thoughts, in its tool card or outside it, as with the terminals' subagent views.
- The exported transcript, which draws thoughts as they are.
- Redrawing thoughts a page already holds on `$.ui.invalidate('ui.render')`, as with reply rows.
- Removing `MessageRewriteMiddleware`. The Web Shell no longer needs it once both sites are drawn, but the VS Code companion still shows its rewritten messages, so removing it is a decision of its own.

## Compatibility contract

These parts follow the Mod author contract and the terminals' `Thinking` site:

- `Thinking` remains a Qwen Code site. The Web Shell's event is the terminals' event on the desktop: `{ surface: 'desktop', component: 'Thinking', requestId, props: { text } }`. `text` is the thought's markdown without trailing whitespace. A hook passes rewritten props down with `next(...)`; `next(e)` leaves the thought as it is.
- The props keep their one key. A rewritten `text` holds at most 100,000 characters and no control characters other than tabs and line breaks. A thought needs nonblank text to be offered.
- `requestId` is a digest of the component and props, as for reply rows, so a thought and a reply block with the same text are different rows.
- A hook with no `component` matcher hears thinking rows too, as in the terminals.

## Qwen design decisions

### Declared with the reply rows

The bridge declares `["AssistantMessage", "Thinking"]` in `_meta["qwen.modRows"]`, and the child adds `Thinking` with its one string prop to the rows it checks. Nothing else on the path names a site. The route, the SDK, the session's row queue and the page's asker serve both sites as they are.

There is no new capability tag. A Web Shell that asks an older daemon for a thought gets `unhooked`, because that child knows no `Thinking` row. The page then stops asking for that site and keeps asking for reply rows.

### Asked from the expanded body

The thought row and the thought line draw an expanded thought with the same body. In the live transcript, that body is swapped for one that asks the session's Mods. The body exists only while the thought and its enclosing tool summary are expanded. Closing either withdraws an ask that has not started, including when a workflow summary keeps its tool details mounted.

The body asks once the thought is complete, its text is not blank, and it intersects the viewport. It uses the same one-at-a-time asker as reply rows. An expanded thought in a tool summary keeps its state when a new tool call moves it from the end of the summary to just before that tool. It shows the stream and is asked for when it completes. The session's cache retains up to 1,000 inactive rows shared between replies and thoughts. Only the body reads the asker, so the thought headers keep their memo boundaries and do not render again per streamed chunk.

### Which thoughts

The page offers the thoughts of the session's own model. A subagent's thought drawn in its tool card is not offered. A subagent's thought can also be drawn outside its card, once the card has left the transcript window. In that case the page keeps the parent tool on the thought, as it does for a subagent's text. The thought is then not merged into the model's thought before it, and it is not offered, whether it is a row of its own or folded into a tool summary.

### What keeps the original

The page draws the rewrite only in the expanded body. The stored thought and the collapsed line keep the model's original. The built-in translate button beside a thought translates the original, which repeats the work of a translating Mod, so the page hides the button once it has drawn a Mod's rewrite of the thought. An open translation stays available until the user closes it. Hiding the button cancels any unfinished translation. If keyboard dismissal hides the button, focus returns to the thought's expand button. If the Mod connection changes, replay gives the row different text, or the expanded body returns to the original, the button is available again. A thought whose hooks left it as it is keeps the button, and so does a subagent's thought.

### The export

The export build replaces the swappable body with the plain one, by the same mechanism as for reply rows. Exported files draw the original thoughts and carry no Mod code.

## Validation and acceptance

Unit tests:

- ACP: a client that declares both sites gets both, and a client that declares one gets one. A thought's props must be exactly `{ text }` with a string.
- Bridge: `initialize` declares both sites.
- Web Shell, thought row: one root is rendered through streaming, complete, expanded, collapsed and expanded again. The thought is asked only once it is complete, expanded and on screen, with its trailing whitespace trimmed. It keeps the answer off screen, and expanding it again draws the kept answer without another ask. Once rewritten, it hides its translate button, also after being collapsed.
- Web Shell, other cases: a collapsed thought, a blank thought and a subagent's thought are not asked for. In the compact tool summary, a folded thought is asked once expanded and then drops its translate button, while a subagent's folded thought is not asked and keeps its button. After the session answers `unhooked` for thinking rows, the page asks for no more thoughts and keeps asking for reply rows.
- Web Shell, compact summary: a new tool call completes an expanded streaming thought and moves it before the tool. The thought stays expanded and shows the rewrite. Closing a workflow summary withdraws a queued thought before the visibility observer reports the collapse.
- Web Shell, transcript: a thought from a missing parent stays apart from the model's thought and keeps its parent, and the compact fold carries the parent.
- Web Shell, replay: a reused standalone or folded row shows Translate when its current thought is unmodified. An expanded row also restores Translate if it keeps the same text and the new session connection leaves it unchanged.
- Mutation check: each of these tests fails once the subagent check, the trim, the parent rule for merging, the parent in the fold or the hidden translate button is removed.

An integration test runs a real `qwen serve`, where the probe Mod hooks `Thinking` and the model streams a thought in two chunks:

- The thought row is rewritten, and a second client gets the first answer.
- Props that carry the reply's flag fail, and a site the Web Shell does not draw is unhooked.
- The replayed thought's text is the text of the row that was asked for.

A browser check ran against the real Web Shell, with two turns:

- In the first turn, one thought before a file read and one after it were folded into the tool summary. The second turn had a standalone thought.
- While every thought was collapsed, the hook did not run.
- Expanded, the standalone thought showed render #1, and it still showed #1 after being collapsed and expanded again. The folded thoughts showed #2 and #3.
- After a reload and in a second tab, all three showed their first renders, and the Mod's log still counted three renders.

These builds measured the export renderer's JavaScript separately from its CSS. Both exceeded their size warning threshold.

| Build                                | Commit       | Renderer JS (bytes) | Hard limit (bytes) | Remaining (bytes) |
| ------------------------------------ | ------------ | ------------------: | -----------------: | ----------------: |
| Linux CI, Node 22                    | `7dc70aadde` |           2,147,983 |          2,148,200 |               217 |
| Local macOS merge candidate, Node 22 | `1ff6ea271a` |           2,151,016 |          2,151,577 |               561 |

Acceptance: in the Web Shell, with `experimental.mods` on and a Mod that rewrites `Thinking`:

- Each complete, expanded thought on screen shows the rewritten text, as a row of its own or in a tool summary.
- A reload shows the cached rewrite again without running the hook.
- A thought that stays collapsed never runs the hook.

## Risks and open questions

- A thought whose hook awaits a model call shows the original when expanded, then changes height when the answer arrives.
- A workflow summary keeps its lines mounted when collapsed. Its thoughts resume their expansion state when the summary reopens and draw any cached answers.
- The page knows a thought was rewritten only once it has drawn the rewrite. A collapsed thought therefore shows the translate button until it is expanded, including after a reload, though the session already keeps its answer.
