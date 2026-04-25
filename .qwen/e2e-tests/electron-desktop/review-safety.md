# Electron Desktop E2E: Review Safety Terminology

Slice: Review safety terminology and discard confirmation.
Date: 2026-04-25.

Executable harness:

- `packages/desktop/scripts/e2e-cdp-smoke.mjs`

Scenario steps:

1. Launch real Electron with isolated HOME, runtime directory, user-data
   directory, temporary Git workspace, and fake ACP enabled.
2. Open the fake Git project and send the first composer prompt without
   creating a thread manually.
3. Approve the fake command request and wait for the fake ACP response.
4. Open the Changes drawer and assert the conversation remains visible.
5. Assert review actions use Stage/Discard terminology and no main review
   action contains Accept/Revert wording.
6. Click Discard All, assert the inline confirmation names the destructive
   action and explains the local-change risk, then cancel it.
7. Assert the confirmation is gone and the dirty counts remain unchanged.
8. Stage all changes, enter a commit message, commit from the drawer, and
   verify the Git worktree is clean.
9. Continue through settings and terminal attach-to-composer paths to ensure
   the full desktop workflow still passes.

Assertions:

- The review drawer exposes `Discard All`, `Stage All`, `Discard File`,
  `Stage File`, `Discard Hunk`, and `Stage Hunk`.
- `Accept` and `Revert` labels are absent from the main review drawer.
- Discard confirmation exposes `Cancel Discard` and `Confirm Discard`.
- Canceling discard does not mutate modified/staged/untracked counts or the
  temporary Git worktree.
- Staging all changes updates the topbar count to `0 modified · 2 staged · 0
  untracked`.
- Committing from the UI creates the expected latest Git commit and leaves the
  temporary workspace clean.
- Console errors and failed local requests are absent.

Exact command:

```bash
cd packages/desktop && npm run e2e:cdp
```

Result:

- Passed.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-18-14-754Z/`.
- Key files: `review-safety-initial.json`, `discard-confirmation.json`,
  `discard-cancel-git-status.txt`, `review-drawer.png`,
  `completed-workspace.png`, `summary.json`, `electron.log`.

Known uncovered risk:

- The harness verifies canceling destructive discard and the existing commit
  flow. It does not intentionally confirm discard because that would remove
  the changes needed for the rest of the smoke workflow; server-side discard
  mutation remains covered by existing Git review service tests.
