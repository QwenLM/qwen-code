# Terminal Strip Fidelity

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-08-19-344Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Verify the initial workbench at the default viewport with the terminal
   collapsed below the conversation-first grid.
3. Open the fake project, send a prompt, approve the fake command request, and
   wait for the assistant response.
4. Resize the real Electron window to the compact `960x640` path and assert the
   collapsed terminal still behaves as a slim supporting strip.
5. Restore the default viewport, expand the terminal, run deterministic command
   and stdin paths, copy output, attach output to the composer, send the
   attached prompt, and collapse the terminal.
6. Continue the existing review, settings, model switching, commit, and final
   layout checks.

## Assertions

- Default collapsed terminal height is 42 px with a 32 px toggle.
- Compact collapsed terminal height is 42 px with a 32 px toggle.
- The collapsed strip has no visible `.message-role` section label.
- Project, status, and preview boxes stay visually contained inside the strip;
  long project names may be ellipsized.
- Expanded terminal height is 238 px while the conversation remains 500 px
  high, so the terminal stays supporting.
- Terminal output attachment populates the composer and does not create an
  approval request.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `initial-layout.json`
- `conversation-surface-fidelity.png`
- `compact-dense-conversation.json`
- `compact-dense-conversation.png`
- `terminal-expanded-layout.json`
- `terminal-expanded.png`
- `terminal-attachment.json`
- `completed-layout.json`
- `completed-workspace.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness verifies default and compact geometry, but it does not yet capture a
focused or hovered screenshot of the collapsed terminal strip.
