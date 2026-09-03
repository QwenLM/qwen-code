# Push hints follow the push destination

## Scenario

Open a trusted git workspace in the Web Shell and open the branch picker from
the sidebar git chip with the repo in each state:

1. Tracking upstream, ahead 1 / behind 0 (pushable).
2. Behind 3, clean tree, ahead 0.
3. Ahead 1 / behind 1 (diverged).
4. Conflicted merge in progress on the branch, ahead 1 / behind 1.
5. Behind 1 with a dirty tracked file whose incoming change conflicts; click
   Update Project to raise the 409 resolution panel.
6. Triangular (fork) workflow with a resolvable push destination:
   `branch.<name>.remote = upstream`, `branch.<name>.pushRemote = origin`,
   **and `push.default = current`** (required — under the default
   `push.default=simple`, git refuses to resolve `@{push}` in this shape and
   the listing reports configured-but-unknown); behind `upstream/main` by 3,
   ahead of `origin/main` by 2.
7. Same config but `push.default` left at its default `simple`: the push
   side is configured-but-unresolvable.
8. `branch.<name>.pushRemote = origin` with `push.default = current`, never
   pushed to origin — the push ref does not exist yet.
9. Detached HEAD (`git checkout --detach`).

## Checks

Only state 9 disables Push — a detached HEAD is the one push failure provable
from local state alone. Everything count-based warns on an enabled row and
lets git answer authoritatively on click:

- State 1: Push shows `↑1`, enabled.
- State 2: Push shows the warning `↓3`, enabled; clicking surfaces git's own
  non-fast-forward rejection in the status line.
- State 3: Push shows the warning `↑1 ↓1 · diverged`, enabled.
- State 4: Push shows the warning "Merging", enabled (a push does not consult
  the index).
- State 5: the panel is up; Push still renders its own hint and stays
  enabled. Clicking Push clears the panel and shows the push outcome.
- State 6: Update Project shows `↓3 · upstream/main`; Push shows `↑2`
  (push-side counts), enabled.
- State 7: Push shows **no hint** — git declined to name a destination, so
  the row makes no count claim; enabled.
- State 8: Push shows "Creates origin/<branch>", enabled.
- State 9: Update Project and Push disabled with "Detached HEAD".
- After a **failed** Update Project against a force-reset upstream (reset the
  remote branch to an ancestor in a second clone, no fetch in between): the
  pull fails, and the re-fetched listing updates the rows in place — the pull
  row leaves its stale `↓n` without reopening the popover. (A *deleted*
  upstream ref defeats the fetch itself; only a prune refreshes that shape,
  as the rule-site comment states.)
- After a **rejected** Push, both the listing and the working-tree status
  re-read (a rejected push is the strongest evidence the counts were stale).

## Evidence

Round 2 pivoted from disabling on `behind > 0` to warn-only after review
measured the disable misfiring across independent config axes
(`remote.<name>.push` refspecs / Gerrit, forcing refspecs, triangular
`push.default=simple`, `checkout -b` name-mismatch shapes, stale last-fetch
counts): remote acceptance is not locally decidable. Unit coverage pins the
warn-only rule, the push-side count display, the configured-but-unknown
silence, the `pushGone` copy, and the failure-refresh render effect; core
pins the push atoms and the `pushConfigured` probe (pushRemote,
remote.pushDefault, remote.<name>.push refspec, per-branch case-preserving
scoping, nonzero real-git `pushBehind`) under a hermetic env.

```sh
cd packages/web-shell && npx vitest run \
  client/components/BranchPickerPopover.test.tsx \
  client/components/sidebar/WorkspaceSection.test.tsx \
  client/components/panels/EnvironmentPanel.test.tsx \
  client/components/ChatEditor.test.tsx
cd packages/core && npx vitest run src/utils/git-branches.test.ts
```
