# Web Shell optional transport capabilities

[English](web-shell-optional-transport-capabilities.md) | [简体中文](web-shell-optional-transport-capabilities.zh-CN.md)

## Problem and scope

An embedded transport can support streaming prompts without exposing the optional daemon recap or native pending-prompt routes. Automatic recap and queue reconciliation must respect advertised capabilities. When `optimisticUserMessage=false`, the authoritative user echo also arrives after the browser starts sending; using the previous user message as the clock anchor briefly shows the previous turn's duration.

This change corrects browser behavior against existing transport contracts. It does not add daemon routes, authentication mechanisms, or persistent client queues.

## Decisions and constraints

- Register automatic recap only when `session_recap` is advertised.
- Query native pending prompts only when `session_prompt` is advertised. Without it, hold ordinary queued prompts locally while the session is active, then send them sequentially through the normal streaming action and await completion. Recheck ownership, cancellation and host dispatch policy before dispatch. Do not automatically replay an uncertain submission.
- Keep mid-turn injection independent from native queue support. An explicit host hold still blocks it; missing native queue support alone does not block an advertised mid-turn capability.
- Do not pair urgent prompt state with a deferred snapshot from an earlier transcript structure. Pure streaming tail appends retain the deferred path.
- A browser-owned send records its session ID and local start time until the send settles. Both chat layouts use it before an authoritative user echo arrives. Cleanup removes only the same operation's record, so a stale completion cannot clear a newer owner. This state is not sent to the daemon. Remote restored turns retain their authoritative start time.

Local queue entries remain browser-local and are not guaranteed to survive refresh. A transport lacking native queue support cannot expose other clients' pending native prompts. The native-capability path keeps its existing behavior.

## Validation and acceptance

Reproduce missing-capability calls, native queue dispatch on a streaming-only transport, and a clock anchored one hour in the past before changing production code. Verify positive capability controls, sequential completion, failed-send handling, independent mid-turn support, and restored remote timing. Verify local clock cleanup for completion, cancellation, rejection and replacement ownership. Keep UI structure consistency and streaming-throttle coverage.

Component and protocol-fixture tests must distinguish their evidence from a browser end-to-end run. No live account or provider-specific endpoint is required for these regressions. Before merging, run the affected tests, build/bundle, typecheck and formatting/lint checks. Browser validation of a host integration remains separate from those gates.
