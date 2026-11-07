# Reclaim Idle Channel Sessions

[English](channel-session-idle-reclaim.md) | [简体中文](channel-session-idle-reclaim.zh-CN.md)

**Status:** Implemented
**Date:** 2026-11-07
**Scope:** `packages/acp-bridge/src/session-control-plane.ts`,
`packages/web-shell/client/**`

## 1. Problem

A workspace can reach `maxSessionsPerWorkspace` while every live session is
idle. The daemon then rejects every new session with HTTP 503 and
`code: "session_limit_exceeded"` until an operator closes sessions manually.

On a long-running daemon this is routine, not exceptional: each GitHub channel
event creates a route-scoped session, and the channel bridge keeps an SSE event
pump attached to it. The existing idle reaper refuses to close any session with
`events.subscriberCount > 0`, so the pump pins the session forever. `qwen-code`
reached 64/64 this way on 2026-11-07; all 64 sessions were idle channel
sessions and the user could not create a new one.

## 2. Current Behavior

- `entryIsAutoCloseCandidate` returns false for every session with a live SSE
  subscriber, regardless of who owns the subscription.
- The channel bridge starts one event pump per cached session and keeps it open
  after the turn settles.
- The reaper therefore never sees a channel session as reaped, and the
  per-workspace cap is consumed until the daemon restarts.
- The release dialog already exists (`/release`), but it is only reachable by
  typing the command and releases one session at a time.

## 3. Goals

- Reclaim an idle channel session even while its channel-owned SSE pump is
  attached.
- Never close a session that has local work or that the child reports as held.
- Preserve the strict SSE-subscriber guard for user-owned sessions.
- Give the user a visible recovery path when the limit is still reached.

## 4. Non-goals

- LRU eviction at the `maxSessions` boundary. This design does not change
  admission; a full workspace still returns 503 when no session is reapable.
- Changing channel route retention or adding per-channel session caps.
- Releasing sessions while a turn, background task, or pending interaction is
  active.

## 5. Design

### 5.1 Reaper exception for channel sessions

`entryIsAutoCloseCandidate` gains an internal option:

```ts
entryIsAutoCloseCandidate(entry, { allowChannelSubscribers: true });
```

The subscriber guard becomes:

```ts
if (
  entry.events.subscriberCount > 0 &&
  !(opts?.allowChannelSubscribers === true && entry.sourceType === 'channel')
) {
  return false;
}
```

Only the session reaper passes `allowChannelSubscribers: true`. The
detach-close path keeps the original guard, so a user-owned session that still
has another subscriber is not closed by a partial detach.

All other guards remain unchanged:

- `entryCanStartConditionalClose` still rejects active prompts, local work,
  restores in flight, and incomplete active-work reporting.
- `childReportsHeldWork` and the child's own conditional-close probe still
  decide whether the child holds work.
- The idle TTL still starts from `sessionLastSeenAt`, so a channel session that
  keeps receiving turns is not reaped.

When the reaper closes a channel session, the channel pump receives the
terminal event and drops its binding. The next message for that route calls
`loadOrReplaceSession`, which reloads the transcript or creates a replacement.

### 5.2 Visible recovery path

`dispatchActionError` now carries `session_limit_exceeded` as the notice code
for a workspace create failure. The Web Shell observes that notice and renders
a banner above the composer with a "Release idle sessions" button. The button
opens the existing `ReleaseSessionDialog` for the locked workspace.

The dialog releases through the current session's client when one exists, and
falls back to the workspace daemon client when it does not. That fallback is
required because the banner is most useful on the empty new-session screen,
where no session client has been created yet.

The banner is cleared when the session or workspace changes, or when the user
dismisses it. This path is a fallback for the remaining 503 cases (for example,
every slot is held by active work); it does not replace automatic reclamation.

## 6. Rejected Alternatives

| Alternative                                 | Reason not chosen                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| Raise `maxSessions`                         | Delays the failure and increases per-workspace memory.                             |
| LRU eviction at admission                   | Broader behavior change; still listed as a P1 follow-up in the idle-reaper design. |
| Channel-side idle TTL                       | Requires a new cross-package bridge close method and per-channel configuration.    |
| Always ignore SSE subscribers in the reaper | Would close user sessions with an open tab, which is not acceptable.               |

## 7. Risks and Mitigations

| Risk                                                           | Mitigation                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Channel session closes while waiting for a permission answer   | The child's hold probe refuses the close while work is held.                       |
| Follow-up message loses conversation context                   | `loadOrReplaceSession` reloads the persisted transcript, or creates a new session. |
| User-owned session is reaped by the new branch                 | The exception is gated on `sourceType === 'channel'`; control test pins it.        |
| A user opens a channel session in Web Shell and leaves it idle | The session closes and its transcript stays; reopening reloads it.                 |
| Reaper closes a channel session mid-turn                       | `entryCanStartConditionalClose` rejects active prompts before the probe.           |

## 8. Validation

- `packages/acp-bridge/src/bridge.test.ts`:
  - reaps an idle channel session while its channel subscriber is attached;
  - keeps a non-channel session with an attached subscriber past the TTL.
- `packages/web-shell/client/daemon/session/httpErrors.test.ts`: classifies
  `session_limit_exceeded` and rejects unrelated 503 bodies.
- `packages/web-shell/client/daemon/session/actions.test.ts`: a create failure
  publishes a `create_session` notice with code `session_limit_exceeded`; a
  release from the empty new-session screen uses the workspace daemon client.
- `packages/web-shell/client/components/SessionLimitBanner.test.tsx`: the
  banner exposes release and dismiss actions.
- Manual browser run on the built Web Shell against a daemon with
  `--max-sessions 1`: submit a prompt, confirm the banner, open the release
  dialog, release the idle session, and create a session successfully.

## 9. Acceptance Criteria

1. A channel session idle past `sessionIdleTimeoutMs` is closed even when its
   channel event pump is subscribed.
2. A non-channel session with a live subscriber is not closed by the reaper.
3. A create rejected by the workspace cap produces a visible release action.
4. Releasing an idle session frees a slot and the next create succeeds.
5. Existing reaper tests and web-shell type checks pass.

## 10. Follow-ups

- Implement LRU eviction at the `maxSessions` boundary so a full workspace can
  reclaim an idle session instead of returning 503 (tracked in
  `docs/design/session-idle-reaper/README.md` as P1).
- Consider a per-channel retention policy if channel session volume grows
  beyond the shared idle TTL.
