# Branch picker action hints

## Scenario

Open a trusted git workspace in the Web Shell (`qwen serve` + the sidebar).
Click the branch chip on the workspace folder header (or the composer chip /
Environment panel row) to open the branch picker. Exercise the repo through
these states between opens:

1. Tracking `origin/main`, in sync, clean tree.
2. `git reset --hard HEAD~3` (behind 3, clean).
3. Same as 2 plus an edited tracked file and one new untracked file.
4. `git checkout -b feat/no-upstream` with one local commit (no upstream).
5. Start a conflicting `git rebase` and leave it in progress.
6. `git checkout --detach`.
7. Start a conflicting `git merge` on a branch with one commit ahead.
8. Push a branch with `-u`, delete it on the remote, `git fetch --prune`.

## Checks

- State 1: Update Project shows "Up to date", Push shows "Nothing to push",
  Commit shows "No changes"; all three rows are dimmed but still enabled.
- State 2: Update Project shows "↓3 · origin/main" in the neutral tone.
- State 3: Update Project shows "↓3 · uncommitted changes" in the warning tone
  and stays enabled; Commit shows "2 changes (1 untracked)" (entries, not
  files: a partially staged file counts twice).
- State 4: Update Project shows "No upstream" and is disabled; Push shows
  "Sets upstream on push" and is enabled.
- State 5: Update Project and Push both show "Rebasing" in the warning tone and
  are disabled (a rebase detaches HEAD); Commit stays enabled.
- State 6: Update Project and Push both show "Detached HEAD" and are disabled.
- State 7: Update Project shows "Merging" and is disabled; Push shows "Merging"
  in the warning tone but stays enabled (a push does not consult the index).
- State 8: Update Project shows "Upstream gone" and is disabled; Push shows
  "Sets upstream on push".
- After committing through the Commit dialog and reopening the picker from
  any of the three entry points (sidebar chip, composer chip, Environment
  panel), the Commit hint reflects the new tree without waiting for the poll.
- With the picker open, run `git branch --unset-upstream` in a terminal and
  refocus the window: once the chip's status updates, Update Project flips to
  disabled "No upstream" without reopening.
- Switching the UI language to 中文 renders the localized copy
  ("已是最新", "无上游分支", "↓3 · 有未提交更改", "2 处更改（1 未跟踪）").

## Evidence

Unit coverage lives in
`packages/web-shell/client/components/BranchPickerPopover.test.tsx`
(`deriveActionHints` decision table + rendered disabled/tone assertions) and the
open-time status refresh in
`packages/web-shell/client/components/sidebar/WorkspaceSection.test.tsx`.

```sh
cd packages/web-shell && npx vitest run \
  client/components/BranchPickerPopover.test.tsx \
  client/components/sidebar/WorkspaceSection.test.tsx \
  client/components/panels/EnvironmentPanel.test.tsx
```
