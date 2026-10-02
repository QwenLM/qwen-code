# Workspace Agent PR Stack

[English](2026-09-27-workspace-agent-pr-stack.md) | [简体中文](2026-09-27-workspace-agent-pr-stack.zh-CN.md)

## Decision

Land persistent workspace-agent collaboration as a stack of reviewable changes:

1. Durable thread, message, run, admission, and lifecycle state in the core package.
2. Agent execution, collaboration tools, daemon routes, recovery, streaming, and the Web Shell workflow that exercises them.
3. A2A external access.
4. Remote Qwen, Codex, and Claude runtimes.

The first change is intentionally internal. It persists and validates the state machine and proves it with package-level tests, but does not register tools, routes, timers, or UI. Therefore merging it alone does not expose a feature or start background work.

The execution and Web Shell changes ship together so reviewers can accept a complete local workflow instead of an invisible API followed by its only user interface. Each later PR must build and pass its own focused tests against the preceding head. Tests move with the behavior they protect. Cross-layer fixes stay with the lowest layer that owns the invariant.

## Boundaries

The foundation owns workspace-scoped identities, durable thread records, message routing, admission decisions, close obligations, token/turn accounting, filesystem locking, and stranded-run inspection. It does not own model execution, ACP sessions, HTTP routes, browser components, A2A grants, or remote-host leases.

The local collaboration PR consumes this internal API, runs Agents, and exposes the daemon contract through the Web Shell. The A2A PR adds authenticated external access to that working local feature. The remote Runtime PR then adds Qwen, Codex, and Claude runtime adapters.

## Merge sequence

Merge the foundation into `main`, then merge the combined local collaboration PR. Merge A2A next, followed by the remote Runtime adapters. Re-run current-head CI after every base change.
