# Subagent detail availability during creation

Web Shell currently opens a detail panel before a subagent session can be resolved. The first running tool update precedes slot allocation, runtime initialization, task registration, and transcript setup. Missing titles are presentation fallbacks, not lifecycle signals.

## Design

Carry an optional `subagentSessionReady` boolean on the existing tool update path. The CLI marks main-session agent launch/preparation frames false and forwards the ready transition from the live execution callback before the tool completes. Core keeps false during regular-agent initialization and emits true only after task registration and transcript/meta setup, for both foreground and background execution. Subsequent progress and result displays retain the value. No new endpoint, SSE event, polling loop, or dependency is needed.

Nested details replay a separate JSONL transcript. Its writer records `agent_session_ready` system records only when readiness changes, starting false after the nested tool call. The existing replay bridge converts these records to tool updates. Resume skips trailing readiness markers when trimming unfinished calls, and finalized nested failures preserve their error status. Legacy inline child streams retain their previous behavior because they do not forward intermediate tool output.

The SDK normalizer reads the explicit metadata/display boolean, and the transcript reducer retains it as typed tool-block state. This also makes it available to safe projections that intentionally discard raw output. Web Shell projects that field into its tool model and preserves it when merging updates. True is latched: later partial updates must not regress an established session back to creation.

A shared presentation helper controls all subagent detail launch buttons. Explicit false on an active call disables activation and supplies the localized hover/focus description “Creating…” / “创建中”. A launch which fails or is cancelled before readiness remains unavailable with its terminal status, rather than claiming it is still creating. Ready agents remain inspectable even if their execution subsequently fails. Missing fields preserve legacy behavior. Completed launches retain their existing opening behavior (including named teammates, which use a different session mechanism). Document-mode inline rendering and approval handling remain intact.

Use `aria-disabled` plus an activation guard and the existing/native tooltip affordance so disabled entries remain discoverable by keyboard and pointer. Guard the shared opening callbacks as well as the visible controls.

## Changes and consumers

- Core: tool display type, regular-agent foreground/background startup, nested transcript readiness records and focused lifecycle tests.
- ACP bridge: replay readiness records on the existing tool-update path.
- CLI: tool-start emitter and its tests, including preparation placeholders; virtual-session streaming and reload regression coverage.
- TypeScript SDK: event/block types, tool normalization and reduction, tests for missing/false/true and partial updates.
- Web Shell: compact event projection, transcript-to-message adapter and merge, tool model, availability helper, single/parallel/plan/workflow buttons, opening callbacks, localized strings and targeted tests.

No daemon route ownership changes. Child details continue resolving inside the existing parent-session owner runtime. No change to spawn scheduling, approvals, or execution status semantics.

## Validation

Verify creation to ready transitions for foreground/background agents, initial placeholders, terminal failures/cancellation, nested launches, legacy transcripts, safe/compact projections, and pointer/keyboard activation. Run build, typecheck, bundle and focused package tests; inspect the complete diff and conduct an independent review.
