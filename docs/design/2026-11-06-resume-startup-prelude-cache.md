# Preserve the startup prelude across resume

[中文版](./2026-11-06-resume-startup-prelude-cache.zh-CN.md)

**Status:** Proposed
**Issues:** [#14215](https://github.com/QwenLM/qwen-code/issues/14215), [#8277](https://github.com/QwenLM/qwen-code/issues/8277)
**Related:** [#14246](https://github.com/QwenLM/qwen-code/issues/14246) (git snapshot moved into the prelude), [#16362](https://github.com/QwenLM/qwen-code/pull/16362) (date reminders read from history)

## Problem

A resumed session does not send the same prompt prefix as the session it
resumed. `Client.startChat()` calls `getInitialChatHistory()` with the saved
history, and that function rebuilds the startup prelude from the current date,
directory tree, git snapshot, MCP instructions, skills, and deferred tools.
The rebuilt prelude is prepended before the saved turns, so the first user
message differs from the one the previous process sent.

With an implicit prefix cache (vLLM, llama.cpp), the reusable prefix ends at
the first differing token. In a reported 417k-token conversation, vLLM reused
only the ~14k-token system prompt, then recomputed ~186k tokens and took 126
seconds to first token. The transcript for that session contains the real user
prompt as its first user record, but no startup prelude: there is nothing to
replay.

## Proposal

Persist the exact prelude and replay it.

1. When `startChat()` generates a startup prelude, record it as a `system`
   record with `subtype: 'startup_context'` and `message` set to the prelude
   `Content`.
2. Recovery (`SessionApiHistoryAccumulator`) keeps the latest such record and
   prepends it to the reconstructed API history. It is never replayed as a
   user turn and never counted as a prompt.
3. `getInitialChatHistory()` detects that `extraHistory[0]` is already a
   startup prelude and returns the saved history unchanged instead of building
   another one.
4. `startChat()` only records a prelude when it generated one. A resumed
   session that already has the saved prelude does not append a duplicate.

The latest record wins so a prelude rebuilt by `/compress` or auto-compaction
replaces the pre-compaction one on the next resume. The post-replay ACP refresh
is skipped for resumed sessions (new ACP sessions keep it), and both the
in-session date refresh and the auto-compaction rebuild record their new
prelude before installing it, so the next resume replays the prefix the latest
request actually used.

## Freshness and limits

- The saved prelude keeps the original date and git snapshot. Date freshness
  is still handled by the existing history-derived date reminder from #16362:
  the saved prelude carries `DATE_REMINDER_METADATA`, so a later date produces
  a tail reminder. The git snapshot is intentionally frozen at session start;
  the model can run `git status` for current state.
- Sessions recorded before this change have no `startup_context` record. Their
  first resume still rebuilds the prelude (one cache miss) and records the new
  prelude for later resumes.
- Managed sessions whose journal cannot carry the record fall back to the
  current rebuild behavior.
- MCP/skills/deferred-tool lists in the saved prelude can be stale. A later
  change can append deltas at the request tail; this proposal deliberately
  does not touch the prefix.
- This is separate from the request-tail memory catalog (#14203) and image
  payload eviction (#15495). A session that already hit those rewrites still
  needs its own fix.

## Acceptance

- Recovering a conversation with a `startup_context` record produces exactly
  one API-history prelude, and the latest record wins.
- `getInitialChatHistory()` with a saved prelude returns the same first entry
  and length; it does not rebuild the date/git snapshot.
- A generated prelude is recorded once; a replayed prelude is not re-recorded.
- Existing image, compression, date-reminder, and rewind tests stay green.

## Alternatives considered

- **Static prelude with no date/git status:** smaller code change, but changes
  the model-facing context for every session and still needs tail reminders.
- **Request-only copy per turn:** keeps history immutable but cannot restore a
  prelude that was never persisted.
- **Disable the prelude on resume:** the previous request had one, so the
  prefix still differs at the same position.
