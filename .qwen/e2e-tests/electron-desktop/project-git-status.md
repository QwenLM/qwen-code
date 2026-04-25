# Electron Desktop E2E Record: Project Registry and Git Status

Date: 2026-04-25

## Slice

Slice 9: Project Registry and Git Status.

## User-Visible Scenario

1. Launch the desktop app with a temporary HOME/QWEN_RUNTIME_DIR and fake ACP.
2. Open a temporary Git workspace through the desktop Open Project flow.
3. Verify the project appears in the left Projects list.
4. Verify the top bar and right Review panel show Git branch/status counts.
5. Create a new local thread and verify session listing is scoped to the active
   project path.
6. Refresh Git status after adding staged, modified, and untracked files.

## Assertions

- First screen is not black and contains `Qwen Code`, `Open Project`, `Review`,
  and `Settings`.
- Local service status is `Connected`.
- Recent project row shows the selected project name and Git branch label.
- Top bar shows a branch label or `No Git branch`.
- Review panel shows Modified, Staged, and Untracked counts.
- Network requests to `/api/projects`, `/api/projects/open`, and
  `/api/projects/:id/git/status` succeed with bearer auth.
- Renderer console has no uncaught exceptions.

## Diagnostics on Failure

- Save renderer screenshot.
- Save renderer console errors and failed network requests.
- Save Electron main stdout/stderr.
- Save the temporary desktop project store JSON.
- Save `git -C <workspace> status --porcelain=v1 --branch` output.

## Automated Coverage Added This Iteration

The full Playwright Electron harness is still pending. This iteration added
server-level coverage in `packages/desktop/src/server/index.test.ts`:

- opens a temporary Git project through `/api/projects/open`;
- persists it to a desktop project store;
- verifies `/api/projects` returns the recent project;
- verifies `/api/projects/:id/git/status` returns staged, modified, and
  untracked counts;
- verifies invalid project paths return a typed `project_path_invalid` error.

## Execution Results

- `npm run test --workspace=packages/desktop` passed: 7 files, 45 tests.
- `npm run typecheck --workspace=packages/desktop` passed.
- `npm run lint --workspace=packages/desktop` passed.
- `npm run build --workspace=packages/desktop` passed.

## Remaining Risk

This slice does not yet verify the real Electron renderer with screenshot/CDP.
Slice 13 must convert the scenario above into repeatable Playwright Electron
coverage and collect the diagnostics listed here.
