# Web Shell session source filtering

[English](web-shell-session-source-filter.md) | [简体中文](web-shell-session-source-filter.zh-CN.md)

## Problem

Web Shell sessions are currently created without source metadata, and every
session-list request is unfiltered. This lets sessions created by other
features, such as scheduled tasks, appear in Web Shell. Existing Web Shell
sessions also have no source metadata, so an exact source filter would hide
historical data.

## Design

- Create every new Web Shell session with `sourceType: 'default'`.
- Use `sourceType: 'default'` for the Sidebar Tasks catalog, Session Overview,
  Split View picker, and workspace total, running, and attention counts.
- The public daemon `sourceType=default` filter includes `sourceType: 'default'`,
  sessions without `sourceType`, and `qwen-live` sessions. Other source filters
  remain exact matches. An explicit `sourceId` further restricts the selected
  catalog by exact identifier.
- The Sidebar groups scheduled-task run sessions (`sourceType: 'default'` and
  a `scheduled_task_run:` sourceId) into dedicated sections. Bound controller
  sessions use `sourceType: 'scheduled_task'` and stay outside the default catalog.
- Support the source filter with organized session views so filtering does not
  disable grouping, pinning, or archived-session behavior.
- Bind organized pagination cursors to the source filter that produced them.

## Compatibility

Older sessions remain visible because missing source metadata is included in
the `default` filter. The broader catalog applies consistently to the Sidebar
Tasks view, Session Overview, Split View picker, and workspace counts, including
attention counts for `qwen-live` sessions. Persisted source metadata, scheduled-task
eligibility, the exact `channel` filter, and the internal Conversations filter
remain unchanged. Callers that omit `sourceType` retain the unfiltered behavior.

Web Shell hides delete and archive actions for `qwen-live` sidebar rows and
excludes them from the permanent-deletion picker. Session Overview disables
single and batch delete/archive for these tasks. Users can still open these
tasks and explicitly release their runtime through the Release dialog.
This is a UI policy, not an authorization boundary: client-declared source
metadata does not grant daemon mutation protection. Explicit REST and ACP
close, delete, and archive keep their existing behavior, including protection
for sessions owned by an active built-in Live call. External clients remain
responsible for their task lifecycle; those API calls can terminate their work.
