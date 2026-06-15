# Error Taxonomy & Remediation

## Overview

The daemon's failure modes are deliberately closed unions so SDK consumers can exhaustively switch and route handlers can shape consistent HTTP responses. This doc catalogues every typed error class / kind across three layers:

1. **`packages/cli/src/serve/`** — boundary errors at the HTTP edge (auth, workspace filesystem, daemon-host preflight).
2. **`packages/acp-bridge/`** — bridge / mediator errors at the daemon-to-ACP-child seam.
3. **`packages/sdk-typescript/src/daemon/`** — SDK-side wrapping + structured error fields.

Wire-level error shapes are documented in [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md); this doc adds the cause-and-remediation lens.

## Filesystem boundary (`packages/cli/src/serve/fs/errors.ts`)

`FsError` carries `{ kind, message, status, cause? }`. `FsErrorKind` union (13 kinds, default HTTP status):

| Kind                     | HTTP      | Cause                                                                          | Remediation                                                                                                             |
| ------------------------ | --------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `path_outside_workspace` | 400       | Resolved path leaves the bound workspace.                                      | Use a path inside the daemon's `workspaceCwd`; check `/capabilities`.                                                   |
| `symlink_escape`         | 400       | Target is a symlink.                                                           | Address the resolved path directly; symlinks are rejected by design.                                                    |
| `path_not_found`         | 404       | `ENOENT`.                                                                      | Confirm the file exists; check case-sensitive paths on Linux.                                                           |
| `binary_file`            | 422       | Content sniffed binary on a text route.                                        | Use `GET /file/bytes` for raw bytes; the text route refuses binaries.                                                   |
| `file_too_large`         | 413       | Above `MAX_READ_BYTES` (256 KiB) or `MAX_WRITE_BYTES` (5 MiB).                 | Use byte-range read; split the write.                                                                                   |
| `hash_mismatch`          | 409       | Optimistic-concurrency `expectedSha256` failed.                                | Re-read the file and retry with the new hash.                                                                           |
| `file_already_exists`    | 409       | `mode: 'create'` against an existing file.                                     | Use `mode: 'overwrite'` or pick a new path.                                                                             |
| `text_not_found`         | 422       | `POST /file/edit` search string not in file.                                   | Re-check the search string; whitespace / encoding mismatch is the usual cause.                                          |
| `ambiguous_text_match`   | 422       | Multiple matches when one was required.                                        | Add more surrounding context to the search string to make it unique.                                                    |
| `untrusted_workspace`    | 403       | Write attempted in an untrusted workspace.                                     | Mark the workspace trusted (`Config.isTrustedFolder()`) or use `runQwenServe` instead of `createServeApp` direct embed. |
| `permission_denied`      | 403       | OS-level `EACCES` / `EPERM`.                                                   | Adjust filesystem ACLs; this is **not** a security alert.                                                               |
| `io_error`               | 503       | `ENOSPC` / `EIO` / `EBUSY` / `ETXTBSY` / `ENAMETOOLONG` / `EMFILE` / `ENFILE`. | Host-level operational fix (disk full, fd exhaustion); page ops, not security.                                          |
| `internal_error`         | 500       | Non-errno error reaches the boundary.                                          | Open a daemon bug.                                                                                                      |
| `parse_error`            | 400 / 422 | Request body parse error (400) or service-level invariant breach (422).        | Validate request body; check SDK version.                                                                               |

`io_error` vs `permission_denied` distinction is deliberate so monitoring pipelines key on `errorKind` for routing — folding ENOSPC into `permission_denied` pages security oncall for a `df -h` problem.

## Bridge errors (`packages/acp-bridge/src/bridgeErrors.ts`)

Typed classes thrown by the bridge / mediator. Most carry an HTTP status via the route handler's switch.

| Class                                 | HTTP | Cause                                                                    | Remediation                                                                                                                                                                      |
| ------------------------------------- | ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionNotFoundError`                | 404  | sessionId not in `byId`.                                                 | Re-create or attach; the session may have been reaped.                                                                                                                           |
| `WorkspaceMismatchError`              | 400  | `POST /session` `cwd` ≠ daemon's `boundWorkspace`.                       | Omit `cwd` (uses bound) or route to a daemon bound to your `cwd`.                                                                                                                |
| `SessionLimitExceededError`           | 503  | `byId.size >= maxSessions`.                                              | Close stale sessions; bump `--max-sessions`.                                                                                                                                     |
| `InvalidClientIdError`                | 400  | `X-Qwen-Client-Id` outside `[A-Za-z0-9._:-]{1,128}`.                     | Sanitize the client id.                                                                                                                                                          |
| `InvalidSessionMetadataError`         | 400  | `displayName` > 256 chars or contains control chars.                     | Trim / sanitize.                                                                                                                                                                 |
| `InvalidSessionScopeError`            | 400  | Unknown `sessionScope` value.                                            | Use `'single'` or `'thread'`.                                                                                                                                                    |
| `RestoreInProgressError`              | 409  | Concurrent `loadSession` / `resumeSession`.                              | Wait + retry.                                                                                                                                                                    |
| `WorkspaceInitConflictError`          | 409  | `POST /workspace/init` against an existing file without `force`.         | Pass `force: true` or pick another path.                                                                                                                                         |
| `WorkspaceInitPathEscapeError`        | 400  | Init path leaves workspace.                                              | Use a path inside `workspaceCwd`.                                                                                                                                                |
| `WorkspaceInitSymlinkError`           | 400  | Init path is a symlink.                                                  | Address the resolved path.                                                                                                                                                       |
| `WorkspaceInitRaceError`              | 409  | TOCTOU race on init.                                                     | Retry.                                                                                                                                                                           |
| `McpServerNotFoundError`              | 404  | Restart for an unknown server.                                           | Verify server name in `/workspace/mcp`.                                                                                                                                          |
| `McpServerRestartFailedError`         | 500  | Restart failed inside ACP child.                                         | Check ACP child logs; may indicate broken MCP server.                                                                                                                            |
| `InvalidPermissionOptionError`        | 400  | Wire vote tried to inject `CANCEL_VOTE_SENTINEL` via `optionId`.         | Vote with `{outcome: 'cancelled'}` instead of an `optionId`.                                                                                                                     |
| `PermissionForbiddenError`            | 403  | Policy refused the voter (`designated_mismatch` / `remote_not_allowed`). | Use the originator client id (designated), pre-register voter (consensus), or vote from loopback (local-only). See [`04-permission-mediation.md`](./04-permission-mediation.md). |
| `CancelSentinelCollisionError`        | 500  | Agent published `'__cancelled__'` as a legitimate option label.          | Agent bug — change the option label to anything other than the sentinel.                                                                                                         |
| `PermissionPolicyNotImplementedError` | 500  | Requested policy not built into this daemon.                             | Update daemon, or change `policy.permissionStrategy`.                                                                                                                            |
| `BridgeChannelClosedError`            | 503  | ACP child channel closed mid-call.                                       | Reconnect / retry; check `session_died` for cause.                                                                                                                               |
| `BridgeTimeoutError`                  | 504  | Bridge-level wallclock exceeded.                                         | Retry; investigate underlying slowness.                                                                                                                                          |

## Daemon-host error kinds (`packages/cli/src/serve/status.ts`)

`DaemonErrorKind` enum used by `GET /workspace/preflight` cells when the daemon-host check fails:

| Kind             | Meaning                                       |
| ---------------- | --------------------------------------------- |
| `missing_binary` | `ripgrep` / `git` / `npm` not on PATH.        |
| `blocked_egress` | Outbound network probe failed.                |
| `auth_env_error` | Auth-related env var malformed.               |
| `init_timeout`   | Daemon-side init step exceeded its wallclock. |
| `protocol_error` | ACP / HTTP protocol mismatch.                 |
| `missing_file`   | Required local file missing.                  |
| `parse_error`    | Local file parse error.                       |

These are surfaced through the preflight cell's `errorKind` so client UIs render structured remediation (not raw stack traces).

## Auth error shapes

| Status | Body                                         | When                                                                                                                                     |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `401`  | `{ error: 'Unauthorized' }`                  | Missing / wrong / no-scheme bearer token. Uniform across `missing header` / `wrong scheme` / `wrong token` so probing can't distinguish. |
| `401`  | `{ error: '...', code: 'token_required' }`   | Mutation-gate strict route on a no-token loopback daemon. SDKs render "configure --token / --require-auth" hint.                         |
| `403`  | `{ error: 'Request denied by CORS policy' }` | `denyBrowserOriginCors` rejected an `Origin`-bearing request.                                                                            |
| `403`  | `{ error: 'Invalid Host header' }`           | `hostAllowlist` rejected the `Host` header (DNS rebinding defense).                                                                      |

See [`12-auth-security.md`](./12-auth-security.md) for the full auth model.

## Permission outcomes (wire-vs-audit overload)

`PermissionResolution` has two terminal kinds:

- `{kind: 'option', optionId}` — a vote won.
- `{kind: 'cancelled', reason: 'timeout' \| 'session_closed' \| 'agent_cancelled'}` — request was cancelled. The wire shape is single (`{outcome: 'cancelled'}`); the audit log distinguishes timeout / session_closed / voter-cancelled / agent-cancelled in `decisionReason.type`. This overload is preserved deliberately to avoid breaking the frozen `permission.ts` contract.

## SDK-side error wrapping

`DaemonClient` returns HTTP errors as rejected Promises with the parsed body as the rejection value. Methods that hit `404` for unknown sessions reject with `{error, sessionId}`; the SDK does not wrap them in a typed class today (callers `instanceof Error` + `.message.includes(...)` matching is discouraged — switch on `err.code` / `err.kind` from the body instead).

`parseSseStream` aborts the iterator on 16-MiB buffer overflow (defensive bound).

## Workflow

### Surface an error to a user

```mermaid
flowchart LR
    A[HTTP 4xx/5xx body] --> B["switch on body.code OR errorKind"]
    B --> C["Render remediation per this doc's table"]
    B --> D["fallback: render body.error as toast"]
```

### Distinguish auth failure modes

```mermaid
flowchart TD
    A["401 received"] --> B{"body.code == 'token_required'?"}
    B -->|yes| C["mutation-gate strict — guide user to --token / --require-auth"]
    B -->|no| D["plain Unauthorized — generic 'check token' UI"]
```

## Dependencies

- All error classes are exported from their respective packages; SDK consumers can `instanceof` against `bridgeErrors.ts` types when running in the same Node process. Across the wire, route on `body.code` / `body.kind` / `body.errorKind`.

## Caveats & Known Limits

- **`io_error` vs `permission_denied`** are distinct on purpose. Don't conflate.
- **`PermissionForbiddenError` reasons (`designated_mismatch` / `remote_not_allowed`) are overloaded** across the `designated` and `consensus` policies; the audit log distinguishes them precisely but the wire form does not.
- **`CancelSentinelCollisionError` indicates an agent-side bug**, not a security event — the bridge refuses the request rather than silently letting the sentinel match a real option.
- **SDK-side typed errors are still evolving.** Callers should route on body fields rather than relying on JS class identity through the wire.
- **`internal_error` should always be investigated.** It signals an `FsError` constructor was called with a kind reserved for non-errno paths (programmer error); the response body's `cause` field may carry the original throw.

## References

- `packages/cli/src/serve/fs/errors.ts:1-80+` (`FsErrorKind`, `FsErrorStatus`)
- `packages/acp-bridge/src/bridgeErrors.ts` (every typed class)
- `packages/cli/src/serve/status.ts` (`DaemonErrorKind`)
- `packages/cli/src/serve/auth.ts:101-294` (auth bodies)
- Wire reference: [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md).
