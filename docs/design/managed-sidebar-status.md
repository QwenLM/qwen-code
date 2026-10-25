# Managed sidebar running status

[English](managed-sidebar-status.md) | [简体中文](managed-sidebar-status.zh-CN.md)

## Problem and scope

Managed workspace rows display only titles, although the conversation already knows its running phase. Their catalog snapshot also loses a newer selected summary when navigating away and never receives background completion. Reuse the daemon sidebar's green pulsing dot and right spinner without changing Java APIs, execution, permissions or user Sessions.

## Behavior

One shared phase predicate treats admitted, runtime starting/waiting, agent/tool execution and cancellation in progress as running. Created, completed, failed and cancelled are idle for this indicator. Java already projects recovery-blocked Turns as failed. Waiting permission Actions retain their existing active Turn phase; this change introduces no new approval status or badge. The row keeps its phase tooltip, keyboard navigation and current-selection marker.

Retain the selected detail summary in the navigation rows so switching to another conversation or Local preserves its last confirmed phase. Catalog and pagination merges preserve newer confirmed summaries, including on equal timestamps, even after selection changes; known rows outside a late first page remain reachable. Reapply the current detail summary with an identity guard to avoid redundant state updates. Existing selected-session polling remains authoritative for the selected row.

Every three seconds, read only known running background Sessions through the existing provider and merge successful same-ID, non-older summaries into the loaded rows. Poll rounds do not overlap. Stable sorted IDs prevent a selected-session poll from continually resetting the background timer. Terminal rows stop polling. Abort on scope, selection or active-ID changes and on unmount; ignore late responses and retain last confirmed state on read failure. Do not reset catalog pagination, reload workspaces or subscribe every Session's transcript. Idle Sessions newly started by another client still enter through the existing catalog refresh/discovery paths.

## Verification and local update

Independent temporary tests reproduce missing indicators against a real daemon positive control and reproduce selection rollback and missing background completion in the actual page. Regression tests cover every phase, switching, delayed reads, terminal completion/failure/cancellation, pagination and stopped background reads. Run root build/typecheck, affected tests, lint and format. Verify the built distribution with isolated controlled model execution and the actual browser: observe the same dot/spinner while running, switch away, then see them disappear after completion. Publish only frontend assets to the existing preview, retaining old hashed assets and atomically replacing the HTML entry, so an active user Turn and its service cohort continue uninterrupted.

Controlled integration-preview captures show the same background row [while running](assets/managed-sidebar-background-running.png) and [after completion](assets/managed-sidebar-background-completed.png). These captures predate the separate composer-hint removal and document only the sidebar behavior; they are not fresh native qualification of the standalone main-targeted PR.
