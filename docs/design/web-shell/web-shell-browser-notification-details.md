# Browser notification details and session navigation

[English](web-shell-browser-notification-details.md) | [简体中文](web-shell-browser-notification-details.zh-CN.md)

Following the base implementation in #11398, this enhancement lets users identify the session behind a notification, preview this turn's reply, and click to return to that session. The browser switch, permissions, background trigger, and deduplication rules remain those of the base implementation. No daemon route or public SDK field is added.

## Content and icon

The title is QwenCode · session title. If a new session has no title yet or its title has been cleared, use the first line of this turn's request; if neither exists, display QwenCode. The body retains the turn status and includes a plain-text excerpt from the last main-assistant reply for a completed turn, without another model call to summarize it. Extraction matches the terminal promptId exactly and excludes tools, thoughts, background agents, and internal insight messages. Missing text does not fall back to an older turn, and failures do not expose partial replies or error details.

Extraction runs after the live/replay transcript projection. Titles use the owning session's state and owner-matched connection metadata. The main chat suppresses the submitting user's SSE echo, and the local optimistic user block may lack a promptId. The observer therefore retains a title fallback through the existing admission promptId/label; live pending-start events can also supply it. Labels remain only in the pending-turn memory Map and are removed on consumption, removal, or release of the last observer.

Titles retain at most 60 Unicode code points and reply excerpts at most 120, ending in an ellipsis when truncated. Excerpts remove common Markdown formatting, link destinations, and HTML tags, collapse whitespace, and avoid splitting Unicode code points.

Notifications include a package-local copy of the project's existing 128×128 PNG mark, with Vite resolving and bundling its URL. Business text does not append IP addresses, ports, or navigation URLs. Chrome's site attribution and its own macOS logo are controlled by the browser and OS and cannot be replaced by the business icon. Content may appear in the notification center or on the lock screen; the setting description explains that titles and reply excerpts are shown. Shared storage continues to record only deduplication hashes, never bodies, titles, or navigation targets.

## Clicking to open a session

The internal owner binding captures sessionId and product context: workspace uses the resolved owner.workspaceCwd, while standalone/live omit internal working directories. The target remains in the notification's in-memory closure. Clicking attempts to focus the original window, passes the explicit target to the existing qwen:open-session entry point, and closes the notification. Navigation is still attempted if the browser refuses focus.

App reuses the existing session-loading flow for settings, split view, draft context, asynchronous navigation, and failure reporting. Existing session links without explicit context keep their behavior. Malformed or conflicting explicit contexts are rejected instead of falling back to the current or primary workspace. If the target is already the healthy current session, its context matches, and there is no pending draft intent, only reveal chat and close panels to avoid disrupting the next turn with a duplicate load. Split-view notifications open the main chat, and the existing callback updates the address bar after a successful load.

The original page and main App navigation listener must still be alive. Expired sessions, removed workspaces, and load failures use existing error feedback without creating a session or switching to another workspace. Closed-page delivery, Channel, Service Worker, and Web Push are outside this enhancement.

## Validation scope

Unit tests cover live/replay content projection, admission title fallback, exact-turn and main-assistant filtering, Unicode truncation, failure and empty-content fallbacks, icon parameters, captured targets, cross-workspace and standalone/live navigation, exiting settings and split view, avoiding duplicate current-session loads, legacy links, and focus failure.

Page verification uses an isolated runtime and Chrome: capture the notification produced after a real submission settles, switch to another session and open settings, then invoke the captured notification's click callback. Check that the original session and URL return, settings exits, and the notification closes. A Notification stub and simulated loss of focus demonstrate browser parameters and navigation, not actual OS banner or icon display. The icon is separately checked for production HTTP availability, PNG signature, and dimensions. Detailed test plans and results are kept locally under .qwen/e2e-tests/.
