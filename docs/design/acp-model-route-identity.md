# ACP Model Route Identity

## Problem

Qwen Code currently exposes ACP model IDs as `modelId(authType)`. Two configured models with the same model ID and auth type but different `baseUrl` values therefore collapse to one ACP selector. Clients cannot identify the active row or round-trip a selection to the intended endpoint.

Core already treats `(authType, modelId, configured baseUrl)` as the registry identity. The loss happens only when that identity crosses the ACP boundary. The configured value must remain separate from the resolved endpoint because provider defaults can fill `baseUrl` after registration.

## Design

Build ACP model options from the existing configured-model list:

- Keep `modelId(authType)` when it is unique. This preserves existing IDs for the normal case.
- When multiple options would share that ID, replace each with a deterministic `qwen-route:v1:<digest>` selector derived from non-secret model metadata and its occurrence within otherwise identical entries.
- Never include or hash `baseUrl` in the wire selector. Endpoint URLs may contain credentials, and an unkeyed digest would still allow offline guessing.
- Continue using `ModelInfo.name` and provider metadata for display. The route ID is an opaque machine selector.

Core exposes the original optional registry `baseUrl` alongside the resolved display endpoint. The same option builder supplies ACP session models, config options, live provider status, and daemon workspace provider status so every client sees the same ID while the server retains the exact registry discriminator.

On `session/set_model`, Qwen Code resolves the selector against the current configured-model list before switching. It passes the resolved `baseUrl` to Core, then persists only the canonical settings values:

- `model.name`: actual model ID
- `model.baseUrl`: configured registry endpoint, or an empty tombstone for an implicit default
- `security.auth.selectedType`: actual auth type

The opaque selector is never written to `settings.json`.

## Compatibility

- ACP schema is unchanged; `modelId` remains a string.
- Unique existing model IDs retain the current wire representation.
- Legacy `modelId(authType)` requests remain accepted. If such an ID is ambiguous, existing first-match behavior is preserved for compatibility; newly advertised selectors are exact.
- Unknown or stale opaque selectors are rejected instead of being treated as literal model IDs.
- Generic ACP clients, including Zed, only need to echo the opaque selector.
- CLI TUI settings and selection behavior are unchanged.

## Verification

- Duplicate routes receive distinct, stable selectors without leaking their URLs.
- Session model state and config options publish the same selectors and exact current route.
- Selecting the second route switches with its `baseUrl`, persists canonical settings, and notifies clients with its opaque selector.
- Daemon provider status identifies the exact current route for Web Shell.
- Unique and legacy model selections keep working.
