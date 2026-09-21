# Saved workflow slash-command completion

[English](2026-09-21-workflow-slash-completion.md) | [简体中文](2026-09-21-workflow-slash-completion.zh-CN.md)

Status: proposed fix for [#12176](https://github.com/QwenLM/qwen-code/issues/12176).

## Problem

A saved-workflow slash command starts a client-initiated tool call. Its foreground result does not continue the model turn, and the registry emits completion notifications only for background runs. The result can exist on disk without reaching the conversation.

## Decision

Keep saved slash commands in the foreground. Separate completion delivery from execution mode: the scheduler passes an internal notification flag to notification-aware invocations for client-initiated calls, excluding nested code-mode calls whose results return to their parent. The Workflow invocation passes that flag to its runner and registry entry. It is not a model-facing tool parameter or a persisted execution-mode setting. Both initial scheduling and rebuilding an invocation after an argument edit preserve the flag.

A completed or failed client-started run uses the existing completion callback and notification queue. Model-started foreground runs retain their tool-result return path; background runs retain their existing notification path. Cancellation produces no completion notification. Terminal-state guards prevent a run from reporting twice.

The runner refreshes the tool card with its terminal state before execution settles. After Esc cancellation, the card retains its run ID and phase history with `status: "cancelled"`, replacing stale running progress. The active-progress guidance disappears once the run settles. This display refresh does not enqueue a completion notification.

Foreground progress stays in the live tool card, with a run ID and guidance pointing to the card and `/workflows`. Its completion notice displays the run ID, status, a bounded result preview or error, recorded subagent failures, and explicit lines for nonempty top-level `failed`, `errors`, or `error` values reported by the script. These fields are displayed as reported data, not used to reinterpret a completed run as a runtime failure. Arbitrary application-specific result schemas remain uninterpreted.

The TUI displays this foreground notice when the callback arrives, before waiting for model admission or a response. The same notification is then delivered through the existing queue and recorded in the conversation. A later question has the returned result in model context. The slash-command dispatch record may still have empty `outputHistoryItems`: the completion has its own notification record.

## Alternatives and tradeoff

Removing the foreground guard for every run would add notifications to model-started runs that already return a tool result. Forcing slash commands into background mode would change inline progress and foreground cancellation. The internal delivery flag preserves those behaviors while reusing the notification channel.

Letting client tools through the normal tool-result continuation would also require handling their missing model-authored tool call, turn ownership, and cancellation. Expanding the command into a model prompt would add an invocation before execution and give the model control over the requested arguments. Neither is needed for this fix.

The existing notification channel starts a model response and consumes tokens; this proposal preserves that report-back behavior requested by the issue. A configurable silent-context update or optional automatic summary is a separate feature, not implied by preserving foreground execution. The visible result does not depend on the model successfully generating a summary.

## Scope

Interactive saved workflow commands keep their script-path/name-only choice, arguments, approvals, foreground progress, and cancellation. Headless and ACP commands retain prompt expansion. Code-mode nested calls return to their parent; ordinary model calls do not gain notifications. No public tool schema, configuration option, or persisted-schema migration is added.

OpenTUI's separate unwired `schedule_tool` handler and a new persisted-result viewer in workflow history remain outside this change.

## Validation

Use an isolated interactive session and a recording synthetic model endpoint. Verify foreground progress before a controlled agent finishes, visible completion data and real subagent failures, exactly one result notification, persistence, and result retention on a follow-up question. Exercise thrown script errors, cancellation, and approval refusal. Use model-initiated foreground execution as a control: one tool response and no completion notification. Preserve loader coverage for arguments, name-only dispatch, headless, and ACP.

Run targeted unit and terminal regressions, build/type checks, and checks for changed files. No local repository-wide test suite is part of this revision. Evidence belongs in the PR verification report and must distinguish synthetic transport checks from real-model summary quality and the reporter's original nine-agent workload.
