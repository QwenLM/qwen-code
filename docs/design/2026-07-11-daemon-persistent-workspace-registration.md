# Persistent daemon workspace registration

## Goal

Workspaces added from the Web Shell survive a `qwen serve` process restart
when the daemon is relaunched with the same primary workspace and `QWEN_HOME`.

## State ownership

Dynamic workspace registration is user-private daemon configuration, not
project configuration and not disposable runtime output. Registrations are
stored under:

```text
${QWEN_HOME:-~/.qwen}/daemon/workspaces/<primary-scope-sha256>.json
```

The scope hash is the full SHA-256 of the canonical primary workspace path
(lower-cased on Windows). The file repeats the primary path so a mismatched or
corrupt scope is rejected rather than silently applied.

```json
{
  "schemaVersion": 1,
  "primaryWorkspace": "/repo/main",
  "workspaces": ["/repo/service-a"]
}
```

Only canonical secondary paths are stored. Trust, environment, workspace ids,
sessions, and runtime errors are re-derived on every daemon start.

## Lifecycle

The production daemon reads the small registration file after resolving and
canonicalizing the primary workspace. Valid stored paths are merged after
explicit `--workspace` inputs. Explicit inputs are authoritative: a malformed
or unavailable explicit path remains a boot error, while an unavailable stored
path is skipped with a warning and retained on disk for a later restart.

Recovered paths enter the normal secondary-runtime construction loop before
`WorkspaceRegistry` and the Express/ACP surfaces are assembled. This keeps
capabilities, workspace-qualified ACP mounts, status aggregation, and the
default total-session limit consistent with the restored runtime set.

For process-local additions after app assembly, workspace-qualified ACP routes
remain mounted whenever a registry exists and create a trusted secondary mount
lazily on first use. This avoids a single-workspace startup snapshot making a
later Web Shell registration unusable until restart.

`POST /workspaces` accepts `persist: true`. A successful persistent request is
not acknowledged until the registration-file update completes successfully.
Repeating a
persistent request for an already-active workspace promotes or confirms its
stored registration and succeeds idempotently. Existing callers that omit
`persist` keep the current process-local behavior.

`GET /workspace-registrations` exposes the desired stored set for management.
`DELETE /workspace-registrations/:id` forgets a stored registration; an active
runtime remains live until restart. The primary workspace can never be stored
or forgotten through this surface.

## Safety and failure behavior

- The store is bounded to 24 secondary paths, each no longer than the daemon
  workspace-path limit.
- Reads reject symlinks, non-regular files, oversized files, malformed JSON,
  unknown schema versions, and primary-scope mismatches.
- Writes use an in-process mutex, a cross-process lock, and the shared atomic
  file-write helper with mode `0600` and no symlink following.
- Corrupt stores are never treated as empty by mutation paths, preventing a
  later add from overwriting recoverable data.
- Persisted trust is deliberately absent; restored workspaces pass through the
  current trusted-folder calculation.
- Stored entries that are missing, inaccessible, nested, or over the active
  limit are skipped without deleting the desired entry. Duplicate entries make
  the store invalid and are never rewritten implicitly.

## Compatibility

The additive `persistent_workspace_registration` capability advertises the new
contract. The SDK request option and `persisted` response field are additive.
`runQwenServe` owns automatic startup restoration. Direct `createServeApp`
embeds gain the persistence management routes only when a registration store
is explicitly supplied, and remain responsible for restoring their injected
workspace registry before app creation.

## Follow-up boundary

Hot removal remains separate: forgetting a registration affects the next
restart but does not terminate sessions or dispose an active workspace bridge.
