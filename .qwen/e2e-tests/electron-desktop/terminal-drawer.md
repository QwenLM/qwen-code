# Electron Desktop E2E Record: Terminal Drawer

Date: 2026-04-25

## Slice

Slice 13 basic scoped terminal.

## User-Visible Scenario

1. Launch the desktop app with a temporary HOME/QWEN_RUNTIME_DIR and fake ACP.
2. Open a temporary project directory.
3. Use the bottom Terminal drawer to run a harmless command.
4. Verify command output appears in the drawer.
5. Start a long-running command and click Kill.
6. Click Clear and verify the drawer output resets.

## Assertions

- `POST /api/terminals` requires a registered project id and non-empty command.
- Terminal cwd is resolved from the registered project path server-side.
- `GET /api/terminals/:id` returns output and exit status.
- `POST /api/terminals/:id/kill` marks a running terminal as killed.
- Renderer terminal controls are visible in the bottom drawer and do not use
  Node integration.

## Diagnostics on Failure

- Save renderer screenshot.
- Save renderer console errors and failed network requests.
- Save Electron main stdout/stderr.
- Save DesktopServer terminal route responses.
- Save the temporary workspace path and command used.

## Automated Coverage Added This Iteration

The full Electron E2E harness is still pending. This iteration added
server-level coverage in `packages/desktop/src/server/index.test.ts`:

- runs `printf terminal-output` scoped to a registered project;
- polls `/api/terminals/:id` until output and exit code are available;
- starts a long-running Node command and verifies `/kill` returns `killed`.

## Execution Results

- `npm run test --workspace=packages/desktop` passed: 8 files, 52 tests.
- `npm run typecheck --workspace=packages/desktop` passed.
- `npm run lint --workspace=packages/desktop` passed.
- `npm run build --workspace=packages/desktop` passed.

## Remaining Risk

The current terminal is a command runner, not a full interactive PTY. PTY
write/resize, output selection/copy polish, send-output-to-AI, terminal tabs,
history, and real Electron renderer assertions remain required before the MVP
can be marked done.
