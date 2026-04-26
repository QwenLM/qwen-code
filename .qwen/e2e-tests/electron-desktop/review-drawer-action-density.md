# Review Drawer Action Density

- Slice: Review Drawer Action Density
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`

## Scenario

1. Launch the real Electron desktop app with isolated HOME, runtime, user-data,
   and fake ACP state.
2. Open the dirty fake project and create the first task through the composer.
3. Open the review drawer from the compact topbar/change summary.
4. Verify review global, file, hunk, comment, and commit actions are compact
   icon-led controls with accessible labels and tooltips.
5. Trigger and cancel discard confirmation, stage all changes, commit, and
   continue the existing branch, settings, terminal, model, composer, and
   compact viewport workflows.

## Assertions

- Repeated review controls expose labels through `aria-label`, `title`, and
  sr-only text while rendering SVG icons.
- Destructive discard controls retain danger styling and still require the
  existing confirmation before touching local files.
- Stage/Discard/Open/Add Comment/Commit terminology remains available;
  `Accept`/`Revert` terminology does not return.
- Review-open desktop and compact viewports have no horizontal overflow, and
  review buttons stay within compact size thresholds.
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

Passed. The real Electron CDP harness exercised the review drawer, discard
cancel, stage all, commit, branch, settings, terminal, composer, and compact
viewport workflows with zero unexpected console errors or failed local
requests.

## Artifacts

- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T20-42-32-251Z/`
- `review-drawer-layout.json`: review actions rendered at 30 px with SVG
  icons, sr-only labels, no direct text, danger styling on discard actions, and
  primary styling on commit.
- `compact-review-drawer.json`: review actions rendered at 28 px in the
  960x608 compact viewport, with no review, changed-file, commit, composer,
  grid, or topbar overflow.
- `review-safety-initial.json`: Stage/Discard terminology present, no
  Accept/Revert terminology, and discard confirmation not open by default.
- `summary.json`: zero console errors and zero failed local requests.

## Known Uncovered Risk

This slice does not add a new overflow menu for destructive actions; it keeps
direct controls compact and relies on the existing confirmation flow.
