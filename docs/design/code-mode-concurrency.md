# Code Mode concurrent tool calls

[English](code-mode-concurrency.md) | [简体中文](code-mode-concurrency.zh-CN.md)

Status: Implemented.

## Problem

Before this change, Code Mode guidance recommended `Promise.all`. One rejected tool
promise can reject the program and cancel sibling calls before their results
are collected. The Core scheduler already runs safe reads concurrently, while
ACP and daemon sessions serialized every nested call. This made the same
program behave differently across entry points.

## Behavior

Recommend `await Promise.allSettled([...])` for independent searches and reads.
Examples inspect every result, printing fulfilled output and `String(reason)`
for rejections. The model must keep dependent actions, mutations, and approvals
sequential.
JavaScript already provides this method; no new runtime API is needed.

Within each Session `exec`, dispatch consecutive safe calls concurrently using
Core's `isToolCallConcurrencySafe` classification. Code Mode Bash calls bypass
the read-only command classifier; the model decides which commands are independent.
Ordinary Bash calls retain the read-only check. Respect
`QWEN_CODE_MAX_TOOL_CONCURRENCY` (default 10). An unsafe call waits for earlier
calls to settle, and later calls wait for it. Explicit sequential JavaScript
awaits retain their ordering. Queue admission follows submission order and
does not rely on timers to collect batches.

The shared safety predicate classifies skill loading as unsafe: despite its
`Read` kind, it can register hooks and change session permissions. This makes
skill execution a barrier in Core (including nested Code Mode), headless tool
batching, and Session nested dispatch.

Each call still re-enters `Session.runTool` for validation, permissions, hooks,
progress, telemetry, and recording. Finalize nested results by call ID so
concurrent completions cannot consume another call's records. Model-visible
results follow the submitted promise order; progress can arrive in completion
order. Drain pending dispatches before completing the parent result.

An ordinary tool error rejects that promise. `allSettled` lets independent
siblings finish. User cancellation and permission cancellation stop pending
work and propagate through abort signals shared by the nested calls. Session
also propagates a nested permission cancellation to its turn-stop result, even
when the program catches the rejection. The existing host
behavior for uncaught program failures, timeouts, and unawaited calls remains
authoritative.

Cancellation ends the wait for a nested tool's execution even if its implementation
ignores the abort signal. The call still finishes its cancellation hooks and
terminal recording before the parent completes. Late fulfillment, rejection, and
progress cannot publish a second result. A file read checks cancellation after
awaiting content, before updating its cache. Tool implementations remain responsible
for stopping their underlying work; cancelling the wait cannot undo side effects.

## Scope and decisions

Changes cover Code Mode guidance and examples, the shared skill safety
classification, Session nested dispatch and recording, and focused regression
tests. Core retains its permission preparation order before execution batching;
direct Session tool batching keeps its existing behavior. Unknown tools and
stateful MCP tools retain the existing conservative safety classification. No
new setting, permission policy, tool-search behavior, or provider-specific path
is added.

The implementation touches `packages/core/src/core/prompts.ts`,
`packages/core/src/core/coreToolScheduler.ts`,
`packages/core/src/tools/code-mode.ts`, and
`packages/cli/src/acp-integration/session/Session.ts`, with tests alongside the
existing prompt, scheduler, host, and Session tests.

## Risks and validation

Concurrency exposes shared result queues, permission cancellation races, and
hooks that rewrite arguments. Tests must check result ownership, safe-read
overlap, unsafe barriers, explicit sequential awaits, the concurrency cap,
failure isolation, and cancellation of active and queued calls. Session handles
hook-driven changes conservatively: shell calls are serialized while enabled
`PermissionRequest` hooks can rewrite their arguments. Evaluate safety when
admitting a call, after earlier barriers, because loading a skill may register
new hooks.

Run deterministic CLI and ACP probes against the global baseline and the local
bundle. Verify the full Session chain through controlled model tool calls;
headless CLI alone exercises the Core scheduler and cannot establish ACP
concurrency. Use a real-model smoke test to inspect the selected calling pattern.
Build, typecheck, run relevant package tests, and review the complete diff.

Acceptance requires safe calls to overlap within the cap, unsafe calls to
preserve submission barriers, each result to retain its call ID and output,
ordinary failures to leave independent results available, and user cancellation
to prevent queued tool execution. With an ACP read reply held, user cancellation
and guest completion must settle the parent and allow the next turn before the
reply is released. A late success or failure must not change terminal records or
populate the read cache. Code Mode remains experimental and opt-in.

## Open questions

None. Implementation or verification findings will be reflected in both
language versions.
