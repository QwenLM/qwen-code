# Dynamic workflows on by default

[English](2026-11-19-workflows-on-by-default.md) | [简体中文](2026-11-19-workflows-on-by-default.zh-CN.md)

Status: proposed, implemented in the same change.

## Problem

The Workflow tool is off unless the user turns on `tools.workflowsEnabled` in
user or system settings, or sets `QWEN_CODE_ENABLE_WORKFLOWS=1`. Most users
never find the switch, so the model cannot reach for a workflow when a task
would benefit from parallel subagents, and `/workflows`, saved workflows and
extension workflows stay hidden.

## Current state

- `Config.isWorkflowsEnabled()` returns the setting, `false` when unset, after
  the env pair (disable wins) and the hard-off cases (shell execution sandbox,
  provisional workspace).
- The daemon reads the setting separately for each workspace runtime and
  treats it as on only when it is `true`.
- The setting is restricted: workspace settings cannot change it.
- The Workflow tool is deferred behind tool search, so until the model loads
  it, the context carries only its name.

## Goals

- Workflows are available without any setup.
- `tools.workflowsEnabled: false` and `QWEN_CODE_DISABLE_WORKFLOWS=1` still
  turn them off.

Non-goals: changing the size guideline, the per-run caps, or the keyword
trigger.

## Design

- `tools.workflowsEnabled` defaults to `true`. An unset value means on in the
  CLI, the TUI, ACP sessions and trusted local daemon workspace runtimes in
  normal mode. An explicit `false` turns workflows off.
- The CLI skips this setting under `--bare`, whose restricted toolset omits
  Workflow. In `--safe-mode`, workflows default to off. An explicit `true`
  or `QWEN_CODE_ENABLE_WORKFLOWS=1` enables them unless the disable override
  is set.
- Daemon capabilities use the selected runtime's settings and environment.
  Workspace reload updates tool availability and model declarations for
  existing ACP sessions.
- The setting's description, the Web Shell description and the user docs say
  workflows are on by default and how to turn them off.

## Decisions

- **Keep the guard rails as they are.** A run is bounded by the size
  guideline (`medium`, under 15 agents, by default), the per-run agent cap
  and the 30-minute wall-clock cap, and the approval mode in effect decides
  whether the run asks first. Those already apply to users who opted in, and
  they are what limits spend.
- **Keep the restricted toolset in bare mode and opt in under safe mode.**
  This preserves the behavior of both startup modes.
- **Keep the keyword trigger on.** A message containing `workflow` or
  `ultracode` now adds a reminder for more users. The reminder only suggests
  the tool when the task fits, and `ui.disableWorkflowKeywordTrigger` turns
  it off.

## Risks

- More users may start runs that spend many tokens. The size guideline keeps
  runs moderate by default, and the caps bound each run.
- Messages that use "workflow" in another sense (for example a CI workflow)
  now get the steering reminder. The model is told to proceed normally when a
  workflow does not fit.

## Validation

- Config: unset means on; `false` means off; unset in bare or safe mode means
  off; the env pair still overrides.
- Daemon: primary, dynamic and secondary runtimes report their effective
  workflow setting, including the safe-mode default and environment overrides.
  Existing ACP sessions can run saved workflows after removing an opt-out and
  stop offering the tool after reapplying it.
- E2E: a fresh HOME with no workflow setting can load and run the Workflow
  tool in `qwen -p`; with `tools.workflowsEnabled: false`,
  `QWEN_CODE_DISABLE_WORKFLOWS=1` or `--bare` the tool is absent.

## Acceptance criteria

- A new install offers the Workflow tool, `/workflows` and saved workflows
  without any setting.
- An explicit `false` or `QWEN_CODE_DISABLE_WORKFLOWS=1` disables the tool and
  saved workflows. In sessions that support Workflow mode,
  `/workflows mode status` and `/workflows mode off` stay available.

## Follow-up

- None planned.
