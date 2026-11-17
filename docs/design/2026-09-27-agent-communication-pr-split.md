# Agent communication PR boundaries

[English](2026-09-27-agent-communication-pr-split.md) | [简体中文](2026-09-27-agent-communication-pr-split.zh-CN.md)

## Decision

Keep #11206 as the local collaboration foundation. Extract A2A from #12582 into a sibling PR based on the same foundation. #12582 retains runtime enrollment, program placement, heartbeat, lease pickup, progress and results. A2A retains the JSON-RPC transport, agent cards, caller grants, idempotent external intake, sharing UI and their tests.

A2A calls the existing local dispatcher through persisted threads; it does not need host identities, execution placement or leases. Each sibling must build and pass its own acceptance before merging. When the foundation lands, update each sibling onto main and rerun CI. Neither sibling requires the other to land first.

## Preservation and validation

Move existing behavior without adding an abstraction or changing the protocol. Keep grant preservation on local session release with A2A; keep held-lease delivery and removed-workspace pickup fixes with remote runtimes. Give sharing its own copy/done translation keys so it works without runtime UI.

Validate independent builds/typechecks, focused store/route/UI tests and real HTTP acceptance. The A2A-only branch must offer sharing while host routes are absent. The runtime-only branch must offer host execution while A2A/share routes are absent. Preserve the previous combined implementation as the comparison point and inspect all extraction changes.

## Remaining work

Runtime removal/key revocation and real cross-machine/Claude/Codex acceptance remain in the runtime PR. A2A uses the agent's existing tool policy and polling transport. The split does not settle the foundation's budget or retention policy and does not claim completed remote CI.
