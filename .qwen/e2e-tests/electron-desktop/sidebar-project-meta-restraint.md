# Sidebar Project Meta Restraint

Date: 2026-04-27 (Asia/Shanghai)

## Slice

Split sidebar project-row Git metadata into compact branch and dirty elements.
Project names stay primary, long branch names are shortened in visible sidebar
text, and dirty state remains visible without turning the project browser into
raw Git diagnostics.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch real Electron with isolated HOME, user-data, runtime, workspace, and
   fake ACP.
2. Open the fake Git project, which starts on a long branch with one modified
   file and one untracked file.
3. Inspect sidebar project-row DOM metrics after sending the first prompt and
   creating the fake ACP thread.
4. Continue the existing composer, branch create/switch, review, settings,
   terminal attach, and follow-up send workflows.

## Assertions

- Project rows expose separate `project-row-name`, `project-row-branch`, and
  `project-row-dirty` elements.
- The visible sidebar branch label is shortened to `desktop-e2e/very-lo...`
  while the full branch remains in the title.
- The dirty badge renders `2 dirty` with a detailed title of
  `1 modified · 0 staged · 1 untracked`.
- Sidebar text does not expose the raw long branch name, and project metadata
  does not overflow horizontally.
- Sidebar width, row height, typography, footer placement, thread title noise
  restraint, and existing workbench paths remain within the CDP thresholds.
- The run records zero console errors and zero failed local requests.

## Commands

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-47-14-573Z/`

Key files:

- `sidebar-app-rail.json`
- `topbar-context-fidelity.png`
- `summary.json`

`sidebar-app-rail.json` recorded the active project row as
`desktop-e2e-workspace-YmMYZZ, desktop-e2e/very-lo..., 2 dirty`, with no
project metadata overflow. `summary.json` recorded zero console errors and zero
failed local requests.

## Known Uncovered Risk

This slice only shortens branch metadata in the sidebar. It does not add
project-row overflow menus, branch switching from the sidebar, or generated
project grouping beyond the current project list.
