# Web Shell composer glow

[English](web-shell-composer-glow.md) | [简体中文](web-shell-composer-glow.zh-CN.md)

## Behavior

`WebShell` and `WebShellWithProviders` accept an optional `composerGlowEnabled` prop. Omitting it keeps the current focus glow and typing pulse. Passing `false` hides both glow layers and skips their animation listeners.

## Implementation

The shared composer customization carries the prop to the main chat, split panes, and side tasks. The composer uses the existing cleanup to cancel pending animation frames and timers and reset the glow state when a host turns it off while mounted.

## Verification

Focus the desktop composer and type to confirm the default glow and pulse. Switch the prop to `false` while focused and verify that the glow layers disappear immediately and further keystrokes still edit the draft. Switch back to `true` and verify that typing triggers the pulse again.
