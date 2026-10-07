# Workspace capacity constants: P0

This is the behavior-preserving first implementation for [#11386](https://github.com/QwenLM/qwen-code/issues/11386). The [capacity measurements](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5586177947) support separating registration expansion from optional LRU work. P0 only separates the constants; it does not raise capacity.

## Current coupling

At `1a73f5bff6201473f237c5106367e944ba2d092b`, the ACP bridge exports `MAX_DAEMON_WORKSPACES = 25` from its public `channelControlTimeouts` subpath. The CLI aliases it as the registration cap, the child heap policy uses it as a modeled child-count ceiling, and the channel-control timeout multiplies it by worker startup/stop and rollback budgets. Changing that one value therefore changes three unrelated policies.

## Ownership and compatibility

| Policy                             | Owner                                    | P0 definition and consumers                                                                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User workspace registration        | CLI `workspace-inputs.ts`                | `MAX_REGISTERED_WORKSPACES = 25`; startup validation/merge, registration-store secondary limit, and management-route admission keep using it. Primary and managed scratch workspaces count; internal live-conversation runtimes retain their existing exemption. |
| Modeled concurrent ACP children    | ACP bridge `child-heap-policy.ts`        | Private `MAX_MODELED_ACP_CHILDREN = 25`; fixed-partition arithmetic uses this upper bound together with the existing pool/minimum and legacy-ceiling constraints. Small hosts can still model fewer children or zero.                                            |
| Channel-control transaction budget | ACP bridge `channel-control-timeouts.ts` | Private `MAX_CHANNEL_CONTROL_WORKSPACES = 25`; the existing formula and worker deadlines continue to produce 2,130,000 ms. SDK consumers keep importing the existing timeout export.                                                                             |
| Legacy public constant             | Existing ACP bridge subpath              | Preserve the exported `MAX_DAEMON_WORKSPACES = 25` as deprecated compatibility data. No internal policy reads it; no new public constants or package exports are required.                                                                                       |

The repeated value 25 is intentional: these values belong to independent policies. They must not be consolidated back into a common default. The compatibility export remains a literal rather than aliasing a new policy, so future changes to any one policy do not silently repurpose the old ambiguous export.

The child policy remains observation-only. P0 preserves modeled refusal accounting, zero/null semantics, fixed partition sizing, process reservations, actual child spawn arguments, and the lack of enforcement. Session admission defaults and channel worker execution are unchanged.

The metrics fan-out comment must describe its actual managed-runtime iteration without claiming that the user registration cap limits every bridge: internal conversation runtimes can exist outside that cap. No polling logic changes are needed.

## Consumers and affected files

Production edits are limited to the three constant owners and the stale metrics comment in `run-qwen-serve.ts`. Registration consumers are `run-qwen-serve.ts`, `workspace-registration-store.ts`, and `routes/workspace-management.ts`. The modeled count is consumed through `createChildHeapPolicy()` and its existing snapshot/observation wiring. All ten `CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS` use sites in the TypeScript SDK retain the same import and value; worker startup/stop/kill timing constants also retain their values.

Tests cover the legacy export, the SDK's channel-operation timeout, existing registration/store boundaries, and child-model behavior. Coupling regression tests substitute a different legacy constant value and require registration and the child model to retain their independent defaults. This catches the original alias/import dependency rather than merely asserting that three constants happen to equal 25.

## Validation and scope

The baseline and implementation must both accept 25 user workspaces and reject the 26th with `workspace_limit_reached`, with zero sessions/children in the controlled fixture. Persisted secondaries remain capped at 24. A modeled large host remains capped at 25 children; constrained-host, off/observe, and refusal-counter tests retain their existing outcomes. Channel-operation defaults remain 2,130,000 ms, and caller overrides continue to win.

The executable test plan and results live in `.qwen/e2e-tests/workspace-capacity-decoupling.md`. Validation includes package-local focused tests, build, typecheck, bundle, and isolated local-daemon verification against a fresh global 0.23.0 baseline.

P1 separately decides registration expansion, session admission defaults, channel transaction/SDK compatibility, and store downgrade behavior. P0 adds no configuration, capability fields, routes, dormant state, LRU, child enforcement, or schema changes. There are no unresolved P0 product decisions.
