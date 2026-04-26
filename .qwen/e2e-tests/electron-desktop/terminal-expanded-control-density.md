# Terminal Expanded Control Density

- Slice: Terminal Expanded Control Density
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test: `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-18-56-808Z/`

## Scenario

1. Launch real Electron with isolated HOME, runtime, user-data, and fake ACP
   paths.
2. Open the fake Git project from the workbench.
3. Send a prompt, approve the fake command, and complete the fake assistant
   response path.
4. Exercise review, branch, settings, and composer model paths from the shared
   CDP smoke.
5. Expand the terminal drawer.
6. Assert the expanded terminal remains supporting and the command controls are
   compact.
7. Run `printf desktop-e2e-terminal`.
8. Run a stdin-driven Node command, send `desktop-e2e-stdin`, attach terminal
   output to the composer, send it, and collapse the terminal.

## Assertions

- Expanded terminal height stayed 238 px while conversation height stayed
  500 px.
- Run button and Send Input button stayed icon-led, accessible, and compact at
  32 x 32 px.
- Terminal actions were grouped inside the command row, not rendered as a
  standalone toolbar row.
- Command row, stdin row, and terminal actions stayed inside the drawer body.
- A 111-character terminal command stayed contained without command-row or
  action-row overflow.
- Terminal output attachment populated the composer and did not create an
  approval request.
- No browser console errors or failed local requests were recorded.

## Commands Run

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck && npm run lint && npm run build
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

Key files:

- `terminal-expanded-layout.json`
- `terminal-long-command-layout.json`
- `terminal-expanded.png`
- `terminal-attachment.json`
- `completed-layout.json`
- `summary.json`

Known uncovered risk: this slice verifies the default Electron viewport for
expanded terminal control density. The shared harness still verifies compact
viewport layout with the terminal collapsed, but it does not expand the
terminal at the compact viewport.
