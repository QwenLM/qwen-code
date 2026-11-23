# Cross-workspace file open from another session's message

Issue: https://github.com/QwenLM/qwen-code/issues/18198

## Baseline

- Web shell 0.28.x: clicking a file path / markdown link / local image in a
  message resolves the target workspace from the app-level current session
  (the last-active session), not the viewed message's session. With the
  current session in another workspace, a relative path is stat'd in the
  wrong workspace and the open fails with
  `GET /workspaces:<wrong-ws>/stat: ENOENT ... lstat '<wrong-cwd>/...'`.
- Note: the issue report cites bundle symbols for a `qwen:open-file`
  listener using `yn.current.sessionContext`. No such listener exists in
  current source (verified by `git grep` at HEAD and at the v0.28.3 tag);
  the same defect class is present at the file-preview tab creation sites
  and the turn-calls panel, which this change fixes.

## Local setup

1. Create two isolated temporary workspaces, A and B.
2. Put the same relative sentinel file in both workspaces with different
   contents, e.g. `docs/runbooks/agent-briefs.md` containing
   `SENTINEL_A_18198` in A and `SENTINEL_B_18198` in B.
3. Start the built `dist/cli.js serve` on loopback with both `--workspace`
   flags and the production Web Shell bundle.
4. Open a session in workspace A and run a tool call that reads the
   sentinel (so the turn's tool-call list has a file link), then switch
   the active session to workspace B.

## Scenarios

### Absolute file link opens in the workspace the file lives in

From the workspace-B session, open the workspace-A turn's tool-call list
and click the file link for `/<workspace-a>/docs/runbooks/agent-briefs.md`.

Expected:

- The preview opens and shows `SENTINEL_A_18198`, never `SENTINEL_B_18198`.
- No `ENOENT` stat error is shown.
- The file tab is owned by workspace A (its workspace indicator / route
  targets `/workspaces/<workspace-a>/...`).

### Relative file link follows the turn's workspace, not the current session

From the workspace-B session, open the workspace-A turn's tool-call list
and click the file link for the relative path
`docs/runbooks/agent-briefs.md`.

Expected:

- The preview opens and shows `SENTINEL_A_18198`.
- The stat request targets workspace A, not workspace B.

### Turn-calls tab survives switching the current session

Open the turn-calls tab for a workspace-A turn, then switch the app-level
current session to workspace B and back to A.

Expected:

- The tab still lists the workspace-A turn (it does not load workspace B's
  turn or go blank).
- File links in the tab still resolve in workspace A.

### Stale current after switching workspaces

Open a workspace-A turn's tool-call list, then switch workspaces so the
app-level connection briefly still reports the previous workspace.

Expected:

- File links are stat'd and opened in workspace A; no request targets
  workspace B for the workspace-A turn.

### Attachment preview with an absolute path

Open an attachment whose `workspacePath` is an absolute path inside
workspace A while the current session is in workspace B.

Expected:

- The attachment preview loads from workspace A; the pre-check stat does
  not fail against workspace B.

## Evidence

- Focused test output for the workspace resolver, turn-calls panel, file
  preview button, transcript viewport, and app tab propagation.
- Production build/typecheck/lint output.
- Captured two-workspace HTTP route log and sentinel contents.
- Browser screenshot of the file preview opened from the other session's
  turn when the local browser harness can represent it.

## Results

Not yet executed in this environment: the plan needs a built production
bundle (`npm run build`) and a live browser harness. The focused unit and
component suites below cover the same assertions at the component level.
