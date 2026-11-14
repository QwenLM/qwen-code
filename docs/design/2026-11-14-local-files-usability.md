# Local Files Usability Improvements

[English](2026-11-14-local-files-usability.md) | [简体中文](2026-11-14-local-files-usability.zh-CN.md)

> Status: implemented in this change. Builds on the
> [Client Filesystem Bridge design](2026-09-03-client-filesystem-bridge.md);
> it does not change that design's security model, tool surface, or
> degradation matrix.

## 1. Problem

The Web Shell sidebar's **Local files** entry (the client filesystem bridge)
works, but several everyday interactions are harder than they need to be:

1. **Connection state is nearly invisible.** The trigger is a 16px icon whose
   only state signal is a 1.5px dot, shown only while connected or busy. A
   `failed` bridge shows no dot at all, and the tooltip is the static label
   "Local files" regardless of state.
2. **Changing the granted directory takes two steps.** While connected, the
   panel offers only Disconnect; the user must disconnect, then connect again
   and re-pick. `connect()` also short-circuits when the stored handle is the
   same entry, so simply calling it again cannot open the picker.
3. **A grant that needs re-authorization is discovered passively.** After a
   reload, a stored handle whose permission fell back to `prompt` parks the
   bridge in `needs-gesture`. Nothing outside the popover reports this, so the
   user can believe the agent still has file access when it does not.
4. **The panel does not say which session is bound.** The bridge is strictly
   session-scoped, but the panel shows only the directory name and tool count.
   The bridge design's lifecycle section promises "connected (bound to session
   X, root Y)"; the session half is missing. The `needs-session` state likewise
   only tells the user to start a session, without offering the action.
5. **Several blocker messages explain the cause but not the fix.**
   `unsupported-daemon` asks the user to set an environment variable and
   restart; `insecure-context` suggests an SSH tunnel without giving the
   command; `workspace-ineligible` uses internal terms ("untrusted or live
   workspace") with no next step; a `failed` bridge with a stored grant still
   labels its button "Connect a directory…" instead of "Retry".

## 2. Current state (verified at the parent commit)

- `packages/web-shell/client/components/LocalFilesControl.tsx` exports the
  prop-driven, hook-free `LocalFilesPanel` and the daemon-side
  `LocalFilesControl` (popover trigger + bridge wiring).
- `packages/web-shell/client/components/ManagedLocalFilesControl.tsx` is the
  Managed-mode entry; it reuses `LocalFilesPanel` and renders its own trigger.
- `packages/web-shell/client/local-files/useLocalFilesBridge.ts` (daemon) and
  `useManagedLocalFilesBridge.ts` (Managed) own the grant lifecycle. Both
  `connect()` implementations reuse a stored handle and never re-open the
  picker while a grant exists.
- `packages/web-shell/client/components/ToastHost.tsx` provides
  `requestToast(tone, message)`, a window-event toast used across the app.
- Session title is available as `useConnection().displayName` (daemon) and
  `currentSummary.title` (Managed page). Session creation is
  `useActions().newSession()` (daemon-react-sdk).
- The panel's degradation matrix and affordances are pinned by
  `LocalFilesPanel.test.tsx`; control wiring by `LocalFilesControl.test.tsx`
  and `sidebar/WebShellSidebar.local-files-footer.test.tsx`; the Managed
  browser path by `client/e2e/managed-local-files.spec.ts`.

## 3. Goals and non-goals

Goals: make bridge state visible at a glance, shorten the change-directory and
re-authorization paths, name the bound session, and turn blocker copy into
concrete actions — without touching the bridge's security model.

Non-goals (unchanged from the bridge design):

- No takeover of a bridge held by another tab (`held-elsewhere` keeps its
  read-only explanation).
- No new tools, no delete tool, no read-only mode switch.
- No change to session scoping, trust gating, or the workspace route resolver.
- No Firefox/Safari support; the capability probe and its blockers stay.

## 4. Proposed changes

### 4.1 Trigger state visibility (both controls)

A shared helper maps `LocalFilesStatus` to a dot color and a tooltip:

| Phase                                         | Dot                         |
| --------------------------------------------- | --------------------------- |
| `connected`                                   | `bg-primary`                |
| `held-elsewhere`, `connecting`, `registering` | `bg-muted-foreground`       |
| `reconnecting`, `needs-gesture`               | `bg-[var(--warning-color)]` |
| `failed`                                      | `bg-destructive`            |
| others                                        | none                        |

`held-elsewhere` is deliberately muted rather than primary: the bridge is live
but owned by another tab, so this tab must not read the dot as "I have a
working bridge here" — this preserves the distinction the pre-change trigger
made. The warning dot uses the theme-aware `--warning-color` token (defined
per theme in `App.module.css`: `#ecc94b` dark, `#9a6a00` light), which the rest
of the app already uses for warnings; a raw palette color such as `amber-500`
would not adapt to the light theme.

The tooltip becomes `Local files — <status>` plus ` (<rootName>)` when a
directory is named, instead of the static label; a transient
`workspace-resolving` blocker reads as "Resolving…" rather than the permanent
unavailable copy. The same string is exposed to screen readers through
`aria-describedby` pointing at a visually hidden span. The `aria-label` stays
the base label so existing entry assertions and screen-reader naming are
stable.

### 4.2 Change directory while connected

- `LocalFilesPanel` gains an optional `onChangeDirectory` prop; when the phase
  is `connected` and the prop is present it renders a "Change directory…"
  button next to Disconnect. `held-elsewhere` deliberately does not offer it:
  the store record is shared across tabs, and re-picking while a peer owns the
  bridge would overwrite the peer's grant.
- Both hooks' `connect()` accept `options?: { forcePicker?: boolean }`. With
  `forcePicker`, the stored-handle reuse branch is skipped and the native
  picker opens directly, and the picked handle is saved over the old record.
  The daemon hook then rebuilds the bridge through its existing
  `startBridge(handle, { force: true })` path; the Managed hook has no
  `startBridge` — it re-runs its registration via `bridge.connect()` after the
  save. All existing generation/in-flight guards apply unchanged in both.
- Picker outcomes under `forcePicker` keep the running bridge truthful:
  - cancelled → no status write (the old bridge keeps running);
  - failed/unavailable → the pre-connect status is preserved instead of
    writing `failed`, because the old bridge is still connected and a `failed`
    write would both misreport state and strand a later retry on the
    same-entry short-circuit. The hook returns a `repick-failed` result and
    the control surfaces it as an error toast, so the click is not silent;
  - re-picking the already-bound entry (identity via `isSameEntry`, not
    basename) saves the refreshed grant but keeps the live bridge instead of
    tearing it down for a rebuild.
- If the Managed save soft-fails (quota/eviction), the change is served
  in-memory and this mount's stale record is cleared — but only while it still
  holds the previous entry (same identity guard as teardown), so a reload does
  not bind the directory the user changed away from, and a peer's different
  record is left alone.

### 4.3 Re-authorization notice

When the daemon control's status transitions into `needs-gesture` (from any
other phase, including on mount after a reload), it fires one
`requestToast('warning', …)` naming the directory and pointing at the Local
files entry. A ref dedupes per transition so re-renders do not re-toast. The
persistent affordance remains the warning-colored trigger dot plus the panel's
Reconnect button; the toast only solves the "never opened the popover" gap.
The Managed hook has no `needs-gesture` phase today, so this notice is
daemon-only.

### 4.4 Bound session and session creation

- `LocalFilesPanel` gains an optional `sessionName` prop; when connected and
  named, it renders a "Session: <name>" row beside the directory row.
- `LocalFilesPanel` gains an optional `onNewSession` prop; in `needs-session`
  it renders a "New session" button when the prop is present.
- The daemon control passes `sessionName = displayName` and
  `onNewSession = () => actions.newSession()` (via `useActions()`);
  `newSession` reports its own failures through the notice system, so the
  control attaches an empty catch only to avoid an unhandled rejection. The
  Managed control passes `sessionName = currentSummary.title` (omitted when
  the title is just the session id) and no `onNewSession` — Managed session
  creation belongs to the page, not this control.

### 4.5 Actionable blockers

- `unsupported-daemon`: a "Copy startup command" button copies
  `QWEN_SERVE_CLIENT_MCP_OVER_WS=1 qwen serve`.
- `insecure-context`: when the control can derive an absolute daemon URL, a
  "Copy SSH tunnel command" button copies
  `ssh -L <localPort>:localhost:<remotePort> <hostname>` — the remote port
  comes from the URL (defaulting by protocol), and a privileged remote port
  (<1024) maps to `remotePort + 8000` locally so the tunnel does not need a
  privileged local bind. The explanatory copy now points at the
  `http://localhost` address inside the copied command.
- `workspace-ineligible`: copy rewritten to state the next step — use a
  session in a trusted, regular workspace — instead of only naming the
  internal condition.
- `failed` with a named grant: the connect button is labeled "Retry"; without
  a grant it stays "Connect a directory…". Both call the same `onConnect`.

Copy buttons are prop-driven: the panel receives `onCopyCommand(command)` and
an optional `tunnelCommand`, and stays hook-free. The control copies through
the shared `writeClipboardText` helper (async Clipboard API with an
`execCommand('copy')` fallback for non-secure contexts) and reports
success/failure via `requestToast`. The daemon startup command is a module
constant; the Managed control passes no copy affordances (its blockers are
browser-level and its base URL is a relative API path).

## 5. Design decisions and rationale

- **Panel stays prop-driven and hook-free.** Every new affordance is an
  optional prop, so the existing degradation-matrix tests keep their shape and
  the new affordances are testable without a daemon provider.
- **`forcePicker` is an opt-in argument, not a new method.** It reuses the
  entire existing picker/save/rebuild path and its race guards. The default
  (no argument) flow is unchanged except for one shared fix: a transient
  `workspace-resolving` blip no longer withholds a live, correctly-routed
  bridge at the connect entry guard (mirroring the rebind effect's existing
  exemption), so both plain connect and Change directory survive the blip.
- **Toast instead of a chat-area banner for `needs-gesture`.** A banner would
  require lifting the bridge state out of the always-mounted sidebar control
  into the session view, changing the hook's mount/restore lifetime. The
  existing toast mechanism delivers the active notice with zero new plumbing;
  the warning-colored dot keeps the state discoverable after the toast
  dismisses.
- **No change-directory under `held-elsewhere`.** The IndexedDB record is
  shared per origin; re-picking from a non-owner tab would silently replace
  the owner's grant.
- **`aria-label` unchanged.** State lives in the tooltip and the panel; the
  entry's accessible name stays stable for existing consumers and tests.

## 6. Files affected

- `packages/web-shell/client/components/LocalFilesControl.tsx` — panel props,
  trigger helper, daemon wiring (toast, copy, session, change-directory).
- `packages/web-shell/client/components/ManagedLocalFilesControl.tsx` —
  trigger helper, session name, change-directory wiring.
- `packages/web-shell/client/local-files/useLocalFilesBridge.ts` —
  `connect({ forcePicker })`.
- `packages/web-shell/client/local-files/useManagedLocalFilesBridge.ts` —
  `connect({ forcePicker })`.
- `packages/web-shell/client/components/managed/ManagedSessionsPage.tsx` —
  pass the session title into the Managed control, suppressed when the title
  is just the session id.
- `packages/web-shell/client/i18n.tsx` — new EN/ZH keys (both locales).
- Tests: `LocalFilesPanel.test.tsx`, `LocalFilesControl.test.tsx`,
  `ManagedLocalFilesControl.test.tsx`, `ManagedSessionsPage.test.tsx`,
  `i18n.test.ts`, hook tests, `client/e2e/managed-local-files.spec.ts`, and
  `client/e2e/web-shell.local-files-toast.spec.ts`.

## 7. Constraints and risks

- The bridge hooks are race-sensitive (generation counters, in-flight latch,
  revoke arbitration). `forcePicker` only skips the stored-handle reuse; it
  must not bypass any guard. Hook tests pin cancel/failure behavior with a
  running bridge.
- New i18n keys must land in both EN and ZH; the panel's Chinese-render matrix
  is extended to cover every new string.
- The toast fires from an always-mounted control; the dedupe ref must prevent
  re-firing on unrelated re-renders.
- Copy relies on `writeClipboardText`: in a non-secure context the async
  Clipboard API is absent and the `execCommand('copy')` fallback runs inside
  the click's user activation. If a secure-context permission prompt consumes
  that activation before rejecting, the fallback can still fail; the control
  then reports the failure via toast instead of claiming success.

## 8. Validation plan

- Unit: extended `LocalFilesPanel.test.tsx` (new affordances per phase, both
  locales), control wiring tests (toast dedupe, copy commands, session name,
  change-directory), and hook tests for `forcePicker` (re-pick, cancel keeps
  bridge, failure preserves status).
- `npm run build && npm run typecheck` plus the focused vitest suites from
  `packages/web-shell`.
- E2E: extend `managed-local-files.spec.ts` to assert the connected-state
  change-directory affordance and session name in a real browser, and add
  `web-shell.local-files-toast.spec.ts`, which restores a persisted grant with
  `prompt` permission (intercepted at IndexedDB) and asserts the one-time
  warning toast reaches the real toast host without opening the popover. The
  non-secure-context clipboard fallback is additionally exercised live over a
  non-loopback origin (`execCommand('copy')` with the derived tunnel command).
  The CLI-level dry-run used for command features does not apply to browser-only
  UI; the baseline is the existing unit + E2E suites.

## 9. Acceptance criteria

- A failed bridge shows a red dot; a grant needing re-authorization shows a
  warning-colored dot and a one-time warning toast; tooltips name the state
  and directory.
- A connected panel offers Change directory… which opens the picker directly
  and rebuilds the bridge on a new grant; cancelling leaves the old bridge
  running.
- A connected panel names the bound session; `needs-session` offers New
  session (daemon).
- `unsupported-daemon` and `insecure-context` offer one-click copy of the
  concrete command; `workspace-ineligible` states the next step; a failed
  bridge with a grant offers Retry.
- All existing degradation-matrix, wiring, footer, and Managed E2E assertions
  still pass; no security-model change.

## 10. Open questions

- Whether the Managed hook should grow a `needs-gesture` phase (its restore
  currently drops a `prompt` grant silently). Out of scope here; the notice
  is daemon-only until that gap is addressed.
