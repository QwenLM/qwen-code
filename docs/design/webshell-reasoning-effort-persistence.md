# WebShell reasoning effort persistence

## Problem

WebShell currently applies a reasoning effort selection only to the active ACP session. A new session therefore falls back to the previously configured model default. The settings schema also treats effort as one global five-value scale, even though providers can expose model-specific values such as `ultra` or `minimal`.

## Semantics

`model.reasoningEffort` is an open string setting:

- An absent value leaves reasoning at the model or provider default.
- `none` disables reasoning by setting the runtime configuration to `reasoning: false`.
- Every other non-empty value is preserved verbatim as `reasoning.effort`.

There is no global normalization, ordering, allowlist, or fallback for persisted values. The existing five built-in effort tiers remain available to `/effort` and provider adapters that explicitly implement that scale. Provider adapters may translate built-in tiers for their own wire protocol, but must pass an unknown value through or reject it explicitly rather than silently changing it.

ACP uses `default` only as an instruction to remove `model.reasoningEffort`; it is never persisted.

## Persistence boundary

The WebShell daemon route marks its ACP `reasoning_effort` update as persistent. The ACP agent applies the selection to the live session first, then writes through the `Session` instance's own loaded settings using the same scope selection as model persistence. Direct ACP calls without the private marker remain session-only.

After a successful persisted update, the bridge broadcasts `settings_changed` for `model.reasoningEffort`. This refreshes retained workspace provider state and the no-session welcome preview without creating an empty session.

If the settings write fails, the live session remains updated and the request reports that the current session changed but the default was not saved. No settings-change event is broadcast.

## Runtime lifecycle

The runtime keeps an explicit reasoning override across authentication refreshes and both hot and full model rebuilds. The override distinguishes disabled reasoning, an opaque effort string, and the provider default. This prevents `none` from being lost merely because it has no `effort` field.

Model reasoning capabilities advertise options as independent `value` and `name` pairs. WebShell stores and submits `value` while rendering `name`, so model-specific values do not depend on global translation keys.

## Validation

Unit and integration coverage verifies opaque string round trips, `none`, clearing to provider defaults, lifecycle rebuilds, capability labels, the private persistence marker, write failures, welcome previews, and provider wire behavior. Real-daemon E2E compares a clean baseline and this change with isolated configuration directories for both Medium and Thinking Off across a daemon restart and a newly created session.
