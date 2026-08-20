# Manual Plan-Exit Notice Delivery

## Problem

Plan mode is reinforced by a recurring reminder on model-bound user turns. When
the approval mode changes outside the approved `exit_plan_mode` flow, merely
stopping that reminder is not a reliable signal that Plan mode ended.

The existing one-shot notice is assembled in `GeminiClient` for UserQuery and
Cron turns. That boundary misses model requests sent through other paths,
including tool-result continuations, steering, hooks, ACP/daemon direct sends,
and interactive agents. A single pending boolean on `Config` also lets one
conversation consume a notice intended for every live conversation sharing the
mode.

## Scope

The guarantee applies to live conversations in the current process. It does not
persist notices across process restarts and does not change approval checks,
plan approval, or tool execution.

Notices are enabled for:

- the main chat created by `GeminiClient.startChat`, including TUI,
  non-interactive, ACP, daemon/Web UI, and replacement chats after compression;
- chats created by `AgentCore.createChat` with `interactive: true`.

They remain disabled for fork/speculation, headless agents, workflows, memory
and compaction side queries, and every other `GeminiChat` unless explicitly
enabled.

## State and Ownership

`Config` keeps two independent pieces of in-memory state:

- a mode event `{ version, kind }`, where `kind` is `clear` or `manual-exit`;
- a conversation cursor `{ seenVersion }`.

The event is owned with the approval mode. A `Config` created with
`Object.create(parent)` inherits both the parent's approval mode and current
event. On the first write that creates an own approval mode, it copies the
current event and then becomes isolated from later parent events.

The cursor is always lazily owned by the receiving `Config`. The main
conversation and each interactive agent can therefore claim the same inherited
event independently. Recreating a chat with the same `Config` retains its
cursor and does not deliver the event again.

Mode transitions update the event as follows:

- non-Plan to Plan increments the version and writes `clear`;
- Plan to non-Plan increments the version and writes `manual-exit`, except an
  approved `exit_plan_mode` writes `clear`;
- non-Plan to non-Plan does not create an event.

Entering Plan clears an undelivered older exit. A delivery reads the latest
approval mode, so a later non-Plan-to-non-Plan switch changes the mode named in
the pending notice without creating another notice.

## Delivery and Failure Semantics

`GeminiChat` exposes an idempotent opt-in. On each send it finishes asynchronous
compression and hard-rescue checks, then synchronously claims a pending event
immediately before committing the user content to history. The notice is added
as the final text part, preserving any function response parts before it.

The linearization point is the successful history commit containing the notice.
Provider retries and fallbacks reuse that committed request and do not append a
second notice to history. If synchronous send setup throws and rolls back the
history push, the claim is restored only when the same manual-exit event is
still current, the mode is still non-Plan, and the cursor still points at that
version. A later mode event makes an old restore stale and harmless.

The implementation cannot determine whether a provider received a failed
transport request. A transport retry may send the same request more than once,
but live chat history contains the notice at most once.

Context-overflow recovery is the exception to reusing the original request:
reactive compression replaces live history before rebuilding the retry payload.
If its compressed history no longer contains the committed notice, the chat
re-appends that exact text before retrying. When compression already ends in a
user turn, the notice is added as its last part rather than creating adjacent
user turns.

## Notice

```text
<system-reminder>
The approval mode changed outside the approved exit_plan_mode flow.
The current approval mode is: ${currentMode}.
Plan mode is no longer active. This notice supersedes any earlier reminder that Plan mode is active. Do not call exit_plan_mode; no plan approval is pending. Continue under the current mode's permissions and confirmation requirements.
</system-reminder>
```

## Verification

Unit tests cover transition semantics, inherited event ownership, independent
conversation cursors, stale restore behavior, opt-in delivery, part ordering,
setup rollback, retries, chat recreation, and chat ownership. The E2E plan
covers PTY, ACP, interactive agents, and approved plan exits.
