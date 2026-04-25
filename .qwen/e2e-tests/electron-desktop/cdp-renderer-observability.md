# Electron Desktop E2E Record: CDP Renderer Observability

Date: 2026-04-25

## Slice

Slice 10: Renderer Asset Loading and CDP Port.

## User-Visible Scenario

1. Build the desktop package.
2. Launch the desktop app with `QWEN_DESKTOP_CDP_PORT=<port>`.
3. Connect to `http://127.0.0.1:<port>/json/version`.
4. List renderer targets from `http://127.0.0.1:<port>/json/list`.
5. Confirm the Qwen Code renderer target points at the built
   `dist/renderer/index.html` file URL.

## Assertions

- CDP is not enabled unless `QWEN_DESKTOP_CDP_PORT` is set to a valid numeric
  port.
- CDP binds to `127.0.0.1`, not a public interface.
- `/json/version` returns a browser websocket URL on the requested port.
- `/json/list` includes a page target titled `Qwen Code`.
- The renderer page URL uses the built `file://.../dist/renderer/index.html`
  path.

## Diagnostics on Failure

- Save Electron main stdout/stderr.
- Save `/json/version` and `/json/list` responses when available.
- Save renderer console and network diagnostics once the Playwright/DevTools
  MCP harness is in place.
- Save a screenshot once the Playwright/DevTools MCP harness is in place.

## Automated Coverage Added This Iteration

- `packages/desktop/src/main/lifecycle/remoteDebugging.test.ts` covers valid,
  missing, and invalid `QWEN_DESKTOP_CDP_PORT` values.
- `packages/desktop/src/main/main.ts` calls the helper before app readiness.
- `packages/desktop/src/main/windows/MainWindow.ts` resolves preload and
  renderer paths from the compiled `dist/main/windows` location.
- `packages/desktop/vite.config.ts` uses relative renderer asset URLs for
  packaged `file://` loading.

## Execution Results

- `npm run test --workspace=packages/desktop` passed: 8 files, 48 tests.
- `npm run typecheck --workspace=packages/desktop` passed.
- `npm run lint --workspace=packages/desktop` passed.
- `npm run build --workspace=packages/desktop` passed.
- `QWEN_DESKTOP_CDP_PORT=9339 npm run start --workspace=packages/desktop`
  printed a DevTools websocket on `127.0.0.1:9339`.
- `curl --fail --silent http://127.0.0.1:9339/json/version` passed.
- `curl --fail --silent http://127.0.0.1:9339/json/list` passed and returned a
  `Qwen Code` page target for
  `file:///Users/dragon/Documents/qwen-code/packages/desktop/dist/renderer/`
  `index.html`.
- The launch process was terminated with SIGINT after endpoint verification;
  the npm lifecycle therefore reported a termination error, which was expected
  for this manual smoke.

## Iteration 9 Automated CDP Harness

Slice 14 added `npm run e2e:cdp --workspace=packages/desktop`, implemented in
`packages/desktop/scripts/e2e-cdp-smoke.mjs`.

The harness launches Electron with:

- `QWEN_DESKTOP_CDP_PORT=<free port>` bound to `127.0.0.1`;
- a temporary HOME, runtime directory, and Electron userData directory;
- a temporary Git workspace with one modified file and one untracked file;
- `QWEN_DESKTOP_E2E_FAKE_ACP=1` so session, prompt, and permission UI can be
  exercised without external credentials;
- `QWEN_DESKTOP_TEST_SELECT_DIRECTORY=<workspace>` so the normal preload
  directory-selection path can be driven without a native dialog.

Additional assertions now covered:

- renderer target is reachable through CDP;
- first workspace screen has stable DOM landmarks and screenshots;
- renderer console errors and failed network requests are collected;
- Open Project registers the temporary Git workspace and shows changed files;
- New Thread creates a fake ACP session and connects WebSocket chat;
- sending a prompt shows a command approval request and approval response;
- settings save updates the visible model summary;
- terminal drawer runs a harmless project-scoped command and shows output.

Diagnostics on failure now include screenshot PNGs, DOM text, renderer console
errors, failed network requests, Electron stdout/stderr, and Git status/diff
under ignored
`.qwen/e2e-tests/electron-desktop/artifacts/<timestamp>/`.

## Iteration 9 Execution Results

- `npm run typecheck --workspace=packages/desktop` passed.
- `npm run build --workspace=packages/desktop` passed.
- `npm run e2e:cdp --workspace=packages/desktop` passed.
- `npm run typecheck` passed.
- `npm run build` passed, with existing VS Code companion warnings only.
- `npm run bundle && npm run package:dir --workspace=packages/desktop &&
  npm run smoke:package --workspace=packages/desktop` passed.
- `npm run smoke:package --workspace=packages/desktop -- --launch` passed.
- Passing run artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T02-54-48-799Z/`.
- The passing run reported `consoleErrors: []` and `failedRequests: []`.

## Remaining Risk

This harness covers renderer/CDP observability and the main P0 workbench paths,
but it is a development E2E smoke using fake ACP. Final MVP verification still
needs the remaining terminal polish and final packaging smoke called out in the
implementation plan.

## Iteration 10 Review Path Extension

The CDP harness now also exercises the hunk review surface after opening the
temporary Git workspace:

- waits for a visible Accept Hunk control in the Review panel;
- clicks Accept Hunk and verifies the hunk state changes to Accepted;
- adds an inline review note for `README.md`;
- continues through session creation, permission approval, settings save, and
  project-scoped terminal output.

Execution result:

- `npm run e2e:cdp --workspace=packages/desktop` passed.
- Passing run artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T03-08-06-087Z/`.
- The passing run reported no renderer console errors or failed network
  requests.
