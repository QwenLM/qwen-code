# Fork Subagent `fork_turns`

## Summary

Add an optional `fork_turns` parameter to the Agent tool's existing detached
`subagent_type: "fork"` runtime. A fork continues to inherit the full parent
conversation when the parameter is omitted. Callers can explicitly use:

- `all` for the full parent conversation, or
- a positive integer string such as `"3"` for the most recent three real user
  turns.

Regular subagents and named teammates do not accept `fork_turns` and continue
to start without parent conversation history.

## Goals

- Preserve the existing full-history behavior for fork calls that omit the
  parameter.
- Let callers bound a fork's inherited history without changing its system
  prompt, tools, model, approval mode, working directory, or detached
  lifecycle.
- Count real user turns rather than raw API messages. Tool responses and pure
  system reminders do not consume the requested turn count.
- Keep the selected fork history isolated from mutable parent message parts.

## Non-goals

- Add context inheritance to regular specialized subagents or agent-team
  teammates.
- Add a no-history fork mode. Callers that do not want parent context should
  launch a regular subagent.
- Change fork availability, nesting rules, background execution, transcript
  recovery, or reuse of the parent's system prompt and tool declarations.

## Design

### Parameter and validation

`AgentParams.fork_turns` is optional. The JSON schema accepts `all` or a string
matching `^[1-9][0-9]*$`. Omission normalizes to `all`, preserving the existing
fork behavior.

Supplying `fork_turns` with any non-fork subagent type, with no explicit
subagent type, or while spawning a named teammate is rejected. `none`, zero,
negative numbers, decimals, whitespace-padded values, and non-string values
are rejected.

### Selecting history

`all` uses the same curated parent history as the existing fork runtime.

For a numeric value, the parent chat removes its leading startup context before
curating conversation history. This prevents curation from coalescing the
startup reminder with the first real user prompt. The original startup prefix
is then prepended to the selected window so the fork retains the parent's
environment context.

A real user turn is a user-role message containing content other than function
responses, empty text, or pure system reminders. The selected slice begins at
the Nth most recent real user turn and includes subsequent model messages,
tool calls, tool responses, and reminders. If fewer than N real turns exist,
all available real turns are selected.

A compacted-history summary is a synthetic prefix and is not included in a
numeric window; callers should use `all` when the fork needs the compacted
summary. The final selected history is deep-cloned so the fork and parent do
not share mutable nested message parts.

The existing fork construction still repairs the final boundary before
sending the directive. It drops an unanswered trailing user message and
closes an open model function call with placeholder responses when required.

### Background revival

The selected initial messages continue to use the existing fork bootstrap
record. Transcript recovery therefore revives a bounded-history fork with the
same selected history, launch-time system instruction, tools, and task prompt
as its original execution.

## Compatibility and risks

Existing fork calls remain full-history forks because omission defaults to
`all`. Existing regular subagent and teammate calls remain isolated. A numeric
window can omit older facts or compacted summaries, so the directive must
repeat any older context the fork still needs. It also shortens the reusable
conversation-history cache prefix, while the parent system prompt, tools, and
startup context remain shared.
