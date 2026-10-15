# Web Shell session catalog store

## Goal

Share session-list reads within one Web Shell page so overlapping surfaces do
not independently scan the same daemon catalogs. Preserve the existing REST
route ownership, public APIs, list metadata, and user-visible refresh cadence.

## Design

Each `DaemonClient` owns one Web Shell-internal `SessionCatalogStore` through a
`WeakMap`. A query is identified by its legacy or qualified route, exact
workspace cwd, and every list option that affects the wire request. Entries
cache the complete `DaemonSessionListPage`, share in-flight requests, retain the
last successful page on errors, and remain available for 30 seconds after their
last subscriber leaves.

The client-wide scheduler allows two concurrent list requests. Background
initial loads, polls, and delayed refreshes may consume only one slot, leaving
one available for explicit reloads, mutations, and user-blocking fresh reads.
Revision numbers prevent a request that began before an invalidation from
overwriting newer state. A fresh read always waits for a request that starts
after that read was requested.

Polling registrations are attached to catalog subscriptions. Identical queries
use the shortest requested interval. Background work pauses while the document
is hidden and overdue work resumes when it becomes visible. Automatic failures
retain their last page and retry no sooner than 30 seconds; explicit work
bypasses that backoff.

Mutation and session lifecycle callers invalidate by explicit workspace cwd.
Only confirmed rename and prompt-admission fields are patched locally. Creation
and turn completion also schedule one workspace-level refresh after two seconds
to cover daemon registration and persistence lag. Session ids are never treated
as globally unique across workspaces.

## Boundaries

This changes only Web Shell. It does not modify daemon routes, SDK APIs, generic
WebUI resource hooks, group/status/Git polling, cross-tab behavior, pagination
policy, or introduce push-based catalog events.
