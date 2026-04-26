# Electron Desktop E2E: Sidebar and Composer Control Density

- Slice name: Sidebar and Composer Control Density
- Date: 2026-04-27 (Asia/Shanghai)
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`

## Scenario Steps

1. Launch real Electron with isolated HOME, runtime, user-data, and fake Git
   project paths.
2. Open the fake project and assert the project-scoped composer is enabled
   before any thread exists.
3. Assert the pre-thread composer stays one compact control surface with
   project, branch, permission, model, new-thread, Stop, and Send controls
   contained.
4. Send a prompt, approve the fake ACP command request, and wait for assistant
   response, changed-files summary, and composer return state.
5. Assert sidebar rail density, default conversation/composer density, compact
   `960x640` conversation density, and compact review drawer composer bounds.
6. Continue the existing branch, review, settings, terminal, discard safety, and
   commit smoke path.

## Assertions

- Sidebar width stays below the previous 252 px baseline and remains bounded at
  `244` px in the default viewport and `232` px in the compact viewport.
- Sidebar app/footer rows are `26` px tall; project/thread rows are `30` px
  tall; sidebar titles are `11.5` px and metadata is `9.2` px.
- The pre-thread composer is `820x88.09` px; its textarea is `41.09` px tall;
  its control row is `26` px tall.
- Composer chips and selects are `24` px tall, the attach control is `24x24`,
  and Stop/Send are `26` px tall.
- The compact conversation composer remains `704x88.09` px with no shell,
  topbar, timeline, composer, composer-context, or composer-action overflow.
- The compact review composer remains bounded at `404x112` px with a `38` px
  textarea and no relevant overflow.
- Console errors and failed local requests are zero.

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
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-51-45-127Z/`
because the narrower default composer still allowed the long-branch pre-thread
context to wrap to two control rows, producing a `115.09` px composer. The CSS
was corrected by constraining chip/select widths and keeping default composer
controls on one row.

Passing real Electron artifacts:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-52-52-008Z/`.

Key passing artifacts:

- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-52-52-008Z/project-composer.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-52-52-008Z/sidebar-app-rail.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-52-52-008Z/conversation-surface-fidelity.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-52-52-008Z/compact-dense-conversation.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-52-52-008Z/compact-review-drawer.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-52-52-008Z/completed-workspace.png`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-52-52-008Z/summary.json`

## Known Uncovered Risk

This harness validates deterministic fake ACP content, one long branch name,
and bounded layout geometry. It does not perform pixel matching against
`home.jpg` or validate arbitrary real model/provider labels in every locale.
