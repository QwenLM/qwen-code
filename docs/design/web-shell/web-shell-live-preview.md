# Web Shell live development preview

## Problem and current behavior

The right panel renders HTML file contents in a sandboxed `srcDoc`, but cannot
open a running development server. Users must leave the conversation to inspect
an application, and the shipped shell's frame policy blocks other ports.

This first increment adds direct, browser-reachable development URLs to the
existing panel. It provides an address field, refresh, responsive width controls,
and external opening. The server continues to run through the existing terminal
or shell tool.

Preview history belongs to the conversation, independently of the viewing
panel. Opening a recorded HTTP/HTTPS webpage artifact from a turn opens its URL
in the preview when the feature is enabled. Closing the panel or its tab does
not remove the artifact card; users can reopen it from the original message.
Use the existing `record_artifact` tool to associate an output with its turn.
Manually entering an address in the panel does not create a transcript record.

These are historical entry points to a live URL, not frozen website versions.
The preview explicitly labels this distinction. Reusing a development URL
shows the current application even when opened from an older turn. Existing
artifact metadata also updates by identity, so it is not a version archive.
Replaying a previous website requires an immutable copy of that turn's HTML
and dependent assets, or an independently versioned deployment. That storage
is implemented for self-contained Artifact deliveries in
`web-shell-preview-snapshots.md`; panel localStorage is only viewing state.

## Design

| Layer      | Change                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel      | Add a `web_preview` tab and a `webPreview` action alongside review and terminal actions. Enable it in the standalone shell; embedded consumers opt in through `rightPanel.items`.  |
| Preview    | Add an internal `WebPreviewPanel` using shared input and button primitives. Desktop fills the panel; mobile uses a 390 CSS pixel viewport.                                         |
| State      | Store the entry URL and viewport with the tab in the existing workspace/session-keyed panel state. Keep inactive preview frames mounted while the panel stays open.                |
| Navigation | The address is the requested entry URL. Without a page bridge, navigation within a cross-origin application cannot update this field. Refresh returns to the entry URL.            |
| Server     | Permit HTTP/HTTPS frames in the shell document policy while preserving the other CSP directives, frame-ancestor policy, and permissions policy. No new daemon route is introduced. |

The panel accepts absolute HTTP/HTTPS URLs without embedded credentials. It
rejects the shell and configured daemon origins. IPv6 literal URLs are excluded
from this increment because CSP host sources do not reliably support them; use
a hostname instead. URLs are validated again when rendering persisted state.
No daemon credentials are forwarded and preview requests omit the referrer.

A trusted, script-free `srcDoc` wrapper contains the application iframe. Its own
CSP pins `frame-src` to the validated development origin, blocking application
direct child redirects and navigations into the shell or a different origin.
Validation also rejects HTTP sources whose CSP-permitted HTTPS upgrade reaches
a protected origin. The inner frame
allows scripts, forms, and its own origin so ordinary modules and web storage
work, but cannot navigate ancestors or open popups. All interpolated markup is
escaped. Browser tests must verify both redirect and script-navigation blocking
before this design is accepted. The wrapper is not a recursive origin firewall:
the application's own descendant frames have their own policies. Shell HTML
must retain its existing `frame-ancestors` protection and file endpoints must
retain attachment/nosniff protection. Embedded consumers must prevent their own
app documents from being framed by preview origins. Vite development serves a
`frame-ancestors 'self'` policy for the same boundary.
Offline HTML artifact previews use their own trusted parent with
`frame-src 'none'` and an opaque content iframe. This parent restriction blocks
self-navigation from offline content even when the shell permits live URLs.

An iframe load event is not evidence of a successful response. The UI provides
an external-open fallback and a short explanation for blocked/unreachable pages,
without claiming that the development server is healthy. Applications with
frame restrictions may require external opening. Embedded Web Shell consumers
must also allow the desired HTTP/HTTPS frame origins in their own CSP.

The existing panel persistence key owns previews, including in multi-workspace
and session-switch flows. Existing turn-output callbacks route recorded webpage
requests into the viewing panel, with tab IDs distinguishing source sessions
and turns. No new filesystem request or annotation feedback route is added.
Closing a preview removes its iframe and does not terminate the user's server.
Closing/reopening the entire panel or changing sessions recreates browser state
from the saved entry URL; switching tabs within the open panel preserves it.

## Files affected

- `packages/web-shell/client/components/preview/WebPreviewPanel.tsx` and
  its URL/document helper and focused tests.
- `packages/web-shell/client/components/artifacts/ArtifactPanel.tsx` and tests.
- `packages/web-shell/client/App.tsx` and tests for creation and persistence.
- `packages/web-shell/client/customization.tsx`, `main.tsx`, and `i18n.tsx`.
- `packages/web-shell/README.md` and a focused browser E2E spec.
- `packages/cli/src/serve/web-shell-static.ts` and its policy tests. This is a
  process-global shell-document policy change; all static and deep-link shell
  consumers use the same policy builder. Workspace runtime routing is unchanged.

## Follow-up increments

Element/region annotations need a controlled page bridge and correct routing to
the owning session's composer. Browser verification needs a shared page binding
to CUA/CDP. Remote development needs a separate-origin authenticated proxy with
HTTP and HMR WebSocket forwarding. None is implied by opening an entry URL in
this increment: the user's browser must already be able to reach it, through a
direct connection or an existing tunnel.

## Validation and open questions

Use the global `qwen` binary for the baseline, then the locally built bundle
for production CSP verification. Exercise a real development server, modules,
storage, WebSocket updates, viewport size, tab switches, refresh, external
opening, persistence, and invalid origins. Verify the trusted-wrapper policy
against hostile redirects and scripts. The detailed plan and observed results
live in `.qwen/e2e-tests/web-shell-live-preview.md`.

The pre-implementation browser spike passed modules, storage, Vite HMR and direct
redirect/script-navigation blocking on Chromium and Firefox. A descendant-frame
probe confirmed the host-policy requirement described above. WebKit was not
validated because the installed browser/runtime versions did not match.
