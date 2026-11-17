# CUA SDK Default Delivery Mode

## Problem

The high-level `@qwen-code/cua-sdk/computer-use` facade currently relies on the
native default whenever an action omits `deliveryMode`. That default is
`background`, which is appropriate for normal desktop automation but not for
isolated benchmark desktops where preserving another foreground window has no
value and background input may be rejected by the application framework.

The facade also exposes camelCase `deliveryMode`, while native refusal text can
recommend snake_case `delivery_mode`. JavaScript silently accepts that unknown
property, so a caller can believe it selected foreground delivery while the
facade still dispatches the native default.

## Design

Add `QWEN_CUA_SDK_DEFAULT_DELIVERY_MODE`, accepting exactly `background` or
`foreground` case-insensitively. `ComputerUse.create()` and
`ComputerUse.connect()` capture it when the facade instance is created.

Delivery precedence is:

1. the action's explicit `deliveryMode`;
2. `QWEN_CUA_SDK_DEFAULT_DELIVERY_MODE`;
3. `background`.

Only actions that already accept `deliveryMode` are affected. Accessibility-only
actions such as `setValue` and `performSecondaryAction` remain unchanged. An
invalid environment value fails during facade creation rather than silently
falling back. The facade passes the resolved value to every supported typed
action, including an explicit `background` when neither higher-precedence source
is present, so the high-level contract does not depend on a native implicit
default.

The facade rejects the unsupported JavaScript property `delivery_mode` with a
camelCase correction before dispatch, and rewrites native delivery-mode guidance
in surfaced error text to the public camelCase name.

## Skill migration

Keep the Codex-aligned API-surface and workflow structure. Add only the real
typed `deliveryMode` option to action signatures. In the screenshot section,
state that `includeScreenshot: true` requests the image and that `disableDiff`
controls only accessibility full/diff output.

## Process-wide configuration

An isolated automation process that should consistently use foreground delivery
sets:

```text
QWEN_CUA_SDK_DEFAULT_DELIVERY_MODE=foreground
```

This is process configuration, not model prompting. Ordinary SDK consumers
remain background by default.

## Scope

No native delivery-mode default changes, persistent window activation, automatic
background-to-foreground retry, or benchmark policy is added to the Skill.
