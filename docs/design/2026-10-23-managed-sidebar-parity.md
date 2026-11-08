# Align the Managed sidebar with daemon navigation

[English](2026-10-23-managed-sidebar-parity.md) | [简体中文](2026-10-23-managed-sidebar-parity.zh-CN.md)

## Goal

Align Managed home navigation with the existing daemon sidebar: reuse its search presentation, plain New task label, workspace headings, active-session rows and hover details. Restore the screenshot's single bottom Archived fold in the combined Web Shell. The Managed home view must not expose a separate Sessions / Archived switch.

## Implementation

Reuse the existing sidebar archive header, expansion state, styling and Local history. App supplies a second portal target inside that archive section. The Managed page renders its archived history into this target using a separate list request with `archiveState: 'archived'`; the active list continues requesting unarchived history. The target mounts on the first expansion, so no Managed archive request runs before the user opens it.

A small archived list component owns pagination, cancellation and request errors. It reports its loaded count and loading/error status through App so the shared archive count and empty state include both sources. Existing Managed lifecycle actions remain owned by the Managed page and receive the archived summaries for recovery and permission checks. Changing the existing list revision refreshes the archived list as well. The standalone Managed page keeps its existing history switch.

### Workspace and active-session appearance

Managed workspace headers use the daemon's existing header styles without a service badge. Their create action appears on hover or keyboard focus and remains visible on touch devices. Remove the extra Managed navigation padding so adjacent Managed and Local workspace headings align.

Bound and unbound Managed home sessions share a full-width row that reuses the daemon's title, active marker, running indicators, right-aligned action slot and details popover. The sidebar action trigger uses vertical dots while other Managed views retain their existing controls. Preserve action permissions and prevent action-button events from selecting the session. The details card shows title, updated time, available workspace label/relative directory, actual Managed lifecycle/phase and copyable session ID. A status-label override on the shared popover avoids inventing daemon client counts. No pin control or backend capability is added, and the bottom archive fold remains unchanged by this follow-up.

## Constraints

Do not change daemon routes, server contracts, Local archive mutation behavior or shared CSS. Requests must be cancelled when their view or provider is replaced. Managed query failures stay visible and retryable, without falling back to daemon history. Loading another archive page must not replace active rows or duplicate an archived row.

## Validation and acceptance

Verify one collapsed bottom Archived entry in English and Chinese, with no top history switch. Before expansion, the browser must make no Managed archived-history request. After expansion, both active and archived rows remain accessible; collapse hides archived content. Check pagination, archive query failure and retry, selection and unarchive refresh. Confirm Local archive history, search filtering and New task still work. Run focused component tests, build/type checks, formatting and diff review; use generated production UI with mocked APIs for browser evidence. Real service/model execution is outside this presentation change.

Compare Managed and daemon row width, alignment and hover actions in the same sidebar. Verify hover details, ID copying, keyboard selection, action-menu isolation, long titles, running-state updates, and touch access. Confirm the standalone Managed view and existing archive behavior retain their prior controls.

## Visual evidence

The screenshots use the production frontend with mocked daemon and Managed responses. Before: the Managed badge and create button remain visible, actions follow the short title and hovering shows no details. After: the full-width row and right-aligned vertical action reveal match the daemon, with the shared details card showing available Managed metadata.

| Before                                                                 | After                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| ![Managed sidebar before alignment](assets/managed-sidebar-before.png) | ![Managed sidebar after alignment](assets/managed-sidebar-after.png) |
