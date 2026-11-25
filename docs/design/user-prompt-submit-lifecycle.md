# UserPromptSubmit lifecycle

[English](user-prompt-submit-lifecycle.md) | [简体中文](user-prompt-submit-lifecycle.zh-CN.md)

## Problem

The shared model client runs `UserPromptSubmit` on tool results and Stop-driven continuations. Legacy ACP can also rerun it on retry. A prompt with two tool calls can therefore evaluate the same hook configuration three times before it yields a final answer. Tool-result rounds can spend time generating context they have already received, and a hook block can prevent completed tool responses from reaching the model.

## Design

- The shared model client checks a new user query once. A caller that checks before expansion hands that verdict to the first send. Tool results, Stop continuations, retries and restored history use their own paths without a prompt check.
- ACP applies the same policy on both model loops. Direct ACP prompts and daemon user submissions also work without original-text metadata. The daemon stamps the prompt origin at admission and the ACP child accepts the stamp only from its authenticated parent. Promoted user messages qualify. Internal dispatches and coordinator-only steering have their own origin. A channel turn qualifies when its trusted origin marks it user-initiated.
- The terminal surfaces retain their existing draft restoration and prompt admission. A completed decision stays with its queue entry when an unsent terminal message is restored. Terminal queue behavior that combines unchecked drafts continues to submit the combined prompt once.
- The hosted harness uses the accepted input's source to identify a fresh user prompt. Its per-message steering admission and durable recovery continue to use their existing occurrence IDs.

`submitted_prompt` remains optional original-text provenance. The invocation decision does not use its presence. Local-only commands, Mod-generated prompts, scheduler jobs, and internal continuations are outside the event. Changes to tool execution and other hook events are outside this scope.

Public prompt endpoints treat incoming prompts as user submissions unless authenticated metadata identifies the source. An external relay that submits generated text through the same endpoints, such as the separate Qwen Live process, follows that public contract.

## ACP steering

The bridge owns each accepted steering message until delivery, policy rejection, withdrawal, or draft recovery. The ACP child claims a batch under a lease, resolves attachments with the turn's cancellation signal, and runs `UserPromptSubmit` once per claimed user message. It returns an individual allow, policy rejection, execution error, or release for each message. Existing coordination messages continue through their dedicated path.

| Bridge state                | Decision                                      | Result                                                                                                                   |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Queued, leased, or promoted | Cancel, execution error, or interrupted child | Revoke admission and append the original text and valid attachments to the assigned client's recoveries.                 |
| Queued, leased, or promoted | Withdraw or delete                            | Revoke admission and remove the queue item.                                                                              |
| Leased or promoted          | Explicit hook rejection                       | Remove the queue item and report the policy reason.                                                                      |
| Leased or promoted          | Allow with a current lease                    | Persist the message, hook context, and attachment references before broadcasting delivery or returning the committed ID. |
| Queued                      | Current turn ends normally                    | Start a following turn under the same lease and admission rules.                                                         |
| Committed                   | Cancellation or child exit                    | Keep the message and complete any missing history write.                                                                 |

The host serializes settlement with cancellation and withdrawal. A result for a revoked lease cannot admit or reject the message. An unsettled lease is released back to the host for terminal settlement. A user stop cancels pending steering while preserving independently queued ordinary prompts. Attachment resolution and hooks observe cancellation, and cancellation cleanup performs no prompt checks.

The durable commit is the boundary for live projection, model input, and chat history. The child records by message ID after the host confirms it. A replacement child replays committed entries into the history before it accepts further prompts. History acknowledgements let the host discard replay data after the transcript is durable. This also covers a promoted message's first prompt.

The client assigns a message ID before upload or enqueue and binds it to the target turn and its cancellation generation. A confirmed handoff transfers draft ownership to the host. The client keeps an unaccepted submission locally. When the request outcome is uncertain, it keeps its copy and reconciles the same ID before restoring it. Cancelled targets cannot be resubmitted automatically through the ordinary prompt endpoint. The host assigns each recovery to a single client. That client merges recoveries in order with its existing draft, deduplicates by message ID, and acknowledges consumption after saving the result.

## Verification

- In a turn with two tool calls, observe one `UserPromptSubmit` before the first request, two `PostToolUse` events, and both tool results in the corresponding model requests. Cover headless and both ACP model loops.
- Submit another user message in the same session and observe its own hook result. Cover a metadata-free prompt, a steering message with added context, and a blocked steering message alongside a successful tool result.
- Confirm that a retry, a Stop continuation, and automated input do not invoke `UserPromptSubmit`. Confirm that an initial hook block or cancellation prevents the initial model request.
- Stop before steering enqueue, while it waits, during attachment resolution or a hook, after allow but before commit, and immediately after commit. Check live projection, model input, history, hook count, and recovery at each boundary.
- Withdraw while queued, leased, or promoted. Verify that delayed answers cannot restore delivery. Cover normal promotion, policy rejection, hook timeout and malformed output, child exit before and after commit, and repeated backfill.
- Drop an enqueue response and refresh the originating client. Use a second client and two unconsumed recovery batches. Verify owner-only restoration, one copy of each message and attachment, and consumption after local persistence.
