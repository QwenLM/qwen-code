# Workspace Agent PR Stack

[English](2026-09-27-workspace-agent-pr-stack.md) | [简体中文](2026-09-27-workspace-agent-pr-stack.zh-CN.md)

## Decision

Land persistent workspace-agent collaboration as a stack of independently buildable changes:

1. Durable thread, message, run, admission, and lifecycle state in the core package.
2. Agent execution, collaboration tools, daemon routes, recovery, and streaming.
3. Web Shell roster, conversation, routing, and activity UI.
4. A2A external access and remote Runtime execution as sibling follow-ups.

The first change is intentionally internal. It persists and validates the state machine and proves it with package-level tests, but does not register tools, routes, timers, or UI. Therefore merging it alone does not expose a feature or start background work.

Each later PR must build and pass its own focused tests against the preceding head. Tests move with the behavior they protect. Cross-layer fixes stay with the lowest layer that owns the invariant.

## Boundaries

The foundation owns workspace-scoped identities, durable thread records, message routing, admission decisions, close obligations, token/turn accounting, filesystem locking, and stranded-run inspection. It does not own model execution, ACP sessions, HTTP routes, browser components, A2A grants, or remote-host leases.

The execution PR consumes this internal API and is the first layer that can run an Agent. The Web Shell PR only exposes the already working daemon contract. A2A and remote Runtime PRs both depend on the Web Shell/execution stack, but not on one another.

## Merge sequence

Merge the foundation into `main`, retarget the execution PR to `main`, then merge the Web Shell PR. Retarget and reconcile the A2A and Runtime sibling PRs after the UI layer lands. Re-run current-head CI after every base change.
