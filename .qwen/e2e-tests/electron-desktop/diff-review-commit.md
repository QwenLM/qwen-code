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

Iteration 10 extended the server and Electron E2E coverage:

- opens a registered project and reads `/git/diff`;
- verifies modified and untracked files are returned with diff text;
- verifies changed files include typed hunk metadata;
- stages all changes and verifies status counts;
- stages one hunk from a multi-hunk tracked file and verifies only that hunk is
  accepted into the index;
- reverts a remaining unstaged hunk and verifies the file content is restored
  while the accepted hunk remains staged;
- commits staged changes and verifies a clean status;
- reverts all changes and verifies the workspace returns to the initial file
  content.
- launches Electron through `npm run e2e:cdp --workspace=packages/desktop`,
  opens a temporary Git workspace, clicks Accept Hunk, verifies the accepted
  state, adds an inline review note, and continues through the existing
  permission/settings/terminal smoke.

## Execution Results

- `npm run test --workspace=packages/desktop` passed: 9 files, 54 tests.
- `npm run typecheck --workspace=packages/desktop` passed.
- `npm run lint --workspace=packages/desktop` passed.
- `npm run build --workspace=packages/desktop` passed.
- `npm run e2e:cdp --workspace=packages/desktop` passed with artifacts under
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T03-08-06-087Z/`.

## Remaining Risk

Hunk-level accept/revert, inline comments, Open in Editor, and real Electron
renderer assertions now have initial coverage. Remaining review risk is around
complex Git states such as renames, binary files, conflicting stale hunks, and
persisting review comments beyond the local renderer session.
