# Electron Desktop E2E: Assistant Control Density

- Slice name: Assistant Control Density Pass
- Date: 2026-04-27 (Asia/Shanghai)
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`

## Scenario Steps

1. Launch real Electron with isolated HOME, runtime, user-data, and fake Git
   project paths.
2. Open the fake project and send a prompt through the composer.
3. Approve the fake ACP command request.
4. Wait for assistant prose, file-reference chips, assistant message actions,
   and the inline changed-files summary.
5. Assert default viewport geometry for assistant chips/actions and the
   changed-files summary.
6. Resize to the compact viewport and assert the same controls stay contained.
7. Continue the existing branch, review, settings, terminal, discard safety,
   and commit smoke path.

## Assertions

- Assistant file-reference chips preserve accessible labels, dedupe repeated
  file references, preserve the `+2 more` overflow indicator, stay below the
  compact height/width thresholds, and remain within the message/timeline.
- Assistant action buttons preserve Copy Response, Retry Last Prompt, and Open
  Changes labels while using compact icon geometry.
- The inline changed-files summary remains a secondary surface with compact row
  and Review Changes action geometry.
- The compact `960x640` viewport has no horizontal overflow in the shell,
  topbar, timeline, message, file references, composer, or composer controls.
- Console errors and failed local requests are zero unless explicitly expected
  by the harness.

## Command

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
git diff --check
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

The first CDP run failed at
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-05-929Z/`
because the new changed-files row font assertion measured the inherited `li`
font style instead of the visible row label. The harness was corrected to
record `rowLabelStyle`, then the full real Electron CDP path passed.

Passing real Electron artifacts:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-41-762Z/`.

Key metrics from the passing run:

- Assistant file-reference chips: `20` px tall, max `220` px wide.
- Assistant action buttons: `24x24`; action row: `24` px tall.
- Changed-files summary: `67` px tall.
- Review Changes action: `24` px tall.
- Changed-file row: `21` px tall with `10.8` px visible label text.
- Compact viewport: file chips `20` px tall, action buttons `24x24`, no shell,
  topbar, timeline, message, file-reference, composer, or composer-control
  overflow.
- Console errors: `[]`.
- Failed local requests: `[]`.

## Artifacts

- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-41-762Z/assistant-message-actions.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-41-762Z/assistant-message-actions.png`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-41-762Z/conversation-surface-fidelity.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-41-762Z/conversation-surface-fidelity.png`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-41-762Z/compact-dense-conversation.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-41-762Z/compact-dense-conversation.png`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-41-762Z/summary.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-41-762Z/electron.log`

## Known Uncovered Risk

This harness validates deterministic fake ACP content and CSS geometry. It does
not compare pixels against `home.jpg` or exercise arbitrary real assistant
responses with unusually long localized file names.
