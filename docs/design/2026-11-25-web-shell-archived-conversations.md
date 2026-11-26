# Web Shell Archived Conversations: Search, Filtering, Sorting, and Archive Time

[English](2026-11-25-web-shell-archived-conversations.md) | [简体中文](2026-11-25-web-shell-archived-conversations.zh-CN.md)

**Status: Design Proposal · 2026-11-25**
**Source Issue:** [QwenLM/qwen-code#17772](https://github.com/QwenLM/qwen-code/issues/17772)
**Tracking Issue:** [QwenLM/qwen-code#18302](https://github.com/QwenLM/qwen-code/issues/18302)

---

## 1. Problem Statement, Goals, and Non-Goals

### 1.1 Background & Verified Codebase Gaps

In Web Shell, the **Settings → Archived conversations** panel acts as long-term storage for finished, idle-reaped, and manually archived conversations. As archives grow across multiple workspaces, the current panel becomes unworkable. Static inspection against the current repository (which has evolved past the `0.27.2` baseline reported in `#17772`) confirms five real gaps:

1. **No search UI and no archived content search:** Active sidebar search explicitly covers active sessions only, while [StandaloneRecents.tsx](../../packages/web-shell/client/components/sidebar/StandaloneRecents.tsx) already accepts a `searchQuery` prop that the archived panel never passes. Meanwhile, `SessionService.searchSessionContent` in [sessionService.ts](../../packages/core/src/services/sessionService.ts) hardcodes `getChatsDirForState('active')`, leaving `chats/archive/` unsearchable.
2. **No workspace filter (and misaligned workspace ordering):** `allArchivedSessions` in [WebShellSidebar.tsx](../../packages/web-shell/client/components/sidebar/WebShellSidebar.tsx) filters only by `archiveSourceType` and renders every workspace group in `Map` insertion order rather than honoring `orderedProjectWorkspaces`. Users cannot isolate a single workspace or standalone ("No-workspace") sessions.
3. **No sort control inside the archived panel and limited sort dimensions:** Since `0.27.2`, archived catalog queries already forward the sidebar's shared `sortBy` preference when `session_last_user_prompt_sort` is advertised, but the archived panel itself exposes no sort control. Furthermore, sorting by `archivedAt`, `createdAt`, or `alphabetical` does not exist yet.
4. **No inline row timestamps and no durable `archivedAt`:** Archived rows render title-only text; timestamps appear only inside the hover [SessionDetailsTooltip.tsx](../../packages/web-shell/client/components/sidebar/SessionDetailsTooltip.tsx). On disk, `SessionService.archiveSessions` moves the transcript via `fs.renameSync` (which preserves `mtime`), and `toSummary` / `toStandaloneSummary` derive `updatedAt` from `item.mtime`. No `archivedAt` field exists anywhere in core, bridge, daemon, or SDK models.
5. **Hidden 100-session pagination cliff & row isolation risks (discovered during design):** Web Shell requests `SESSION_LIST_PAGE_SIZE = 1000`, but the daemon clamps `pageSize` to `MAX_SESSION_PAGE_SIZE = 100` in [session-list.ts](../../packages/cli/src/serve/server/session-list.ts). Unlike `StandaloneRecents` (which paginates with `cursor`), workspace-grouped archives ignore `nextCursor`, making sessions beyond the first 100 per workspace unreachable. Additionally, `StandaloneRecents` renders its section header and empty message during zero-hit searches, and `renderSessionRow` reads active `contentSearchHits` unless explicitly isolated for archived rows.

### 1.2 Goals

- Redesign **Settings → Archived conversations** into a clean, scalable archive-management surface with a top control bar (search input, unified `Type` & `Sort by` dropdown, and workspace filter dropdown) and bordered per-workspace cards featuring two-line rows (title + formatted timestamp subtitle).
- Keep all existing archived row actions (Export, Restore/Unarchive, Rename, Delete) accessible on both desktop and touch viewports without breaking existing hover/touch layout contracts.
- Persist true archive timestamps (`archivedAt`) using an `O(1)`-read append-only ledger (`chats/archive/archive-meta.jsonl`) aligned with the daemon's disk-I/O budget.
- Extend server-side sorting (`archivedAt`, `createdAt`, `alphabetical` alongside `updatedAt` and `lastUserPromptAt`) and transcript content search (`archiveState=archived`) with full backward compatibility for older daemons via capability gating.
- Provide per-workspace `Load more` cursor pagination so large archives (>100 sessions per workspace) remain fully accessible.

### 1.3 Non-Goals

- **`managed-agent-server` backend API changes (`#15077`):** `ManagedArchivedSessions` is owned by the Java managed-agent control plane and is out of scope for core/daemon API changes here (the Web Shell UI merely preserves integration compatibility when `managedArchivedSessions` is mounted).
- **Full-text search index or persistent transcript search cache:** Archived content search reuses the existing bounded streaming scanner.
- **Read-only viewing of archived transcripts (`#13018`):** Users still unarchive to reopen a conversation.
- **CLI `/resume` or VS Code picker history search (`#6824`):** Out of scope, though the core `searchSessionContent(..., { archiveState })` extension remains reusable by those surfaces later.
- **Destructive workspace-group bulk actions in V1:** Group-level `...` overflow triggers are kept only as an optional visual extension point, not wired to bulk delete/unarchive in V1.

---

## 2. Current Architecture Baseline (Verified Against Codebase)

### 2.1 Web Shell Surfaces

- **Container mount:** [SettingsMessage.tsx](../../packages/web-shell/client/components/messages/SettingsMessage.tsx) renders the Settings `Archived` category (`activeGroup?.id === 'Archived'`) and supplies `[data-web-shell-archived-sessions]` (`archivedSessionsTarget`) as the portal destination.
- **Portal & state assembly:** [WebShellSidebar.tsx](../../packages/web-shell/client/components/sidebar/WebShellSidebar.tsx) computes `archivedSection` via `createPortal(..., archivedSessionsTarget)`, subscribes to primary (`useWebShellSessions`) and secondary (`useSessionCatalogQueries`) archived catalogs with `archiveState: 'archived'` and `view: 'organized', group: 'all'`, groups rows into `archivedWorkspaceGroups`, and renders `Tabs` (Tasks / Channels), `managedArchivedSessions?.content`, `<StandaloneRecents archiveState="archived" />`, and `archivedWorkspaceGroups`.
- **Standalone archives:** [StandaloneRecents.tsx](../../packages/web-shell/client/components/sidebar/StandaloneRecents.tsx) fetches `GET /standalone/sessions?archiveState=archived` (`PAGE_SIZE = 50`), already supports `searchQuery` filtering (`displayName` and `sessionId`) and cursor pagination, and reports `{ count, loading, error }` via `onStatusChange`.
- **Row rendering & tooltip:** `renderSessionRow` in [WebShellSidebar.tsx](../../packages/web-shell/client/components/sidebar/WebShellSidebar.tsx) renders `.archivedRow` with `.sessionText` + `SessionPrBadge` + `.sessionMetaSlot` (Export, Restore, More → Rename/Delete) wrapped in [SessionDetailsTooltip.tsx](../../packages/web-shell/client/components/sidebar/SessionDetailsTooltip.tsx). Active CSS contracts in [WebShellSidebar.module.css](../../packages/web-shell/client/components/sidebar/WebShellSidebar.module.css) and [WebShellSidebar.css.test.ts](../../packages/web-shell/client/components/sidebar/WebShellSidebar.css.test.ts) plus [web-shell.archived-settings.spec.ts](../../packages/web-shell/client/e2e/web-shell.archived-settings.spec.ts) tightly constrain `.sessionMetaSlot` and touch button layout.
- **Shared helpers & primitives:** [SessionSortMenu.tsx](../../packages/web-shell/client/components/sidebar/SessionSortMenu.tsx), [sessionSearch.ts](../../packages/web-shell/client/components/sidebar/sessionSearch.ts) (`sessionMatchesGitQuery`, `mergeSessionContentHits`), [useSessionContentSearch.ts](../../packages/web-shell/client/components/sidebar/useSessionContentSearch.ts), [formatDateTime.ts](../../packages/web-shell/client/utils/formatDateTime.ts), [formatRelativeTime.ts](../../packages/web-shell/client/utils/formatRelativeTime.ts), [constants/sessions.ts](../../packages/web-shell/client/constants/sessions.ts), [i18n.tsx](../../packages/web-shell/client/i18n.tsx), and `useWebShellPortalRoot()`-aware shadcn primitives ([input.tsx](../../packages/web-shell/client/components/ui/input.tsx), [select.tsx](../../packages/web-shell/client/components/ui/select.tsx), [dropdown-menu.tsx](../../packages/web-shell/client/components/ui/dropdown-menu.tsx), [button.tsx](../../packages/web-shell/client/components/ui/button.tsx)).

### 2.2 Core, Daemon, Bridge, and SDK Pipeline

- **Storage & lifecycle:** All local workspace and standalone archive/unarchive/delete operations converge on `SessionService` in [sessionService.ts](../../packages/core/src/services/sessionService.ts) (`archiveSessions`, `unarchiveSessions`, `cleanupRemovedSessionStateInternal`, `removeSessionFiles`). `SESSION_FILE_PATTERN` (`/^[0-9a-fA-F-]{32,36}\.jsonl$/`) skips non-UUID sidecars/ledgers during directory enumeration. Existing per-session sidecar conventions live in [session-title-sidecar.ts](../../packages/core/src/services/session-title-sidecar.ts) (`0o600`, `atomicWriteFileSync`) and [session-pr-service.ts](../../packages/core/src/services/session-pr-service.ts) (in-process serialization + `proper-lockfile`). Active-session project relocation moves explicit per-session files in [config.ts](../../packages/core/src/config/config.ts) (`moveCurrentSessionArtifacts`).
- **Daemon list, cache & search:** [session-list.ts](../../packages/cli/src/serve/server/session-list.ts) builds `PersistedSessionListSnapshot` via [persisted-session-list-cache.ts](../../packages/cli/src/serve/server/persisted-session-list-cache.ts) (2 s TTL, invalidated by archive/unarchive/delete routes across `['active', 'archived']`), sorts via `OrganizedCursorKey` / `LiveSessionCursorKey`, and serves [session.ts](../../packages/cli/src/serve/routes/session.ts) (`GET /workspace/:id/sessions`, `GET /workspaces/:workspace/sessions`, `GET /workspace/:id/sessions/search`, `GET /workspaces/:workspace/sessions/search`), [session-catalog.ts](../../packages/cli/src/serve/routes/session-catalog.ts) (`POST /sessions/catalog`), and [standalone-sessions.ts](../../packages/cli/src/serve/routes/standalone-sessions.ts) + [standalone-session-service.ts](../../packages/cli/src/serve/conversations/standalone-session-service.ts) (`GET /standalone/sessions`).
- **Types & capabilities:** Wire summaries and client methods live in [bridgeTypes.ts](../../packages/acp-bridge/src/bridgeTypes.ts) (`BridgeSessionSummary`), [types.ts](../../packages/sdk-typescript/src/daemon/types.ts) (`DaemonSessionSummary`), [standalone-sessions.ts](../../packages/sdk-typescript/src/daemon/standalone-sessions.ts) (`parseStandaloneSummary`), [DaemonClient.ts](../../packages/sdk-typescript/src/daemon/DaemonClient.ts), [capabilities.ts](../../packages/cli/src/serve/capabilities.ts), and [capability-parity.ts](../../packages/cli/src/serve/capability-parity.ts).

---

## 3. Target UX and Visual Design

```text
Archived conversations
┌───────────────────────────────────┐ ┌────────────────────┐ ┌──────────────────────┐
│ 🔍 Search archived conversations ×│ │ ≡ All chats      ⌄ │ │ 📁 All workspaces  ⌄ │
└───────────────────────────────────┘ └────────────────────┘ └──────────────────────┘

📁 qwen-code                                                               6 conversations
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Find assigned contributor PRs · #142                    [↓] [Rename/Del ⋯] [ Unarchive ]│
│ Nov 25, 2026, 10:33 AM                                                                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Fix archived sorting edge case                                     [↓] [⋯] [ Unarchive ]│
│ Nov 24, 2026, 5:14 PM                                                                  │
│ …matching transcript snippet shown here in Phase 3…                                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                    [ Load more ]   (when nextCursor exists)

◌ No-workspace sessions                                                    2 conversations
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Standalone cleanup task                                            [↓] [⋯] [ Unarchive ]│
│ Nov 20, 2026, 2:08 PM                                                                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Top Control Bar

Placed immediately below the panel heading (`flex flex-wrap items-center gap-2 px-1 pb-3`):

1. **Search `<Input>`** (`flex-1 min-w-[180px]`):
   - Rounded field with leading `SearchIcon` and trailing clear button (`aria-label`) when non-empty.
   - **Keyboard contract:** Pressing `Escape` while non-empty clears the search query and calls `event.stopPropagation()` so it does not close the outer Settings dialog/panel; pressing `Escape` when empty propagates normally.
   - **Client-side fast-path matching (case-insensitive):** matches resolved `displayName` (custom title or first prompt), `sessionId`, and `sessionMatchesGitQuery(session, query)` from [sessionSearch.ts](../../packages/web-shell/client/components/sidebar/sessionSearch.ts) (branch name, worktree branch/slug, bound PR `#N`, and closed issue `#N`). Also forwarded via `searchQuery` to `<StandaloneRecents archiveState="archived" />`.

2. **Unified Filter & Sort Dropdown** (trigger button: `ListFilterIcon` + active `Type` label + `ChevronDownIcon`, backed by Web Shell's shared `DropdownMenu` primitive so `useWebShellPortalRoot()` applies automatically):
   - **Section 1 — `Type`** (only dynamically populated options are rendered so dead options never appear):
     - `All conversations` (default)
     - **Source options** (rendered when `showSessionSourceSwitch && sourceMetadataEnabled`): `Tasks` (`default`), `Channels` (`channel`) — replacing the current full-width `Tabs` switch bar above the archived list.
     - **Origin options** (rendered only when `managedArchivedSessions` is mounted alongside local daemon archives): `Local` (workspace + standalone daemon sessions), `Cloud` (`managedArchivedSessions`).
   - **`DropdownMenuSeparator`**
   - **Section 2 — `Sort by`** (persisted independently per host under `web-shell:archived-session-sort:${host}`, separate from the active sidebar's `web-shell:session-sort:${host}` so sorting archives by archive time or title never mutates active sidebar ordering):
     - `Archived` (`archivedAt` desc) — shown in Phase 2 when `session_archived_at_sort` is advertised; becomes the default when the user has no saved archived-sort preference.
     - `Updated` (`updatedAt` desc) — default in Phase 1 and automatic fallback on older daemons.
     - `Last question` (`lastUserPromptAt` desc) — shown when `session_last_user_prompt_sort` is advertised.
     - `Created` (`createdAt` desc)
     - `Alphabetical` (`alphabetical`, A→Z case-insensitive by resolved label via `localeCompare`)
   - **Phase 1 vs. Phase 2 sort execution:** In Phase 1, `updatedAt` and `lastUserPromptAt` delegate to existing server parameters while `createdAt` and `alphabetical` sort client-side across loaded rows (showing a subtle completeness hint if any visible workspace has an unloaded `nextCursor`). In Phase 2, `archivedAt`, `createdAt`, and `alphabetical` promote to full server-side pre-pagination sorting (while keeping client-side fallback for `createdAt` and `alphabetical` against older daemons).

3. **Workspace Filter `<Select>`** (`FolderIcon` + active workspace label + `ChevronDownIcon`):
   - Options: `All workspaces` (default) → `No-workspace sessions` (when `archivedStandaloneSessionsVisible` and either standalone count > 0 or standalone is currently selected) → workspaces containing ≥1 loaded archived session ordered by `orderedProjectWorkspaces` (with count badges), followed by any unregistered `cwd` groups sorted alphabetically.
   - **Visibility:** Hidden when `lockedWorkspaceCwd` is set, or when ≤1 selectable scope exists while filter is `all`.
   - **State synchronization rules:**
     - Selecting a specific workspace hides `StandaloneRecents`; selecting `No-workspace sessions` shows only `StandaloneRecents`.
     - Switching `Type` to `Channels` while `No-workspace sessions` is selected resets the workspace filter to `all` (standalone sessions do not belong to `channel`).
     - Unarchiving or deleting the last archived session inside a filtered workspace keeps that workspace selected and displays a targeted empty state with a `Show all workspaces` action rather than silently jumping lists.
     - Changing daemon host or primary workspace resets transient `searchQuery`, `typeFilter`, and `workspaceFilter` states.

### 3.2 Grouped Workspace Cards and Two-Line Archived Rows

- **Group Header (outside card):** Left side renders `FolderClosedIcon` (or `CircleDashedIcon` for standalone) + workspace display name; right side renders the localized count (`N conversations` / `N 个会话`, appending `+` if `nextCursor` remains) and an optional extension slot for future group actions.
- **Card Container:** `rounded-xl border border-border bg-card divide-y divide-border overflow-hidden` using unprefixed Tailwind semantic tokens.
- **Two-Line Row Anatomy:**
  - **Left column (`min-w-0 flex-1`):**
    1. **Line 1:** Resolved title (`truncate font-medium`), `SessionPrBadge`, git/worktree icon, and scheduled-task marker (`CalendarClockIcon`).
    2. **Line 2:** Formatted timestamp subtitle (`<time dateTime={iso} className="text-xs text-muted-foreground tabular-nums">`) formatted via `Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })` (e.g., `Nov 25, 2026, 10:33 AM` / `2026年11月25日 10:33`), guarding against invalid timestamps (`!Number.isFinite(Date.parse(iso))`).
       - **Timestamp selection rule:** Follows the active sort dimension where applicable: `archivedAt` sort prefers `session.archivedAt`; `lastUserPromptAt` sort prefers `session.lastUserPromptAt`; `createdAt` sort prefers `session.createdAt`; `updatedAt` and `alphabetical` prefer `session.updatedAt ?? session.createdAt`. When `session.archivedAt` is absent on legacy pre-upgrade archives, fallback display uses `updatedAt ?? createdAt` with its truthful label (never mislabeling `updatedAt` as `Archived`).
    3. **Line 3 (Phase 3):** Muted single-line truncated transcript match excerpt (`styles.sessionSearchSnippet`).
  - **Right column (`shrink-0 flex items-center gap-1.5`):**
    - Preserves every existing archived action capability: Export icon button, More menu (`Rename`, `Delete`), and a clearly labeled pill **`Unarchive` / `Restore`** button (retaining `aria-label` / `title` `t('sidebar.unarchive')` compatibility).
    - **CSS & Touch Layout Safety:** Rather than overloading `.sessionMetaSlot` (whose hover overlay and width rules are strictly asserted by [WebShellSidebar.css.test.ts](../../packages/web-shell/client/components/sidebar/WebShellSidebar.css.test.ts) and [web-shell.archived-settings.spec.ts](../../packages/web-shell/client/e2e/web-shell.archived-settings.spec.ts)), archived card rows use a dedicated `.archivedCardRow` layout where actions sit cleanly inline on both desktop (`1440×900`) and touch (`390×900`) without horizontal overflow or layout shift.
- **Hover Tooltip Alignment:** [SessionDetailsTooltip.tsx](../../packages/web-shell/client/components/sidebar/SessionDetailsTooltip.tsx) renders an explicit **Archived** row (`archivedAt`) above/beside **Updated** whenever `session.archivedAt` is present.

### 3.3 Pagination, Empty States, and Query Hygiene

- **Per-workspace `Load more`:** When a workspace's archived query returns `nextCursor`, render a `Load more` button below that workspace card that fetches subsequent pages using the daemon's cursor and appends deduplicated sessions. Keep the button available during search even when no loaded rows match.
- **Query slimming:** Omit `view: 'organized', group: 'all'` from Web Shell's archived catalog queries (archived panels do not render pin/group sections, so skipping organized mode prevents pinned old sessions from jumping to the top and avoids reading `session-organization.v1.json`).
- **`StandaloneRecents` empty-search suppression:** Extend `onStatusChange` with `matchedCount: number`. After loading succeeds, hide the standalone section during a search only when no loaded rows match and the standalone cursor is exhausted. The archive panel shows the unified no-match state and `Clear filters` after the visible groups have exhausted their cursors.
- **Snippet isolation:** In `WebShellSidebar.tsx`'s `renderSessionRow`, archived rows read `options.searchSnippet` exclusively and never read active sidebar `contentSearchHits`.

---

## 4. Phased Delivery Architecture

### 4.1 Phase 1 — Web Shell Archived Panel Redesign & Client-Side Controls

**Scope:** Pure client-side Web Shell changes; zero daemon, core, or SDK protocol changes; 100% compatible with deployed daemons.

- Extract [WebShellSidebar.tsx](../../packages/web-shell/client/components/sidebar/WebShellSidebar.tsx)'s archived portal logic into:
  - `packages/web-shell/client/components/sidebar/ArchivedSessionsPanel.tsx` (+ `.test.tsx`)
  - `packages/web-shell/client/components/sidebar/archived-session-sort.ts` (`ArchivedSessionSort`, `readArchivedSessionSort`, `writeArchivedSessionSort`, client-side comparators)
- Wire unified search, `Type`/`Sort by` dropdown, workspace filter, `orderedProjectWorkspaces` group ordering, two-line card rows with formatted timestamps, per-workspace cursor pagination, `StandaloneRecents` `matchedCount` reporting, and `i18n.tsx` English/Chinese strings.

### 4.2 Phase 2 — Durable `archivedAt` Ledger (Option D), Extended Server Sorting, and SDK

#### Storage Decision for `archivedAt`

| Option                                                                   | Cold Scan Read I/O (1,000 sessions)    | Write Concurrency & Locking                                       | Corruption Isolation                                      | Implementation Complexity       | Verdict                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| **A. Append record to transcript `.jsonl`**                              | 0 extra reads                          | Contends with writer lease                                        | Coupled to transcript                                     | Medium                          | **Rejected:** mutates `mtime` (corrupting `updatedAt`), pollutes conversation history and exports   |
| **B. Rely on filesystem `ctimeMs`**                                      | 0 extra reads                          | None                                                              | None                                                      | Very low                        | **Rejected:** renaming archived sessions, backups/syncs, and Windows NTFS renames overwrite `ctime` |
| **C. Per-session sidecar** (`chats/archive/<id>.archive.json`)           | `O(N)`: 1,000 `open+read` calls        | Lock-free per session                                             | Single-session isolation                                  | Low (~70 LOC)                   | **Rejected:** `O(N)` cold reads violate [daemon-session-list-io.md](daemon-session-list-io.md)      |
| **D. Directory append-only ledger** (`chats/archive/archive-meta.jsonl`) | **`O(1)`:** 1 `readFile` per directory | Two-tier queue + `proper-lockfile` (writes only; lock-free reads) | Tolerant JSONL line parsing; truncated tail line isolated | Low (~130 LOC incl. compaction) | **Selected**                                                                                        |

**Why Option D fits this codebase:** `SESSION_FILE_PATTERN` in [sessionService.ts](../../packages/core/src/services/sessionService.ts) (`/^[0-9a-fA-F-]{32,36}\.jsonl$/`) ignores non-UUID files, so `archive-meta.jsonl` is invisible to transcript enumerators and active-session project relocation in [config.ts](../../packages/core/src/config/config.ts). Reading happens **only** when `archiveState === 'archived'`, adding zero overhead to active session lists.

#### Core Ledger Format & Lifecycle (`packages/core/src/services/session-archive-metadata.ts`)

- **File path & permissions:** `<chatsDir>/archive/archive-meta.jsonl`, mode `0o600`.
- **Record schema (JSONL):** `sessionId` normalized to lowercase for case-insensitive filesystem consistency:
  ```json
  {"v":1,"op":"archive","sessionId":"<lowercase-uuid>","archivedAt":"2026-11-25T03:00:00.000Z"}
  {"v":1,"op":"clear","sessionId":"<lowercase-uuid>"}
  ```
- **All 5 write points in `SessionService`:**
  1. `archiveSessions` normal move (`active` → `archived`): after `fs.renameSync` succeeds, append `op: "archive"` with `new Date().toISOString()`.
  2. `archiveSessions` `alreadyArchived`: do **not** overwrite existing `archivedAt` (preserve original archive time).
  3. `archiveSessions` conflict repair (`resolveConflicts` keeping archived): write `op: "archive"` only if the ledger has no active timestamp for that `sessionId`.
  4. `unarchiveSessions` (normal restore & conflict resolution keeping active): after move/cleanup succeeds, append `op: "clear"` so an external file move back to `archive/` cannot resurrect a stale `archivedAt`.
  5. `cleanupRemovedSessionStateInternal` / `removeSessionFiles` (deletion): if `archive-meta.jsonl` exists and currently holds an entry for `sessionId`, append `op: "clear"` (zero extra I/O when deleting active sessions that were never archived).
- **Best-effort & writer fencing:** All ledger writes run inside `assertCleanupOwned?.()` ownership checks and are best-effort (logging via `this.warn(...)` on failure without rolling back an already committed transcript move).
- **Concurrency & lazy compaction:** Writes serialize via the two-tier pattern used in [session-pr-service.ts](../../packages/core/src/services/session-pr-service.ts) (in-process per-path async queue + `proper-lockfile`). Under the write lock, when total lines exceed `256` and exceed `liveEntries * 3` (or file size exceeds `256 KiB`), compact by dropping cleared IDs and IDs lacking `<sessionId>.jsonl` in `chats/archive/`, replacing via `atomicWriteFileSync(..., { mode: 0o600 })`.
- **Lock-free reads & legacy compatibility:** Reads use a bounded single read (capped at `4 MiB`), return an empty map on `ENOENT`, ignore malformed lines, and validate `Number.isFinite(Date.parse(archivedAt))`. Pre-upgrade archived sessions without a ledger entry keep `archivedAt: undefined` (never fabricated from `mtime` or `ctime`).

#### Wire Propagation, Sorting, Pagination, and Capabilities

- **Types & mappers:**
  - Add `archivedAt?: string` to `SessionListItem` ([sessionService.ts](../../packages/core/src/services/sessionService.ts)), `BridgeSessionSummary` ([bridgeTypes.ts](../../packages/acp-bridge/src/bridgeTypes.ts)), and `DaemonSessionSummary` ([types.ts](../../packages/sdk-typescript/src/daemon/types.ts)).
  - Populate `archivedAt` in `SessionService.listSessions` (1 ledger read per call when `archiveState === 'archived'`) and `SessionService.getSessionListItem(..., 'archived')`.
  - Forward in `toSummary` ([session-list.ts](../../packages/cli/src/serve/server/session-list.ts)) and `toStandaloneSummary` ([standalone-session-service.ts](../../packages/cli/src/serve/conversations/standalone-session-service.ts)); preserve `archivedAt` in `withoutDecorations` (it is a core timestamp, not a sidecar decoration); validate optional string in `parseStandaloneSummary` ([standalone-sessions.ts](../../packages/sdk-typescript/src/daemon/standalone-sessions.ts)).
- **Extended `sortBy` contract:**
  - Widen `sortBy` across `GET /workspace/:id/sessions`, `GET /workspaces/:workspace/sessions`, `POST /sessions/catalog`, `GET /standalone/sessions`, and `DaemonClient` to `'updatedAt' | 'lastUserPromptAt' | 'archivedAt' | 'createdAt' | 'alphabetical'`.
  - **Route ownership & trust boundaries:** Every workspace route remains strictly selected-runtime scoped (read-only secondaries query persisted storage only and never fall back to primary); `GET /standalone/sessions` remains standalone-runtime scoped.
  - **Input validation (`400`):** Reject `sortBy=archivedAt` when `archiveState !== 'archived'` or `liveOnly=1`; reject `sortBy=createdAt|alphabetical` when `liveOnly=1`; reject unknown `sortBy` values; reject cross-sort cursors with `400 invalid_cursor`.
- **Cursor keys & deterministic ordering in `session-list.ts`:**
  - Route `archivedAt`, `createdAt`, and `alphabetical` through `listWorkspaceSessionsByMetadataForResponse` (and `listOrganizedWorkspaceSessionsForResponse` when `view=organized` is passed), binding `sortBy` into the cursor payload.
  - **`archivedAt` ordering:** Two-tier key `(hasPrimaryTime desc, activityTime desc, sessionId asc)` where sessions with valid `archivedAt` set `hasPrimaryTime: true` and sort by `Date.parse(archivedAt)`, followed by legacy sessions (`hasPrimaryTime: false`) sorted by `Date.parse(updatedAt ?? createdAt) || 0` desc, breaking ties by `sessionId` asc.
  - **`createdAt` ordering:** `(hasPrimaryTime desc, createdAtMs desc, sessionId asc)`.
  - **`alphabetical` ordering:** `(hasTitle desc, normalizedTitle asc, sessionId asc)` where untitled sessions (`!displayName?.trim()`) sort last and `normalizedTitle` uses `displayName.trim().toLocaleLowerCase('en')`.
  - **Cache reuse:** `PersistedSessionListCache` already invalidates `['active', 'archived']` on archive/unarchive/delete mutations, so `archivedAt` naturally stays fresh inside cached snapshots.
- **Capability gating:**
  - Register `session_archived_at_sort` in [capabilities.ts](../../packages/cli/src/serve/capabilities.ts) and mark `LEGACY_ONLY` in [capability-parity.ts](../../packages/cli/src/serve/capability-parity.ts) (matching `session_last_user_prompt_sort`).
  - SDK pre-flights `requireCapability('session_archived_at_sort')` when `sortBy` is `'archivedAt' | 'createdAt' | 'alphabetical'`. Web Shell defaults new users to `archivedAt` only when `session_archived_at_sort` is present, falling back to `updatedAt` (and client-side `createdAt`/`alphabetical`) on older daemons.

### 4.3 Phase 3 — Archived Transcript Content Search

- **Core (`packages/core/src/services/sessionService.ts`):**
  - Add `archiveState?: SessionArchiveState` (default `'active'`) to `SessionContentSearchOptions`.
  - Read from `this.getChatsDirForState(archiveState)` instead of hardcoded `'active'`.
  - When `archiveState === 'archived'`, order candidate files within the `maxFiles = 200` scan budget by `max(archivedAtMs ?? 0, mtime)` descending so recently archived older conversations are prioritized. Retain `AbortSignal` and `setImmediate` event-loop yielding.
- **Daemon (`packages/cli/src/serve/server/session-list.ts` & `routes/session.ts` & `routes/standalone-sessions.ts`):**
  - Pass `archiveState` through `searchWorkspaceSessionsForResponse` into `searchSessionContent`, `getSessionListItem(hit.sessionId, archiveState)`, `enrichWorktreeSidecars(..., archiveState)`, and `enrichPrSidecars(..., archiveState)`.
  - Extend `GET /workspace/:id/sessions/search` and `GET /workspaces/:workspace/sessions/search` with optional `archiveState=active|archived` (default `'active'`; invalid returns `400 invalid_search_archive_state`; preserves selected-runtime isolation).
  - Add standalone parity route `GET /standalone/sessions/search?q=...&archiveState=active|archived&maxResults=...` filtering to valid standalone top-level sessions and excluding deletion-journal entries.
  - Register `session_archived_content_search` and `standalone_session_content_search` in `capabilities.ts` / `capability-parity.ts`.
- **SDK & Web Shell:**
  - Extend `DaemonClient.searchWorkspaceSessions` with `archiveState?: DaemonSessionArchiveState` (pre-flighting `session_archived_content_search` when `'archived'`) and add `searchStandaloneSessions`.
  - Add `useArchivedContentSearch` in Web Shell (300 ms debounce, min length 2 chars, `AbortController`, max 3 concurrent workspace requests when `All workspaces` is active, 1 workspace when filtered, silent degradation on missing capability).
  - Merge hits with local matches via `mergeSessionContentHits` (admitting ghost hits beyond page 100) and render `sessionSearchSnippet` inside archived card rows.

---

## 5. Constraints, Risks, and Mitigations

| Risk / Constraint                                                                    | Impact                                                        | Mitigation                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing CSS & E2E tests assert `.sessionMetaSlot` and `390×900` touch button bounds | Breaking active sidebar or touch E2E tests                    | Keep active `.sessionMetaSlot` untouched; render archived card rows with a dedicated `.archivedCardRow` layout validated at both `1440×900` and `390×900` |
| Legacy archives lack `archivedAt`                                                    | Confusing or fake dates if `updatedAt` is shown as "Archived" | Keep `archivedAt: undefined` on legacy items; display explicit context labels ("Archived" vs. "Updated")                                                  |
| Ledger write failure or concurrent daemon/CLI archive processes                      | Lost timestamp or corrupt JSONL tail                          | Best-effort writes (never fail transcript move), `proper-lockfile` + atomic compaction, tolerant line parser                                              |
| Fan-out search burst across many workspaces                                          | Saturated daemon I/O when typing search in `All workspaces`   | 300 ms debounce, min 2 chars, abort superseded requests, scan only workspaces with archived sessions, concurrency cap of 3                                |
| Older daemon incompatibility                                                         | 400 errors on unknown `sortBy` or `archiveState`              | Gate new query parameters behind `session_archived_at_sort`, `session_archived_content_search`, and `standalone_session_content_search`                   |

---

## 6. Validation Plan & Acceptance Criteria

### 6.1 Validation Plan

- **Phase 1:** Unit tests in `ArchivedSessionsPanel.test.tsx`, `StandaloneRecents.test.tsx`, `SessionDetailsTooltip.test.tsx`, and `WebShellSidebar.css.test.ts`; Chromium E2E in [web-shell.archived-settings.spec.ts](../../packages/web-shell/client/e2e/web-shell.archived-settings.spec.ts) across desktop (`1440×900`) and touch (`390×900`) plus visual screenshot inspection.
- **Phase 2:** Core unit tests for `session-archive-metadata.ts` and `SessionService` (normal archive, `alreadyArchived` preservation, conflict repair, unarchive/delete clear, case-insensitive IDs, corrupt line recovery, lazy compaction, legacy `undefined`); daemon/SDK unit tests (`sortBy=archivedAt|createdAt|alphabetical`, mixed legacy+new cursor pagination, `400` invalid combinations, cross-sort cursor rejection, capability fallback); real `qwen serve` smoke verification confirming `archivedAt !== updatedAt` across restarts and renames.
- **Phase 3:** Core/daemon/SDK tests for `archiveState=archived` search isolation, sidecar hydration, standalone search filtering, `400` validation, and `AbortSignal` cancellation; Web Shell tests/E2E for snippet display and ghost-hit actions beyond page 1.
- **Repository gates before each PR:** `npm run build && npm run typecheck`, `npm run lint`, and targeted package vitest/playwright suites.

### 6.2 Acceptance Criteria

1. Users can search archived sessions by title, prompt, session ID, branch/worktree/PR/issue (Phase 1) and transcript message content (Phase 3).
2. Users can filter by workspace (including `No-workspace sessions`), conversation `Type` (`All conversations` / `Tasks` / `Channels` / `Local` / `Cloud` where applicable), and sort by `Archived`, `Updated`, `Last question`, `Created`, or `Alphabetical` with independent host-scoped persistence.
3. Archived rows display formatted timestamps inline and distinguish `Archived` from `Updated` in hover details; pre-upgrade archives never display fabricated `archivedAt` timestamps.
4. Workspaces with >100 archived sessions paginate cleanly via `Load more`, and older daemons without new capabilities continue functioning without errors.

---

## 7. Rollout Milestones & Open Questions

### 7.1 Milestones

- **Milestone 0:** Merged bilingual design docs (`docs/design/`) and tracking issue.
- **Milestone 1 (Phase 1 PR):** Web Shell `ArchivedSessionsPanel` UI, client filtering/sorting/timestamps, and per-workspace `Load more`.
- **Milestone 2 (Phase 2 PR):** Core `archive-meta.jsonl` ledger, `archivedAt` propagation, server-side `archivedAt`/`createdAt`/`alphabetical` sorting, SDK, and `session_archived_at_sort`.
- **Milestone 3 (Phase 3 PR):** Archived workspace & standalone content search, `session_archived_content_search` / `standalone_session_content_search`, and snippet rendering.

### 7.2 Open Questions

- **Group `...` overflow actions:** Deferred past V1; decide in a follow-up whether group-level `Unarchive all` or `Delete all` is needed and what confirmation guardrails it requires.
- **Read-only archive preview (`#13018`):** Independent follow-up; clicking an archived card row can navigate to a read-only transcript viewer once `#13018` lands without changing the Phase 1–3 card layout.
