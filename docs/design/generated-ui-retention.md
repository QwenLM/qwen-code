# Generated UI retention in Web Shell

[English](generated-ui-retention.md) | [简体中文](generated-ui-retention.zh-CN.md)

## Problem and scope

Remounting a transcript card recreates its iframe and Worker, losing applied
output, dirty inputs, dynamic controls, and guest state. Retain eligible bundled
Generated UI activations within one browser page across virtualization, history,
same-workspace navigation, New task, and main/split-view handoffs.

Ordinary MCP Apps and manually installed extensions keep their existing
lifecycle. Refresh, page closure, export, and session forks do not preserve or
transfer live activations. No interaction snapshots are persisted, and there
are no new daemon routes or protocol fields.

## Identity and ownership

Each record is keyed by daemon/credential/workspace scope, session, producer
tool-call ID, server, and resource URI. Independent calls and copied sessions
never share an activation. A separate resource key covers bootstrap HTML,
arguments/results, permissions, CSP, daemon epoch, and host capabilities.
Changing that resource releases the activation and requires explicit reopening.
Memoization avoids serializing the full bootstrap on unrelated renders.

The provider binds session clients to their original scope. The daemon's
confirmed canonical cwd remains authoritative during reconnect and detachment;
requested aliases do not create new scopes on transport failure. Actual host,
credential, or workspace changes retire the old scope. The binding guard must
never reassign an old client to a different scope.
An action-created client binds only when its scope matches the daemon's
canonical cwd. A connected render before attachment cannot bind it to a
provisional requested alias.

## Parking and authorization

The page owns a store and hidden, inert parking hosts in its document and portal
roots. A live container moves only between connected elements sharing one root,
using native `moveBefore`; moving an empty container may use `appendChild`.
Unsupported or failed populated moves release the activation instead of
claiming continuity. Cross-root handoffs cannot preserve the activation.

Only one visible transcript slot owns an activation at a time. Hiding, folding,
unmounting, or clearing the session revokes its lease synchronously. New task
parks rather than deletes. Returning requires a current owner, matching enabled
receipt, and compatible resource. Every host call checks the lease before and
after awaiting and composes its abort signal with the lease signal.

A pending message review is cancelled on hide. An already dispatched analysis
continues in its original session; navigation or reset never resends it or
claims to cancel it. Parked size notifications cannot change the restored height.

## Bounds and invalidation

At most four parked instances survive, evicting the oldest parked instance.
Each parking period lasts at most 15 minutes, checked both by timer and absolute
age. All roots share these bounds. At most 128 identities are tracked; further
cards require explicit opening without retention.

Policy events and confirmed disabled receipts release the matching scope's
instances. The SDK reports each validated current denial synchronously and
replays its latest revocation revision to late subscribers. The workspace owner
subscribes before reading context, so a later enabled receipt or React batching
cannot erase a confirmed revocation. Missing/failed receipts revoke authority
without certifying policy revocation. Authentication failure releases instances
but keeps identity records, so recovery cannot silently restart them. Deletion,
rewind, epoch changes, eviction, expiry, and changed resources likewise preserve
released records. Only actual scope retirement forgets its records.

Released eligible cards offer **Reopen interactive view**. **Reopen and reset**
also resets retained, stopped, or failed cards. Both create a fresh activation
from the saved original content and display the interaction-loss notice.

## Validation and acceptance

- New task, controlled empty-session navigation, virtualization, history, and
  successful retry after a temporary load failure preserve the actual realm,
  Worker, applied result, and dirty input when retention remains eligible.
- Canonical-cwd reconnection keeps scope and owner source stable. Actual scope
  changes and foreign scopes remain isolated.
  Creation may commit before attachment; the attached client must still have a
  canonical owner and retain its activation after the first prompt.
- Disabled load/context receipts and attached-stream/heartbeat access failures
  release runtimes. Recovery of a released card requires explicit reopening.
  Disabled then enabled receipts before one React commit must still release the
  old activation; stale or foreign receipts must not release another owner.
- Hidden main/split surfaces, including artifact fullscreen and missing-session
  states, reject tool/message RPCs while retaining eligible runtime identity.
- Reopening resets only the affected activation; siblings and independent panes
  keep their frames and dirty values. Ordinary apps close on removal.
- Unit/DOM tests pin leases, resource changes, reset, admission denial, and
  bounds. Native Chromium tests establish frame/Worker continuity and host RPC
  denial; DOM move shims alone do not establish browser continuity.

Browser support for state-preserving moves is required. Firefox/WebKit, online
model quality, and long-running memory pressure remain outside this change's
validation scope. Retained Workers remain subject to existing execution budgets.
