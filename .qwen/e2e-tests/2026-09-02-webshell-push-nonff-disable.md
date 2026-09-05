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
   the listing names no push destination); behind `upstream/main` by 3,
   ahead of `origin/main` by 2.
7. Same config but `push.default` left at its default `simple`: git names no
   push destination, though a bare `git push` still succeeds via the
   configured `pushRemote`.
8. `branch.<name>.pushRemote = origin` with `push.default = current`, never
   pushed to origin — the push ref does not exist yet.
9. A tracking upstream whose name the branch does not match — from `master`,
   `git push origin master:bar`, `git branch --set-upstream-to=origin/bar`,
   then one local commit — with `push.default` at its default, so the branch
   is ahead 1 of an upstream git will not turn into a push destination. Git
   names no destination *and* refuses the bare push (`exit 128`).
   `push.default = nothing` on an otherwise plain tracking branch is the
   sibling shape.
10. A branch with no upstream at all, in a repo that configures a repo-wide
    push override (`remote.pushDefault`, or a `remote.<name>.push` refspec).
11. Detached HEAD (`git checkout --detach`).

## Checks

Only state 11 disables Push — a detached HEAD is the one push failure provable
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
- State 7: Push shows **no hint** — git named no destination, so the row
  makes no count claim; enabled.
- State 8: Push shows "Creates origin/<branch>", enabled.
- State 9: Push shows **no hint**, enabled. The upstream `↑1` must not appear
  as a push count here: git refuses this push outright, and clicking surfaces
  git's own refusal in the status line.
- State 10: Push shows "Sets upstream on push", enabled — the daemon pushes a
  branch with no upstream through an explicit `--set-upstream` refspec, which
  ignores `push.default` and the repo-wide override.
- State 11: Update Project and Push disabled with "Detached HEAD".
- After a **failed** Update Project against a force-reset upstream (reset the
  remote branch to an ancestor in a second clone, no fetch in between): the
  pull fails, and the re-fetched listing updates the rows in place — the pull
  row leaves its stale `↓n` without reopening the popover. (A *deleted*
  upstream ref defeats the fetch itself; only a prune refreshes that shape,
  as the rule-site comment states.)
- After a **rejected** Push, both the listing and the working-tree status
  re-read. That is a re-read, not a fetch: a rejected push moves no local ref,
  so git's own message in the status line — not the refreshed counts — is what
  explains the rejection.

## Evidence

Round 2 pivoted from disabling on `behind > 0` to warn-only after review
measured the disable misfiring across independent config axes
(`remote.<name>.push` refspecs / Gerrit, forcing refspecs, triangular
`push.default=simple`, `checkout -b` name-mismatch shapes, stale last-fetch
counts): remote acceptance is not locally decidable. Round 3 then re-keyed the
row's silence from "a push override is configured" to "git named no
destination for a live upstream" — the boundary the rule site states. The old
key was wrong in both directions: state 9 showed pull-side counts for a push
git refuses, and state 10 dropped the accurate "Sets upstream on push". The
`pushConfigured` atom it read had no other consumer, so it and the
`git config --get-regexp` probe that produced it are gone. Unit coverage pins
the warn-only rule, the push-side count display, the silence boundary on both
real-git shapes, the `pushGone` copy, the status-only fallback, and the
post-failure refresh (both actions, its best-effort failure path, and the
resolution panel staying usable while the refresh is in flight); core pins the
push atoms — including that git names no destination in the three silence
shapes — and a nonzero real-git `pushBehind`, under a hermetic env.

```sh
cd packages/web-shell && npx vitest run \
  client/components/BranchPickerPopover.test.tsx \
  client/components/sidebar/WorkspaceSection.test.tsx \
  client/components/panels/EnvironmentPanel.test.tsx \
  client/components/ChatEditor.test.tsx
cd packages/core && npx vitest run src/utils/git-branches.test.ts
```
