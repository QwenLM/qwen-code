# Background workflows in ACP clients (Web Shell)

## Scenario

In a Web Shell (or other ACP client) session with workflows enabled, ask the
model for a long workflow run and let it call the Workflow tool with
`run_in_background: true`.

## Checks

- The Workflow tool call completes right away with "Workflow started in
  background" and a run ID; the turn ends and the composer is free while the
  run keeps working.
- The run is listed as running in the session's background tasks, linked to
  that tool call, and its tool card still shows the live run.
- Stopping a later turn does not stop the run. As for background agents and
  shells, the stop holds the run's report until the next prompt, which then
  releases it.
- When the run settles, exactly one workflow notification turn starts and the
  model answers from the run's result.
- A headless run (`qwen -p`) still rejects `run_in_background: true`. So does
  an ACP session whose workflow controls are off (workflows disabled, also
  by a settings reload mid-session; bare mode; or an untrusted workspace, as
  resolved by `isTrustedFolder`), or one without a completion channel.
- A call without `run_in_background` behaves exactly as before: the tool waits
  for the run and returns its result inline.

## Baseline

Against the global `qwen` CLI (0.25.1), the daemon integration test below fails
at the first check: the tool is refused with "`run_in_background` is available
only in the interactive TUI", and no workflow task is registered.

To reproduce it, point the root `dist/cli.js` at the baseline build first: the
integration global setup always sets `TEST_CLI_PATH` to `<repo>/dist/cli.js`,
so setting `TEST_CLI_PATH` yourself has no effect. For example, link
`dist/cli.js` to the global install's `cli.js`, run the test, then remove the
link and rebuild.

## Evidence

- Gate (TUI, ACP, ACP with controls off, headless, no channel), abort of
  the starting turn, single completion:
  `packages/core/src/tools/workflow/workflow.test.ts`.
- Resume-in-background flag per host:
  `packages/core/src/agents/runtime/workflow-runner.test.ts`.
- Real daemon with the fake model server, with and without the unified agent
  loop (the prompt ends on the run handle, the run is still running, a later
  turn is cancelled and the run keeps running and settles, its report is held
  until the next prompt, then one notification turn): `integration-tests/cli/daemon-workflow-background.test.ts`.
- Real Web Shell in Chromium against `qwen serve` and the same fake model
  (2026-11-11):
  - Before (global 0.25.1): the Workflow tool card shows "WorkflowTool:
    `run_in_background` is available only in the interactive TUI."
  - After: the turn ends on the run handle and the tool card shows the live
    run graph with its agent still running. A follow-up message is answered
    while the run keeps going; the tasks snapshot then lists the run as
    `running`, linked to the tool call. When the agent finishes, one
    notification turn answers from the run's result.

## Known, not changed here

In the collapsed view, the notification turn's reply was shown as the latest
turn's answer and hid the answer that turn gave before it. This looks like the
collapse behaviour #16581 addresses; it was not re-checked with that change
applied.
