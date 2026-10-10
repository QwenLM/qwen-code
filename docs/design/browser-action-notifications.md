# Browser notifications for user actions

[English](browser-action-notifications.md) | [简体中文](browser-action-notifications.zh-CN.md)

## Problem and scope

Browser task notifications currently cover turn completion and failure. A chat
waiting for tool approval or an AskUserQuestion answer can remain blocked while
the user is away without notifying them. Add both waiting states to the existing
notification setting for the current chat and mounted split-view chats.

## Design

Both interactions arrive as `permission_request` events. Reuse
`extractPendingPermission` and `isAskUserPermission` on the matching unresolved
transcript block so notification classification matches the interactive UI.
Flush buffered transcript events before observing a live permission request so
its block is available. No daemon, SDK, approval policy, or route changes are
needed; requests and click targets retain their existing session/workspace scope.

The shared notification observer handles these requests before terminal-event
prompt validation because permission requests need a `requestId`, not a
`data.promptId`. Use a key containing scope, the `permission` discriminator, and
request ID. Repeated requests and duplicate panes notify once, independently of
the turn's completion key. Foreground and disabled requests are consumed without
later backfill, matching existing terminal notification behavior. Snapshot replay
is silent, including requests already resolved in history; this change does not
add catch-up notifications for permission requests missed while disconnected.

Reuse browser permission checks, preference persistence, Web Locks/shared claims,
branding, localization, and click navigation. The title contains the session name;
the body only says approval or an answer is needed. Do not copy commands, paths,
question text, choices, or partial assistant responses into these notifications.
Clicking focuses the window and opens the captured session without answering or
approving anything. Notifications require an open, mounted chat and browser/OS
permission, as before; this is not a background push service.

## Affected files

- `packages/web-shell/client/daemon/session/turn-notification-context.ts` and its
  tests: classify and deduplicate live action requests.
- `packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx`: flush the
  permission projection before observation.
- `packages/web-shell/client/adapters/transcriptAdapter.ts`,
  `packages/web-shell/client/utils/askUserPermission.ts`, and
  `packages/web-shell/client/components/messages/toolFormatting.ts`: use explicit
  `.js` import paths so the reused helpers also pass NodeNext integration checks.
- `packages/web-shell/client/browser-turn-notifications.tsx` and its tests: share
  one-shot authorization and exercise browser delivery and navigation.
- `packages/web-shell/client/components/messages/BrowserNotificationControl.tsx`,
  `ToolApproval.tsx`, and `AskUserQuestion.tsx`: expose notification status,
  authorization, and system guidance in both action panels.
- `packages/web-shell/client/i18n.tsx` and `packages/web-shell/README.md`: explain
  the two additional triggers in English and Chinese where applicable.
- `packages/web-shell/client/e2e/web-shell.browser-notifications.spec.ts`: validate
  the page and mocked SSE delivery with a captured Notifications API.

## Validation and acceptance

1. A live tool approval in the background sends one localized approval reminder;
   a live AskUserQuestion sends one localized answer reminder.
2. Foreground, disabled, denied, historical, resolved, and mismatched-session
   requests do not notify. Repeated requests and duplicate panes do not duplicate
   a reminder. Separate requests in one turn remain independent.
3. A request reminder never consumes the eventual turn-complete notification.
4. Clicking opens the original session through existing navigation and does not
   submit approval or an answer. Notification bodies do not leak request details.
5. Focused unit tests and browser E2E pass, with build and typecheck verification.
   E2E uses a mock daemon and Notification capture; it does not prove native OS
   notification delivery or real backend approval execution.

## Open questions

None. Iframe support, disconnected catch-up, and automatic closing of displayed
reminders are outside this change.

## Notification access from action panels

ToolApproval and AskUserQuestion share a notification status button in their
top-right header, including inline and floating variants and split panes. Reuse
the existing scoped Popover and Button primitives. Hover, keyboard focus, and
click open an interactive popover without stealing the approval selection.
Moving into its content keeps it open; Escape closes it without rejecting or
submitting the action. Isolate its keyboard events from panel shortcuts.

The icon and localized status distinguish enabled with site permission, disabled,
not yet authorized, denied, and unsupported environments. Unavailable notification
contexts (including iframe and hosts that have not opted in) render no control.
The popover offers the existing enable/permission action where possible, browser
site-setting instructions when denied, and explains background/unfocused triggers,
mounted chats, click behavior, and macOS/Windows notification and Focus settings.
Both OS guides start collapsed, with a chevron beside each heading to expand or
collapse the instructions independently.
The web page cannot detect OS-level permission; do not claim that it can.

On the first eligible panel appearance, attempt authorization once per browser
site through the existing settings controller. Record the attempt before calling
the API to cover duplicate panes and Strict Mode; use an in-memory fallback when
storage is unavailable. Only attempt while permission is default, with no explicit
saved off preference. Do not retry automatically after dismissal, rejection, or
refresh. Browsers can suppress requests without a user gesture, so a manual
button remains available. No timer, synthetic click, or repeated prompt bypasses
browser rules. A successful grant enables the existing preference. Merely opening
the application still never requests permission.

Add controller tests for one-shot behavior and explicit off/denied/unavailable
states, and browser E2E for both panel controls, hover-to-content, manual grant,
enabled/denied copy, safe keyboard handling, persisted attempts, and screenshots.
Guidance follows [Apple Notifications settings](https://support.apple.com/en-gb/guide/mac-help/-mh40583/mac)
and [Microsoft Notifications and Do Not Disturb](https://support.microsoft.com/en-us/windows/experience/notifications-and-do-not-disturb-in-windows).
E2E uses an isolated mock API, not user permissions.
