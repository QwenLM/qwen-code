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

## Checks

- State 1: Update Project shows "Up to date", Push shows "Nothing to push",
  Commit shows "No changes"; all three rows are dimmed but still enabled.
- State 2: Update Project shows "↓3 · origin/main" in the neutral tone.
- State 3: Update Project shows "↓3 · uncommitted changes" in the warning tone
  and stays enabled; Commit shows "2 files (1 untracked)".
- State 4: Update Project shows "No upstream" and is disabled; Push shows
  "Creates remote branch" and is enabled.
- State 5: Update Project and Push both show "Rebasing" in the warning tone and
  are disabled; Commit stays enabled.
- State 6: Update Project and Push both show "Detached HEAD" and are disabled.
- After committing through the Commit dialog and reopening the picker, the
  Commit hint reflects the new tree without waiting for the 60s poll.
- Switching the UI language to 中文 renders the localized copy
  ("已是最新", "无上游分支", "↓3 · 有未提交更改", "2 个文件（1 未跟踪）").

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
