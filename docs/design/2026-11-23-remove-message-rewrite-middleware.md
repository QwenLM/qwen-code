# Removing MessageRewriteMiddleware

[English](2026-11-23-remove-message-rewrite-middleware.md) | [简体中文](2026-11-23-remove-message-rewrite-middleware.zh-CN.md)

Status: implemented. This removes the ACP message rewrite middleware, tracked in #13749, now that Mods rewrite what replies and thoughts show in every Qwen Code interface ([Mod reply rows in the Web Shell](2026-11-18-mod-rows-in-web-shell.md), [Mod thinking rows in the Web Shell](2026-11-20-mod-thinking-rows-in-web-shell.md)).

## Problem and current behavior

ACP sessions carry `MessageRewriteMiddleware`, added as a stopgap for display rewrites. A `messageRewrite` object in user or workspace settings turns it on. At the end of each model response it sends the response's thought and reply text to a separate model call with a custom prompt, and appends the result as an extra `agent_message_chunk` marked `_meta.rewritten: true`. Its README calls it temporary and asks for a hook-based approach.

The Mod `ui.render` sites are that approach, and they do more:

- They rewrite each block for display only, and only blocks someone sees.
- They answer a reload from a cache.
- They work in the Ink and OpenTUI terminals and the Web Shell.

The middleware, by contrast, reaches only clients that understand its marker. The Web Shell and the SDK never did. The VS Code companion streams the rewritten copy as more text, and the channel bridges skip it.

Keeping the middleware costs every ACP turn:

- Optional calls in more than ten places in `Session`, in the emitters and in the history replayer.
- Awaits on the default path even when it is off.
- A setting outside the settings schema.

## Goals and non-goals

Goals:

- Remove the middleware, its setting reader and its model-call rewriter.
- Remove the call sites in the ACP session, the emitters and the history replayer.
- Remove the channel bridges' handling of the marker, which only the middleware emitted.

Non-goals:

- A replacement in the VS Code companion. Mod rows are drawn by the Ink and OpenTUI terminals and the Web Shell only.
- Migrating `messageRewrite` settings into a Mod.

## Design decisions

### Removed outright

The setting is undocumented in the settings reference, absent from the settings schema and off by default. A `messageRewrite` key left in a settings file is reported like any other unknown key: a debug log line says it is ignored. No migration code is added.

### Consumers of the marker

The channel bridges run with the CLI of the same install: one spawns its own child, the other talks to the daemon of the same install. Their skip of `_meta.rewritten` messages can never fire again, so it goes with the middleware.

The VS Code companion ships separately and may talk to an older CLI, so it keeps its handling; only its comments now say that older CLIs emit the marker.

### Session timing

Five of the removed calls were awaited even with no middleware installed, so every turn yielded there. Five session tests used the middleware's wait as a pause point to land a cancellation or a newer prompt at that moment. Each now pauses at the next real step on the same path:

- the history write that keeps the ended batch or the stop message;
- the end of the model's response stream.

A mutation check confirms that each of these tests still fails once the check it guards is removed:

- the cancellation check before the loop-protection error;
- the tool phase being cleared;
- the abort-aware stop reason;
- the cancellation check when the Stop loop starts;
- the ownership check before resetting the newer prompt's state.

### Name

`Session.installRewriter` only loads the session's Mods now, so it is renamed `installMods`.

## Validation and acceptance

- The CLI, bridge and channel packages typecheck.
- The full ACP session test file and the ACP agent tests pass.
- The channel bridge tests pass.
- The nine adjusted session tests pass, and the five race tests each fail under the mutation of their guard. One test that only covered the middleware is deleted.
- A whole-tree search finds no remaining reference to the middleware, its setting reader or its rewriter outside historical design notes.

Acceptance: an ACP session with a `messageRewrite` setting runs as one without it, and sends no rewritten messages.

## Risks and open questions

- VS Code companion users who set `messageRewrite` lose rewritten summaries with no replacement in that client.
- Turn timing changes slightly for every ACP session, because the removed awaits yielded even when the middleware was off. The full session tests cover it.
