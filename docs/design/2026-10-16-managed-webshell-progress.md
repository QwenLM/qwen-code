# Managed WebShell progress and daemon appearance

[English](2026-10-16-managed-webshell-progress.md) | [简体中文](2026-10-16-managed-webshell-progress.zh-CN.md)

Status: implemented and accepted in the local Lima deployment.

## Problem and scope

An observed Managed Turn executed 18 tools but exposed no tool events. A silent archive download timed out after 300 seconds, then the private model loop stopped at its hardcoded 16 rounds. WebShell showed only concatenated assistant text and a generic failure. Managed already uses the daemon's MessageList, but does not inherit its customization and adds a large progress box and extra layout gaps.

This change restores observable tool lifecycle metadata, removes the separate 16-round ceiling in favor of the existing model.maxSessionTurns setting, and aligns the presentation with ordinary daemon WebShell. It does not change execution placement, permissions, tool-result publication policy, or replay tools.

## Event projection

The Hosted Harness derives a tool's public identity and name from its committed assistant batch and ordinal. A committed tool.intent produces an in-progress tool_call update; its matching tool.receipt produces the terminal update from the durable execution status. Committed single-call tool_result history also projects a terminal update, covering legacy file execution without a receipt; duplicate status updates converge on the same Item. The model call ID is retained so O3 result projections join the same Item. Both live SSE and transcript replay use the same derivation and original journal sequence. Parallel calls retain separate identities.

Lifecycle updates contain only the tool ID, name and status. Raw arguments, paths, command contents, output, private references and credentials remain outside this projection. Original content and previews continue through the existing publication and artifact policy. A silent command therefore shows an active tool and elapsed time without inventing output. Missing or unrelated source records do not invent a tool or a terminal status.

## Model continuation and errors

The Hosted loop reads the existing model.maxSessionTurns configuration. Its default -1 allows continuation beyond 16 rounds. A positive setting bounds the Turn's model rounds, including the saved round on recovery. The existing cancellation signal, deadline, model token budget and durable recovery barriers remain in force. Limit exhaustion receives a named stop reason and public error code with a fixed, safe message; arbitrary provider errors remain redacted. No new configuration option is introduced.

Java persistence validation and the CLI's persisted approval and model-request readers accept nonnegative safe-integer round numbers without a separate 16-round ceiling. They preserve the original identity, source activation, digest and authorization checks; the configured limit is enforced by the model loop after restoration. Replacement-owner tests cover both the initial round and the first round beyond the former ceiling. Java tests cover admission beyond that ceiling and rejection of negative, fractional, coerced and unsafe counters.

## Presentation

Managed continues using the shared MessageList, MessageItem and ToolGroup. It receives the same presentation customization, without ordinary-daemon ownership callbacks. Its layout removes extra section gaps and passes the Managed Turn's start time to MessageList. The footer uses the daemon StreamingStatus stylesheet with Managed state, rather than reading ordinary daemon stores. Repeated tool progress preserves the first start time. Tools separate consecutive assistant commentary through the existing message adapter. On completion, the final assistant message receives the terminal timestamp so the shared summary retains total duration after replaying snapshot text parts that share their Item's creation time.

## Affected components and boundaries

CLI changes affect Hosted event envelopes, metadata derivation, the model loop and continuation validation. Java changes classify the safe limit error and accept late continuation rounds without weakening the existing field allowlist. WebShell changes affect the Managed message adapter, page layout and progress presentation, plus the App customization boundary. There is no schema migration or new API route. Workspace directory selection remains an independent part of this delivery.

## Validation and acceptance

Focused tests cover parallel identities, exact receipt association, successful/failed/cancelled outcomes, absence of raw content, live/replay parity, more than 16 model rounds, positive configured limits and recovery round counting. Consumer tests cover tool timing, message separation, progress presentation and shared customization. Run root build/typecheck/bundle and the affected Java verification gates. Verify the deployed local stack with a disposable real-model Session, a silent Shell, refresh, terminal status and a browser screenshot. Test that publication results still join the metadata Item when publication is enabled; a fixture result alone does not establish live storage acceptance.

Local acceptance on 2026-10-17 used the existing DeepSeek/deepseek-v4.1-flash configuration. A disposable Session exposed an environment-Hook refusal, a successful 50-second silent Shell and a completed file read as three distinct tool Items, with ordered assistant commentary, terminal state and identical transcript readback. The browser showed Running/elapsed/Waiting for output, then Completed and the final file marker; refresh retained a total duration of 4m36s. A pre-restart disposable Session also continued on the same Runtime worker PID/start identity. The original user Session remained at sequence 148 and was never resubmitted. That initial deployment used controlled tests for more-than-16-round and configured-cap acceptance; live publication storage acceptance remains outside this deployment's metadata-only policy.

Subsequent isolated acceptance completed 11 Turns across five Sessions using the same model. Independent checks confirmed diagnosis without edits, a rounding repair with nine passing tests and 40 additional arithmetic vectors, and three incremental requirements with preserved history. The first long-chain Turn exposed Java's remaining 0–15 persistence guard after 16 reads and completed after the guards were repaired and the isolated services restarted. A fresh Session then completed without a restart, persisting 25 model requests with rounds 0–24 and Shell approvals at rounds 21 and 23. Its 24 tools read all 20 dependent files, wrote the proof, observed a real verifier failure, corrected the proof and passed verification without another user message. Refresh retained Completed, tool steps and 51s total duration. The original user services and Session were untouched.

The interrupted task used the existing Runtime tool-result recovery route, which does not emit fresh main-model request metadata. Its completion is recovery evidence; the fresh Session independently establishes uninterrupted continuation beyond 16 rounds. Repeated crashes and a positive configured quota across that legacy route were not tested. Some earlier prompts used extra, individually approved read-only inspection commands despite their narrower Shell list; final model self-reports are not evidence of instruction compliance.

## Local UI evidence

The silent command remains visible while running, and the completed transcript retains tool steps and elapsed time after refresh.

![Silent tool running in Managed WebShell](../assets/managed-agent-local-debugging/progress-running.png)

![Completed Managed transcript after refresh](../assets/managed-agent-local-debugging/progress-completed.png)

The follow-up screenshots show separate Sessions: the first task blocked after 16 reads, and a fresh task completing 24 tools after the repair. The first test Session also completed after recovery.

![Long-chain task blocked after 16 reads](../assets/managed-agent-local-debugging/complete-prompt-blocked.png)

![Fresh long-chain task completed after refresh](../assets/managed-agent-local-debugging/complete-prompt-completed.png)

## Risks and open questions

Historical public projections are not rewritten, and an already failed Turn is not resumed automatically. Metadata projection must not turn a private result into public content or confuse a Broker execution ID with a model call ID. The existing unlimited default can run longer than the former hardcoded cap; operators can use the existing model limit and Turn deadline. No open product decision blocks this scoped repair.
