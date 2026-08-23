# CUA Driver Computer Use SDK implementation plan

1. Add the opt-in `accessibility.observation_revision.v1` request and response contract while preserving all legacy full-snapshot callers.
2. Finish the shared revision lineage, deterministic renderer, replay validation, bounded retention, session cleanup, stable IDs, and current-element resolution in cua-driver core.
3. Complete macOS AX identity, capture-completeness, invalidation/refetch, and signed real-platform E2E.
4. Implement Windows UIA identity with RuntimeId candidates plus `CompareElements`; keep MSAA explicitly full-only.
5. Implement Linux AT-SPI identity with unique D-Bus owner plus object path; keep X11 fallback explicitly full-only.
6. Expose revision-v1 through the Rust contract and generated Python and TypeScript SDKs, including compatibility/version negotiation.
7. Publish the generated TypeScript SDK and thin standalone Computer Use wrapper
   as one `@qwen-code/cua-sdk` package. Load native code only from the matching
   Qwen GitHub Release; do not create driver or platform npm packages.
8. Make the CUA Driver release workflow build every native target, pack and
   clean-install the single SDK package in dry-run, and publish the GitHub
   Release before the npm package in production.
9. Validate deterministic transitions, stable-token actions, lifecycle cleanup,
   compatibility fixtures, generated binding drift, platform E2E, context
   reduction, packaging, and release artifacts.

## Explicit exclusions

Do not modify Qwen Code core, CLI, ACP, TUI, Node REPL, tool registration, scheduler, permission manager, prompts, or Skills in this stage. Do not add a Qwen host bridge or model-delivery tracking. Those belong to Stage 3 (#9335).

## Current checkpoint

The shared revision core, macOS AX, Windows UIA, Linux AT-SPI, generated SDK
exposure, direct JavaScript wrapper, and lifecycle cleanup are present in the
working tree. macOS has real native E2E evidence, including 30 deterministic
transitions and token-bound actions. Windows UIA/MSAA and Linux AT-SPI/X11 have
compile-time and deterministic-test coverage but still require real target E2E
before this stage can claim cross-platform completion. The earlier root-plus-
platform npm staging result is invalid for the approved distribution model. A
single-package local clean install, Release-fixture postinstall, native smoke,
and packaged AppKit E2E now pass; the GitHub-hosted all-platform workflow
dry-run remains the release gate.
