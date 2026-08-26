# Channel Named Sessions: Part 2

## Goal

Add the first safe, opt-in named-session catalog for daemon-managed Channels.
With `sessionScope: "user"` and `multiSession: true`, one sender can retain up
to eight named tasks in the same chat, select an idle task, close it without
deleting its transcript, and reopen the exact daemon session later. Catalogs
are isolated by channel instance, chat, and sender.

This part deliberately keeps one selected task at a time. Switching, creating
a selected task, or closing a task is rejected while the current task is still
running or has a pending permission request. Part 3 will remove the running
switch guard after named delivery, cancellation, and permission correlation
are complete. Part 4 will add worktree creation.

## Reviewed boundaries

### Runtime and compatibility

The mode is accepted only by daemon-managed Channel workers and only with
`sessionScope: "user"`. Standalone `qwen channel start`, configured webhooks,
non-zero channel or group `groupHistoryLimit`, and Channel loops fail closed or
remain unavailable. A daemon worker refuses to start a multi-session Channel
that already owns an enabled persisted loop, and it does not expose loop
creation commands or loop MCP tools to that Channel's sessions. Existing
behavior is unchanged when `multiSession` is absent or false.

The legacy route file remains unchanged and continues to hold the selected
session used by normal dispatch. A separate registry is stored below the
daemon's workspace- and channel-scoped state directory. The registry is the
catalog authority; the route is the compatibility pointer.

Channel memory remains chat-scoped and is neither copied per task nor used as
an ownership index.

### Ownership and names

An owner is the exact tuple `(channelName, chatId, senderId)`. Thread IDs do
not participate because `sessionScope: "user"` already routes across threads
inside one chat. Every operation starts from the authenticated inbound
envelope and never accepts an owner or daemon session ID from command text.
The compatibility route is not an ownership authority: legacy adoption checks
the route's stored target against the exact owner, and local selected-session
commands resolve through the catalog instead of a delimiter-based route key.

Names match `[A-Za-z0-9][A-Za-z0-9_-]{0,31}` and are unique
case-insensitively across both open and closed tasks for one owner. Commands
resolve only names, never session IDs. Each owner may have at most eight open
tasks; closed tasks do not consume the open-task quota.

### Registry

The version 1 registry contains an array of owner records. Each owner records
its exact identity, optional selected task name, and task records containing:

- display name and exact daemon session ID;
- working directory and `shared` isolation mode;
- open or closed state;
- creation, update, and last-selection timestamps;
- the original Channel delivery target.

Using arrays instead of attacker-controlled object keys avoids prototype-key
and delimiter-collision hazards. Owner mutations are serialized in memory and
task timestamps advance monotonically even when several selections occur in
one clock tick. Changes are committed by writing a unique same-directory
temporary file followed by an atomic rename. A malformed or unsupported
registry prevents the enabled channel from starting instead of silently
replacing the ownership catalog.

### Router primitives

Named-session operations do not call the router's ordinary lazy `resolve()`
path. That path intentionally creates a replacement when a restored legacy
route cannot load, which is incompatible with exact task selection.

The router instead exposes narrow managed-session primitives to:

1. create a live daemon session without changing the selected route;
2. load and validate one exact session without replacement;
3. bind that validated session as the selected compatibility route while
   retaining delivery metadata for other live named sessions; and
4. detach and forget a closed session without deleting daemon data.

Replacing a crashed daemon bridge marks all managed clients dormant. The
selected compatibility route is restored once by normal recovery; an inactive
task is reattached by exact ID only when it is selected later.

If exact loading fails, neither the registry selection nor the compatibility
route changes. If registry persistence fails after creating a daemon session,
the new client is detached and the task is not exposed to chat.

### Busy state

`ChannelBase` owns the Part 2 busy decision. A session is busy when it still
has an active Channel turn, a pending permission request, or the daemon bridge
reports an active prompt. The Channel turn is authoritative during
cancellation because the daemon bridge can clear its active flag before the
turn's `finally` block has completed.

The guard applies to `/session new`, `/session use`, and `/session close` when
they would leave the selected task. Existing `/clear`, `/new`, and `/reset`
remain explicit destructive resets: they replace only the selected task's
daemon session under the same task name and run the existing bounded
cancellation and cleanup path for the retired session.

## Commands in Part 2

- `/sessions` lists open tasks owned by the sender in the current chat.
- `/sessions all` also lists closed tasks.
- `/session current` reports the selected task without exposing its session ID.
- `/session new <name>` creates a shared-working-directory task and selects it.
- `/session use <name>` selects an open task or reopens a closed task by loading
  its exact persisted session.
- `/session close <name>` rejects busy tasks, detaches the live client, and
  retains the catalog record and transcript. Closing the selected task chooses
  the most recently selected remaining open task; if none remains, normal
  messages ask the user to create or reopen a task.
- `/session new <name> --worktree` is recognized but rejected with an
  actionable Part 4 message.
- `/session cancel [<name>]` is recognized but deferred to Part 3. The existing
  `/cancel` continues to cancel the selected task.

The first catalog operation or normal message adopts an existing legacy route
as `default` without loading a replacement or changing its transcript. If no
route exists, the first normal message creates and persists `default` before
dispatch.

## Failure ordering

Create and reset use: create exact daemon session, persist ownership, bind the
route. Persistence failure detaches the newly created client and preserves the
old selection.

Select and reopen use: exact-load the target, persist the new selection, bind
the route. Load failure leaves the old selection unchanged. Persistence
failure detaches a target loaded only for the failed operation.

Close validates idle state and loads any replacement selection before changing
the catalog. It then commits the closed state, changes or removes the selected
route, and detaches the closed task. A detach failure is surfaced and the task
is restored to open/selected state where possible; no transcript or worktree
is deleted.

## Verification

Focused tests cover configuration gates, owner isolation, case-insensitive
name uniqueness, the eight-open-task cap, legacy adoption, atomic persistence,
create rollback, exact-load failure, idle guards including cancel wind-down,
close/reopen, selected-task reset, restart recovery, command output without
session IDs, and unchanged legacy behavior. Daemon-worker tests verify the
runtime-only wiring. A daemon-backed E2E plan exercises two users in one group
and restart recovery; concurrent running-task switching and worktree creation
remain explicit later-part cases.
