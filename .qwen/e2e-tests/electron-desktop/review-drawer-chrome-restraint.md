# Review Drawer Chrome Restraint

- Slice: Review Drawer Chrome Restraint
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`

## Scenario

1. Launch the real Electron desktop app with isolated HOME, runtime,
   user-data, temp workspaces, and fake ACP state.
2. Open the dirty fake project and create the first task through the composer.
3. Open the review drawer from the compact topbar/change summary.
4. Verify the review drawer tabs, Git metadata, and empty comment area render
   as compact supporting chrome in both desktop and compact windows.
5. Open the comment editor from `Add Comment`, save a review note, cancel a
   destructive discard confirmation, stage all changes, commit, and continue
   the existing branch, settings, terminal, model, composer, and relaunch
   workflows.

## Assertions

- Review section tabs expose accessible labels and titles, render SVG icons,
  have no direct button text nodes, and stay within compact height thresholds.
- Git metadata remains available as Branch, Modified, Staged, Untracked, and
  Files, but each item fits a short strip.
- No `Review comment for README.md` textarea is visible by default; clicking
  `Add Comment` reveals it, and the saved note appears before staging.
- Review actions remain icon-led with sr-only labels, destructive controls keep
  danger styling, and discard still requires confirmation.
- Review-open desktop and compact viewports keep the conversation wider than
  the drawer with no horizontal overflow.
- The real Electron run records no unexpected console errors or failed local
  requests.

## Commands

- Passed: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Passed: `git diff --check`
- Passed:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Passed: `cd packages/desktop && npm run typecheck`
- Passed: `cd packages/desktop && npm run lint`
- Passed: `cd packages/desktop && npm run build`
- Passed: `cd packages/desktop && npm run e2e:cdp`

## Result

Passed. The real Electron CDP harness exercised review drawer chrome, comment
editor opening and saving, discard cancel, stage all, commit, branch, settings,
terminal, model, composer, project relaunch, and compact viewport workflows
with zero unexpected console errors or failed local requests.

## Artifacts

- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-03-53-113Z/`
- `review-drawer-layout.json`: tabs rendered at 28 px with icons and title
  metadata; Git metadata items rendered at 22 px; collapsed comment box was
  51 px with no textarea.
- `compact-review-drawer.json`: tabs rendered at 26 px, metadata items at
  22 px, and collapsed comment box at 43 px in the compact viewport.
- `review-drawer.png` and `compact-review-drawer.png`: screenshots showing the
  restrained review chrome and collapsed comment affordance.
- `discard-confirmation.json`: destructive copy and confirmation actions stayed
  intact after the chrome changes.
- `summary.json`: zero console errors and zero failed local requests.

## Known Uncovered Risk

The tabs are still presentational placeholders for Files, Artifacts, and
Summary content; this slice makes them compact but does not implement separate
tab bodies.
