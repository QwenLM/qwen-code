# Background workflow runs by default

[English](2026-11-19-workflow-background-by-default.md) | [简体中文](2026-11-19-workflow-background-by-default.zh-CN.md)

Status: proposed. Step 1 (background runs in headless mode) is implemented in
the same change; steps 2 and 3 follow in later changes.

## Problem

A foreground workflow holds its tool call until the run settles, which can take
up to the 30-minute wall-clock cap. For that whole time the model's turn is
blocked and the user can only watch. A background run returns a run handle at
once and reports back through the conversation when it settles, but the model
gets one only when it asks: `run_in_background` defaults to `false`, and
headless runs (`qwen -p`, stream-json) reject it outright.

## Current state

- The Workflow tool accepts `run_in_background: true` in the interactive TUI
  and in ACP sessions (Web Shell, IDE clients). Both register a workflow
  completion callback that feeds the session's notification queue.
- A headless run registers no workflow completion callback, and its exit
  holdback waits only for background agents, so the tool refuses background
  workflows there.
- Some hosts keep workflows in the foreground on purpose: a Qwen Session Agent
  (its adapter returns only the original prompt's result), a Channel turn that
  cannot receive a background result, and an ACP session whose workflow
  controls are off (workflows disabled, bare mode, untrusted workspace).
- Bundled skills that need a result inside the same turn pass
  `run_in_background: false` explicitly (`review`), or rely on the default
  (`autofix-pr`'s foreground branch).

## Goals

- Every host that can deliver a result to the conversation, headless included,
  accepts background workflow runs.
- When the caller does not say, a workflow runs in the background wherever the
  host supports it.
- Foreground stays available: on request, and as the fallback where a host
  cannot take a background run.

Non-goals: removing the foreground mode, changing how Session Agents or
Channels deliver results, and the execution view redesign.

## Design

1. **Headless delivery (this change).**
   - The headless run registers a workflow completion callback that queues the
     completion as a notification, the same way background agent results are
     queued, and clears it when the run ends. Stream-json sessions run each
     prompt through the same code, so they get the same behavior.
   - Before emitting its result, the run waits while a workflow is starting,
     running or pausing, and drains each completion as a turn.
   - A cancelled run sends no completion, and a paused run would wait for a
     resume nobody can give in an unattended run, so neither holds the run
     open. Teardown cancels whatever is left.
   - Every path that ends the run early (an interrupt or the `--max-wall-time`
     abort at any point, structured output, loop detection) cancels running
     workflows and waits up to 2 seconds for each to record its end. A run
     that settles in time is saved as `cancelled` and removes its checkpoint,
     so it does not read as a run a crash interrupted.
   - `hostSupportsBackgroundWorkflows` accepts every non-ACP host. The tool
     still refuses a background run when no completion callback is
     registered, so a host that cannot deliver one keeps failing closed.
   - The parameter and runtime descriptions say a headless run waits for a
     background workflow before exiting.
2. **Background by default (next change).**
   - An omitted `run_in_background` means background where the host supports
     it, and foreground where it does not. An explicit `true` is still refused
     where unsupported; an explicit `false` stays in the foreground.
   - Saved-workflow slash commands follow the same default.
   - Refusal texts that tell the model to omit the parameter tell it to pass
     `false` instead. Skill steps that rely on the omitted value meaning
     foreground pass `false` explicitly.
3. **Execution view (later).** The redesign treats a background run as the
   common case: the inline card stays a live view of the run, and the
   Workflows page and Background tasks dialog carry the full detail.

## Decisions

- **Keep the foreground mode.** Some callers need the result inside the same
  turn: review waves, a Session Agent returning to its caller, a Channel turn
  with no chat to report to.
- **Fall back instead of failing on an omitted parameter.** The caller did not
  ask for background, so a host that cannot take one runs the workflow the way
  it does today.
- **No separate headless wait limit.** The workflow's own wall-clock cap
  (`QWEN_CODE_MAX_WORKFLOW_SECONDS`, 30 minutes by default) already bounds the
  wait, and `--max-wall-time` bounds the whole headless run.
- **Cancelling a turn no longer stops a background run.** It is stopped from
  Background tasks or `/workflows`; in a headless run, an interrupt cancels it.
- **No SDK task events for workflows in this change.** A cancelled workflow
  sends no completion, so a `task_started` event could not always be paired
  with a `task_notification`. Stream-json consumers see the completion summary
  as a user message and the turn it starts.

## Risks

- A headless run that starts a background workflow now lasts until the run
  settles instead of failing the tool call.
- A paused background workflow in a stream-json session does not hold the
  prompt open; if it is resumed and settles after that prompt ended, its
  completion is not delivered.
- An interrupt that a stream-json session recovers from leaves a background
  workflow running, as it leaves a background agent. Its completion is
  delivered only if a later prompt is running when it settles, and that
  prompt then waits for it.
- After step 2, a model that expected a foreground result gets a run handle
  and must wait for the notification. The tool description and the authoring
  skill say so.

## Validation

- Core: a non-interactive host with a completion callback accepts
  `run_in_background: true`; without one it is refused.
- CLI: a headless run waits while a background workflow is running, drains
  its completion as a second turn, and clears the callback at the end.
- CLI: an interrupt cancels the workflow and exits only after its runner has
  settled.
- E2E: `qwen -p` asked to run a short workflow in the background prints the
  final answer after the workflow completes; an interrupt during the run,
  while waiting to exit or mid-turn, exits with code 130 and leaves the run
  saved as `cancelled` with no checkpoint.

## Acceptance criteria

- `qwen -p` and stream-json sessions accept a background workflow and do not
  exit before its completion has been handled.
- Hosts without a completion channel still refuse background runs.
- TUI and ACP behavior is unchanged by step 1.

## Follow-up

- Step 2: make background the default.
- SDK `task_started` / `task_notification` events for workflows, once a
  cancelled run reports its end.
