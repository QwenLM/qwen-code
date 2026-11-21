# Channel Events Session Link

[English](2026-11-05-channel-events-session-link.md) | [简体中文](2026-11-05-channel-events-session-link.zh-CN.md)

Status: implemented (2026-11-05)

## Problem

The Web Shell Channel events page shows what a Channel did (inbound,
outbound, task, poll), but a row that refers to a concrete session offers no
way to open that session. Operators investigating a bound-session delivery
(PR events injected into a PR-bound session, #16117) or a published reply
must copy the session id and find the session manually.

## Current state

- The journal record (`ChannelEventRecord` in
  `packages/channels/base/src/channel-events.ts`) and the SDK shape
  (`DaemonChannelEvent` in `packages/sdk-typescript/src/daemon/types.ts`)
  already carry an optional `sessionId`, and the daemon route
  `GET .../channels/events` passes records through unchanged.
- GitHub outbound (publication audit) rows already record the `sessionId`
  of the Channel's own reply session.
- GitHub task rows do NOT record a session, even when the task delivers
  into a PR-bound session (`task.delivery.sessionId` is known at every
  transition).
- The page renders GitHub web links only; no session navigation exists.
- The app shell already has a session navigation path: the
  `qwen:open-session` window event with `{ sessionId, workspaceCwd? }`
  detail, used by markdown `qwen-session://` links and turn notifications.

## Goals

- Every journal row that names a session offers a one-click jump to it.
- Bound-session delivery task rows name the target session, including its
  owner workspace, so cross-workspace targets open correctly.

## Non-goals

- No change to delivery, dedupe, or recovery semantics.
- No session links for rows without a session identity (inbound skips,
  polls, public-path tasks before a reply session exists).
- No new daemon route; the journal remains the only data source.

## Solution

1. Journal: add an optional `sessionWorkspaceCwd` field to
   `ChannelEventRecord` (normalized like other text fields, capped at 1024
   characters) and to the SDK `DaemonChannelEvent`.
2. GitHub adapter:
   - `claimInboundTask` (accepted) and `transitionInboundTask` (every later
     state) attach `sessionId` and, when the binding snapshot knows it,
     `sessionWorkspaceCwd` for bound-session deliveries, via one shared
     `boundJournalIdentity` helper. The identity is read from the UPDATED
     task record so retargets and gone-fallbacks journal the session the
     transition actually refers to.
   - `recordPublicationAudit` stamps `sessionWorkspaceCwd` with the
     Channel's own workspace (`config.cwd`), which owns the reply session.
3. Web Shell `ChannelEventsPage`: rows with `sessionId` render an icon
   button ("Open session" / "打开会话") that dispatches `qwen:open-session`
   with `{ sessionId, workspaceCwd: event.sessionWorkspaceCwd ??
selectedWorkspaceCwd }`. The app shell closes the panel and loads the
   session through the existing navigation path.

## Design decisions

- Workspace attribution rides on the record instead of a client-side
  lookup: bound delivery is explicitly cross-workspace, and the daemon's
  session load route resolves to the primary workspace when no workspace
  is given, so a link without the owner would fail for secondary-workspace
  targets. The binding snapshot (`PrBindingSummary.workspaceCwd`) is
  already in the worker's memory at journal time; no extra I/O.
- Fallback for records without `sessionWorkspaceCwd` (older journals) is
  the journal's own workspace: correct for the Channel's reply session,
  the only session kind older records name.
- A frozen delivery can outlive its binding (restored task, gone session);
  such rows keep `sessionId` without a workspace rather than guessing.
- The jump reuses `qwen:open-session` instead of a URL: it is the same
  in-app path as markdown session links and needs no router changes. The
  handler's locked-workspace guard applies to browser-notification clicks
  (dispatched on a dedicated EventTarget), not to window-dispatched
  in-page links, so in a locked-workspace shell the button behaves exactly
  like an existing markdown session link.

## Constraints and risks

- Additive optional fields only; older daemons/clients interoperate
  unchanged. Journal normalization drops invalid values.
- The workspace lookup is best-effort decoration; a miss degrades to the
  fallback workspace, never breaks delivery.
- In locked-workspace shells the jump is not separately restricted: it
  shares the window-event path of markdown session links, whose dispatches
  bypass the notification-only locked-workspace guard.

## Validation

- Unit: `channel-events.test.ts` (round-trip and normalization of the new
  field), `GithubAdapter.test.ts` (bound task rows carry the binding's
  session and workspace; public-path task rows carry neither),
  `ChannelEventsPage.test.tsx` (button renders only with a session; click
  dispatches the navigation event with the record's workspace, falling
  back to the selected workspace).
- Build and typecheck: `npm run build && npm run typecheck`.

## Acceptance criteria

- A bound-session delivery produces task rows whose "Open session" button
  opens the target session, including when it lives in another workspace.
- An outbound row's button opens the Channel's reply session.
- Rows without a session render no button; existing GitHub links and the
  visuals fixture are unchanged.
