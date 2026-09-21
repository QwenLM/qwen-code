# Saved workflow slash-command completion

[English](2026-09-21-workflow-slash-completion.md) | [简体中文](2026-09-21-workflow-slash-completion.zh-CN.md)

Status: proposed fix for [#12176](https://github.com/QwenLM/qwen-code/issues/12176).

## Problem

The interactive saved-workflow command dispatches a client-initiated foreground
tool call. Client-initiated tools do not send their results to the model, while
the workflow completion callback serves background runs only. The run can
finish and persist a result without sending that result to the conversation.

## Decision

Set `run_in_background: true` on the interactive command's workflow arguments.
Use the existing run acknowledgement, workflow registry completion callback,
and TUI notification queue. Preserve script-path versus name-only dispatch and
the supplied arguments.

The acknowledgement identifies the run and points to Background Tasks. The
`/workflows` dialog provides its phase tree, usage, pause/resume, and cancellation
controls. Completion or failure enters the conversation through the existing
notification channel, including the returned value and recorded agent failures.

## Alternatives and tradeoff

Keeping the foreground mode would require either a client-origin discriminator
in the workflow registry or an exception in the tool-result continuation path.
Both would introduce new delivery rules for a case the existing background mode
already handles. Removing the foreground notification guard would deliver
model-initiated foreground results twice.

Another option is to expand interactive commands into model prompts, as headless
and ACP commands do. The model could then invoke a foreground workflow and keep
inline progress. This adds a model turn before execution and gives the model
control over whether to invoke the tool and how to pass the arguments. Background
dispatch preserves the user's explicit invocation and arguments without that
extra launch step.

The chosen change moves inline live progress to Background Tasks and
`/workflows`, and releases the prompt after launch. Completion also starts a model
turn, consuming tokens even for a short script whose result previously stayed in
the local tool card. Maintainers should assess both the progress presentation and
the added completion cost. The change introduces no protocol or persisted-schema
change and does not alter model-initiated, headless, or ACP execution.

## Scope

The change covers interactive saved-workflow commands, including user, project,
and extension sources. Tool approval, trust checks, the workflow runner, and
notification admission remain owned by their existing components. Headless and
ACP commands continue to expand into model prompts.

OpenTUI's separate unwired `schedule_tool` handler and adding a persisted-result
viewer to workflow history are outside this fix.

## Validation

Use an isolated interactive session with a synthetic model endpoint. Prove that
a slash-command run writes its result and that the model receives that result
once without another user prompt. Cover successful results, a result describing
partial failure, and a thrown workflow error. Verify the start acknowledgement
and the model's completion response in the terminal.

Keep foreground model-tool execution as a control: its result uses the normal
tool response and produces no background completion notification. Preserve the
existing cancellation, approval, argument, name-only, headless, and ACP checks.

Execution evidence belongs in the PR's before/after report; this document states
the acceptance criteria, not a completed-test claim.
