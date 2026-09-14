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
- Separately, the Sidebar adds sessions bound to durable scheduled tasks whose
  session mode is not `per_run` to its ordinary task list. This client-side
  inclusion does not broaden the daemon filter. Scheduled-task run history
  stays in its dedicated Sidebar view.
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

REST close, delete, and archive reject `qwen-live` sessions while a client is
attached or a prompt is active, alongside the existing built-in Live call guard.
Detached idle Live sessions remain eligible for those actions.
