# Managed Session Lifecycle and Reading Exports

[English](2026-10-22-managed-session-lifecycle-ui.md) | [简体中文](2026-10-22-managed-session-lifecycle-ui.zh-CN.md)

## Problem and current state

Java already owns durable close, archive, unarchive and delete operations. Managed Web Shell does not expose them, drops Session lifecycle state in its adapter and lists archived Sessions together with ordinary history. Published public item snapshots already provide immutable, authorized pagination. The ordinary CLI exporter reads private local records and cannot be used by the Managed browser.

## Behavior and ownership

Close reliably ends a Session and retains readable history. Archive accepts closed Sessions; unarchive restores closed, read-only history. Delete retires Session resources without deleting shared Workspace files. An active Session can be closed and then archived through two sequential, separately idempotent commands. Running Turns must be stopped explicitly; existing server admission remains authoritative, including parked recovery states.

The existing Managed navigation gains ordinary/archived views and a shared row/detail action menu. Close, close-and-archive and delete require confirmation. A closed Session stays selected; archiving or deleting the selected Session opens a draft in its Workspace. Unarchive selects the restored Session in ordinary history. Other selections and drafts remain intact. Reuse scoped UI primitives, portals and localized labels.

## Contracts and recovery

WebShell list requests gain `archiveState` (`unarchived`, `archived`, `all`); omission preserves current `all` behavior. Filter in SQL before keyset pagination. New cursors bind the filter; legacy cursors remain valid only for `all`. Public list behavior stays unchanged.

WebShell lifecycle capabilities include current actor authority. A batched optional `lifecycleOperation` projection exposes the current unsettled operation identity, kind, state and failure code; settled Sessions omit it. This adds one bounded batch query per page: Session status alone cannot distinguish failed from recovery-blocked operations or recover their identity in another browser. Lifecycle requests gain trace-only `requestId`. Update canonical OpenAPI, generated browser types, route registry and contract tests together. No schema migration is needed.

The browser persists frozen per-Session intents in the provider identity scope before submission. HTTP 202 is admission, not completion. Lost responses replay the same key. Pending/running operations are polled; recovery-blocked operations wait for reconciliation. Only an explicit retry after a failed operation gets a new key. Close-and-archive retains both keys and its current stage across refresh. If archive fails after close, report the closed state and unfinished archive. Selection changes do not discard operations; identity changes abort old requests.

## Reading exports

Add read-authorized `POST /api/agent/web-shell/v1/sessions/export/query`, adapting existing immutable snapshot pages into WebShell items. Capture the Session watermark and wait up to 30 seconds for a published snapshot to cover it, then use only that snapshot's cursors. Cursor expiry, changed watermark or failed reads abort the export. Never merge different snapshots or silently omit the tail.

HTML and Markdown use the same public data: title and timestamps, user/assistant/reasoning text, public tool call inputs and result previews, and public attachments. Preserve truncation notices; full Artifacts remain separately downloadable. Use a 32 MiB budget. HTML is a static document with inline CSS, escaped content and safe embedded raster images; it runs no conversation scripts and fetches no remote resources. The embedded library resolves `react-dom/server` from its host alongside React, preserving React 18/19 renderer compatibility. Release download object URLs. Do not export private journals, credentials, recovery references or internal storage addresses.

## Validation and boundaries

Cover lifecycle state menus, permissions, multi-page filtering, response loss, refresh, explicit retry versus recovery waiting, composite interruption and isolation of other Sessions/Workspace files. Cover complete immutable export pagination, freshness, offline HTML, injection, Unicode, code, images, truncated results and budget errors. Run focused browser and Java tests, build/typecheck/bundle, Maven verify and disposable MySQL integration tests. Record actual browser/backend evidence separately from controlled transport tests.

Implement and validate lifecycle/navigation before exports within one change, so the closed-history handoff can be reviewed end to end. Keep lifecycle/recovery and snapshot/security checks separate. Provide an E2E plan and synchronized English/Chinese documentation. Reopen, import/restore, batch operations, Workspace deletion and database migration are outside this change. No open product decisions remain.
