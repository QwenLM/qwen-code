# Web Shell Workspace Extra Directories

[English](web-shell-workspace-directories.md) | [简体中文](web-shell-workspace-directories.zh-CN.md)

Status: implemented in the working tree (2026-10-24); not yet merged.

## Problem

The CLI exposes `/directory add <path>` and `/directory show`, which extend the
session's workspace context with additional directories and persist them to the
workspace settings key `context.includeDirectories`. The Web Shell has no
equivalent surface: the Settings panel never renders that key (it is
`showInDialog: false` and outside the daemon's settings allowlist), and no route
inspects or mutates the directory list. A Web Shell user therefore cannot do
from the UI what a CLI user does with one command.

## Current state

- `packages/core/src/utils/workspaceContext.ts` owns the directory set. It
  canonicalizes paths with `realpathSync`, refuses missing or non-directory
  paths, protects the primary directory as an "initial" directory, and answers
  containment checks (`isPathWithinWorkspace`) used by workspace-bounded tools.
  `addDirectory` logs and skips unreadable paths instead of throwing.
- `packages/cli/src/ui/commands/directoryCommand.tsx` implements
  `/directory add`. It calls `WorkspaceContext.addDirectory`, merges the
  accepted paths into workspace settings `context.includeDirectories`, reloads
  hierarchical memory when `context.loadFromIncludeDirectories` is on, and
  notifies the model through `GeminiClient.addDirectoryContext`.
- In the daemon, every session owns a `Config` and therefore its own
  `WorkspaceContext`, built at session creation from the merged settings.
  `WorkspaceContext` is not shared between sessions. The workspace runtime also
  holds a base `Config`.
- Workspace-scoped REST routes are registered with
  `resolveWorkspaceRuntimeFromParam` plus `requireTrustedWorkspaceRuntime`, and
  persist settings through `prepareSettingWrite` + the daemon's `persistSetting`
  dependency.
- The Web Shell Settings panel renders daemon setting descriptors generically
  (boolean / enum / number / text) and supports a few bespoke sections
  (`local-control`, `connections`, `model-management`). It has no array editor,
  so `context.includeDirectories` could not be edited even if it were exposed.
- The Add Workspace dialog already contains the directory input, debounced
  autocomplete (`workspace-path-suggestions`) and native picker
  (`workspace-directory-picker`) that this feature needs.

## Goals

- List, add, and remove extra workspace directories from the Web Shell Settings
  panel, under a new Workspace category.
- Match CLI semantics: a change applies to the workspace's live sessions
  immediately and is persisted so later sessions inherit it.
- Reuse the existing directory input, autocomplete, and native picker.
- Keep the primary workspace directory visible and non-removable.

## Non-goals

- Multi-root workspace identity. A workspace is still identified by its single
  cwd; extra directories only widen the file-access and tool-search roots.
- Editing the user-scope `context.includeDirectories`.
- Managing directories for a workspace other than the selected one, or for
  workspaces the daemon cannot run (SSH, managed, standalone).
- A general array editor in the Settings panel.

## Design

### HTTP surface

Three workspace-qualified routes, trust-gated like the existing
`/workspaces/:workspace/settings` pair:

| Route                                              | Purpose                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /workspaces/:workspace/directories`           | `{ primaryDirectory, directories }`; `directories` are the extra entries persisted at workspace scope. |
| `POST /workspaces/:workspace/directories`          | body `{ path }`; returns `{ primaryDirectory, directories, changed, warnings }`.                       |
| `DELETE /workspaces/:workspace/directories?path=…` | returns `{ primaryDirectory, directories, changed, warnings }`.                                        |

`changed` reports whether the persisted list changed; `warnings` carries
per-session memory or model-context refresh failures that did not block the
mutation.

Failure shapes follow the existing routes: `403 untrusted_workspace`,
`400 invalid_path` / `invalid_scope`-style codes, `404 workspace_not_found`,
`409 directory_management_unsupported` for SSH or managed workspaces,
`409 restrictive_sandbox`, `500 persist_error`.

GET reads the workspace settings file directly instead of round-tripping to the
ACP child. The persisted list is what new sessions will get, and unlike the live
runtime state it does not depend on which session last ran `/directory add`.

### Mutation path

POST and DELETE forward to one new ACP control method,
`qwen/control/workspace/directories`, with `{ action: 'add' | 'remove', path }`.
The handler in `acpAgent.ts` owns the whole mutation, mirroring the CLI command:

1. Reject when the runtime is in restrictive sandbox mode, when the session
   source is standalone/managed-conversation-bound, or when the workspace cwd is
   not a local path.
2. Add requires an absolute path: reject NUL bytes, missing paths, and
   non-directories, then canonicalize with `fs.stat` + `fs.realpath`. Remove
   accepts the persisted or display spelling (absolute, relative, or `~`) and
   resolves it against the workspace root; NUL bytes are still rejected.
3. Remove: refuse to remove the workspace's primary directory. Add: refuse to
   add it (`primary_directory`), because it is always part of the workspace. A
   session that `/cd`'d into the extra directory treats it as its own working
   directory, so that session is skipped with a warning instead of failing the
   whole workspace-level removal.
4. Read the mutation base from the settings layer with environment variables
   resolved, and match/remove live roots using those resolved values. Apply the
   delta to every live config: the workspace base config plus each active
   session's config. Add via `WorkspaceContext.addDirectory`; remove via
   `removeDirectory`.
5. Persist the new list to workspace settings `context.includeDirectories`
   using the original spelling (deduplicated; the primary directory is never
   written).
6. For each changed config with `shouldLoadMemoryFromIncludeDirectories()`,
   call `refreshHierarchicalMemory()`.
7. For each changed session, call `getLlmClient()?.addDirectoryContext()` so the
   model learns the new roots.

Memory and model-context failures are collected as `warnings` and returned in
the response; the mutation still succeeds because the directory set and the
settings file are already consistent.

The daemon route is a thin transport: resolve the runtime, enforce trust, map
`RequestError` codes to HTTP status, and return the handler result. It does not
re-persist the setting, so there is exactly one writer for this key.

### Capability

A new conditional feature tag `workspace_directories`, advertised when the
daemon wires `persistSetting` (the same condition as `workspace_settings`) and
experimental paired engines are off. Paired engines keep managed sessions on a
second ACP child that a workspace-scoped mutation cannot reach, so that mode
omits both the route and the tag instead of applying the change to one engine
only. The tag is registered in `SERVE_CAPABILITY_REGISTRY`, the toggle map, the
managed parity table (no managed equivalent), and the conditional table in
`docs/developers/qwen-serve-protocol.md`.

### Web Shell

- `WorkspaceDaemonClient` gains `directories()`, `addDirectory(path)`, and
  `removeDirectory(path)`, with matching types in the daemon type surface.
- `useWorkspaceActions` gains `listWorkspaceDirectories`,
  `addWorkspaceDirectory`, and `removeWorkspaceDirectory`, each wrapped in the
  standard mutation timeout; a mutation invalidates the cached list.
- The Settings panel gains a `Workspace` category rendered only for the
  Workspace scope tab, containing one bespoke item backed by a new
  `WorkspaceDirectoriesSection` component. The section shows the primary
  directory as read-only, lists the extra directories with a remove button, and
  offers "Add directory".
- The add flow reuses `AddWorkspaceDialog` with two new optional props (`title`
  and `submitLabel`) instead of a second dialog implementation; path
  autocomplete and the native picker come from the existing workspace actions.
- The section is hidden when the connection lacks `workspace_directories`, when
  no workspace is selected, or when the workspace cwd is an SSH location.
- The section carries an explicit note that extra directories widen the file
  access boundary beyond the workspace root.
- All new copy lands in `i18n.tsx` for both English and Simplified Chinese.

## Files affected

- `packages/core/src/**` — no change expected.
- `packages/acp-bridge/src/status.ts` — new control method constant.
- `packages/cli/src/acp-integration/acpAgent.ts` — control method handler.
- `packages/cli/src/serve/routes/workspace-directories.ts` (new) and its test.
- `packages/cli/src/serve/server.ts` — route registration.
- `packages/cli/src/serve/capabilities.ts`,
  `packages/cli/src/serve/capability-parity.ts`,
  `packages/cli/src/serve/run-qwen-serve.ts` — capability tag and toggle.
- `docs/developers/qwen-serve-protocol.md` — conditional table entry.
- `packages/sdk-typescript/src/daemon/DaemonClient.ts` and daemon types.
- `packages/web-shell/client/daemon/workspace/actions.ts` and `types.ts`.
- `packages/web-shell/client/components/workspaces/WorkspaceDirectoriesSection.tsx`
  (new) with a collocated test.
- `packages/web-shell/client/components/messages/SettingsMessage.tsx`.
- `packages/web-shell/client/components/dialogs/AddWorkspaceDialog.tsx`.
- `packages/web-shell/client/i18n.tsx`.

## Design decisions

- **The ACP runtime owns the mutation.** The CLI command already writes the
  workspace setting from the runtime; keeping one writer avoids two persistence
  paths with different locking and lets the handler validate against the real
  filesystem of the machine that runs the tools.
- **Delta, not full sync.** Add and remove are separate actions. A full-list
  sync would have to canonicalize stale persisted entries and decide what to do
  with directories a session added outside the UI.
- **Live apply to every session.** The user chose workspace-wide semantics.
  Applying only to the current session would leave sibling sessions with a
  different view of the workspace until they restart.
- **GET reads settings.** It is cheap, needs no bridge round-trip, and states
  what the next session will inherit. The trade-off is that a session that ran
  `/directory add` from the composer can be ahead of the list until a UI
  mutation or daemon restart reconciles it; that divergence already exists for
  every sibling session today.
- **No removal of initial directories.** Enforced in the handler with
  `isInitialDirectory`, so the workspace root can never be dropped.
- **Reuse `AddWorkspaceDialog`.** It already implements autocomplete, Browse,
  keyboard handling, and inline errors; a second picker dialog would duplicate
  them.

## Security and constraints

- Adding a directory widens the roots that workspace-bounded tools may read and
  write. The route is trust-gated, the capability is explicit, and the UI says
  so.
- SSH, managed, and standalone workspaces are refused: their filesystem
  validation does not happen on the daemon host, and the CLI blocks `/directory`
  for standalone sessions as well.
- The route never accepts a relative path or a path containing NUL.
- Persistence requires a trusted workspace; an untrusted write is already
  rejected by the existing trust gate.

## Risks

- Memory refresh runs per live session, so a workspace with many sessions pays
  that cost on each mutation. It only runs when
  `context.loadFromIncludeDirectories` is enabled.
- A directory can disappear between validation and use; `WorkspaceContext`
  logs and skips it, and the next GET still lists it until the user removes it.
  The handler returns the canonical path it validated so the client can show
  what was actually added.
- Settings writes from the runtime share the file with other settings writers;
  the list read-modify-write is not atomic with a concurrent MCP server edit or
  a second directory mutation from another client. The UI serializes its own
  requests, and a lost entry is recoverable by adding it again.

## Validation plan

- Unit tests: route status mapping and trust gating; handler add/remove/live
  apply/persistence/warnings; capability advertisement; daemon client request
  shapes; section rendering, add, remove, and error states; dialog prop
  overrides.
- E2E: start a daemon, list directories, add one through the UI, confirm the
  live session can read a file from it, remove it, confirm the tool boundary
  rejects the path again, and restart the daemon to confirm persistence.
- Docs contract test for the conditional capability table.

## Acceptance criteria

- The Settings Workspace tab lists the primary directory and every extra
  directory persisted at workspace scope.
- Adding a valid directory returns it in the list, applies to live sessions,
  and survives a daemon restart.
- Removing an extra directory applies to live sessions and removes it from
  settings; the primary directory cannot be removed.
- Untrusted, SSH, managed, and standalone workspaces do not offer the section or
  answer a mutation successfully.
- An add with a relative path or any path containing NUL returns `invalid_path`;
  a missing path or a file returns `directory_not_found`. Adding the primary
  directory returns `primary_directory`. Remove accepts relative and `~`
  spellings.
- Existing relative, `~`, or environment-variable entries are listed as the
  runtime resolves them, and removing one clears it from every live session.

## Open questions

None blocking. If removal ever needs a confirmation step, it can be added
without changing the daemon contract.
