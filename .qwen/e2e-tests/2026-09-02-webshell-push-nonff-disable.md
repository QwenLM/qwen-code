# Push disabled on non-fast-forward states

## Scenario

Open a trusted git workspace in the Web Shell and open the branch picker from
the sidebar git chip with the repo in each state:

1. Tracking upstream, ahead 1 / behind 0 (pushable).
2. Behind 3, clean tree, ahead 0.
3. Ahead 1 / behind 1 (diverged).
4. Conflicted merge in progress on the branch, ahead 1 / behind 1.
5. Behind 1 with a dirty tracked file whose incoming change conflicts; click
   Update Project to raise the 409 resolution panel.
6. Triangular (fork) workflow: `branch.<name>.remote = upstream`,
   `branch.<name>.pushRemote = origin`; behind `upstream/main` by 3, ahead of
   `origin/main` by 2.
7. Same triangular config, behind upstream, with the panel from state 5 up.
8. Push destination configured (`pushRemote`) but never pushed — the push
   ref does not exist yet.

## Checks

- State 1: Push shows `↑1` and is enabled.
- State 2: Push shows "Nothing to push" (dimmed) and is now **disabled** —
  pushing an older tip is a non-fast-forward the remote rejects
  unconditionally.
- State 3: Push shows the warning `↑1 ↓1 · update first` and is now
  **disabled** for the same reason.
- State 4: Push shows the warning "Merging" and stays **enabled** — during an
  in-progress operation the behind count is in flux (concluding the merge is
  what resolves it), so the row only warns.
- State 5: while the panel is up, the Push row is **disabled** ("Nothing to
  push", dimmed) — the behind > 0 that raised the panel is exactly what
  disables push. This is the reachable E2E check of the panel-vs-push
  interaction; the "competing push clears the panel" race stays unit-only, on
  the triangular fixture below.
- State 6: Update Project shows `↓3 · upstream/main`; Push shows `↑2` and is
  **enabled** — the disable reasons about the push target (git's `%(push)`
  resolution), not the tracking upstream.
- State 7: the panel is up (pull-side behind) while Push stays enabled
  (push-side ahead); clicking Push clears the panel and shows its outcome —
  the real-git shape of the unit race test.
- State 8: Push stays enabled (pushing creates the remote branch).
- After a **failed** Update Project (e.g. the upstream ref was deleted since
  the last fetch), the listing re-fetches: the rows leave the pre-pull
  snapshot without reopening the popover.
- A caller status and the popover's own on-open fetch carrying the same
  `computedAt` render the fetched counters (tie breaks toward the fetch).

## Evidence

Follow-ups to the sandboxed verification of #10397 (run 33195566824): F1's
measured rule (`detached || (!operation && hasUpstream && behind > 0)`, its
M6' row, green there on 170 tests) and F2's surviving M5 mutant
(`newerStatus` `>=` → `>`), now pinned. Local mutation A/B: reverting the rule
to `detached` fails 3 tests; `>=` → `>` fails exactly the tie-break test.

```sh
cd packages/web-shell && npx vitest run \
  client/components/BranchPickerPopover.test.tsx \
  client/components/sidebar/WorkspaceSection.test.tsx \
  client/components/panels/EnvironmentPanel.test.tsx \
  client/components/ChatEditor.test.tsx
```
