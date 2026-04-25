# Electron Desktop E2E Record: Terminal Drawer

Date: 2026-04-25

## Slice

Slice 13 basic scoped terminal.

## User-Visible Scenario

1. Launch the desktop app with a temporary HOME/QWEN_RUNTIME_DIR and fake ACP.
2. Open a temporary project directory.
3. Use the bottom Terminal drawer to run a harmless command.
4. Verify command output appears in the drawer.
5. Copy the terminal transcript and verify the UI reports copy success.
6. Start a command that waits for stdin, send input through the drawer, and
   verify the command output includes that stdin.
7. Send the terminal output to the active AI thread and approve the fake ACP
   command request.
8. Start a long-running command and click Kill.
9. Click Clear and verify the drawer output resets.

## Assertions

- `POST /api/terminals` requires a registered project id and non-empty command.
- Terminal cwd is resolved from the registered project path server-side.
- `GET /api/terminals/:id` returns output and exit status.
- `POST /api/terminals/:id/write` writes stdin only while the terminal is
  running and returns `terminal_not_running` after completion.
- `POST /api/terminals/:id/kill` marks a running terminal as killed.
- Renderer terminal controls for run, stdin, copy, kill, clear, and send to AI
  are visible in the bottom drawer and do not use Node integration.
- Copy output uses the preload-whitelisted Electron clipboard IPC, not renderer
  Node integration or an unbounded IPC channel.
- Send to AI uses the existing authenticated WebSocket user-message path with
  a bounded terminal transcript.

## Diagnostics on Failure

- Save renderer screenshot.
- Save renderer console errors and failed network requests.
- Save Electron main stdout/stderr.
- Save DesktopServer terminal route responses.
- Save the temporary workspace path and command used.

## Automated Coverage Added In Slice 13

Slice 13 added server-level coverage in
`packages/desktop/src/server/index.test.ts`:

- runs `printf terminal-output` scoped to a registered project;
- polls `/api/terminals/:id` until output and exit code are available;
- starts a long-running Node command and verifies `/kill` returns `killed`.

## Automated Coverage Added In Slice 16

Slice 16 adds server and Electron CDP coverage:

- server test starts a command waiting on stdin, writes to
  `/api/terminals/:id/write`, verifies output, and verifies a stale write fails
  with `terminal_not_running`;
- CDP smoke runs a command, copies output, starts a stdin-driven command,
  sends input, sends the terminal transcript to the fake ACP session, approves
  the command request, and verifies the fake ACP response includes the terminal
  prompt.
- the real Electron CDP run exposed that browser clipboard fallback is not
  reliable from the built `file://` renderer; Slice 16 now covers the
  preload-backed Electron clipboard path.

## Execution Results

Slice 16:

- `npm run test --workspace=packages/desktop` passed: 9 files, 55 tests.
- `npm run typecheck --workspace=packages/desktop` passed.
- `npm run lint --workspace=packages/desktop` passed.
- `npm run build --workspace=packages/desktop` passed.
- Initial `npm run e2e:cdp --workspace=packages/desktop` failed on the copy
  status assertion. Diagnostics:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T04-42-48-004Z/`.
- After adding the preload clipboard IPC, `npm run e2e:cdp
  --workspace=packages/desktop` passed. Success artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T04-45-53-738Z/`.
- `npm run typecheck` passed across workspaces.
- `npm run build` passed across workspaces. Existing VS Code companion lint
  warnings remained warnings only.

Slice 13:

- `npm run test --workspace=packages/desktop` passed: 8 files, 52 tests.
- `npm run typecheck --workspace=packages/desktop` passed.
- `npm run lint --workspace=packages/desktop` passed.
- `npm run build --workspace=packages/desktop` passed.

## Remaining Risk

The current terminal is still a command runner with stdin pipes, not a full
interactive PTY. PTY resize, terminal tabs/history, and richer output
selection remain deferred beyond the P0 path.
