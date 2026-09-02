# Secondary artifact workspace ownership

Issue: https://github.com/QwenLM/qwen-code/issues/8494

## Baseline

- Global CLI: `qwen 0.21.3`
- `qwen serve --help` confirms repeated `--workspace` registration and Web
  Shell serving are available.
- Current component behavior is captured failure-first: an artifact tab with
  no owner uses root workspace actions, and scheduled-task detail omits the
  secondary `workspaceId`.

## Local setup

1. Create isolated primary and secondary temporary workspaces.
2. Put the same relative sentinel filename in both workspaces with different
   contents.
3. Create distinct durable scheduled-task fixtures for both runtimes.
4. Start the built `dist/cli.js serve` on loopback with both `--workspace`
   flags and the production Web Shell bundle.

## Scenarios

### Secondary file action

Open a secondary-session artifact and download/preview its sentinel.

Expected:

- The request targets `/workspaces/<secondary>/file...`.
- The returned bytes are the secondary sentinel, never the primary sentinel.

### Secondary scheduled task

Open the secondary durable task, toggle it, edit it, and delete the test copy.

Expected:

- Every request targets `/workspaces/<secondary>/scheduled-tasks...`.
- The primary task and primary task file are unchanged.

### Ownership loss

Keep an artifact tab open, then remove or mark the secondary workspace
unavailable in the capability fixture before a delayed read resolves.

Expected:

- The panel displays the localized workspace-unavailable state.
- The delayed response is ignored.
- No request is retried against the primary route.

## Evidence

- Focused test output for resolver, turn outputs, artifact panel, nested
  subagent, and app tab propagation.
- Production build/typecheck/lint output.
- Captured two-workspace HTTP route log and sentinel hashes.
- Browser screenshot of the secondary artifact panel and the fail-closed
  ownership-loss state when the local browser harness can represent it.

## Results (2026-08-04)

Result: PASS

### Automated verification

- Failure-first run: 3 expected failures and 29 existing passes. The primary
  sentinel leaked into an ownerless tab, the secondary qualified client was
  unused, and scheduled-task list omitted `workspaceId`.
- Focused ownership suite: 413/413 tests passed across the six affected test
  files.
- Full Web Shell suite: 167 files and 2,777 tests passed.
- Web Shell lint and TypeScript typecheck passed.
- Package Web Shell build and repository root production build passed.
- The changed files pass Prettier. The package-wide format check still reports
  five unchanged baseline files:
  `BranchPickerPopover.module.css`, `GitModePopover.module.css`,
  `GitDialog.module.css`, `PlanExecutionView.module.css`, and `index.html`.

### Production two-workspace verification

The built CLI served the copied production bundle with two trusted workspaces.
`GET /capabilities` advertised distinct primary and secondary runtime IDs, and
the served JavaScript contained the new stale-owner guard.

The same relative file was read through both routes:

- `GET /file?path=artifact-owner.txt` returned
  `PRIMARY_WORKSPACE_SENTINEL_8494`, SHA-256
  `818d5f4f1fb9c7e3f9bdfd9a3ad39361c93a23ca3f3d0ba5e4a7c889b33b9127`.
- `GET /workspaces/<secondary-id>/file?path=artifact-owner.txt` returned
  `SECONDARY_WORKSPACE_SENTINEL_8494`, SHA-256
  `0e9fac7909b16ff8b17014ea103ed5018c8b4e9ad21d2f95e128fef3a3544a12`.
- The secondary bytes route returned only the secondary sentinel bytes.

Durable task CRUD was exercised against isolated primary and secondary task
fixtures:

- Secondary list, update, and delete requests all used
  `/workspaces/<secondary-id>/scheduled-tasks...`.
- The secondary update changed only the secondary name/enabled state.
- The primary task remained present, enabled, and unchanged after that update.
- Deleting the secondary task emptied only the secondary list; the primary
  task was still present. Both test tasks were then removed.

The daemon request log independently recorded the qualified file, bytes,
scheduled-task POST/GET/PATCH/DELETE routes and their successful statuses.

### Visual evidence

The in-app browser runtime reported no available browser instance, so a UI
screenshot could not be captured in this environment. No synthetic screenshot
was substituted. The production server returned the current Web Shell bundle
with HTTP 200, and the DOM behavior is covered by the focused and full suites
above.
