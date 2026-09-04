# Headless context-inheriting subagents

## Problem

An explicit `subagent_type: "fork"` request is currently honored only when
`Config.isInteractive()` is true. Headless callers such as `qwen --prompt`,
the TypeScript SDK, and CI runners silently execute a fresh
`general-purpose` subagent instead. The requested and effective context modes
therefore differ, and the child does not receive the parent conversation.

## Design

Fork availability is independent of the presentation surface. A top-level
fork request always uses the existing fork construction path, which copies
the parent's history and cache-safe generation configuration.

Headless forks run through the existing background-agent registry even when
`run_in_background` is omitted or false. Forks are detached by definition, and
the registry gives non-interactive callers the lifecycle they need:

- one-shot headless execution waits for the fork to finish;
- stream consumers receive `task_started` and terminal task notifications;
- the effective `subagent_type: "fork"` is recorded in events, metadata, and
  subagent telemetry;
- permission requests that cannot be shown in a non-interactive session are
  denied by the existing background-agent policy instead of hanging.

Interactive fork behavior remains unchanged.

A fork request from a nested subagent is still unsupported, but it now fails
with an explicit tool error instead of silently running a fresh
`general-purpose` subagent.

## Scope

This change reuses the current full-history fork behavior. It does not add
partial history selection such as `fork_turns`; that can be introduced
separately without blocking correct headless inheritance.

## Verification

- Core dispatch tests cover interactive forks, headless forks, forced
  background lifecycle, inherited history construction, permission behavior,
  and explicit nested-fork rejection.
- The non-interactive CLI test covers the SDK-facing `task_started` event and
  verifies that it exposes `subagent_type: "fork"`.
- The desktop SDK adapter test verifies that the runtime's background result
  takes precedence over a caller-provided `run_in_background: false`.
- An end-to-end `qwen --prompt --output-format stream-json` check uses a parent
  marker that is absent from the fork directive and verifies that the child
  can still recover it from inherited history.
