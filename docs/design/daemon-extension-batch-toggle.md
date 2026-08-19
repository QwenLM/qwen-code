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

Both accept 1–100 Extension names in `extensionNames`, deduplicate them
case-insensitively in request order, and return one Extension operation id. The
public target is name-keyed because Extension loading and installation enforce
name uniqueness, while a client declaring activation before installation cannot
derive Qwen's source-dependent internal id. The global
body accepts `state` as `enabled` or `disabled` and writes every target's
`defaultActivation`. The workspace body also accepts `inherit`; it clears each
target's exact override using the same legacy-rule masking semantics as the
singular DELETE route. `inherit` does not create a declaration for a name with
no existing policy; an all-unknown clear is a no-op.

Malformed names or state reject the request
before queueing. Batch operations intentionally do not require an installed
artifact: setting `enabled` or `disabled` for an unknown identity creates a
declaration policy so clients can set desired activation before installation.
Successful global results report the
resulting default activation. Successful workspace results report the exact
override (`null` for inherit) and effective activation. Singular activation
routes remain installed-only and id-addressed.

## Persistence and ownership

All targets are written under one Extension Store lock, producing one
generation. Existing policies and new declarations share the same atomic
validation. A declaration uses a deterministic provisional id plus the regular
V2 policy shape and a `declarationOnly` marker. Installing or discovering that
name re-keys the declaration to the artifact's real id, removes only the marker,
records the artifact generation, and preserves the declared global and
workspace activation. V1 projection entries whose identities are not known yet
remain carried by the V2 snapshot so later declaration, discovery, or artifact
transactions cannot erase them. The manager applies the committed snapshot and
refreshes its tool cache once.

The global batch is process-global: it refreshes all registered runtimes. The
workspace batch is selected-runtime scoped: it resolves the exact workspace id
or canonical path, requires that runtime to be trusted and open, writes only its
canonical workspace override, and refreshes only that runtime. It never falls
back to the primary runtime.
