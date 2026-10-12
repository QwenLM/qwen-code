# Web Shell context usage open callback

[English](web-shell-context-usage-callback.md) | [简体中文](web-shell-context-usage-callback.zh-CN.md)

## Problem and scope

The composer context usage hover action opens Web Shell’s right panel. Embedded
hosts need to open their own detail surface. Main and split sessions already
share one context detail opener, also used by built-in and custom headers.

## Design

Add `onContextUsageOpen?: (sessionId: string) => void` to `WebShellProps`.
When supplied, the shared opener invokes it with the originating session ID and
returns before creating or selecting a built-in panel tab. Without the callback,
existing behavior is preserved. Both `WebShell` and `WebShellWithProviders`
expose the prop through their existing public types.

The callback applies to composer details and header detail entries, including
split panes. It does not intercept the ring’s `/context` snapshot action,
compression, or restoration of already persisted panel tabs. It is an override,
not a notification; no return-value protocol or extra UI is needed.

## Files and validation

Update `client/App.tsx`, its existing tests, and the package README. Test callback
invocation and session ownership for main and split composers, absence of panel
creation or automatic detail reads, callback replacement/removal, and unchanged
default opening. Existing popover tests cover the hover action wiring. Run build,
typecheck, focused tests and a browser smoke check with the mock daemon.

## Acceptance and risks

Hosts receive the selected session ID once per detail action and can choose any
presentation. Omitted callbacks retain the current right panel behavior. The
shared opener also redirects header actions; this is intentional and documented.
No daemon routes or data contracts change. No open questions remain.

## Snapshot collapse

Transcript cards start expanded. An icon button immediately after Snapshot
collapses all content below the title row; expanding restores the current card.
Use the shared Button, existing translated expand/collapse labels and Lucide
chevrons. Keep the body mounted but hidden so nested detail expansion is retained.
The control exposes `aria-expanded` and works with Enter and Space. State is local
to each mounted card; no persistence or host option is added. Compact right-panel
content has no snapshot header or collapse control and remains visible.

Verify default expansion, collapse to only the header, keyboard reopening, no
context request on toggle, and unchanged compact rendering. Extend the existing
browser context-compression scenario and inspect expanded/collapsed screenshots.
