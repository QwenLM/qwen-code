# Terminal and Review Status Label Restraint

- Slice name: Terminal and Review Status Label Restraint
- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command: `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Final artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-19-11-628Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP data.
2. Verify the initial collapsed terminal strip before a project is opened.
3. Open the fake dirty Git project, send the deterministic prompt, approve the
   fake command, and reach the changed-files summary.
4. Open the review drawer, inspect default and compact review layouts, then
   open the review comment editor.
5. Continue discard cancellation, stage all, commit, Settings/model provider,
   terminal attach, branch, relaunch, and compact viewport paths.

## Assertions

- Collapsed terminal status reports `text-transform: none`, weight `680`, and
  remains contained at default and compact desktop widths.
- Review changed-file metadata, hunk source metadata, collapsed review-note
  prompt, and terminal status support labels report `text-transform: none` and
  compact font weights at default and compact review widths.
- The open review comment editor label reports `text-transform: none`, weight
  `680`, and keeps the textarea accessible as
  `Review comment for README.md`.
- Stage All updates review counts to `0 modified`, `2 staged`,
  `0 untracked` and now asserts the normal-case `added · 1 hunk` metadata.
- Review remains a supporting drawer, terminal remains collapsed by default,
  and `summary.json` records zero console errors and zero failed local
  requests.

## Artifacts

- `initial-layout.json`
- `compact-dense-conversation.json`
- `review-drawer-layout.json`
- `compact-review-drawer.json`
- `review-comment-editor-chrome.json`
- `review-stage-all-result.json`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

The harness validates computed CSS and geometry in deterministic Electron
viewports. It does not pixel-diff against `home.jpg`, so very subtle visual
weight regressions still require screenshot review.
