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

## Remaining Risk

This slice proves the CDP endpoint exists, but it does not yet automate DOM
text checks, console/network collection, or screenshot validation. Slice 14 must
connect through Playwright or Chrome DevTools MCP and persist those diagnostics.
