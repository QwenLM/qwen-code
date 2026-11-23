# Removing MessageRewriteMiddleware

[English](2026-11-23-remove-message-rewrite-middleware.md) | [简体中文](2026-11-23-remove-message-rewrite-middleware.zh-CN.md)

Status: implemented. This removes the ACP message rewrite middleware, tracked in #13749. Mods can rewrite displayed replies and thoughts in Ink, OpenTUI and the Web Shell ([Mod reply rows in the Web Shell](2026-11-18-mod-rows-in-web-shell.md), [Mod thinking rows in the Web Shell](2026-11-20-mod-thinking-rows-in-web-shell.md)).

## Problem and current behavior

ACP sessions carry `MessageRewriteMiddleware`, added as a stopgap for display rewrites. A `messageRewrite` object in user or workspace settings turns it on. At the end of each model response it sends the response's thought and reply text to a separate model call with a custom prompt, and appends the result as an extra `agent_message_chunk` marked `_meta.rewritten: true`. Its README calls it temporary and asks for a hook-based approach.

The Mod `ui.render` sites are that approach, and they do more:

- They rewrite each block for display only, and only blocks someone sees.
- They answer a reload from a cache.
- They work in the Ink and OpenTUI terminals and the Web Shell.

Legacy ACP sends the rewrite as a normal text chunk with extra metadata. The Web Shell and SDK can consume it as additional reply text without interpreting the marker. The VS Code companion also streams that text and uses the marker to avoid storing duplicate notifications. The channel bridges use the marker to skip rewritten background replies.

Keeping the middleware costs every ACP turn:

- Optional calls in more than ten places in `Session`, in the emitters and in the history replayer.
- Awaits on the default path even when it is off.
- A setting outside the settings schema.

## Goals and non-goals

Goals:

- Remove the middleware, its setting reader and its model-call rewriter.
- Remove the call sites in the ACP session, the emitters and the history replayer.
- Preserve compatibility with rewritten background replies from older ACP sessions.

Non-goals:

- Mod rendering in the VS Code companion or Zed.
- Migrating `messageRewrite` settings into a Mod.

## Design decisions

### Removed outright

The setting was described in the middleware README, was absent from the settings reference and schema, and was off by default. The CLI now ignores a leftover `messageRewrite` key. Startup paths that report unknown settings treat it like any other unknown key.

### Consumers of the marker

Both channel bridges keep filtering discrete background replies marked `_meta.rewritten`. A daemon can reload its channel worker after an in-place upgrade while an older ACP session stays live. A standalone bridge can also be given an older CLI entry path. Filtering prevents duplicate chat delivery and protects the original per-task result in the daemon bridge.

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
- The channel bridge tests cover legacy rewritten chunks, including duplicate delivery and per-task result selection.
- The nine adjusted session tests pass, and the five race tests each fail under the mutation of their guard. One test that only covered the middleware is deleted.
- The current CLI has no calls to the middleware, its setting reader or its rewriter.

Acceptance: a current ACP session with a `messageRewrite` setting runs as one without it and sends no rewritten messages. Channel bridges skip rewritten background chunks received from older sessions.

## Risks and open questions

- Users who enabled `messageRewrite` lose the appended summaries on ACP clients that displayed them, including the Web Shell and the VS Code companion. Mod display rewrites are available in Ink, OpenTUI and the Web Shell.
- Turn timing changes slightly for every ACP session, because the removed awaits yielded even when the middleware was off. The full session tests cover it.
