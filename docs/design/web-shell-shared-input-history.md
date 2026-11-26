# Web Shell Shared Workspace Input History

[中文版本](./web-shell-shared-input-history.zh-CN.md)

- **Status:** merged — PR #18120, squash `65616b314b` (2026-11-26), released in `v0.28.6`. Deferred `[P3]` follow-up tracked in #18423.
- **Scope:** `packages/core`, `packages/cli` (shell-history file lock, serve routes, TUI `useShellHistory`), `packages/sdk-typescript`, `packages/web-shell`, `integration-tests`
- **Verification at merge:** On final PR head `4cfaddc70e`, `web-shell E2E Smoke` shard 1 passed 416/416 (37.1m, executing `web-shell.shared-input-history.spec.ts`), alongside green Smoke shard 2, Linux unit shards, no-AK integration shards, TUI parity, Serve A/B, and `SDK Java (fast) / Real daemon E2E`; `gh pr checks` on `4cfaddc70e` ultimately settled at 43 pass / 4 fail / 1 cancelled / 53 skipped because 3 `SDK Java (full)` jobs and `Managed Agent full suite` concluded failure after merge and `Capture web-shell visuals` was cancelled. `verify-pr` reported 28/28 `merge-ready` at `4cfaddc70e` (PR #18120 comment 7165336894; Playwright browser E2E was listed under its Not covered section). Local runs at `242d5293ca` (comment 7157080066) recorded CLI suites 138 passed, Web Shell suites 84 passed, real daemon HTTP/FS integration 4/4, desktop + Pixel 7 Chromium E2E 3/3, and the prompt/mid-turn write-ordering mutation kill; the 100-entry-bound and conditional-read queue-wait / failing-append `304` checks and mutation kills were recorded in comments 7154154453 (at `255fab4dfc`) and 7135944012 (at `32231a4b95`) and re-measured at `4cfaddc70e` (comment 7165336894); the final delta to `4cfaddc70e` touched only `web-shell.shared-input-history.spec.ts` (+10/−7), re-verified locally at `4cfaddc70e` with `PLAYWRIGHT_PORT=42273` 3/3 and default port 1/1 (comment 7135944012). Post-merge main push workflows on `65616b314b` (`Qwen Code CI`, `Managed Agent gate`, `Managed Agent loop verification`, `Web Shell Managed Host Build`, `Verify Landlock helper`, `pnpm Worktree Smoke`) all succeeded. Coverage boundary: mobile E2E ran in Linux Chromium Pixel 7 context with a mock ACP model child rather than physical phones, mobile Safari/WebKit, or live models.

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

Each workspace stores up to `100` unique entries per kind under `Storage(workspaceCwd).getProjectTempDir()`, evaluated inside `runWithWorkspaceRuntimeStorage(runtime, ...)`. This combines the workspace project hash with that runtime's `sessionRuntimeBaseDir`; each legacy-primary request resolves the current primary runtime, rather than retaining one across replacement, while qualified routes use the explicitly selected trusted runtime. A bare `new Storage(workspaceCwd)` without this context must not redirect data into the process's ambient temporary root.

- `kind = 'prompt'`: `<project-temp>/input_history.json` — JSON `string[]` ordered **oldest-to-newest** (matching Web Shell's `useInputHistory`).
- `kind = 'shell'`: reuses `Storage(workspaceCwd).getHistoryFilePath()` (`<project-temp>/shell_history`) — JSON `string[]` ordered **oldest-to-newest** on disk, matching the TUI's load-then-reverse behavior. The shared read/append helper preserves both JSON and legacy line-based formats and serializes TUI/daemon mutations across processes; the HTTP API returns `entries` oldest-to-newest.

Persistence invariants:

- Trim input; ignore empty strings and entries exceeding `32_768` characters.
- Deduplicate by moving an existing identical entry to the newest position and capping to the newest `100` entries.
- Serialize prompt appends per file path with an in-process asynchronous queue that propagates errors without orphaned rejections. The TUI also keeps a per-file Promise FIFO so rapid local submits preserve their order before asynchronous locking; an append failure is logged and does not stop the next command. Other file paths are not blocked by that FIFO. Serialize TUI and daemon shell appends with `proper-lockfile`: reacquire/reclaim stale locks asynchronously, reread inside the lock, and yield during contention rather than blocking the event loop.
- Treat lock compromise as an append-promise rejection, not an uncaught asynchronous callback error. When compromise is already observed before the atomic write, do not write; handle the expected release failure from an already-compromised lock. Other release errors still propagate. A module-level pending-write set lets the normal exit cleanup drain writes after the hook unmounts. Its active drain keeps consuming additions that arrive while it is already waiting, until the set is empty or the existing timeout prevents further progress; those writes join the same pass rather than escaping its initial snapshot. The existing 2-second per-function and 5-second total exit bounds remain unchanged.
- Write atomically through a temporary file in the same directory + `rename`, `fsync`, and `0o600` on platforms that support POSIX mode bits. For shell history, the final compromise check and atomic replacement stay in one synchronous commit; lock acquisition, retries, and the preceding read remain asynchronous.
- Return `[]` only for a missing (`ENOENT`) file. Preserve legacy line-based shell history; reject malformed prompt history instead of overwriting it. Both TUI and daemon keep shell history oldest-to-newest on disk; the TUI reverses it only in memory for navigation.
- Compute a lightweight `revision` (short SHA-256 hex digest of the canonical entries payload) for `ETag` / `If-None-Match` (`304 Not Modified`). Conditional reads carrying `If-None-Match` await any already-queued write on the same path (swallowing write failures so the read falls back to the on-disk snapshot rather than propagating a `500`), while unconditional reads remain immediate.

### 2. Automatic Server-Side Recording

Normal user submissions are recorded automatically on the daemon without extra client write requests:

- `POST /session/:id/prompt`: when admitted (`!admission.deduplicated`) and not a channel relay (`!classification.channelPrompt && !classification.requestedChannelPrompt`), record `classification.submittedPrompt` if non-empty, otherwise concatenated text blocks from `prompt`, into `prompt` history for `runtime.workspaceCwd`.
- A host-generated command may explicitly opt-out with `suppressInputHistory: true`. The Web Shell uses this for `/model --fast`, `/language output`, `/compress`, and a scheduled task's manual `Run now`; host-initiated retries carry the same flag through the original prompt and retry state rather than globally excluding all retries. Normal user submissions, including those without `submittedPrompt` metadata, retain the fallback described above. The daemon consumes and removes this flag from the body forwarded to the agent; it is not prompt content.
- `POST /session/:id/mid-turn-message`: after `enqueueMidTurnMessage` returns `accepted: true` with non-empty `trimmed`, inspect its prior mid-turn snapshot and record `trimmed` only when the supplied `messageId` is not already queued, settled, or promoted. Rejected messages and idempotent replay acknowledgements do not enter `prompt` history for `runtime.workspaceCwd`; fresh accepted IDs still record normally.
- `POST /session/:id/shell`: once `command.trim()` passes validation, record `command.trim()` into `shell` history for `runtime.workspaceCwd`.

All recording hooks are best-effort (errors are logged via `daemonLog` and never fail the session request). Prompt and mid-turn-message routes await their local atomic JSON write before returning `202`/`200` so concurrent peer refreshes observe the new revision, whereas shell history writes do not block command execution behind cross-process file locks. Prompt, mid-turn-message, and shell auto-recording execute in the same runtime storage context as their target session.

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

Cross-origin conditional synchronization requires `If-None-Match` in the daemon's CORS `Access-Control-Allow-Headers`. Existing authorization and origin restrictions are unchanged.

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
- **Scope binding beyond target trust**:
  - Implicit legacy-primary remains supported because the primary route has a unique bound target. For explicitly selected workspaces, prompt/shell storage keys must equal the encoding of the target's workspace scope before remote GETs or pending tracking can run. An explicitly shared, non-canonical storage key stays local-only: it does not fetch another workspace's snapshots, advance their pending expiry, or create confirmation markers. It does not silently fall back to an unrelated primary destination.
  - A secondary target key is prefixed with `workspace:` so a server-assigned literal `<primary>` ID cannot collide with the legacy-primary sentinel. The optional workspace ID and its encoded URL route remain unchanged.
- **Workspace-scoped shell history**:
  - Scope shell history `localStorage` keys per workspace (`qwen-web-shell-command-history:<workspace>`) with fallback to legacy `qwen-web-shell-command-history` when fallback is enabled.
- **Sync triggers in `useComposerCore.ts`**:
  1. Initial mount and workspace change (prefetch prompt history; prefetch shell history when shell mode is active).
  2. Opening the Input history panel (`openHistorySearch`, desktop `Ctrl+R` or mobile `+ -> Input history`), updating `searchMatches` immediately if newer entries arrive while the panel is open.
  3. Starting `↑` navigation from idle (`!isNavigating()`).
  4. Window `focus` / `visibilitychange` (`visible`) so returning to a mobile browser tab syncs inputs submitted on desktop while backgrounded.
  5. Live cross-client SSE signal (`remotePromptSidechannel.ts`, published by `DaemonSessionProvider.tsx` when a live `user.text.delta` or `midTurnInjected` arrives from another `originatorClientId`) triggers a conditional refresh immediately when desktop and mobile have the same session open.
- **Merge & race safety (`useInputHistory.ts`)**:
  - `mergeRemoteInputHistory(localEntries, remoteEntries, previousRemoteEntries?)`: puts independent local entries ahead of older remote entries while retaining at least one incoming remote item whenever remote history is present. A legacy browser history of `100` local-only entries therefore retains its newest `99`, rather than hiding every remote item. The merged array stays capped at `100`.
  - Persist the remote-sourced subset of the merged result under `${storageKey}:remote-source`. Previously authoritative entries that the daemon evicted from a rolling window do not get promoted to local-only entries. The subset has the same `100`-entry bound; its write is best-effort, and the next accepted remote snapshot repairs the classification in memory even when browser persistence is unavailable. If the key is absent, old-window provenance is ambiguous: never promote an incoming full window merely from ordered text overlap, even when a prior pending copy is confirmed. Ambiguous entries remain browser-local within the bounded window rather than being erased without evidence. When source metadata is known, an advancing remote window evicts its stale members, including after confirming a pre-existing pending copy. A present empty source array is a known empty set, not missing provenance.
  - Track a per-hook mutation sequence number so an in-flight `GET` started before a local `push()` never overwrites the freshly pushed local entry. Give each target change a generation and each request an independent identity. An A→B→A switch cannot make an older A response authoritative again or let an old completion clear the new request's in-flight state; queued refresh is resumed only by the matching completion.
  - Track unconfirmed locally pushed entries up to the same `100`-entry bound as stored history, each trimmed and length-valid. Persist `{ text, seenRemoteRevision?, missedRemoteSnapshots, hadLocalBefore? }` beside the browser-local history; migrate legacy `string[]` markers and normalized duplicates by keeping the latest valid marker, restore pending order on the initial mount and after scope changes, and create no new markers while remote history is unsupported. Oversized or blank inputs do not become permanently pending entries.
  - Keep an unconfirmed entry at the newest tail while its revision is unchanged. Once its baseline is known, two responses with newer, differing revisions that both miss it expire it. Remove expired or confirmed markers from the pending ordering before merging, preserving authoritative daemon order for confirmed entries without displacing the remaining remote window. A previous local-only copy (`hadLocalBefore`) is preserved during expiry while its pending marker is dropped. A copy already identified as remote does not set that flag, so resubmission and later expiry cannot turn a stale daemon-owned entry into independent local history. Only a genuinely new entry with no previous local-only copy can be discarded; missing provenance remains conservative as described above. A response carrying an outdated mutation sequence cannot advance expiry or overwrite a just-pushed entry.
  - Preserve history and drafts already being browsed during asynchronous merges, and preserve `useInputHistory`'s zero-re-render invariant when the search panel is closed.
  - Create pending markers only when an exact input-history target resolves. Unknown, ambiguous, or untrusted workspaces remain local-only.
  - Compare storage identity, the exact input-history target key, and workspace cwd when a local slash command is accepted after an asynchronous allocation gap. A live key reused during a workspace change must not record that command into the newly selected workspace; it may use the target captured at submit start or explicitly skip the remote write. The primary key represents its stable route destination whether the optional workspace list is absent or later populated, so enriching capability metadata does not reject a same-primary acceptance. A session/draft identity change during allocation does not bypass this check: a same-target deferred Slash command is recorded once, while a workspace mismatch still suppresses its remote write.
  - Confirm pending entries using the daemon's trim convention, without retaining a raw-whitespace duplicate. Legacy pending migration preserves valid markers up to that history bound in their original order.

## Acceptance Criteria

1. Submitting a prompt or mid-turn message on desktop makes it visible in mobile's Input history panel for the same workspace without manually refreshing the page.
2. Submitting a shell-mode command on desktop makes it visible in mobile's shell Input history and persists in `<project-temp>/shell_history`.
3. Multi-workspace routes (`/workspaces/:workspace/input-history`) stay strictly scoped to the resolved trusted runtime and fail cleanly for unknown, untrusted, or closed-generation workspaces without falling back to primary.
4. Older daemons without `workspace_input_history`, offline browsers, and standalone tests continue working via `localStorage` without errors or extra renders.
5. An explicit alternate runtime storage root receives both HTTP mutations and automatic prompt/shell records; no route or recording path falls back into the ambient temporary directory.
6. Machine-initiated commands with `suppressInputHistory: true` are absent from prompt history and from the forwarded request body, while ordinary user prompts and the optional-metadata fallback remain recordable.
7. An unconfirmed pending input cannot permanently pin the newest end or repeatedly evict a real cross-device entry. A full `100`-entry remote window remains intact after its expiry, while independently sourced local entries retain the feasible local window.
8. A local slash command whose acceptance spans a workspace change cannot be appended to the newly selected workspace's remote history. Session/draft identity changes without a workspace change still record once into the unchanged target.
9. A daemon-evicted entry previously identified as remote must not be retained as browser-local through successive full remote snapshots, while unknown-provenance entries retain their feasible bounded local window, and a newly incoming remote entry must remain visible when legacy local history fills the window.
10. An explicit shared, non-canonical storage key must not let another workspace's snapshots reorder, confirm, or expire its local entries. A literal `<primary>` secondary id must not collide with the primary sentinel, and implicit legacy-primary synchronization remains supported.
11. A host command retry preserves its opt-out. A compromised lock fails the append without an uncaught asynchronous exception, and an in-flight append is drained by the bounded exit cleanup after its hook unmounts.
