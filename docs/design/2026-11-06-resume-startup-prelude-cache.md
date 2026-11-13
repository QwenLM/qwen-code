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
   `Content`. The record is held in memory until the transcript's first real
   record arrives: writing it eagerly would create a transcript for a session
   that never sent a turn, and the session list would then treat that empty
   session as a conversation.
2. Recovery (`SessionApiHistoryAccumulator`) keeps the latest such record and
   prepends it to the reconstructed API history. It is never replayed as a
   user turn and never counted as a prompt.
3. `getInitialChatHistory()` detects that `extraHistory[0]` is already a
   startup prelude and returns the saved history unchanged instead of building
   another one.
4. `startChat()` only records a prelude when it generated one. A resumed
   session that already has the saved prelude does not append a duplicate.
5. Mid-session context reminders (MCP tools or instructions, skills, and
   agent types that became available after startup, such as an MCP server
   that connects after the first request is built) are recorded as `system`
   records with `subtype: 'context_reminder'` when they are added to the
   history, and recovery replays them in place. Without this, a resumed
   session drops the reminder from its original position and the first
   user message diverges right after the prelude.

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
  does not touch the prefix. The skill-reminder dedup is seeded from the saved
  `<available_skills>` block, so a resume does not re-announce the whole
  listing. Deferred-tool and MCP-instruction bookkeeping is still seeded from
  the live registry, so entries added or removed between sessions are not
  announced as a tail delta; seeding those from the saved prelude is a
  follow-up.
- This is separate from the request-tail memory catalog (#14203) and image
  payload eviction (#15495). A session that already hit those rewrites still
  needs its own fix.

## Acceptance

- Recovering a conversation with a `startup_context` record produces exactly
  one API-history prelude, and the latest record wins.
- The selective restore projection replays the saved prelude exactly like the
  legacy full-history path.
- `getInitialChatHistory()` with a saved prelude returns the same first entry
  and length; it does not rebuild the date/git snapshot.
- A generated prelude is recorded once; a replayed prelude is not re-recorded.
- A resumed deferred/standalone session does not rebuild its prelude after
  activation.
- A resumed session seeds skill-reminder dedup from the saved listing, so its
  first turn does not re-announce every available skill/command.
- Recording a startup prelude alone does not create a transcript; the prelude
  is written ahead of the first real record.
- A context reminder added mid-session is recorded and replayed at the same
  position, so a session whose MCP server connected late resumes with the
  same request prefix.
- Existing image, compression, date-reminder, and rewind tests stay green.

## Alternatives considered

- **Static prelude with no date/git status:** smaller code change, but changes
  the model-facing context for every session and still needs tail reminders.
- **Request-only copy per turn:** keeps history immutable but cannot restore a
  prelude that was never persisted.
- **Disable the prelude on resume:** the previous request had one, so the
  prefix still differs at the same position.
