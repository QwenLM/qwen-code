# Configurable browser notification branding

[English](web-shell-browser-notification-branding.md) | [简体中文](web-shell-browser-notification-branding.zh-CN.md)

## Problem and scope

Before this PR, #11398 used the fixed `Qwen Code` title and passed no icon to Notification. This PR introduces the bundled PNG and the requested QwenCode spelling, alongside configurable branding.

The [content and navigation design](web-shell-browser-notification-details.md) defaults to the QwenCode name and bundled icon. QwenCode is the requested notification brand spelling; it is independent of sidebar branding. Hosts embedding Web Shell need to supply their own application name and image URL, including an HTTPS CDN URL. This changes notification branding only, not sidebar branding or browser-controlled site attribution.

## Configuration and integration

Expose `browserNotifications?: WebShellBrowserNotificationsOptions` on `WebShellWithProviders` and its `StandaloneWebShell` alias. The options contain optional `appName` and `iconUrl` strings, plus `defaultEnabled?: boolean` (false by default). Missing or whitespace-only branding values fall back independently to QwenCode and the bundled PNG. The title remains application name · session title, or only the application name when there is no session title. Pass the trimmed icon URL directly to Notification.icon; no proxy, preload, authentication headers, or automatic retry is added. The browser fetches the image under its security policies; a failed custom image does not guarantee the default icon is shown.

Omitting the options preserves the embedded entry's existing behavior without automatic browser notifications. Passing an object, including an empty object, connects the notification provider above the daemon session provider and exposes the existing UI setting. The initial browser-local preference uses defaultEnabled only when no stored choice exists. If storage is unreadable, start off rather than assuming a missing preference; the user may still explicitly enable notifications temporarily. Explicit stored true or false always wins, including after reload; removing the stored choice restores that instance's initial default. Changing defaultEnabled after mounting does not overwrite the current choice. Permission is never requested automatically, even when the default is on. Changing branding values or toggling the options between an object and undefined preserves the mounted session and notification preference. Omission disables notification contexts and delivery; returning to an object restores the same instance. The initial default is read at mount even if integration is initially omitted. The built-in main.tsx explicitly sets defaultEnabled to true while keeping the default name and icon. Thus the built-in development and installed qwen serve pages start enabled for a fresh browser site, but delivery still requires browser permission and the existing background/unfocused conditions.

The low-level WebShell component does not gain this prop: its daemon providers are owned by the caller and sit outside its subtree, so an internal notifier could not observe their events. No new CLI option, daemon setting, public daemon protocol, or low-level notification provider API is introduced. Iframe and server-rendered paths continue without browser notifications.

Notification status and excerpt labels follow the App's resolved UI language, including settings changes. The existing internal settings context synchronizes that language without adding a second locale selection policy.

## Click ownership

Each mounted notification provider owns an internal EventTarget shared with its descendant App through React context. Notification clicks use this target instead of a window-wide broadcast, so only the owning Web Shell navigates. Existing window qwen:open-session events remain available for Markdown links. A notification target that conflicts with the App's current locked workspace is ignored, including a stale notification after the host changes the lock. A target whose owner has unmounted has no active navigation listener.

## Validation

Tests cover public-entry provider order, opt-in versus omitted configuration, default and partial/blank options, CDN URL forwarding, changed options without remounting, preserved permission/off behavior, per-instance notification navigation, locked-workspace rejection, and the existing standalone navigation path. Library builds must include the default image in the published output. Browser verification uses a host fixture importing the public entry with custom branding and a real daemon turn; API capture verifies the name, prompt/reply, and image URL, not OS icon placement or remote CDN availability.
