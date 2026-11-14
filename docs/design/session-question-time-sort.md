# Session question-time sorting

[English](session-question-time-sort.md) | [简体中文](session-question-time-sort.zh-CN.md)

## Requirement

Add a visible WebShell sidebar selector for Recent activity and Last question, and expose the same optional `sortBy: updatedAt | lastUserPromptAt` contract through workspace list, batch catalog, standalone list and SDK so external products such as Data Agent can use it. Default ordering stays compatible. Assistant output must not advance question order.

## Server and cache

Sort the complete eligible candidate set before pagination. Reuse organized/metadata filtering, retain pinned-first behavior in organized views, sort unknown question times last without a creation/activity fallback, and break equal times by session id. Bind opaque cursors to the selected sort; reject cross-sort cursor reuse. Unknown sort values return 400. Advertise `session_last_user_prompt_sort`; SDK and WebShell pre-flight the capability on older daemons.

Question sorting needs the full candidate time index. Retain scalar metadata in runtime/workspace/archive scope buckets, within a global budget of 100,000 entries and 64 scopes; evict whole least-recently-used scopes rather than individual rows during full-index traversal. This prevents the old 512-row LRU from turning every large sorted read into a full rescan. Warm sorting reads the retained scalar directly; cold missing entries use the canonical reader with two concurrent reads. Existing writer notifications update the same entries; owner/topology recovery, archive/unarchive and deletion invalidate them. Catalog TTL expiry does not discard the time index. Bounded scope eviction is an explicit cold recovery condition. General catalog enumeration may still read its existing bounded metadata.

## WebShell and SDK

Place the sorting selector in the session action row, immediately left of multi-select, rather than beside the brand title. Keep both controls aligned as one action group. Expanded embedded layouts that omit New session retain a visible sort-only action row, even when the Projects header is hidden. Collapsed layouts retain the Projects-header fallback where available.

Use the existing scoped dropdown primitives and semantic styles, with English/Chinese labels and a host-scoped persisted preference. Carry sort through primary/secondary workspace, recent and standalone lists, SDK query options and catalog query keys. Live activity overlays may update status/time but must preserve question order. Reset pagination on a sort change. Preserve pinned placement, grouping, archive and current-session selection. Old daemons keep the existing view and do not silently accept an unsupported question sort.

## Acceptance

A was asked at 10:00 and continued output at 10:10; B was asked at 10:05. Activity shows A before B; Last question shows B before A. Repeat across multiple pages, equal timestamps and unknown values. Verify warm reads after assistant output and catalog TTL refresh do not rebuild transcript indexes, including a catalog larger than 512 entries. Verify successful human input updates the index and sorting, cursor scope rejection, workspace/archive isolation, SDK forwarding, preference restoration and live overlays. Run build/typecheck, focused tests and local real WebShell/daemon checks. Post before/after screenshots to PR #14654. No new HTTP endpoint or per-card requests.
