# Daemon Extension Batch Activation

## Context

Extension Management V2 separates global default activation from exact
workspace overrides. Its singular global route writes `defaultActivation` by
stable Extension id and refreshes every runtime. Its singular workspace routes
write or clear an override for a selected trusted runtime and refresh only that
runtime.

Remote clients currently repeat those singular operations when toggling several
Extensions. The legacy `/workspace/extensions/*` compatibility surface has
different semantics: user scope writes a home-level path rule and workspace
scope is bound to the primary workspace. A batch route on that surface alone
therefore cannot optimize V2 clients.

## V2 contract

Add `extension_batch_activation_v2` as an independent capability so clients can
distinguish older `extension_management_v2` daemons. It exposes two queued
operations:

```text
PUT /extensions/activation
PUT /workspaces/:workspace/extensions/activation
```

Both accept 1–100 stable `extensionIds`, deduplicate them in request order, and
return one Extension operation id. The global body accepts `state` as `enabled`
or `disabled` and writes every valid target's `defaultActivation`. The workspace
body also accepts `inherit`; it clears each valid target's exact override using
the same legacy-rule masking semantics as the singular DELETE route.

Malformed ids or state reject the request before queueing. A well-formed but
missing id is a per-target `extension_not_found` error and does not block valid
targets. Successful global results report the resulting default activation.
Successful workspace results report the exact override (`null` for inherit) and
effective activation.

## Persistence and ownership

All valid targets are resolved from one loaded-Extension snapshot and written
under one Extension Store lock, producing one generation. The manager applies
that snapshot and refreshes its tool cache once.

The global batch is process-global: it refreshes all registered runtimes. The
workspace batch is selected-runtime scoped: it resolves the exact workspace id
or canonical path, requires that runtime to be trusted and open, writes only its
canonical workspace override, and refreshes only that runtime. It never falls
back to the primary runtime.
