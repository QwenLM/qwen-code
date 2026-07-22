# Daemon MCP force reconnect

## Problem

`POST /workspace/mcp/reload` reloads persisted settings but reconciles MCP
connections incrementally. A server whose settings are unchanged retains its
existing transport. OAuth credentials written by another Qwen Code process are
therefore not read until that transport reconnects.

## Design

Add optional `forceReconnectAll` and `forceReconnectWhich` fields to both
workspace MCP reload routes and their SDK/ACP bridge methods.
`forceReconnectAll` defaults to `false`; `forceReconnectWhich` selects named
servers. The fields are mutually exclusive.

When either reconnect option is supplied, the daemon first performs the normal
settings reconciliation. It then reconnects every configured MCP server across
the workspace, or only the names selected by `forceReconnectWhich`:

- pooled servers restart through the workspace transport pool once per server
  name, then refresh the model tool snapshots for live configs;
- servers without a pool entry use the existing per-config discovery path,
  which disconnects and reconnects before rediscovery.

This deliberately does not initiate OAuth. It only causes a new connection,
which reads the credentials currently persisted by the daemon's token storage.

## API

`POST /workspace/mcp/reload` and
`POST /workspaces/:workspace/mcp/reload` accept:

```json
{ "forceReconnectAll": true }
```

`forceReconnectWhich` accepts an array of non-empty server names. Invalid
values return 400.
The response remains `202 { "accepted": true }` because the work is queued.

## Verification

- Route tests cover default forwarding, `true` forwarding, and invalid input.
- ACP tests cover propagation to each live config and force reconnect behavior.
- E2E plan documents an OAuth-token-written-externally scenario.
