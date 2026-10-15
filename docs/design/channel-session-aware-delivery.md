# Channel Session-Aware Delivery

## Problem

Channel sessions are already independent, but a few adapters keep delivery-only
state at chat or process scope. When two sessions run in the same chat, a later
message can replace the reply target of an earlier QQ response, one completed
Weixin session can clear another session's typing indicator, and the plugin
example can associate overlapping responses with the wrong inbound message.

## Scope

This change makes existing same-chat delivery state session-aware. It does not
add named sessions, task selection, session persistence, result labels, or
worktree creation. It does not change `ChannelBase` or the public channel
adapter interface.

`ChannelOutputSegmentContext` already carries the originating session, run,
target, and message ID. `ChannelBase` also retains the active prompt's message
ID until response delivery completes. Adapters can therefore preserve the
origin without introducing another shared delivery abstraction.

## QQ

QQ passive replies require the original inbound `msg_id`, and streaming blocks
for that message share a `msg_seq` counter. The adapter keeps a bounded
in-memory context for every recently accepted message while retaining the
persisted per-chat latest message as a compatibility pointer.

Prompt output uses the message ID from the active prompt or output segment.
Streaming state copies that reply context so delayed flushes and retries do not
depend on mutable chat state. Replies produced while handling an inbound
command use async-local inbound context. Background and cron delivery is
explicitly active and never borrows the latest inbound message.

An expired or missing explicit context falls back to active delivery, never to
a different message in the same chat. Sequence counters remain isolated by
message ID and are reclaimed with the message context's existing five-minute
TTL. The persisted schema is unchanged; restore keeps sequence counters only
for restored valid reply contexts.

## Weixin

Weixin typing ownership is tracked as `chatId -> sessionId -> startedAt`.
Starting the first session enables typing and starts one chat-level keepalive.
Additional sessions only add owners. A terminal event removes its own owner,
and only the last owner disables typing.

The existing generation guard continues to reject stale asynchronous typing
results. The keepalive backstop expires individual sessions rather than the
whole chat, so an old wedged session cannot clear a newer session's indicator.
Session death removes only that session; disconnect clears all state.

## Plugin example

The example replaces its process-global pending message ID with async-local
inbound context for command replies and uses output-segment or active-prompt
message IDs for agent output. This demonstrates the same correlation contract
to third-party adapter authors without changing the protocol.

## Failure semantics

- A missing or expired QQ passive context uses active delivery and remains
  subject to the existing active-message policy.
- A failed QQ passive attempt rolls back only its original message's sequence
  before the existing active fallback.
- A failed Weixin typing request does not discard live owners; the bounded
  keepalive retries while at least one owner remains.
- Cleanup on session death, group removal, and disconnect cannot remove state
  owned by another live session.

## Verification

Focused tests cover two sessions in one chat, delayed streaming flushes,
independent QQ sequence rollback, expired reply contexts, background delivery,
Weixin first-owner/last-owner transitions, stale async typing results,
per-session backstop expiry, and overlapping plugin messages. Package tests are
followed by the repository build, typecheck, and lint checks.
