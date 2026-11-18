# Agent Host replacement program compatibility

[English](2026-11-18-host-replacement-program-compatibility.md) | [简体中文](2026-11-18-host-replacement-program-compatibility.zh-CN.md)

## 1. Status and background

Implemented and locally verified, 2026-11-18. Addresses [#13644](https://github.com/QwenLM/qwen-code/issues/13644). The issue and its comments were read with `gh`; current implementation was inspected at `b9da38c7bd` on `feat/managed-agents/defined-a-capacity`.

The issue describes a Host replacement preserving an agent's pinned `execution.provider` while moving it to a Host without that program. The live `SessionAgentOrchestrator.pickupForHost` skips an agent when `programForAgent` cannot select its pinned program. Replacement can therefore introduce a configuration that leaves work queued indefinitely. The direct execution-binding writer already rejects a pin unsupported by every bound Host with `program_unavailable`.

Current code lives in `packages/core/src/agents/workspace-agents/store.ts`. Enrollment writes the replacement identity and `enrollment.replacementHostId`, rewrites agent bindings, then removes the superseded Host and enrollment token. These are independent file commits under one workspace lock. Existing retries intentionally recover interrupted replacements. Enrollment initially supplies provider declarations, not v2 program probes.

## 2. Goals and scope

Refuse a replacement that leaves any affected pinned agent without a compatible Host in its resulting binding set. Identify affected agent IDs, preserve explicit pins, and preserve enrollment recovery. Allow a replacement if another bound Host still offers the program. Apply to all remapped agents, including disabled and retired records, as the existing replacement does.

Scope is the core enrollment store, the CLI enrollment HTTP error mapping and client secret recovery, focused regression tests, and this bilingual design. No Java/control-plane changes, schema changes, scheduling redesign, automatic unpinning, runtime availability guarantee, or repair of already completed incompatible replacements. Existing incompatible agents can be explicitly rebound by the owner. Heartbeat changes after admission remain outside this configuration check.

## 3. Proposed solution

Within the existing workspace transaction, after token, target, input and identity checks, construct the proposed replacement Host and final Host registry: retain other Hosts, replace any staged record of this identity, remove the superseded Host, and add the proposed Host.

Read the agent roster once and prepare the old-to-new binding remap in memory. Deduplicate Host IDs as today and preserve every other agent/execution field. For each affected pinned agent, require at least one Host in its resulting `hostIds` to satisfy the existing `hostOffersProgram` helper. Check the entire resulting topology, not just the new machine. Use v2 probes for surviving Hosts when present; use the new Host's provider declarations, accepting both program IDs and legacy labels.

Also validate agents already bound to `replacementHostId` on an interrupted-replacement retry. A previous attempt may have committed the roster but failed to finalize the registry; retrying with narrower declarations must not bypass the check merely because the old ID no longer appears. Other agents are not revalidated globally.

Collect every incompatible agent ID and throw a dedicated exported `AgentHostReplacementProgramError` before any Host or agent-file write. Its message identifies only the agent IDs and advises installing the pinned programs or updating bindings before retrying. Do not include names, paths, tokens or secrets. If compatible, retain the existing write sequence: staged identity, changed roster if needed, final registry. No additional file, lock, persistence abstraction or rollback is introduced.

## 4. Error and ownership contracts

`POST /agent-hosts/enroll` is persisted-workspace scoped: resolve the requested workspace, require trust and enabled agents, and use that runtime's store. There is no primary-runtime fallback. The route handles only the dedicated compatibility error specially. Invalid or expired capabilities continue to receive generic `401`; unexpected store failures remain sanitized `503`.

The compatibility error is raised only after successful capability validation, so an invalid token cannot enumerate agents. Classify the exact proposed secret, not merely whether a pending replacement exists. If it matches the staged replacement Host's `secretHash`, do not mark refusal: an earlier attempt enrolled it. Otherwise the earlier enrolled-identity checks have excluded other registered secrets, so this secret is known not to have enrolled; mark `enrollmentRefused: true` on the store error. This includes a new secret proposed during a pending replacement and a freshly minted secret from a legacy no-secret request.

For a known unregistered secret, return the existing `401` with `error: AGENT_HOST_ENROLLMENT_REFUSED` plus a `detail` containing the actionable compatibility message. Older clients still recognize the fixed refusal and preserve their existing cleanup/restoration contract. The current client derives refusal classification from that fixed status/error pair before showing the optional string detail; never use arbitrary detail or a wire boolean to establish refusal. Existing `isEnrollmentRefusal` accepts that internally derived classification, so cleanup and compare-and-swap earlier-secret restoration still run even when the displayed message is detailed. After `AGENT_HOST_ALREADY_ENROLLED` caused a secret rotation, restore the earlier enrolled identity on known-unregistered refusal instead of losing its recovery path. For an enrolled staged secret, return `409` with the actionable message and retain that secret. This different conflict does not invoke the already-enrolled rotation branch. Only coordinator transport uses these statuses; the existing restartless local `/agent/hosts/connect` wrapper continues reporting connection failures as `400` while preserving the message.

On fresh rejection, registry bytes (including token and absence of a staged identity) and roster bytes remain unchanged. On rejection of an already staged retry, preserve the entire intermediate state, even if this request proposed a different secret; do not undo a prior successful file commit. Existing token refresh for the same pending replacement remains available. A corrected retry reuses the staged Host ID and finishes normally; the existing recovery sequence may replace its secret only after preflight succeeds.

## 5. Decisions and risks

Refusal preserves owner intent. Automatically dropping the pin could silently execute another program. Checking all bound Hosts matches the direct writer's `some` semantics; requiring the new Host itself to offer the program would reject valid multi-Host configurations.

Admission proves compatibility with available declarations/probes only. Hosts may be offline, declarations may be inaccurate, and a later heartbeat may remove a program. Successful enrollment does not prove the next run can execute. This change prevents replacement from introducing this specific unsupported-pin configuration; it does not promise general queue liveness.

The new conflict is a behavioral tightening for incompatible replacements. Operators must install the program, explicitly update affected bindings/pins (cancelling blocking queued/live work first when required by the existing guard), or retain a compatible surviving Host. There is no data migration. Error classification must preserve a staged secret; tests cover the real client handling as well as the route.

## 6. Validation and acceptance criteria

1. Sole old Host with pinned `claude`, Qwen-only replacement: known-unregistered `401` with fixed refusal and actionable detail, affected IDs reported, no registry/roster mutation and no pin change. A multi-agent replacement with one incompatible pin moves neither agent. Invalid tokens reveal no agent IDs.
2. Compatible replacement succeeds; an unpinned agent continues to use the default. Accept both legacy labels and program IDs. With a compatible surviving Host, a Qwen-only replacement is allowed and the pin remains. A surviving v2 probe with `available=false` must not count even if declarations list the program.
3. After conflict, correct declarations and retry the same unexpired token successfully. Client handling clears a known-unregistered refused secret, restores the earlier enrolled secret after an already-enrolled rotation (including when a different pending secret exists), and retains an enrolled staged secret. The conflict itself does not invoke the already-enrolled rotation branch. An arbitrary detail or wire refusal marker must not turn a different failure into refusal; missing detail remains compatible with old coordinators. Concurrent secret changes must not be overwritten.
4. Inject failure at roster write and at final registry write; preserve existing retry behavior, stable replacement ID and pins. After a final-write failure, retrying with incompatible declarations must fail before further mutation even though the roster already uses the new ID; a compatible retry must finish.
5. A later v2 unavailable heartbeat is stored as reported: enrollment admission is not an execution guarantee. Already completed incompatible bindings and general scheduling behavior remain unchanged.

The test-engineer first attempts the global `qwen` baseline, then uses a test-script fallback if the relevant path is inaccessible. Record commands and observed outcomes under `.qwen/`; do not present a fallback as a full multi-process Host E2E. Before completion run focused core/store, CLI route and client tests, root build/typecheck and bugfix bundle, formatting/lint checks, and two clean full-diff self-audit passes. An independent agent audits this design twice, each with forward requirement-to-solution and reverse failure-to-invariant analysis, before implementation.

## 7. Audit and implementation record

Round 1 of independent forward/reverse design audit identified a recovery defect in treating every compatibility conflict as non-refusal: an already-enrolled rotation followed by fresh conflict could lose the earlier secret. Round 2 found the pending-replacement/new-secret variant of the same defect. The final design checks exact staged-secret ownership, retains the legacy fixed `401` error for proven refusal, and adds optional actionable detail plus explicit rotation/restoration/concurrency tests. Both design findings and the mixed-version recovery concern are addressed in the implementation; the same independent agent subsequently reviewed the complete implementation diff and reported “No findings.” Global `qwen 0.27.3` HTTP reproduction and a current-source store script both reproduced the incompatible replacement; neither exercised an actual queued run or remote program. No unresolved product-policy question: this change selects strict refusal while preserving explicit owner configuration.

## 8. Verification results

Validation ran on macOS with Node.js `v22.18.0` and pnpm `11.24.0` against the implementation on `codex/fix-host-replacement-program-compatibility`:

- `npm run build`, `npm run typecheck`, and `npm run bundle`: passed. Build retained unrelated bundle-size, third-party annotation/eval and IDE companion lint warnings; no errors remained.
- From `packages/core`, `npx vitest run src/agents/workspace-agents/store.test.ts --coverage.enabled=false`: 46 tests passed. Coverage includes both file-failure boundaries, unchanged bytes, exact staged-secret classification, compatible survivors, provider vocabularies and later unavailable heartbeats.
- From `packages/cli`, `npx vitest run src/serve/routes/agent-hosts.test.ts src/serve/agent-host-client.test.ts --coverage.enabled=false`: 123 tests passed. Detailed and legacy refusals exercise cleanup, earlier-secret restoration, concurrent-secret protection and staged-conflict retention.
- Targeted ESLint on all six changed TypeScript files: passed.
- Independent test-engineer using `node dist/cli.js` with an isolated daemon and real HTTP routes: `VERIFIED_FIXED`. Invalid token returned `401` without detail; incompatible fresh replacement returned fixed `401` plus affected IDs and advice; registry/roster bytes were unchanged; the same token/secret with compatible declarations returned `201` and preserved pins. A Qwen-only replacement with a compatible surviving Claude Host also returned `201` with the surviving binding and pin preserved.

The earlier global `qwen 0.27.3` HTTP baseline returned `201` for the incompatible replacement. A current-source script also reproduced the defect before changes. A first root build failed because installed `diff 7.0.0` did not match required `^8.0.3`; `CI=true corepack pnpm install --frozen-lockfile --ignore-scripts` followed by `npm run postinstall` synchronized dependencies without changing manifests/lockfile, then build passed. An early test attempt during rebuilding was stopped by the missing-dist guard; final tests above ran after their build prerequisites were complete and dependencies settled.

Evidence limits: no actual queued run or remote Claude/Codex execution was exercised; the indefinite-queue consequence is supported by the inspected pickup path. Staged `409` and file-failure recovery were verified by focused fault-injection tests, not by killing the real daemon between commits. Older-client compatibility is supported by retaining its fixed status/error contract, not by a full mixed-version process test. Linux, Windows, offline/future heartbeat availability and CI are not validated by these local results. There is no screenshot or recording; observed HTTP logs are the before/after evidence.
