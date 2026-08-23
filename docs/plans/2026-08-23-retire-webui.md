# Retire `@qwen-code/webui`

Status: Draft

Depends on the complete VS Code Web Shell cutover draft
[#9811](https://github.com/QwenLM/qwen-code/pull/9811).

## Outcome

Delete the legacy shared package at `packages/webui` and remove every active
source, build, test, documentation, and dependency reference to
`@qwen-code/webui`.

This is a physical retirement, not a rename. Useful behavior must already live
in the SDK or Web Shell; obsolete components and adapters are deleted rather
than copied into another compatibility package.

## Target boundary

The target is the workspace package whose manifest name is
`@qwen-code/webui`.

The following similarly named products are not removed:

- `packages/desktop/apps/webui`, which is a desktop application;
- the user-facing `qwen --webui` mode;
- Web Shell itself.

Renaming those unrelated surfaces would be a product/API change and is not
required to remove the legacy shared package.

## Prerequisite

The preceding cutover PR must establish all of the following before this PR is
ready:

- `packages/web-shell` contains the daemon React providers and hooks it needs;
- `packages/web-shell` has no package, build, test, or source dependency on
  `@qwen-code/webui`;
- `packages/vscode-ide-companion` uses the complete Web Shell chat surface and
  has no dependency on `@qwen-code/webui`;
- all replaced VS Code presentational and interaction code is already deleted.

If any of those conditions are false, this PR must stay draft rather than add
a compatibility shim.

## Remaining consumers found in the repository

The pre-cutover tree contains 317 references outside `packages/webui`, spread
across production code, tests, configuration, and historical documentation.
Most Web Shell and VS Code references are removed by the prerequisite PR. The
remaining categories require explicit handling here.

### Exported HTML viewer

`packages/web-templates` currently compiles the WebUI source tree into an
inline UMD bundle and renders exported conversations with `ChatViewer`. This
is a real release consumer, not stale build configuration.

Replace it with the canonical pipeline:

1. parse the exported `ChatRecord` data;
2. project it with
   `projectChatRecordsToDaemonTranscript` from `@qwen-code/sdk/daemon`;
3. render the resulting blocks with `WebShellTranscript`;
4. inline the exact JavaScript and CSS assets at build time so an exported HTML
   file remains deterministic and works offline.

Preserve theme switching, code blocks, tool calls, file references, images,
and safe script inlining. Do not replace the embedded renderer with a CDN URL.

### Daemon integration tests

The live-journal recovery integration test imports
`DaemonSessionProvider` and `useTranscriptBlocks` from the old daemon React
subpath. Retarget it to the Web Shell-owned React layer established by the
prerequisite PR without weakening the live HTTP/SSE assertions.

### Legacy scripts and fixtures

The concurrent-runner HTML fixtures still load old WebUI UMD releases from
unpkg. Determine whether each fixture is exercised:

- delete it when no current command or test reaches it;
- otherwise migrate it to the self-contained Web Shell transcript bundle.

The Web Shell E2E harness that imports `ChatViewer` follows the same rule. It
must not keep the package alive solely as a visual fixture.

### Build and repository configuration

Remove the package from:

- root build orchestration;
- workspace lock data;
- Vite aliases and externals;
- TypeScript path mappings;
- ESLint special cases;
- visual-test path filters and publishing scripts;
- release and capture tooling;
- package dependency manifests.

Regenerate `package-lock.json` through npm; do not hand-edit the lock graph.

### Documentation

Update active architecture, daemon adapter, quickstart, and package reference
documentation to name Web Shell as the React owner and the SDK as the
transport/transcript owner.

Historical design documents may retain links to the old package only when the
text is clearly historical and not presented as current guidance. Active
commands or file paths must not point to deleted files.

## Deletion inventory

At the investigated head, the package contains approximately:

| Area | Lines including tests and styles | Destination |
| --- | ---: | --- |
| Daemon React layer | 36,787 | Moved into Web Shell by the prerequisite PR |
| Presentational components | 16,642 | Already replaced by Web Shell; delete |
| ACP/JSONL adapters | 573 | Replace with canonical SDK projections; delete |
| Context, hooks, types, and utilities | 1,043 | Move only live primitives in prerequisite PR; delete remainder |

The final removal deletes the package manifest, source, Storybook/Vite/Tailwind
configuration, package-local tests, and generated package output rules.

## Implementation sequence inside this PR

1. Migrate the exported HTML viewer and add offline rendered-output tests.
2. Retarget the daemon integration test and any still-live visual fixtures.
3. Remove active configuration and documentation references.
4. Delete `packages/webui` in one change.
5. Regenerate the lockfile and generated export template.
6. Add a repository gate that rejects active `@qwen-code/webui` imports,
   dependencies, aliases, and build entries.

These are steps in one cleanup PR, not additional PR boundaries.

## Verification

### Focused behavior

- Build a self-contained exported conversation HTML file with no network
  access and open it in Chromium.
- Confirm transcript text, thought, code highlighting, tool calls, images, and
  light/dark theme behavior with screenshot evidence.
- Run the daemon live-journal recovery integration test against the relocated
  provider layer.

### Repository gates

- Build and test `@qwen-code/web-shell`.
- Build and test the VS Code companion.
- Build and test `packages/web-templates` and its generated export artifact.
- Run the relevant integration test, typecheck, lint, and package build gates.
- Run `npm install --package-lock-only` or the repository-equivalent lock
  regeneration and verify a clean second run.
- Verify that no active source or configuration imports, declares, aliases, or
  builds `@qwen-code/webui`.
- Verify that the root build and release package inventory succeeds without a
  `packages/webui` directory.

### Regression evidence

Reuse the real VS Code E2E suite from the prerequisite PR as a regression
check; this deletion must not change the companion UI. Add Before/After
screenshots for the exported HTML viewer because that renderer changes in this
PR.

## Completion criteria

- `packages/webui` does not exist.
- No workspace manifest or lockfile entry defines `@qwen-code/webui`.
- No active source, build, test, or documentation path imports or points to the
  deleted package.
- Exported conversation HTML is still self-contained and verified offline.
- Web Shell, VS Code, daemon integration, and release build checks pass.
- CI prevents a future production dependency on `@qwen-code/webui`.
