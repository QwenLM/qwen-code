# Deliver background (async) hook output to the model

[English](2026-11-16-async-hook-output-delivery.md) | [简体中文](2026-11-16-async-hook-output-delivery.zh-CN.md)

- **Status**: implemented in this change. Closes capability ledger row L11, carried as a defect by the follow-up #17284.
- **Date**: 2026-11-16, against `main` `27681123f719`.
- **Related**: [agent loop capability ledger](2026-11-15-loop-capability-ledger.md) (L11); [unified agent loop](2026-10-23-unified-agent-loop.md); follow-up #17284; the synchronous counterpart `hooks/user-prompt-submit-context.ts`.

## The defect

Background (async) hooks run between turns. When one completes, `AsyncHookRegistry.complete` parses its stdout and accumulates model-facing context (`hookSpecificOutput.additionalContext`) and notification messages (`systemMessage`, plain stdout, stderr) into `completedContexts` / `completedOutputs`. `HookSystem.getPendingAsyncOutput()` drains both (get-and-clear), and its doc comment says the output is "for delivery to the next turn" — but **nothing called it**: on `main` the only occurrence of `getPendingAsyncOutput` outside tests is its own definition (`hooks/hookSystem.ts:996`). The output was collected and then silently dropped; it never reached the model. The 1.0 loop drains the equivalent pending async context in its request preparation (`event-bus/llm/request-preparation.ts:748-760`) and injects it as a meta user message before compression.

## The decision

Drain the pending async output when the outgoing request is assembled, and append it as a tagged context part, so it reaches the model on the next request.

- **Delivery point**: `LlmClient.sendMessageStream`, at the `requestToSend` assembly — after the UserPromptSubmit hook-context receipt and before the IDE-context merge and the system-reminders prepend. This is downstream of the Goal-admission and hook-window settlement blocks (it touches none of their contracts) and upstream of the send and its in-chat auto-compaction, so the compression threshold sees the same tail the provider will — matching the 1.0 "drain before compression" intent. It covers every turn type that reaches the assembly.
- **What is delivered**: both `contexts` (verbatim additional context) and `messages` (labeled `[type] hookName: message`), joined into one block. `<`/`>` are escaped so hook output cannot forge the closing tag, mirroring the synchronous UserPromptSubmit context.
- **Reserved tag**: `<qwen:async-hook-context>…</qwen:async-hook-context>`, defined in the new self-contained `hooks/async-hook-context.ts`.
- **Get-and-clear, no dedup**: the drain clears the registry, so a block is delivered exactly once. Unlike the synchronous UserPromptSubmit context — which persists in history and therefore needs the receipt symbol, history dedup and resume re-stamping — the async block needs none of that machinery: it is drained once and then lives in history as an ordinary delivered context part.

## Scope

- **In**: model-facing delivery of pending async hook output (L11): the drain, the formatting/wrapping helper, the single call site in the request assembly, and unit tests with mutation witnesses.
- **Out (follow-up)**: display projection and resume provenance for the async tag. The synchronous context is hidden from the user-facing transcript projection and re-stamped on resume via its receipt; the async block is delivered as a tagged part but is not yet wired into `projectUserTranscriptForDisplay`, so it currently projects as model-facing text. Hiding it and giving it resume provenance is a separate concern from "the output reaches the model" and is left to a follow-up.

## Verification

`hooks/async-hook-context.test.ts` drives a real `AsyncHookRegistry`: a completed hook's `additionalContext` and `systemMessage` are delivered in the tagged part, a second drain delivers nothing (get-and-clear), blank output yields no part, and hook output cannot forge the closing tag. Mutation witnesses: making the drain deliver nothing turns exactly the three delivery tests red (6 green); removing the escaping turns exactly the two escaping tests red (7 green); both mutants restored byte-identical. `prettier`/`eslint` clean on the changed files; the changed files typecheck (CI's frozen-lockfile build is authoritative).
