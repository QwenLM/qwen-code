# MCP session metadata hot reload

## Problem

MCP transport identity deliberately excludes `trust`, `includeTools`, `excludeTools`, and `alwaysLoadTools` so daemon sessions with different policies can share one healthy transport. Settings reconciliation previously treated a matching transport fingerprint as a complete no-op. The attached session view therefore kept stale tool and prompt registrations. The same omission existed in same-fingerprint runtime replacement.

Unpooled connections exposed a different mismatch: their public lifecycle id (`name::unpooled-N`) was compared with the desired transport fingerprint (`name::fingerprint`). A healthy unpooled connection was consequently replaced on every reconciliation pass.

## Invariants

1. Transport-affecting changes reconnect; metadata-only changes do not.
2. Pooled and unpooled handles expose both a unique lifecycle id and the transport identity captured when the transport was created.
3. Session metadata is projected from the canonical discovery snapshot without mutating it. Sessions sharing a transport may independently choose filters, trust, and eager loading.
4. Equivalent metadata does not churn registries.
5. Runtime replacement and settings reconciliation use the same refresh behavior.

## Metadata identity

The session metadata key has these canonical rules:

| Setting           | Canonical behavior                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trust`           | Missing, `false`, and `true` remain distinct.                                                                                                                                   |
| `alwaysLoadTools` | Only `true` enables eager loading; missing and `false` are equivalent.                                                                                                          |
| `includeTools`    | Presence is significant: missing allows all tools and `[]` allows none. Order and duplicates are ignored, and `foo(args)` is equivalent to `foo`, matching discovery filtering. |
| `excludeTools`    | Missing and `[]` are equivalent. Order and duplicates are ignored; names remain exact matches.                                                                                  |

The key is captured by each session view instead of recomputed from its previous config reference. This detects a settings object mutated in place. Transport identity is likewise captured by each pool entry so mutating the caller-owned config cannot make an old transport appear current.

## Refresh flow

During pooled reconciliation, each held connection is compared through its captured transport identity. A mismatch releases and reacquires the connection. A match calls the existing handle's metadata refresh method. The handle updates only its attached `SessionMcpView`; when the canonical metadata key changes, the view replays the entry's current tool, prompt, and resource snapshots. Equivalent settings return without registry changes.

The runtime add-or-replace path performs the same handle refresh after updating the runtime overlay when the transport identity matches.

`alwaysLoadTools` is projected alongside trust by cloning the discovered tool for the session. The canonical snapshot retains its original value and remains safe to share. Legacy single-session discovery includes the same canonical metadata key in its connected-config identity, so changes reconnect and rediscover there.

## Lifecycle behavior

Refreshing a released handle or a terminal entry fails closed. A live entry can accept the new view config while a restart is in progress; the normal restart snapshot fan-out then applies that config to the refreshed discovery result. Refresh never calls `acquire` again for the same session, avoiding handle replacement and reference-count ambiguity.

## Compatibility and scope

No user setting, MCP wire message, transport fingerprint, or daemon API shape changes. Existing sessions gain immediate metadata updates, and unpooled transports stop reconnecting on metadata-only or equivalent settings changes. Transport changes, disabled servers, approval changes, and explicit restarts retain their existing teardown behavior.

Atomic filesystem configuration reloads, MCP server-driven list-change behavior, and new metadata fields are out of scope.

## Verification

Unit and integration coverage exercises pooled refresh, unpooled identity, same-fingerprint runtime replacement, legacy reconnect keys, equivalent filter normalization, absent-versus-empty include lists, in-place config mutation, per-session `alwaysLoadTools`, and shared-snapshot isolation. A real local stdio MCP harness additionally verifies transport reuse, metadata projection, an actual tool call, and zero churn for canonical-equivalent settings.
