# Single-Store Multi-Version Extension Management

[English](2026-11-27-multi-version-extension-store.md) | [简体中文](2026-11-27-multi-version-extension-store.zh-CN.md)

- **Status**: Draft (Core & CLI implemented; Daemon V2 / TUI / Web Shell follow-up)
- **Date**: 2026-11-27
- **Related Issue**: [#18339](https://github.com/QwenLM/qwen-code/issues/18339)

## Problem Statement and Current State

Under Extension Management V2 ([extension-management-v2.md](extension-management-v2.md)), every installed extension lives in a single directory under `<QWEN_HOME>/extensions/<name>/`, and `ExtensionStore` enforces global case-insensitive name uniqueness across all installed artifacts. Passing `--scope workspace` only sets `defaultActivation: 'disabled'` with a per-workspace `enabled` override on that single copy.

As a result, developers cannot run two different versions or two local `link` branches of the same extension simultaneously across different workspaces on the same host, nor isolate workspace-specific settings when sharing a versioned artifact.

An earlier proposal in `#18339` suggested installing extensions physically inside `<workspace>/.qwen/extensions/<name>/` with a second per-workspace transactional store. While that aligns cosmetically with `.qwen/skills/`, extensions carry executable capabilities (MCP servers, shell/HTTP hooks, LSP servers, JS workflows, channels). Storing executable artifacts inside Git repositories introduces significant security and operational complexity: bypassing project hook/MCP approval gates on `git pull`, exposing a new Auto-Mode self-modification surface inside the workspace, requiring a second transactional store with cross-filesystem `.extension-tmp/` staging, dual generation tracking, and cross-store credential reference counting.

## Goals and Non-Goals

### Goals

- Support installing multiple versions or local `link` targets of the same extension under a single host-local `ExtensionStore`, keeping `<QWEN_HOME>/extensions/` clean.
- Store additional versioned copies under a sibling tree `<QWEN_HOME>/extension-versions/<name>/<versionSlot>/` on the same filesystem as `extension-store/` (no `EXDEV`, no second store, no repo pollution).
- Derive deterministic 64-char hex `extensionId` values from resolved version locators so installing the exact same real version across workspaces is idempotent and deduplicated on disk.
- Enforce per-workspace same-name mutual exclusion inside a single store transaction so at most one version of any extension is active in a workspace, with strict no-fallback when disabled.
- Isolate per-workspace `.env` and Keychain settings for shared versioned artifacts without mutating the shared artifact directory.
- Prevent unbounded version growth through automatic pruning of zero-reference version slots on version switch and an explicit `qwen extensions prune` command for stale workspace references.
- Fix CLI folder-trust handling to fail closed (`isTrusted === true`) instead of treating undecided (`undefined`) directories as trusted.

### Non-Goals

- Installing executable extension artifacts directly inside `<workspace>/.qwen/extensions/` (declarative team recommendations in project settings are a separate follow-up).
- Daemon V2 route updates, TypeScript SDK additions, Ink/OpenTUI dialog changes, and Web Shell UI changes are deferred to follow-up PRs once the Core & CLI contract is validated.
- Cloud-managed extension packages (`managed-agent-server`) are out of scope.

## Proposed Architecture

### Storage Layout

```text
<QWEN_HOME>/
├── extensions/                       # Unchanged: primary global installs (1 dir per extension)
│   ├── extension-enablement.json     # V1 projection (projects primary/default policy per name)
│   ├── extension-preferences.json
│   └── <name>/
├── extension-versions/               # Sibling tree for workspace-scoped versioned slots
│   └── <name>/
│       ├── 2.0.0/                    # Readable semver slot (or <label>-<id8> on collision/link/local)
│       └── link-feature-a1b2c3d4/
└── extension-store/                  # Single transactional V2 store (1 lock, 1 state.json, 1 generation)
    ├── lock
    ├── state.json                    # Optional policy.versionSlot points into extension-versions/
    ├── state.previous.json
    ├── staging/ | rollback/ | transactions/
    ├── plugin-data/agent-plugins/<extensionId>/
    └── workspace-env/<extensionId>/<sha256(canonicalWorkspace)>.env
```

Keeping `<QWEN_HOME>/extensions/` untouched for single-version global installs prevents top-level directory clutter and preserves compatibility with existing tools and older binaries.

### Deterministic Version Key and Idempotent Install

Non-credentialed versioned installs compute a deterministic `versionKey` persisted in `.qwen-extension-install.json`:

| Source Type                     | `versionKey` Formula                             | Idempotent Reuse       |
| ------------------------------- | ------------------------------------------------ | ---------------------- |
| `npm`                           | `npm:<registry>:<name>@<resolvedVersion>`        | Yes                    |
| `github-release`                | `gh-release:<source>:<releaseTag>`               | Yes                    |
| `git` (public)                  | `git:<source>:<gitCommit \|\| ref \|\| version>` | Yes                    |
| `link`                          | `link:<canonicalTargetPath>`                     | Yes                    |
| `local` / `archive-url`         | `content:<name>:<directoryContentSha256>`        | Yes                    |
| `snapshot` / `stored` HTTPS Git | None (retains random `installId`)                | Intentionally isolated |

The 64-char hex `extensionId` is `sha256("v2:" + baseId + ":" + versionKey)`. When two workspaces install the exact same version (e.g., `@acme/foo@2.0.0` or the same archive content), both derive the identical `extensionId`. If the artifact already exists on disk and in `state.json`, the store commits idempotently by updating `workspaceOverrides` without creating a duplicate directory.

### Single-Store Mutual Exclusion and Views

- **Mutual exclusion**: Within a single store lock transaction (`commitArtifact`, `setWorkspaceActivation`, `setDefaultActivation`, `setActivationScope`), enabling an extension instance for a workspace automatically sets `workspaceOverrides[canonicalWs] = 'disabled'` on all other installed instances with the same case-insensitive name. Disabling an instance never re-enables a sibling (no-fallback).
- **Effective vs. management views**: `ExtensionManager.extensionCache` is keyed by `extension.id`. `getLoadedExtensions()` returns at most one entry per name for `this.workspaceDir` (active version first, then primary non-versioned copy), protecting all downstream runtime registries (`MCP`, `Skills`, `Hooks`, `Commands`, `Agents`, `Workflows`, `LSP`) from same-name collisions. `getAllLoadedExtensions()` exposes all installed versions for management commands (`list --all`, `uninstall --version`, `prune`).

### Per-Workspace Settings Isolation

Because multiple workspaces can share an immutable version slot under `extension-versions/<name>/<slot>/`, workspace-scoped `.env` files for versioned extensions are written to `<QWEN_HOME>/extension-store/workspace-env/<extensionId>/<sha256(canonicalWorkspace)>.env`, and Keychain namespaces are keyed by `(extensionName, extensionId, canonicalWorkspaceDir)`.

### Version Pruning and Garbage Collection

- **Automatic cleanup on version switch**: After committing a new versioned workspace install, `ExtensionStore.pruneUnusedVersions()` removes any versioned slot (`policy.versionSlot !== undefined`) that has `defaultActivation === 'disabled'`, zero `'enabled'` workspace overrides, and no legacy path rules. Primary installs in `<QWEN_HOME>/extensions/<name>/` are never auto-pruned.
- **Explicit pruning**: `qwen extensions prune [--dry-run] [--keep-missing-workspaces]` removes workspace overrides pointing to deleted directories and reclaims any resulting zero-reference version slots along with their `workspace-env` and `plugin-data` directories.

### CLI Surface

- `qwen extensions install <source> --scope workspace`: Installs into a versioned slot (or idempotently reuses an existing identical slot) and activates it exclusively for the current workspace.
- `qwen extensions link <path> --scope workspace`: Links a local branch into a versioned slot scoped to the current workspace.
- `qwen extensions list [--all]`: Defaults to primary extensions plus versions active in the current workspace; `--all` shows all installed versions and their bound workspaces (flagging missing workspace paths).
- `qwen extensions uninstall <name> [--version <version|slot|idPrefix>]`: Supports targeting a specific version slot without wiping shared preferences while another version remains.
- `qwen extensions prune [--dry-run]`: Reclaims unreferenced versioned slots and stale workspace references.

## Constraints and Risks

- **Legacy binary compatibility**: Older binaries ignore `<QWEN_HOME>/extension-versions/` and continue reading `<QWEN_HOME>/extensions/` and `extension-enablement.json` (which projects the primary/default entry per name).
- **Workspace rename / ephemeral worktrees**: Path-keyed `workspaceOverrides` reset if a directory is renamed, matching existing Folder Trust and V2 activation semantics; `qwen extensions prune` cleans up orphaned entries.
- **Team sharing**: Sharing extension recommendations via Git is intentionally decoupled from binary artifact storage and left for a declarative project manifest follow-up.

## Validation Plan and Acceptance Criteria

1. **Multi-version coexistence & mutual exclusion**: Global `foo@1.0.0` in `extensions/foo/` coexists with workspace `foo@2.0.0` in `extension-versions/foo/<slot>/`; workspace A runs `1.0.0`, workspace B runs `2.0.0`, disabling `2.0.0` in B does not fall back to `1.0.0`, and `getLoadedExtensions()` returns strictly one `foo` per workspace.
2. **Idempotent reuse**: Installing the same archive/version in workspace B again and in workspace C produces the same `extensionId`, creates only one directory under `extension-versions/foo/`, and activates both workspaces independently.
3. **Auto-prune & explicit `prune`**: Switching workspace B from `2.0.0` to `3.0.0` automatically reclaims `2.0.0` when unreferenced (and retains `2.0.0` while workspace C still uses it); deleting workspace C and running `prune` removes stale references and reclaims `2.0.0`.
4. **Per-workspace settings & `link --scope workspace`**: Two workspaces sharing `2.0.0` write isolated `.env` files under `extension-store/workspace-env/`, and two workspaces can link two distinct local branches concurrently.
5. **CLI fail-closed trust**: Undecided (`isTrusted: undefined`) workspaces are rejected on CLI extension installs instead of failing open.

## Follow-Up Work

- Expose multi-version management and versioned installs in Daemon V2, TypeScript SDK, Ink/OpenTUI, and Web Shell.
- Add declarative project-level extension recommendations (e.g., in `.qwen/settings.json`) with one-click consented installation into the versioned store.
