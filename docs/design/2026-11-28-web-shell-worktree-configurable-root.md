# Configurable managed worktree root (P7)

[English](2026-11-28-web-shell-worktree-configurable-root.md) | [简体中文](2026-11-28-web-shell-worktree-configurable-root.zh-CN.md)

- Status: Proposed and in implementation on branch `feat/web-shell-worktree-p7` (branched from `origin/main` `32d857ab81`).
- Tracks: [#17237](https://github.com/QwenLM/qwen-code/issues/17237) (P7) and addresses the shared configuration request in [#15292](https://github.com/QwenLM/qwen-code/issues/15292).
- Builds on: `2026-11-14-web-shell-codex-worktree-parity.md` (D2 / P7) and `2026-11-21-web-shell-worktree-retention-restore.md` (P6 U4/U5).
- E2E plan: `.qwen/e2e-tests/2026-11-28-web-shell-worktree-configurable-root.md`.

## Problem and pre-change state

General-purpose CLI worktrees (`--worktree`, `enter_worktree`, `exit_worktree`, `agent` `isolation: "worktree"`, workflow isolation) and Web Shell / daemon managed session worktrees (`POST /session`, handoff, branch, reset, restore, orphan cleanup, retention) all share `GitWorktreeService.getUserWorktreesDir()`, which currently hardcodes `<repoRoot>/.qwen/worktrees`.

Projects whose build tools, IDEs, or file watchers scan dotfiles or treat `.qwen/` specially have no way to relocate managed worktrees inside the repository. Before this change:

- `settingsSchema.ts` exposes `worktree.defaultForNewSessions`, `worktree.symlinkDirectories`, and `worktree.maxRetained`, with no root setting.
- `GitWorktreeService.getUserWorktreesDir()`, `ensureWorktreesExcludeRule()`, `removePreparedUserWorktree()`, and `symlinkConfiguredDirectories()` hardcode `.qwen/worktrees` and only guard `.git` and `.qwen` against symlink recursion.
- Security-sensitive containment and ownership checks in `worktreeSessionService.ts`, `session.ts`, `session-restore.ts`, `worktree-orphan-cleanup.ts`, `worktree-retention.ts`, `worktree-snapshot-binding.ts`, `worktree-snapshot-pairs.ts`, `session-worktree-restore.ts`, `branch-worktree-preparation.ts`, `workspace-route-runtime.ts`, and `workspace-git-worktrees.ts` hardcode `.qwen/worktrees` or instantiate `GitWorktreeService` with no root setting.
- Nested-worktree guards (`worktreeStartup.ts`, `enter-worktree.ts`, `agent.ts`, `workflow-orchestrator.ts`), stale cleanup (`Config.initialize()`, `worktreeCleanup.ts`), resume project-hash matching (`sessionService.ts`), workspace artifact path helpers (`workspace-artifact-path.ts`, `workspace-artifact-directory.ts`), and Web Shell UI (`GitModePopover.tsx`, `SettingsMessage.tsx`) hardcode `.qwen/worktrees`.

## Goals and scope boundaries

### Goals

1. Add `worktree.root` as a unified repository-relative setting (default `.qwen/worktrees`) governing both CLI general-purpose worktrees and Web Shell / daemon managed session worktrees.
2. Enforce strict path validation and containment (fail closed on invalid settings, absolute paths, `..` traversal, `.git`, direct `.qwen`, and symlink/junction escapes outside the repository root for custom roots).
3. Migrate all hardcoded `.qwen/worktrees` production sites across `packages/core`, `packages/cli`, and `packages/web-shell` to derive from the single validated `worktree.root` helper.
4. Keep `worktree.symlinkDirectories` recursion protection sound for any configured `worktree.root` (rejecting both descendants and ancestors of the configured root).
5. Surface `worktree.root` in Web Shell settings (`GET`/`POST` `/workspace/settings` and `/workspaces/:workspace/settings`), regenerate `settings.schema.json`, and show the effective root in `GitModePopover`.

### Out of scope

- Out-of-repository absolute paths for `worktree.root` (kept out of scope so managed checkouts remain inside the trusted repository subtree and daemon shell-guard containment stays sound without widening trust boundaries).
- Arena multi-model worktrees (`agents.arena.worktreeBaseDir` continues to govern `~/.qwen/arena`).
- Automatic migration of pre-existing checkouts on disk when a user edits `worktree.root`.
- Unrelated open daemon-guard issues ([#11503](https://github.com/QwenLM/qwen-code/issues/11503) and [#13705](https://github.com/QwenLM/qwen-code/issues/13705)).

## Decisions and rationale

### 1. Setting key and unified scope (`worktree.root`)

Use `worktree.root` (type `string`, default `'.qwen/worktrees'`, `requiresRestart: false`) in `settingsSchema.ts` and `WorktreeSettings`. Both CLI worktrees and Web Shell session worktrees already share `GitWorktreeService.getUserWorktreesDir()`, so one setting keeps behavior uniform across CLI and Web Shell and satisfies `#15292` without introducing an alias (`worktree.baseDir`). `agents.arena.worktreeBaseDir` stays separate for Arena.

`worktree.root` is honored from User scope (`~/.qwen/settings.json`), System scope, and trusted Workspace scope (`<repo>/.qwen/settings.json`), matching `worktree.symlinkDirectories`, `worktree.defaultForNewSessions`, and `worktree.maxRetained`. Untrusted workspaces never load `.qwen/settings.json`.

### 2. Validation and canonical normalization

A single zero-dependency core module `packages/core/src/utils/worktree-root.ts` defines `DEFAULT_WORKTREE_ROOT`, `InvalidWorktreeRootError`, `validateWorktreeRoot`, and `parseWorktreeRoot`:

- `undefined` resolves to `.qwen/worktrees` (`isDefault: true`).
- Non-string, empty/whitespace-only, leading/trailing whitespace, control characters (`[\x00-\x1f\x7f]`), NUL, CR/LF, or length > 240 chars are rejected.
- Absolute POSIX paths (`/…`), Windows drive/UNC paths (`C:…`, `\\…`), tilde paths (`~`, `~/…`), and colons (`:`) in any segment are rejected.
- Any `..` segment is rejected. Redundant `.` and trailing slashes are normalized; an empty normalized result (e.g. `.`, `./`) is rejected.
- First segment `.git` (case-insensitive) is rejected.
- Exact single segment `.qwen` (case-insensitive) is rejected so worktrees cannot collide with `.qwen/settings.json`, `.qwen/commands/`, or hide all of `.qwen/` in `.git/info/exclude`. Subdirectories under `.qwen/` (such as `.qwen/worktrees` or `.qwen/wt`) remain valid.
- Canonical form is POSIX slash-separated `segments.join('/')`.

### 3. Fail-closed invalid settings and symlink/junction containment

- **API writes**: `validateSettingValue` validates `worktree.root` via `validateWorktreeRoot`, rejecting invalid values with HTTP `400` (`code: 'invalid_value'`) on both `/workspace/settings` and `/workspaces/:workspace/settings`.
- **Runtime reads**: Daemon routes and services read `worktree.root` through `readRuntimeWorktreeRoot(runtime)` / `readWorkspaceWorktreeRoot(cwd, ...)` using `readSettingsSnapshot` (no disk mutation, respects `workspaceTrusted`, validates `worktree` is a plain object). Invalid values throw `InvalidWorktreeRootError` instead of silently falling back to `.qwen/worktrees`:
  - Creation / handoff / branch routes return `400` (`code: 'invalid_worktree_root'`).
  - Retention pauses with `settingsError` (fail-closed) and re-verifies `worktree.root` per candidate alongside `maxRetained`.
  - Orphan cleanup preserves the checkout with a diagnostic log.
  - CLI `restoreWorktreeContext` warns and skips restore without deleting the sidecar.
  - CLI `--worktree`, `enter_worktree`, `exit_worktree`, `agent`, and workflow isolation return a clear error.
- **Symlink / junction handling**:
  - For all roots (default and custom), the resolved managed directory must never resolve to `canonicalRepoTop` itself or inside `canonicalGitDir`, and leaf symlinks (`<root>/<slug> -> outside`) are always rejected by realpath containment.
  - For custom roots (`!isDefault`), `assertWorktreeRootContainment` requires every existing prefix component along `worktree.root` inside `repoTop` to be a real directory (rejecting symlinks and Windows junctions — even those pointing inside the repository) and enforces that the resolved managed directory lies strictly inside `canonicalRepoTop`. This keeps creation, `changeSessionCwd` relocation containment, `isBranchWorktreeCreationSupported`, `removePreparedUserWorktree`, and `.git/info/exclude` in full agreement.
  - Existing tests for operator-symlinked default `.qwen/worktrees` remain preserved; `isBranchWorktreeCreationSupported` continues to require real non-symlink directories (`lstat().isDirectory()`) along every prefix of the configured root, and `removePreparedUserWorktree` continues to require exact canonical path identity `<canonicalRepo>/<root>/<slug>`.

### 4. Git ignore, `symlinkDirectories`, artifacts, and daemon shell guard

- **`.git/info/exclude`**: For the default `.qwen/worktrees`, `ensureWorktreesExcludeRule()` writes `/.qwen/worktrees/` and runs legacy `.qwen/.gitignore` migration. For any custom `worktree.root`, it writes a per-checkout rule (`/<root>/<slug>/`) on creation and removes that exact rule on checkout removal, so pointing `worktree.root` at a directory that already holds user files never hides non-worktree files from git, and legacy `.qwen/.gitignore` is left untouched.
- **`worktree.symlinkDirectories`**: Rejects `.git`, `.qwen`, AND any configured symlink path (lexical or realpath) that is either inside the configured `worktree.root` or an ancestor of it (e.g., `symlinkDirectories: ["tmp"]` when `worktree.root: "tmp/wts"`), preventing recursive worktree-inside-worktree loops.
- **Nested-worktree guards**: `worktreeStartup.ts`, `enter-worktree.ts`, `agent.ts`, and `workflow-orchestrator.ts` check git structurally (`GitWorktreeService.isLinkedWorktree()`, catching any checkout created under a previous root) plus anchored `isPathInsideWorktreeRoot(cwd, worktreeRoot, repoTop)` and the reserved default `.qwen/worktrees` path, so repositories living under an ancestor directory sharing the root name (such as `/tmp/qwen-code` with `worktree.root: "tmp"`) are never falsely rejected.
- **Workspace artifacts & resume matching**: `resolveBoundWorkspaceRoot`, `toCanonicalWorkspaceArtifactPath`, `stripWorktreeArtifactPrefix`, `pathHasSkippedDirectoryComponent`, and `SessionServiceOptions.worktreeRoot` (consumed by `sessionBelongsToCurrentProject`) accept the configured `worktreeRoot` so dot-prefixed custom roots (like `.worktrees`) do not trip the artifact skip-directory gate, non-worktree repos under `<parent>/<root>/<repo>` never widen their bound workspace root, and `--resume` / daemon session catalogs still match custom-root transcripts.
- **Daemon git worktree guard (`daemon-git-worktree-guard.ts`)**: Because custom `worktree.root` is strictly contained within `canonicalRepoTop`, an isolated sub-agent's `canonicalReported` cwd remains inside `sessionCwd`, and `resolveDiscoveredRepository(canonicalReported, sessionCwd) === canonicalReported` pins the sub-agent to its own checkout without needing a hardcoded path check. Regression tests explicitly verify custom-root sub-agent confinement.

### 5. Route ownership classification (daemon routes)

- `GET`/`POST` `/workspace/settings`: legacy-primary workspace scoped (reads/writes primary workspace or user scope).
- `GET`/`POST` `/workspaces/:workspace/settings`: selected-runtime scoped (trust-gated, workspace-only writes).
- `POST /session`, `POST /session/:id/worktree-{reset,branch,handoff,restore}`, `POST /session/:id/branch`, `DELETE /session/:id`: live-session-owner / selected-runtime scoped; each resolves `worktree.root` from that runtime's workspace settings, never falling back to the primary runtime.
- `GET /workspaces/:workspace/git`, `GET /workspaces/:workspace/git/worktrees`: selected-runtime scoped; resolves `worktree.root` from the selected runtime only.
- Background retention (`worktree-retention.ts`): daemon-wide per active runtime; collision detection evaluates each runtime's resolved management root and fails closed if any sibling in the same repository has unreadable/invalid settings or is non-active.

## Risks and mitigations

- **Changing `worktree.root` with existing sessions**: Existing checkouts created under the previous root will fail strict containment under the new root (fail-closed: they are neither silently deleted nor silently adopted). Recovery is either reverting `worktree.root` or manually removing the old checkout.
- **Symlinked custom root in a trusted repo**: A committed symlink at the configured custom root pointing outside the repo is blocked by `assertWorktreeRootContainment` before `mkdir` or `git worktree add`, and rejected by all read/restore/cleanup containment checks.
- **Stale `settings.schema.json`**: Regenerated via `scripts/generate-settings-schema.ts` in the same commit.

## Validation plan and acceptance criteria

1. **Unit & integration tests**:
   - `worktree-root.test.ts`: validation matrix (valid single/multi-segment roots, normalization, rejection of absolute/drive/UNC/`~`/`..`/`.`/empty/control-chars/`.git`/`.qwen`/over-long), path helpers, and symlink/junction containment (in-repo vs escaping vs `.git` vs repoTop).
   - `gitWorktreeService` tests: custom root creation, `.git/info/exclude` rule generation without removing legacy `.qwen/.gitignore`, `symlinkDirectories` ancestor/descendant recursion blocking, and `removePreparedUserWorktree` identity check.
   - `worktreeSessionService`, `worktreeCleanup`, `enter-worktree`, `exit-worktree`, `agent`, `worktreeStartup`, `workspace-artifact-path`, `workspace-artifact-directory`, `sessionService`: custom root end-to-end behavior + invalid-root fail-closed tests.
   - Daemon serve tests: `workspace-settings` (GET/POST validation + i18n), `session` (create, handoff, branch, reset, restore, delete), `worktree-orphan-cleanup`, `worktree-retention`, `session-worktree-restore`, `branch-worktree-preparation`, `workspace-route-runtime`, `workspace-git-worktrees`, `daemon-git-worktree-guard`.
   - Web Shell tests: `GitModePopover` custom root display, `SettingsMessage` rendering/saving `worktree.root`, and locale coverage tests.
2. **E2E verification**: Real isolated CLI (`--worktree`) and `qwen serve` daemon HTTP + real git repository tests verifying custom `worktree.root` lifecycle (create, `.git/info/exclude`, handoff, retention snapshot + restore, symlink-escape rejection, invalid-setting 400).
3. **Build, lint, typecheck, schema sync**: `npm run build`, `npm run typecheck`, `npm run lint`, and clean `packages/vscode-ide-companion/schemas/settings.schema.json`.
