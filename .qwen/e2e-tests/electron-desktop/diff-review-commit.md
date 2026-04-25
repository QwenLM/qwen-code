# Electron Desktop E2E Record: Diff Review and Commit

Date: 2026-04-25

## Slice

Slice 12 basic diff review and commit.

## User-Visible Scenario

1. Launch the desktop app with a temporary HOME/QWEN_RUNTIME_DIR and fake ACP.
2. Open a temporary Git workspace with an initial commit.
3. Modify a tracked file and create an untracked file.
4. Verify the right Review panel lists changed files and textual diff content.
5. Stage all changes from the Review panel.
6. Enter a commit message and commit.
7. Verify the Review panel returns to a clean state.

## Assertions

- `GET /api/projects/:id/git/diff` returns modified and untracked files.
- The Review panel shows changed file count and diff text.
- `POST /api/projects/:id/git/stage` updates Git status from modified/untracked
  to staged.
- `POST /api/projects/:id/git/commit` creates a commit and returns a clean
  status.
- `POST /api/projects/:id/git/revert` cleans tracked and untracked changes when
  explicitly invoked.
- Commit and Git errors are displayed in the review area.

## Diagnostics on Failure

- Save renderer screenshot.
- Save renderer console errors and failed network requests.
- Save Electron main stdout/stderr.
- Save `git -C <workspace> status --porcelain=v1 --branch`.
- Save `git -C <workspace> diff` and `git -C <workspace> diff --cached`.
- Save DesktopServer responses for diff/stage/revert/commit routes.

## Automated Coverage Added This Iteration

The full Electron E2E harness is still pending. This iteration added
server-level coverage in `packages/desktop/src/server/index.test.ts`:

- opens a registered project and reads `/git/diff`;
- verifies modified and untracked files are returned with diff text;
- stages all changes and verifies status counts;
- commits staged changes and verifies a clean status;
- reverts all changes and verifies the workspace returns to the initial file
  content.

## Execution Results

- `npm run test --workspace=packages/desktop` passed: 8 files, 50 tests.
- `npm run typecheck --workspace=packages/desktop` passed.
- `npm run lint --workspace=packages/desktop` passed.
- `npm run build --workspace=packages/desktop` passed.

## Remaining Risk

Hunk-level accept/revert, inline comments, Open in Editor, and real Electron
renderer assertions are not complete yet. They remain required before the MVP
can be marked done.
