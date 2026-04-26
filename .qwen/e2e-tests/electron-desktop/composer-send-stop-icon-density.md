# Composer Send/Stop Icon Density

Date: 2026-04-27 (Asia/Shanghai)

## Slice

Make the composer Stop and Send controls compact, icon-led, and accessible so
the bottom composer aligns more closely with the `home.jpg` task control
center while preserving send/stop behavior.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch real Electron with isolated HOME, user-data, runtime, and fake ACP.
2. Open the fake project and inspect the project-scoped composer before any
   thread exists.
3. Type the first prompt and submit through the composer Send control.
4. Approve the deterministic fake command request and wait for the assistant
   response.
5. Inspect default conversation, compact conversation, and compact review
   layouts for composer control geometry and overflow.
6. Attach terminal output to the composer, submit the follow-up through Send,
   and approve the fake command request.

## Assertions

- Stop and Send expose stable `aria-label` and `title` values.
- Both controls contain an icon plus `.sr-only` text and no direct visible text
  node.
- Idle Stop and empty-message Send stay disabled.
- Stop is `28 x 28`; Send is `30 x 30` in the project composer snapshot.
- Default, compact, and compact review snapshots report no composer,
  composer-context, or composer-actions overflow.
- The existing send, retry, review, settings, branch, terminal attach, and
  approval paths continue to pass with no console errors or failed local
  requests.

## Commands

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

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-13-34-084Z/`

Key files:

- `project-composer.json`
- `conversation-surface-fidelity.json`
- `compact-dense-conversation.json`
- `compact-review-drawer.json`
- `summary.json`

`summary.json` recorded zero console errors and zero failed local requests.

## Known Uncovered Risk

This slice still relies on native `<select>` controls for model and permission
mode. Very long localized option labels need a separate compact-control pass.
