# Batch workspace session catalog

[English](daemon-batch-session-catalog.md) | [简体中文](daemon-batch-session-catalog.zh-CN.md)

Status: implemented alongside this document for [#12249](https://github.com/QwenLM/qwen-code/issues/12249).

## Problem and scope

Clients showing several workspaces currently refresh each session page and group
catalog separately. Add one read-only daemon request and one TypeScript SDK
method. Preserve the single-workspace endpoints, their defaults, execution,
registration, and live-state delivery. Web Shell migration and a globally sorted
feed are outside this change.

## Ownership and failure semantics

Each member has **persisted-workspace** ownership under the existing
[hardening baseline](daemon-multi-workspace-hardening.md). The batch is an ordered
collection of independently resolved members; it does not add an ownership class.
Authentication and HTTP admission remain process-global. Each member uses only
its resolved runtime's bridge, runtime storage directory, and organization
service; no member falls back to primary. No environment overlay or workspace
service is executed by catalog browsing.

`all` enumerates public registered entries, including temporarily unavailable
entries, but excludes internal Conversations and removed workspaces. Explicit
selectors resolve workspace IDs before canonical absolute paths, using the
existing registered-workspace resolver. Internal selectors are rejected as
unknown. This intentionally avoids the resolver that can boot Conversations.

| Member state                                           | Result                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Unknown, internal, or removed                          | `404 workspace_not_found`                                                           |
| Draining, transitioning, blocked, or closed generation | `503 workspace_runtime_unavailable`                                                 |
| Untrusted primary                                      | `403 untrusted_workspace`                                                           |
| Untrusted secondary                                    | Persisted reads only, without live merging, repair writes, or debug-session logging |
| Invalid cursor/group                                   | Existing catalog error code and status                                              |
| Read failure                                           | `500 session_catalog_failed`                                                        |
| Oversized serialized member                            | `413 catalog_response_too_large`                                                    |

Check the selected runtime generation again after reads. A changed/removed
generation cannot produce a successful page. Ordinary trusted runtimes may merge
already-present bridge state through the existing list helper; enumeration never
creates sessions or starts ACP children. Daemon bootstrap and shutdown behavior
remain unchanged; draining or transitioning workspace generations return the
errors above.

## API and SDK

Advertise `session_catalog_batch`. `POST /sessions/catalog` accepts:

- `workspaces`: `"all"` or an ordered array of `{ workspace, cursor? }` selectors.
- `options`: shared `size`, `archiveState`, `view`, `group`, `parentSessionId`,
  `sourceType`, and `sourceId`, preserving existing catalog combinations.
- `includeGroups`: optional boolean, default false.

Return `{ workspaces: [...] }` in selection order. Successful members contain
`workspace` (original selector), canonical `cwd`, `workspaceId`, `sessions`, and
the existing optional `nextCursor`, `truncated`, and `liveMergeFailed` fields.
Each session's `workspaceCwd` is normalized to this canonical owner as well.
When requested, `groups` is the complete existing group catalog, including color
options. Organized pages and their requested group catalog use one organization
snapshot. Group IDs are scoped by the enclosing workspace. Error members contain
`workspace`, resolved identity when available, and
`error: { code, message, status }`; they never contain a successful empty page.
Valid batches return HTTP 200 even with failed members. Malformed envelopes fail
before storage reads with HTTP 400.

Storage normalization remains the existing single-workspace behavior: malformed
organization stores log a warning and yield an empty group catalog without repair
writes. The batch isolates thrown read errors; it does not add storage-integrity
validation or change that recovery policy.

Continue pagination by sending explicit members with each returned `cwd` and
`nextCursor`. Cursors remain opaque and retain the existing filter semantics;
clients must reuse the same filters. The batch default uses the existing merged
activity paginator with an empty metadata filter, so live-only rows also respect
the page size. Its cursors are not interchangeable with legacy numeric cursors.
SDK `listSessionsCatalog` exposes the same
shape, mapping its existing `pageSize` convention to wire `size`. Clients discover
the capability once and use workspace-qualified APIs for older daemons; catalog
refresh itself performs one HTTP request. An optional second SDK argument accepts
`signal` and `timeoutMs`; these transport options are not sent in the JSON body.

## Bounds and implementation

Accept 1–20 members, 1–100 sessions per member (default 20), at most four concurrent
member reads, selectors up to 4096 characters, and cursors up to 16384 characters.
Group and parent-session filters are limited to 256 characters. The read-only POST
uses the existing read rate-limit tier and records request telemetry without
attributing the whole batch to primary. Each member read has its own child span
with the selected workspace hash, preserving per-member scan/cache attributes.
The request span records member count and whether any returned page is truncated.
An `all` selection exceeding 20 fails explicitly; callers can split an explicit
selection. Never silently truncate selected workspaces. Each serialized successful
member is limited to 512 KiB, bounding a response to approximately 10 MiB plus
small envelope/error overhead. Oversized members fail explicitly so callers can
reduce the page size or omit groups. Request bodies retain the existing daemon
JSON parser limit. Client disconnect aborts pending session reads and prevents
new members from starting. Existing persisted scan/cache bounds remain in force.

Add a dedicated route module, reuse the existing session-list and organization
services, and extract only the pure workspace selector resolution from its HTTP
wrapper. Wire the route into the daemon and add the capability, SDK exports,
protocol/reference documentation, and focused tests. No core storage redesign or
client polling changes are required.

## Validation and acceptance

With primary and two secondary workspaces, one request returns independently
owned pages and optional group catalogs. Test subset isolation, source/archive/
organization filters, pagination, missing and removed entries, generation changes,
trust behavior, internal exclusion, malformed requests, concurrency, size limits,
and disconnect cancellation. Verify that existing qualified-route resolution
still passes its tests. SDK tests cover serialization, response/error preservation,
and a single HTTP request. Run build, typecheck, focused tests, and a global-CLI
baseline followed by local-bundle E2E verification. Review the complete diff and
keep this document and its Chinese translation synchronized.

## Open questions

Maintainers should review the public API, limits, and internal-workspace
exclusion in this PR. These are explicit implementation choices for the
requested no-ACP catalog contract; changing internal visibility later requires a
separate boot-free persisted-read policy.
