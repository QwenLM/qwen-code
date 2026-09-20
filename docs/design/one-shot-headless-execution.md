# One-shot headless execution

[English](one-shot-headless-execution.md) | [简体中文](one-shot-headless-execution.zh-CN.md)

Status: Implemented in this change.

## Problem

A one-shot invocation starts with an explicit prompt, runs without the interactive UI, and exits after that prompt completes. It currently pays for two interactive facilities it cannot use: a resident relaunch supervisor and a PTY plus headless terminal emulator for every shell command. In a 100-command local mock workload, these paths accounted for roughly 200 MiB of peak process-tree RSS and about half of shell execution time.

## Current behavior

The CLI relaunches itself under a parent process to apply Node memory arguments. Shell commands default to PTY execution even though one-shot mode has no input surface that can write to that PTY. Interactive TUI sessions use the PTY input and resize APIs; one-shot sessions do not.

## Goals

- Avoid the resident relaunch parent for an explicit one-shot prompt when the runtime can replace the current process.
- Default explicit one-shot prompts to pipe-based shell execution.
- Preserve existing behavior for interactive TUI, ACP, stream-json input, stdin-only, and file-input sessions.
- Preserve `tools.shell.enableInteractiveShell` as an explicit override.

## Non-goals

- Changing shell execution semantics for interactive or protocol-driven sessions.
- Removing PTY support.
- Changing the outer installation launcher or sandbox relaunch flow.

## Design

For an explicit prompt outside ACP, stream-json input, prompt-interactive, file-input, and file-descriptor output modes, the memory-argument relaunch uses `process.execve` when available. This keeps the same executable, Node arguments, script arguments, environment provenance, and `QWEN_CODE_NO_RELAUNCH` guard without retaining the loaded parent. File-descriptor output keeps the supervisor because process replacement closes descriptors above standard input, output, and error. Runtimes without `process.execve` keep the existing supervised spawn path.

When `tools.shell.enableInteractiveShell` is unset, an explicit one-shot prompt defaults to `child_process`. Interactive TUI, ACP, stream-json input, stdin-only, and file-input sessions retain the PTY default. An explicit setting always wins.

## Risks and constraints

Pipe execution reports non-TTY stdio, preserves carriage-return output instead of rendering a terminal viewport, and does not provide interactive input. Those semantics match one-shot automation, but the scope remains narrow to avoid changing long-lived integrations. The existing shell service continues to own timeout, cancellation, background promotion, output limits, and process-tree cleanup in both execution methods.

## Validation plan

- Unit-test process replacement arguments, environment, and spawn bypass.
- Unit-test the shell default matrix for interactive, explicit one-shot, ACP, and explicit settings.
- Run CLI build, typecheck, lint, and the affected CLI test files.
- Run the production bundle against a local OpenAI-compatible mock for 100 successful shell calls and compare wall time, peak RSS, request count, and process count.

## Acceptance criteria

- Explicit one-shot prompts complete with the same model-request and tool-success counts.
- Interactive TUI, ACP, stream-json input, stdin-only, and file-input defaults remain unchanged.
- Explicit PTY settings remain authoritative.
- Runtimes without `process.execve` fall back without failing startup.

## Open questions

None.
