# Floating environment panel with a pending question

Issue: [#17963](https://github.com/QwenLM/qwen-code/issues/17963).

## Manual baseline and acceptance

1. Start `qwen serve`, open its Web Shell in Chromium, and use an existing
   workspace session. Set the browser narrow enough to float the environment
   panel, or select wide chat mode. Open **Toggle environment information**
   with enough subagents or artifacts for a tall panel.
2. Trigger a pending question with at least two options. On an affected build
   the floating panel and question overlap. Depending on stacking order,
   a covered panel action or question control is unreachable.
3. On the fixed build, check that the panel ends above the question. Scroll
   inside the panel and open its last artifact. Reopen the panel, resize the
   window, and verify that the question controls and panel remain reachable.
4. Confirm the question. Reopen the panel and check that it uses its normal
   height again. At a width where the panel docks, the existing layout should
   not change.

## Automated regression

From `packages/web-shell`, run:

```bash
npm run test:e2e -- --project chromium web-shell.environment-question-layout.spec.ts
```

The test uses the standalone app and a mocked daemon to control question and
artifact data. It checks element bounds and pointer reachability, not just
the CSS custom property. It exercises 1080×940 and 1080×740 viewports,
collapse/expand without resizing, and a real answer request to the mock. This
does not require model credentials.

The change does not repartition height in unusually short embeds where the
question itself leaves little or no room above it.
