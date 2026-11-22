# Web Shell approval actions

[English](2026-11-19-web-shell-approval-actions.md) | [简体中文](2026-11-19-web-shell-approval-actions.zh-CN.md)

## Problem

The shared approval card presents every permission scope as a footer button. People approving a tool call should be able to distinguish a one-time decision from a broader permission at a glance, including on narrow screens.

## Design

- Put Reject and the primary approval action on the right. The primary action submits the one-time option. A chevron attached to it opens a menu with every offered approval scope when there is more than one.
- Prefer the ordinary one-time option, including manual approval when exiting Plan Mode. Keep mode changes and broader scopes explicit in the menu. When all approval options are persistent, the primary control opens the menu. Requests with unclassified options or multiple rejection scopes retain their original list.
- Keep the existing initial focus, native activation, dismissal behavior, and submission guard. Escape closes an open menu before it can reject or dismiss a request. Number shortcuts apply to the visible direct actions. Reuse the shared portal and send the original option ID.

## Validation

Exercise one-time and persistent decisions, plan mode, disabled state, and request replacement. Verify the menu and focus behavior in the browser on desktop and narrow screens, and verify both inline and floating approval cards.
