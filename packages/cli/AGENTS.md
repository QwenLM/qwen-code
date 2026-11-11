# Qwen Code CLI (`@qwen-code/qwen-code`)

Shared CLI startup, interactive TUI, headless execution, ACP/SDK adapters, and
session hosting. Product entries supply their own plugins and framework.

## Entrypoints and Ownership

- `bin.ts` starts Qwen Code through `src/startup/runCli.ts`, with the public
  authentication and installation plugins and Qwen themes.
- Product hosts call the same `runCli` API with their own settings,
  telemetry, command declarations, and framework factories. Keep product-only
  startup and UI implementations outside the shared CLI package.
- After building the workspaces, use `npm start -w @qwen-code/qwen-code` from
  the repository root to run the public CLI's `dist/bin.js`.
- `src/startup/` and `src/framework/` own startup phases and execution modes;
  `src/headless/`, `src/acp/`, `src/sdk/`, and `src/worker/` adapt those modes.
- `src/thread-manager/` hosts session lifecycles; `src/ui/` owns interactive
  state and rendering; `src/ink/` contains the vendored Ink implementation.
- `src/config/` integrates settings with CLI startup and sessions. File-based
  settings parsing, validation, and resource loading live in
  `@qwen-code/resource`; follow that package's `AGENTS.md` for its boundary.
- Shared brand configuration lives in `../core/src/config/brand.ts` and is
  injected by product builds. The public welcome identity in `src/brand.ts`
  is separate from product frameworks' display names and banners.

## React & Ink (CLI UI)

- **Side Effects**: Use reducers for complex state transitions; avoid `setState`
  triggers in callbacks.
- Always fix react-hooks/exhaustive-deps lint errors by adding the missing
  dependencies.
- **Shortcuts**: only define keyboard shortcuts in
  `packages/cli/src/ui/key/keyBindings.ts`
- Do not implement any logic performing custom string measurement or string
  truncation. Use Ink layout instead leveraging ResizeObserver as needed. When
  using `ResizeObserver`, prefer the `useCallback` ref pattern (as seen in
  `src/ui/components/shared/MaxSizedBox.tsx`) to ensure size measurements are captured as soon as the
  element is available, avoiding potential rendering timing issues.
- Avoid prop drilling when at all possible.

## Testing

- **Running**: run only the tests related to your change, from `packages/cli`:
  `npx vitest run src/path/to/file.test.ts`. `npm test` excludes `src/ui/**`
  and `src/test-utils/**`, so passing it a UI test path runs zero tests. Do not
  run the whole suite unless the user explicitly asks.
- **Utilities**: Use `renderWithProviders` from `src/test-utils/render.tsx`
  and the React-aware `waitFor` from `src/test-utils/async.ts`. Shared file
  system helpers and `TestRig` are exported by `@qwen-code/core/test-utils`.
- **Slow Tests**: For a specific test excluded by the default slow-test list,
  use `QWEN_RUN_SLOW_TESTS=1 npx vitest run <path>` from this package.
- **Snapshots**: Use `toMatchSnapshot()` to verify Ink output.
- **SVG Snapshots**: Use `await expect(renderResult).toMatchSvgSnapshot()` for
  UI components whenever colors or detailed visual layout matter. SVG snapshots
  capture styling accurately. Make sure to await the `waitUntilReady()` of the
  render result before asserting. After updating SVG snapshots, always examine
  the resulting `.svg` files (e.g. by reading their content or visually
  inspecting them) to ensure the render and colors actually look as expected and
  don't just contain an error message.
- **Mocks**: Use mocks as sparingly as possible.

## TUI Debugging with React DevTools

The vendored Ink reconciler in `src/ink/reconciler.ts` connects to standalone
React DevTools when `DEV=true` and `react-devtools-core` is available.

Run these commands from the repository root:

1. Start standalone React DevTools in one terminal: `npx react-devtools`.
2. Build the workspaces with `npm run build`. For incremental TypeScript
   compilation, run `npx tsc -b packages/cli --watch` in another terminal.
3. Launch the public CLI with
   `DEV=true npm start -w @qwen-code/qwen-code -- -c`.

TypeScript watch updates compiled files, not the running process; restart the
CLI after source changes. DevTools can inspect the mounted tree and edit
component props/state. The connection is gated by `DEV`; production builds
eliminate this development path.

## Output Channels

The CLI serves three IO modes from the same code: interactive TUI, `-p` text,
and `-p --output-format stream-json` (the SDK NDJSON protocol). Anything written
to `stdout` / `stderr` outside the sanctioned paths can break the protocol or
get scraped by SDK consumers and surfaced to integrators — treat the streams as
a wire format, not a scratchpad.

- Information for users goes through the existing UI / headless output paths
  (Ink components, `coreEvents.emitFeedback`, and the `HeadlessSession` /
  `StreamJsonOutput` output paths).
  Information for developers goes to `runLogger` / `sessionLogger`, never to
  stderr.
- Avoid `console.*`, `process.stdout`, and `process.stderr`. `writeToStdout` /
  `writeToStderr` bypass the stream-json guard and are an escape hatch for
  pre-init fatal errors or standalone subcommands (`--version`, etc.) only — not
  for hook callbacks, event listeners, or any long-lived code path.

## Startup Architecture

- `src/startup/runCli.ts` checks the working directory and applies the config
  directory override before loading the main entry. `src/qwen.tsx` installs
  product-supplied dependencies and creates the Commander command tree from
  `src/commands/index.ts`.
- Keep terminal subcommands on the command execution path; do not route them
  through the root conversation startup merely because they share a process.
- `src/startup/determineStartupMode.ts` selects daemon, ACP, headless, or
  interactive mode. `src/startup/startupPolicy.ts` derives MCP initialization
  waiting, preloads, and cleanup policy from that mode. New policy fields need
  actual consumers and behavior tests, not only logs or snapshots.
- `src/startup/rootCommandHandler.ts` dispatches daemon/ACP first, then built-in
  exit options, then headless execution or interactive startup.
  `src/startup/selectBuiltinExitOption.ts` owns the built-in exit-option
  priority. Preserve conflicting-flag behavior when changing either selector.
- `src/startup/startupContext.ts` defines the configured startup context. Only
  expose a full `config` and framework after construction; do not turn this
  into a large context filled with optional, partially initialized services.
- `src/startup/startupCoordinator.ts` owns startup phase transitions. Keep
  startup MCP initialization waiting separate from serve-time readiness and
  command/slash-command catalog readiness.
- When extracting a startup branch into a helper or runner, remove the old
  branch. Preserve dispatch and startup lifecycle coverage, including whether
  config construction and framework initialization occur.
