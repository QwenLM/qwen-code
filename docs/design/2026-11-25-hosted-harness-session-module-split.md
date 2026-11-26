# Hosted Harness Session module split

[English](2026-11-25-hosted-harness-session-module-split.md) | [简体中文](2026-11-25-hosted-harness-session-module-split.zh-CN.md)

## Current structure

`hosted-harness-session.ts` has 15,614 lines. Its route registration function owns the resident session registry, instance drain, session opening, and most Hosted Session endpoints. The shared closure obscures which state each feature uses.

## Module boundaries

Keep the existing route registration entry point as the composition root. It owns the resident registry and instance drain and registers feature routes in their original order. Each registrar receives the session registry and only the dependencies it uses. Session opening and suspension share the opening state. Runtime handback keeps its refusal map scoped to one registration.

Extract session opening, idle suspension, workspace restore, and runtime ownership. Separate turn execution, cancellation, runtime takeover, wake recovery, and wake scheduler setup. Group the remaining endpoints around lifecycle, configuration, session interactions, events and inspection, and automations. Keep session state and common HTTP helpers available to the modules that share them.

## Compatibility and verification

Preserve existing exports, middleware and route order, request and response contracts, authorization, and the lifetime of resident state, retry guards, and timers. The split is internal to the CLI daemon. Keep the existing test fixtures and use the Hosted Session suites and their caller tests to verify the existing behavior. Run the repository build and type check and compare the moved bodies and route registrations against the original source.
