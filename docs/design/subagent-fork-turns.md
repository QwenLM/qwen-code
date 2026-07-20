# Subagent `fork_turns`

## Summary

Add a `fork_turns` parameter to the `Agent` tool so a regular subagent or
named teammate can inherit parent conversation context without becoming the
existing detached `subagent_type: "fork"` runtime.

The accepted values match Codex while preserving Qwen Code's existing default:

- `all` inherits all available conversational history.
- `none` starts without parent conversation history and is the default.
- A positive integer string such as `"3"` inherits the most recent three
  real user turns.

Callers must explicitly opt into context inheritance. Existing calls that omit
`fork_turns` keep their fresh-context behavior.

## Goals

- Preserve each regular subagent's own system prompt, model, tools, approval
  mode, working directory, and lifecycle.
- Count real user turns rather than raw API messages. Tool responses and pure
  system reminders do not consume the requested turn count.
- Keep inherited history valid when the parent is currently issuing the
  `Agent` tool call.
- Apply the same context-selection semantics to named in-process teammates.
- Preserve inherited context when a background subagent is later revived from
  its transcript.

## Non-goals

- Change the detached `subagent_type: "fork"` runtime. It already inherits the
  full parent context and cache-safe runtime prefix.
- Add context inheritance to subprocess backends. Team teammates currently use
  the in-process backend.
- Make `fork_turns` select a model, agent type, or execution mode.

## Design

### Parameter and validation

`AgentParams.fork_turns` is optional. The JSON schema accepts `all`, `none`,
or a string matching `^[1-9][0-9]*$`, with `none` as the default.

An explicitly supplied `fork_turns` is rejected with
`subagent_type: "fork"` because the detached fork always owns the complete
parent history. Accepting both would imply that a detached fork can be
partially or not context-inheriting, which its runtime does not support.

### Selecting history

The parent Gemini client's curated history is used so invalid or interrupted
entries have already been repaired by the chat layer. The leading startup
context reminder is removed because the child generates startup context for
its own working directory.

For a numeric value, a real user turn is a user-role message that is neither:

- a pure function-response message, nor
- a pure system-reminder message.

The selected slice begins at the Nth most recent real user turn and includes
all model messages, tool calls, tool responses, and reminders after that
boundary. If fewer than N real turns exist, all available real-turn history
is inherited. A compacted-history summary is a synthetic prefix and is not
included in a numeric window; use `all` when the child should receive it.

The selected history must end with a model message before the child task is
sent as a new user turn. A trailing user message is dropped. Open function
calls in the final model message are closed with placeholder function
responses followed by a short model acknowledgement.

### Runtime composition

`PromptConfig` gains `extraHistory`, which is appended after the regular
subagent's own environment bootstrap. This differs from `initialMessages`:

- `extraHistory` preserves the child's startup context and system prompt.
- `initialMessages` continues to replace startup context for the detached fork
  and transcript-resume paths that own the complete history.

Regular foreground and background subagents pass selected history through
`SubagentManager.createAgentHeadless(..., promptConfigOverrides)`. Named
teammates pass the same history through the existing
`InProcessSpawnConfig.chatHistory` path.

### Background revival

When a background regular subagent inherits context, the selected parent
history is written as a context bootstrap record in its JSONL transcript.
Transcript recovery prepends that bootstrap between the newly generated child
environment context and the subagent's own recorded task history. This keeps
`send_message` revival semantically equivalent to continuing the original
subagent.

The existing detached-fork bootstrap remains distinct because it also
persists the exact launch-time system instruction and tools.

## Compatibility and risks

The default remains zero inherited turns for backward compatibility. Selecting
`all` can increase prompt size; callers can select a bounded positive count
when they need context with tighter token control.

Inherited paths may refer to the parent's working tree. Existing worktree
notices remain authoritative and tell isolated or pinned subagents to
translate and re-read those paths before editing.
