# Project-Level Extensions Support

## Background

Currently, extensions only support **user-level** installation (`~/.qwen/extensions/`). Although the codebase already has `Storage.getExtensionsDir()` returning `<project>/.qwen/extensions/` and a public `loadExtensionsFromDir(dir)` method, neither is called during normal startup.

This design proposes supporting project-level extension installation, so that extensions can be scoped to a specific project and only take effect within that project.

## Current Architecture

### Storage Paths

| Level   | Method                                    | Path                          |
| ------- | ----------------------------------------- | ----------------------------- |
| User    | `Storage.getUserExtensionsDir()` (static) | `~/.qwen/extensions/`         |
| Project | `Storage.getExtensionsDir()` (instance)   | `<project>/.qwen/extensions/` |

### Loading Flow

1. `Config.initialize()` creates `ExtensionManager` with `workspaceDir` and calls `refreshCache()`
2. `refreshCache()` only loads from `ExtensionStorage.getUserExtensionsDir()` (`~/.qwen/extensions/`)
3. `loadExtensionsFromDir(dir)` exists as a public method but is never invoked
4. `performWorkspaceExtensionMigration()` is dead code (defined but never called)

### Installation Flow

- `installExtension()` always installs to `ExtensionStorage.getUserExtensionsDir()`
- Destination directory: `~/.qwen/extensions/<extension-name>/`

### Key Files

| File                                              | Role                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/core/src/extension/extensionManager.ts` | Core: Extension interface, refreshCache, install/uninstall, enablement |
| `packages/core/src/config/storage.ts`             | Storage paths: getUserExtensionsDir (user), getExtensionsDir (project) |
| `packages/core/src/extension/storage.ts`          | ExtensionStorage: per-extension directory management                   |
| `packages/cli/src/commands/extensions/install.ts` | CLI install command handler                                            |
| `packages/cli/src/commands/extensions/utils.ts`   | CLI utilities, list output formatting                                  |

## Proposed Design

### 1. New Type: `ExtensionScope`

Add to `packages/core/src/extension/extensionManager.ts`:

```typescript
export enum ExtensionScope {
  User = 'user',
  Project = 'project',
}
```

Extend `Extension` interface with a `scope` field:

```typescript
export interface Extension {
  // ... existing fields ...
  scope: ExtensionScope;
}
```

### 2. Loading: `refreshCache()` Changes

Modify `refreshCache()` (line 544) to also load project-level extensions:

1. Load user-level extensions first, tag with `scope: User`
2. If `isWorkspaceTrusted === true`, load from `<project>/.qwen/extensions/`, tag with `scope: Project`
3. **Conflict resolution**: when both levels have same-named extension, user-level wins; project-level is dropped with a debug log warning
4. If `isWorkspaceTrusted === false`, skip project-level loading entirely (consistent with project hooks trust gating)

```typescript
async refreshCache(options?: { names?: string[] }): Promise<void> {
  this.extensionCache = new Map<string, Extension>();
  // ...existing name-based loading...

  // 1. Load user-level extensions
  const userExtensions = await this.loadExtensionsFromExtensionsDir(
    ExtensionStorage.getUserExtensionsDir(), this.workspaceDir,
  );
  userExtensions.forEach(ext => ext.scope = ExtensionScope.User);
  const extensions = [...userExtensions];

  // 2. Load project-level extensions (trust-gated)
  if (this.isWorkspaceTrusted && this.workspaceDir) {
    const projectExtensionsDir = new Storage(this.workspaceDir).getExtensionsDir();
    const projectExtensions = await this.loadExtensionsFromExtensionsDir(
      projectExtensionsDir, this.workspaceDir,
    );
    projectExtensions.forEach(ext => ext.scope = ExtensionScope.Project);

    const userNames = new Set(userExtensions.map(e => e.name));
    for (const projExt of projectExtensions) {
      if (userNames.has(projExt.name)) {
        // user-level wins, skip project-level duplicate
      } else {
        extensions.push(projExt);
      }
    }
  }

  extensions.forEach(ext => this.extensionCache!.set(ext.name, ext));
}
```

### 3. `loadExtensionByName()` Changes

Modify `loadExtensionByName()` (line 580) to also search project-level directory when the extension is not found at user level:

```typescript
async loadExtensionByName(name: string, workspaceDir?: string): Promise<Extension | null> {
  // ... existing user-level search ...

  // If not found at user level, try project level (trust-gated)
  if (this.isWorkspaceTrusted && cwd) {
    const projectExtensionsDir = new Storage(cwd).getExtensionsDir();
    // search projectExtensionsDir subdirectories...
  }

  return null;
}
```

### 4. `installExtension()` Changes

Add `scope` parameter (line 842):

```typescript
async installExtension(
  installMetadata: ExtensionInstallMetadata,
  requestConsent?: ...,
  requestSetting?: ...,
  cwd?: string,
  previousExtensionConfig?: ExtensionConfig,
  scope?: ExtensionScope,  // NEW
): Promise<Extension> {
```

Key changes:

- **Destination directory** (line 868): scope-aware resolution
  ```typescript
  const installScope = scope ?? ExtensionScope.User;
  const extensionsDir =
    installScope === ExtensionScope.Project
      ? new Storage(currentDir).getExtensionsDir()
      : ExtensionStorage.getUserExtensionsDir();
  ```
- **Enablement** (line 1113): project-level installs use `SettingScope.Workspace`
- **Loaded extension**: set `extension.scope = installScope`

### 5. `uninstallExtension()` Changes

Use the loaded extension's `scope` field to determine the correct directory:

- `scope === Project` -> delete from `<project>/.qwen/extensions/<name>/`
- `scope === User` -> delete from `~/.qwen/extensions/<name>/` (existing logic)

### 6. CLI Changes

#### `install` command

Add `--scope` option to `packages/cli/src/commands/extensions/install.ts`:

```typescript
.option('scope', {
  describe: 'Install scope: "user" (global, default) or "project" (current project only)',
  type: 'string',
  choices: ['user', 'project'],
  default: 'user',
})
```

Usage:

```bash
qwen extensions install <source> --scope project
```

#### `list` command

Show scope in output (`packages/cli/src/commands/extensions/utils.ts`):

```
output += `\n Scope: ${extension.scope ?? 'user'}`;
```

#### `uninstall` / `link` commands

Add `--scope` option for disambiguation when needed.

#### `enable` / `disable` commands

No changes needed — enablement already supports workspace scope via path-based rules.

## Design Decisions

| Decision            | Choice                               | Rationale                                                |
| ------------------- | ------------------------------------ | -------------------------------------------------------- |
| Storage location    | `<project>/.qwen/extensions/<name>/` | Follows existing `Storage.getExtensionsDir()` convention |
| Trust gating        | Required for project-level loading   | Consistent with workspace settings and project hooks     |
| Conflict resolution | User-level wins                      | Matches MCP server merge precedence                      |
| Version control     | User/team decides                    | `.qwen/extensions/` can be gitignored or committed       |

## Verification Plan

1. `qwen extensions install <source> --scope project` installs to `<project>/.qwen/extensions/`
2. `qwen extensions list` shows scope indicator (user/project)
3. Switch to another project directory — the project extension is not loaded
4. In an untrusted workspace, project-level extensions are not loaded
5. When both user + project have same-named extension, user takes precedence
6. `qwen extensions uninstall <name>` correctly deletes from the appropriate scope directory
