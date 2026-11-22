# Web Shell Shared Workspace Input History

[中文版本](./web-shell-shared-input-history.zh-CN.md)

## Background

Web Shell stores composer input history (prompt history and shell-mode command history) solely in browser `localStorage` (`qwen-web-shell-history:<workspaceCwd>` and `qwen-web-shell-command-history`). When a user opens the same Web Shell session or workspace on both desktop and mobile, inputs submitted on desktop are invisible from mobile's **Input history** panel (and vice versa). Shell command history in Web Shell is also not scoped per workspace and does not share history with the CLI's project-level `shell_history` file.

## Goals

1. Share composer prompt history and shell-mode command history across devices (desktop, mobile, multiple browsers) connected to the same `qwen serve` daemon, scoped per workspace.
2. Keep synchronization near-real-time when desktop and mobile have the same session open simultaneously, without adding a custom sync protocol.
3. Reuse the existing project-level `shell_history` file (`Storage(workspaceCwd).getHistoryFilePath()`) so Web Shell and TUI share shell command history per workspace.
4. Preserve full backward compatibility and offline/legacy-daemon fallback to browser `localStorage`.

## Non-Goals

- Cross-daemon cloud sync or Managed Host backend routes (Managed Host keeps client-local fallback until it advertises `workspace_input_history`).
- Cross-device composer draft synchronization.
- Rewriting TUI's `logs.json` undo/session-deletion semantics.

## Design

### 1. Daemon Storage (`packages/cli/src/serve/workspace-input-history.ts`)

Each workspace stores up to `100` unique entries per kind under `Storage(workspaceCwd).getProjectTempDir()`:

- `kind = 'prompt'`: `<project-temp>/input_history.json` — JSON `string[]` ordered **oldest-to-newest** (matching Web Shell's `useInputHistory`).
- `kind = 'shell'`: reuses `Storage(workspaceCwd).getHistoryFilePath()` (`<project-temp>/shell_history`) — JSON `string[]` ordered **oldest-to-newest** on disk, matching the TUI's load-then-reverse behavior. The shared read/append helper preserves both JSON and legacy line-based formats and serializes TUI/daemon mutations across processes; the HTTP API returns `entries` oldest-to-newest.

Persistence invariants:

- Trim input; ignore empty strings and entries exceeding `32_768` characters.
- Deduplicate by moving an existing identical entry to the newest position and capping to the newest `100` entries.
- Serialize writes per file path via an in-process promise queue and write atomically (`0o600` temp file in the same directory + `rename`).
- Return `[]` only for a missing (`ENOENT`) file. Preserve legacy line-based shell history; reject malformed prompt history instead of overwriting it.
- Serialize prompt appends per process and shell appends with the shared TUI/daemon interprocess lock; both producers reread under the lock before an atomic write.
- Compute a lightweight `revision` (short SHA-256 hex digest of the canonical entries payload) for `ETag` / `If-None-Match` (`304 Not Modified`).

### 2. Automatic Server-Side Recording

Normal user submissions are recorded automatically on the daemon without extra client write requests:

- `POST /session/:id/prompt`: when admitted (`!admission.deduplicated`) and not a channel relay (`!classification.channelPrompt && !classification.requestedChannelPrompt`), record `classification.submittedPrompt` if non-empty, otherwise concatenated text blocks from `prompt`, into `prompt` history for `runtime.workspaceCwd`.
- `POST /session/:id/mid-turn-message`: after `enqueueMidTurnMessage` succeeds with non-empty `trimmed`, record `trimmed` into `prompt` history for `runtime.workspaceCwd`.
- `POST /session/:id/shell`: once `command.trim()` passes validation, record `command.trim()` into `shell` history for `runtime.workspaceCwd`.

All recording hooks are best-effort (errors are logged via `daemonLog` and never block or fail the session request).

### 3. HTTP Routes & Capability

Route ownership and trust boundaries:

| Route                                       | Ownership          | Trust & Failure Semantics                                                                                                                              |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /workspace/input-history`              | `legacy-primary`   | Checks primary generation open; returns `200 { kind, entries, revision }` or `304` on `If-None-Match`.                                                 |
| `POST /workspace/input-history`             | `legacy-primary`   | Behind `mutate()`; checks primary generation open; appends `{ kind, entry }` for client-local commands (e.g. local-only slash commands).               |
| `GET /workspaces/:workspace/input-history`  | `selected-runtime` | Resolves via `resolveWorkspaceRuntimeFromParam` + `requireTrustedWorkspaceRuntime` + generation guard; never falls back to primary.                    |
| `POST /workspaces/:workspace/input-history` | `selected-runtime` | Behind `mutate()`; resolves via `resolveWorkspaceRuntimeFromParam` + `requireTrustedWorkspaceRuntime` + generation guard; never falls back to primary. |

Query & body validation:

- `kind`: required on `POST`, optional on `GET` (defaults to `'prompt'`), must be `'prompt' | 'shell'` (`400 invalid_input_history_kind`).
- `limit` (optional on `GET`): positive integer in `1..100` (`400 invalid_limit`).
- `entry` (on `POST`): non-empty trimmed string within `32_768` characters (`400 invalid_entry`).

Capability advertisement:

- Register `workspace_input_history: { since: 'v1' }` in `packages/sdk-typescript/src/daemon/capabilities.ts` (re-exported by `packages/cli/src/serve/capabilities.ts`, unconditional on `qwen serve`).
- Classify in `packages/cli/src/serve/capability-parity.ts` as `NO_MANAGED_EQUIVALENT('no Managed input history route')`.

### 4. Web Shell Synchronization & Fallback

- **Workspace actions (`packages/web-shell/client/daemon/workspace/actions.ts`)**:
  - `loadInputHistory({ kind, limit, workspaceId, ifNoneMatch })`: hits `/workspaces/:id/input-history` for non-primary trusted workspaces and `/workspace/input-history` for primary. Returns `{ notModified: true }` on `304`, or `{ notModified: false, entries, revision }`.
  - `recordInputHistory({ kind, entry, workspaceId })`: best-effort `POST` used for local-only slash commands that never reach `/session/:id/prompt`.
- **Target resolution**:
  - Only enabled when `capabilities.features` includes `'workspace_input_history'`.
  - For a non-primary `atWorkspaceCwd`, requires `'workspace_qualified_rest_core'`, an unambiguous match in `capabilities.workspaces`, and `trusted !== false`. Unknown, ambiguous, or untrusted workspaces stay strictly local-only and never fall back to primary `/workspace/input-history`.
- **Workspace-scoped shell history**:
  - Scope shell history `localStorage` keys per workspace (`qwen-web-shell-command-history:<workspace>`) with fallback to legacy `qwen-web-shell-command-history` when fallback is enabled.
- **Sync triggers in `useComposerCore.ts`**:
  1. Initial mount and workspace change (prefetch prompt history; prefetch shell history when shell mode is active).
  2. Opening the Input history panel (`openHistorySearch`, desktop `Ctrl+R` or mobile `+ -> Input history`), updating `searchMatches` immediately if newer entries arrive while the panel is open.
  3. Starting `↑` navigation from idle (`!isNavigating()`).
  4. Window `focus` / `visibilitychange` (`visible`) so returning to a mobile browser tab syncs inputs submitted on desktop while backgrounded.
  5. Live cross-client SSE signal (`remotePromptSidechannel.ts`, published by `DaemonSessionProvider.tsx` when a live `user.text.delta` or `midTurnInjected` arrives from another `originatorClientId`) triggers a conditional refresh immediately when desktop and mobile have the same session open.
- **Merge & race safety (`useInputHistory.ts`)**:
  - `mergeRemoteInputHistory(localEntries, remoteEntries)`: keeps unique local-only entries before remote entries, then appends remote entries in canonical server order, capped to the latest `100` entries.
  - Track a per-hook mutation sequence number so an in-flight `GET` started before a local `push()` never overwrites the freshly pushed local entry.
  - Track locally pushed entries not yet present in the remote snapshot, persist that bounded pending order beside the existing browser-local history per storage scope, and keep them at the newest tail until a remote snapshot confirms them. Remounts and workspace switches preserve that order; a stale response cannot demote a just-submitted input behind older remote history. Confirmation clears the pending markers without unnecessarily rewriting an unchanged history array.
  - Preserve `useInputHistory`'s zero-re-render invariant when the search panel is closed.

## Acceptance Criteria

1. Submitting a prompt or mid-turn message on desktop makes it visible in mobile's Input history panel for the same workspace without manually refreshing the page.
2. Submitting a shell-mode command on desktop makes it visible in mobile's shell Input history and persists in `<project-temp>/shell_history`.
3. Multi-workspace routes (`/workspaces/:workspace/input-history`) stay strictly scoped to the resolved trusted runtime and fail cleanly for unknown, untrusted, or closed-generation workspaces without falling back to primary.
4. Older daemons without `workspace_input_history`, offline browsers, and standalone tests continue working via `localStorage` without errors or extra renders.
