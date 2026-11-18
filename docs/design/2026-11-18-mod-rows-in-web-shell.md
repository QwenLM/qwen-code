# Mod reply rows in the Web Shell

[English](2026-11-18-mod-rows-in-web-shell.md) | [简体中文](2026-11-18-mod-rows-in-web-shell.zh-CN.md)

Status: implemented. This draws the Mods' rewrites of reply rows in the Web Shell, tracked in #13749. It builds on [Mods in ACP sessions](2026-11-18-mods-in-acp-sessions.md) and [Mod reply rows](2026-11-10-mod-assistant-message-rows.md). Thinking rows follow in the next step.

## Problem and current behavior

Since Mods run in ACP sessions, a Web Shell session loads the workspace's Mods, but nothing they draw reaches the page. The session reports no surface, its `ui.render` hooks are skipped, and the Mods' log lines arrive on the event stream as frames the SDK does not know, so the Web Shell hides them. A Mod that translates replies works in the terminal and does nothing in the Web Shell. `experimental.mods` is also missing from the Web Shell settings page, so a Web Shell user turns it on by editing a settings file.

## Goals and non-goals

Goals:

- A Web Shell session's Mods run on the `desktop` surface and rewrite how each complete block of the model's reply reads, as `AssistantMessage` rows do in the terminals.
- A block costs a hook run only once someone sees it, and once per text: a reload or a second tab does not run the hooks again.
- The Mods' log lines show in the Web Shell transcript.
- The setting shows on the Web Shell settings page.

Non-goals:

- Thinking rows, which are the next step, the band above the prompt, and trees drawn in place of a row.
- Redrawing rows that a page already holds on `$.ui.invalidate('ui.render')`.
- Mod rows over the ACP-over-HTTP transport or in other ACP clients (Zed, the VS Code companion).
- Removing `MessageRewriteMiddleware`. It can go once thinking rows land too.

## Compatibility contract

These parts follow the Mod author contract:

- The `AssistantMessage` site and its props are those of the terminals: `text` (the block's markdown) and `isFirstOfReply`. A hook rewrites the row with `next({ ...e, props: { ...e.props, text } })`. The envelope and `isFirstOfReply` are pinned.
- The session draws on `desktop`: `session.start` receives `surface: 'desktop'` and `isInteractive: true`, and `$.session.surfaces()` is `["desktop"]`.
- `$.ui.resolve(e)` for a `desktop` event returns the desktop's element table, the ten constructors `Box`, `Text`, `Button`, `Input`, `Select`, `Svg`, `Link`, `Code`, `Markdown` and `Client`. As in the terminals, a row draws only rewritten props.
- `requestId` names the row; here it is a digest of the row's props. `viewport`, which the contract leaves optional, is absent.

## Qwen design decisions

### The Web Shell asks for its rows

The plan before this step had the child run the hooks on each finished block and push the rewrites to the page by message id and block number. The child cannot do that well: a live reply block carries no message id, the page numbers its blocks per projection, and only the page knows which blocks are on screen (and, for thinking, which are expanded). So the page asks. Once a reply block is complete and on screen, the Web Shell asks the daemon for its row (`POST /session/:id/mod-row`). The daemon forwards the ask to the child, where the session's Mods answer it through the row queue the terminals use. This keeps the terminals' cost rule: a block nobody sees costs no hook run.

### Capability and surface

The daemon's bridge names, in its ACP `initialize` client capabilities, the row sites its Web Shell draws: `_meta["qwen.modRows"]: ["AssistantMessage"]`. When a client draws a row site, the child runs each of its sessions' Mods on the `desktop` surface and offers the sites it can answer of those. Zed and the VS Code companion send no such capability, so their sessions stay as they were. The surface is read at load, so it belongs to the daemon and not to whichever page is open: a session another daemon client drives reports `desktop` too. The daemon advertises `session_mod_rows` in `/capabilities`, and the Web Shell asks only then. `isInteractive` is true on the desktop because the Web Shell has a person at its prompt.

The Mod host keeps "an ACP session" apart from its surface, so a desktop session keeps the ACP host's rules: no prompts and no tool middleware, logs through the ACP notification, and context figures from the session's own chat.

### The row's identity

The child builds the event's envelope. `requestId` is a digest of the component and props, and the props are checked against the site's exact keys and kinds. The page's block ids are per projection and differ across tabs and reloads, while a digest makes the same text the same row, so the session's row cache (up to 1,000 rows, as in the terminals) answers a reload or a second tab without running the hooks again. Two blocks with the same text and flag are one row and share an answer; for a rewrite of the text, that is the same answer anyway.

### One ask at a time

The Web Shell keeps one ask in flight per session and queues the rest in the order they appeared. A block that leaves the screen before its turn leaves the queue. The session's Mods render one row at a time anyway, so more asks in flight would only wait in the child, and many held requests could use up the browser's connections to the daemon. An ask the page abandons is not cancelled in the child; it costs at most the one row in flight. The child gives an ask 60 seconds, for the load, the rows ahead of it and its own 30-second render. The bridge's backstop is 75 seconds.

The answer says one of three things. No hook in the session hears the site, and the page stops asking for it. The hooks did not answer in time or the session moved on, and the row stays as it is and is asked again when it is shown again. Or the hooks answered, possibly with no rewrite. The page keeps only answers; a failure is never kept as "no rewrite".

### What is a reply row

The Web Shell offers the assistant messages that hold the model's reply. It does not offer command output (a block with a `meta.source`), a workspace agent's reply, a local command's output, or a subagent's text, which it draws inside the tool card. `isFirstOfReply` is true unless the message before it, thinking aside, is reply text too. The Web Shell keeps no response boundary, so this follows OpenTUI, which flags only a known continuation. The page draws the rewrite in the message's Markdown only; copying, search and branching keep the original, as `/copy` does in the terminals. A row keeps its answer after it scrolls away, so the rows above the viewport keep their height.

### Logs in the transcript

The SDK knows the `mod_log` event and turns each into an informational line, `[Mod <plugin>] <text>`, as the terminals print it. A line does not end the reply block it arrives during; it sits below it. The lines are not saved with the session, as in the terminals.

### The setting

`experimental.mods` moves off the Web Shell's terminal-only list and gains a Chinese label and description. Sessions started after a change load Mods without a daemon restart. The setting still says it needs a restart, which is true in a terminal, where a running session does not load Mods again, so the page says so too.

## Validation and acceptance

Unit tests:

- Core runtime, with the real QuickJS worker: a desktop host's `session.start` reports `desktop`, `true` and `["desktop"]`. A desktop row is rewritten, and `$.ui.resolve` hands out the desktop table and refuses other surfaces.
- Mod session: a desktop host loads with the ACP host's arguments and the client's sites. An ask is answered with the rewrite, and from the cache for the same props, with a 32-hex-digit `requestId`. A site no hook hears is unhooked, a row too large is drawn as it is, and a terminal host answers no asks. The row queue settles a client's single ask on each of its ends: a rewrite, no rewrite, a cleared session and an abort.
- ACP: the capability gives the desktop and the sites this host answers. An ask waits for the load, refuses props that do not match the site, and is unhooked after a failed load. The agent hands the client's sites to each session and routes the ext method.
- Bridge, daemon route and SDK: `initialize` declares the sites and the row is forwarded. The route checks the body and answers 404 for a session that is not live. The SDK knows `mod_log`, draws it below a streaming reply, and posts the row.
- Web Shell: the asker asks one row at a time, skips a released row, keeps answers, asks again after a failure and stops after an unhooked answer. A reply row draws the rewrite and copies the original; it is asked only once complete and on screen, and keeps its answer off screen. The list flags reply rows and their `isFirstOfReply`, passing over thinking and Mod log lines, and flags none without the capability. Command output carries its source.

An integration test runs a real `qwen serve` with a Mod installed and Mods off. The capability is advertised, and a session answers unhooked. Turning Mods on through the settings route reports that a restart is needed, yet the next session loads the Mod, and a prompt completes. The row is rewritten; the same row from a second client comes from the first answer, so the hook's counter does not grow; a different flag runs the hook again. `Thinking` is unhooked, mismatched props fail, and the event stream carries the `mod_log` line `start desktop true ["desktop"]`. The ACP integration test still sees `null` for a client without the capability.

A browser check ran the same against the real Web Shell, with a reply streamed in chunks around a file read. Each of the two reply blocks was rendered once while live; after a reload, in a second tab, and with the finished turn opened again, both showed their first answers, and copying gave the original.

Acceptance: in the Web Shell, with `experimental.mods` on and a Mod that rewrites `AssistantMessage`, each complete reply block on screen shows the rewritten text, a reload shows it again without running the hook, copying gives the original, and the Mod's log lines show in the transcript.

## Risks and open questions

- A row is asked once it is complete, so a rewrite that calls a model shows the original first, and the row then changes height.
- The surface is the daemon's: a session that another daemon client drives reports `desktop` and `isInteractive: true` though no page draws it.
- `$.ui.invalidate('ui.render')` does not redraw rows a page already holds; the page asks again only after a reload. A notification that tells pages to ask again can follow.
- `mod_log` lines take places in the session's event ring like any other frame.
- An ask in flight counts as the session's work, as a recap does, so idle cleanup leaves the session open meanwhile and the session reads as active until the row is answered.
- A `Thinking` hook in a Web Shell session loads without the "will not run" diagnostic, because the session raises `ui.render` for reply rows, and is not called until thinking rows land.
