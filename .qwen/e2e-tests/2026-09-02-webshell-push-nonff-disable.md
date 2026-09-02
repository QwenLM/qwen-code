# Push disabled on non-fast-forward states

## Scenario

Open a trusted git workspace in the Web Shell and open the branch picker from
the sidebar git chip with the repo in each state:

1. Tracking upstream, ahead 1 / behind 0 (pushable).
2. Behind 3, clean tree, ahead 0.
3. Ahead 1 / behind 1 (diverged).
4. Conflicted merge in progress on the branch, ahead 1 / behind 1.
5. Update Project blocked by uncommitted changes (409 panel up), ahead 1 /
   behind 0; click Push while the panel shows.

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
- State 5: the pull-resolution panel clears and the push outcome shows in the
  status line (unchanged from #10390's flow; the scenario's fixture must be
  ahead-only now).
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
