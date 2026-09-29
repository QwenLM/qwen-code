# Workflow completion follow-ups

[English](2026-09-28-workflow-completion-followups.md) | [简体中文](2026-09-28-workflow-completion-followups.zh-CN.md)

## Problem and scope

Issue #12908 follows the four non-blocking findings on #12415: failed runs use the run ID as their label, nested Error reasons disappear, explicit notification opt-out lacks a unit test, and foreground notices precede their tool card and earlier background notices. This change covers the Ink workflow completion path and shared result formatting. It adds no OpenTUI, ACP, or headless notification delivery.

## Design

Register the compiled metadata before execution so the registry can derive the run description from its name. This covers success, script failure, and approval failures that settle the registry before the runner settles. Preserve caller-provided descriptions and the separate run ID.

Keep the existing Error string representation and append bounded aggregate members and causes. Use cross-realm native Error detection. Limit one rendered error to 4,096 UTF-16 code units without splitting a surrogate pair, at most 32 visited values, depth 4 below the root, and 8 aggregate members per error. Mark cycles and truncation, omit stacks, and read cause/errors data properties without invoking getters. Non-Error reasons use their string representation. If conversion or an Error property read throws, mark that value unrenderable while preserving surrounding results and sibling reasons. The existing outer JSON fallback, terminal sanitization, and notification budgets still apply.

A foreground completion retains its display item until its owning scheduler batch commits the tool card. Resolve the run's toolUseId to the existing per-mount batch identity, rather than using a wire call ID as a persistent identity. Retain preceding queued terminal notifications with the foreground display so their visible order matches arrival order. Interim monitor pulses retain their current drain behavior. When the batch commits, append the pending displays after the card and mark the same notification objects displayed. Model admission continues through the existing queue; retries/requeues therefore cannot duplicate display. Retain foreground display references even if queue admission drops their model notification. Clear deferred display state on session change. Completions without an active owning batch can display without waiting.

This separates the display barrier from model admission: a refused or failed model turn cannot hide a completed result. It does not move model submission into the scheduler callback or introduce a second model-delivery queue.

Queue overflow marks discarded notification objects at admission or requeue. Deferred displays skip those objects, except for their own foreground completion, whose display remains required even if its model notification is discarded. This prevents a captured background result from being displayed after eviction while retaining the foreground visibility guarantee.

## Validation and acceptance

- Named failures preserve name and run ID in foreground/model notices, including registry settlement before script completion; background labels and explicit descriptions are correct.
- Cross-VM aggregate/cause results keep inner reasons; unrenderable members preserve other result fields and sibling reasons; ordinary Error output stays compatible. Tests pin both sides of the depth, member, and visit limits, along with cycles, length, getter avoidance, and stack omission.
- Explicit false enablement returns the tool result without notifying; true enablement provides a positive control. Removing the enabled guard must fail the new test.
- A scheduled workflow's card precedes the earlier background notice and foreground notice. Model failure leaves each notice visible once. Overflow and session reset must not leak or lose a deferred foreground display. Evicted background results and cancelled interim monitor pulses must not appear during the foreground flush.
- Run focused core and CLI tests, build, typecheck, formatting/lint, and the mock-provider interactive workflow completion suite. A global qwen E2E baseline is unavailable on this host; baseline test-script reproductions are recorded separately.

## Risks

Nested-error formatting expands error content within a new per-error cap. Display ordering retains references for in-flight batches and must release them at batch completion or session reset. Model notification admission, cancellation semantics, and successful result persistence must remain unchanged.
