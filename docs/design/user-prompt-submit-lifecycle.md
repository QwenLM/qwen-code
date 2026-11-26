# UserPromptSubmit lifecycle

[English](user-prompt-submit-lifecycle.md) | [简体中文](user-prompt-submit-lifecycle.zh-CN.md)

## Problem

The shared model client runs `UserPromptSubmit` on tool results and Stop-driven continuations. Legacy ACP can also rerun it on retry. A prompt with two tool calls can therefore evaluate the same hook configuration three times before it yields a final answer. Tool-result rounds can spend time generating context they have already received, and a hook block can prevent completed tool responses from reaching the model.

## Design

- The shared model client checks a new user query once. A caller that checks before expansion hands that verdict to the first send. Tool results, Stop continuations, retries and restored history use their own paths without a prompt check.
- ACP applies the same policy on both model loops. Direct ACP prompts and daemon user submissions also work without original-text metadata. The daemon stamps the prompt origin at admission and the ACP child accepts the stamp only from its authenticated parent. Promoted user messages qualify. Internal dispatches and coordinator-only steering have their own origin. A channel turn qualifies when its trusted origin marks it user-initiated.
- With `enableDelegatedPromptHooks` enabled in the receiving session's settings, its hooks check prompts sent by `create_sub_session` or `/send` before the model request. Delegated text that starts with a slash goes through message admission. The default preserves the previous handling of delegated prompts. The daemon stamps the sender's session and workspace on the trusted channel and the hook receives them as `source`. Delegated prompts omit `submitted_prompt`. Scheduled task runs skip this event. When a hook blocks the prompt, the first-turn result has stop reason `blocked`, and any `sent` completion notification reports failure.
- During an active turn, steering checks each user message before joining it to a model request. A blocked message is omitted, a notice is shown, and the tool results can still proceed. Accepted context uses the existing hook context part. A completed decision stays with its queue entry when an unsent terminal message is restored. ACP preserves input already delivered by the host through its existing history path, where it can provide context for later turns. Only live input admission can start a submit hook. Queue behavior that combines unchecked drafts into one fresh prompt continues to submit the combined prompt once.
- The hosted harness uses the accepted input's source to identify a fresh user prompt. Its per-message steering admission and durable recovery continue to use their existing occurrence IDs.

`submitted_prompt` remains optional original-text provenance. The invocation decision does not use its presence. Local-only commands, Mod-generated prompts, scheduler jobs, and internal continuations are outside the event. Changes to tool execution and other hook events are outside this scope.

Public prompt endpoints treat incoming prompts as user submissions unless authenticated metadata identifies the source. An external relay that submits generated text through the same endpoints, such as the separate Qwen Live process, follows that public contract.

## Verification

- In a turn with two tool calls, observe one `UserPromptSubmit` before the first request, two `PostToolUse` events, and both tool results in the corresponding model requests. Cover headless and both ACP model loops.
- Submit another user message in the same session and observe its own hook result. Cover a metadata-free prompt, a steering message with added context, and a blocked steering message alongside a successful tool result.
- Send a prompt to another workspace's session with `create_sub_session`. With the default setting, the target's hook skips the prompt. Enable `enableDelegatedPromptHooks` in the target, then check that the hook receives `source` before the model request, its context reaches that request, and a block reaches the sender with stop reason `blocked`. Repeat with text that starts with a slash and confirm it uses message admission. A public prompt request that supplies the sender key carries no `source`.
- Confirm that a retry, a Stop continuation, and automated input do not invoke `UserPromptSubmit`. Confirm that an initial hook block or cancellation prevents the initial model request.
