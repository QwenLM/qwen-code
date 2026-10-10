# Managed Tool Publication: background Shell and Monitor arm

[中文版](2026-10-09-managed-tool-publication-background-arm.zh-CN.md)

Status: design proposal. Part of [#13533](https://github.com/QwenLM/qwen-code/issues/13533) (finding A1 from the [Linux acceptance comment](https://github.com/QwenLM/qwen-code/issues/13533#issuecomment-6081348948)), Stage H under [#12827](https://github.com/QwenLM/qwen-code/issues/12827), proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). Builds on the O2 publication ownership design ([2026-09-27](2026-09-27-managed-tool-publication-ownership.md)) and the H3 Shell/Monitor runtime design ([2026-10-03](2026-10-03-managed-shell-monitor-runtime.md)).

## Problem statement and current state

A hosted turn's background-Shell start (and equally a Monitor start) cannot reserve its capture publication. The reserve fails on the server before any process exists, and the failure converts into a recovery-blocked turn:

1. The turn admits a background `run_shell_command` (publication lane owned, `child_run` admitted through its gate) or a `monitor` call (publication lane owned, `monitor_run` admitted through its gate), commits `toolIntent`, `childRuns.admit` / `monitors.admit`, `dispatchStarted`, then posts its reservation to `POST /internal/managed-tool-publications/v1/sessions/{id}/grants` with `operation: "reserve"`.
2. The server's `ToolPublicationContract.requirePayload` (`packages/sdk-java/managed-agent-server/.../store/ToolPublicationContract.java:145`) hard-refuses the payload: it requires `toolName == "run_shell_command"`, refuses any input carrying `is_background: true` with `IllegalArgumentException("Only foreground Shell can publish")`, and closes the input key set to `{command, timeout, description}`. A background shell payload (`is_background: true`) and every Monitor payload (`toolName == "monitor"`, input carries `is_monitor: true`) fail here → **400 `invalid_request`**.
3. The turn cancels the start execution; the cleanup `close_not_started` call also 400s (the reserve never created a row); the turn goes recovery-blocked. Reproduced wire-faithfully on macOS at both `f20ed558e3` and the rig commit `ac497aeed9` (see the reproduction report in `.qwen/issues/issue-13533.md`).

The foreground-only arm is landing scope, not a security invariant: the contract arrived with O2's durable _remote Shell_ result delivery (#12894), which covered foreground Shell only. The refused payload families are exactly the ones H3's runtime already produces (the turn-side background/Monitor admission, dispatch and detached-capture wiring is landed; the reserve is the blocker). Locally verified at `f20ed558e3`: guard text and line unchanged; no production caller of `observeBackgroundProcess` yet (B1); `monitor_run`/`child_run` still outside `MANAGED_SESSION_ENABLED_DOMAINS`.

A useful consequence of the existing gates: **the contract arm is unreachable in production until the domains are admitted.** Production turns reach the reserve only through the admission gates (`childRunAdmissionsEnabled()` / `monitorRunAdmissionsEnabled()`), which read the enabled-domain/kind-gate constants that this slice does not touch. Tests drive the path through the declared test switch, as the acceptance pass did.

## Decision: extend the one contract with a background arm (Option A)

The issue names two directions:

- **A (chosen). Extend the existing contract with a background arm.** `requirePayload` (Java) and its TypeScript mirror `assertToolPublicationPayload` (`packages/core/src/managed-runtime/managed-tool-publication.ts`) admit two further closed payload families — background Shell and Monitor — beside the unchanged foreground family. The reserve route, the binding shape, the grant lifecycle (`reserve`/`renew`/`fence`/`close_not_started`), the digests, and the capture/receive machinery stay exactly as they are.
- B (rejected). Route background captures through a different reserve (a second operation/endpoint/binding family). This duplicates the entire grant lifecycle — reserve validation, lease/renewal, fencing, not-started close, catalog, GC — in both languages for zero invariant gain: the security basis of the publication is the digest-exact binding between payload, args and request, and that binding is identical whatever the tool family. Option A is strictly additive; old servers refuse the new families the same way they refuse them today (the families are not allow-listed), and the established server-first deployment order (H1/H2/H4) applies unchanged because production writers cannot emit these payloads until domain enablement, which is a later, separate change.

The H3 design already assumes this direction: its retention section speaks of "H3 background publications" joining the same Session retention root (with the O4 foreground-collector coverage gap recorded there as a follow-up, unchanged by this slice).

## Admitted payload families (both languages, byte-identical digests)

The payload is `{toolName, input}` with `requestDigest == sha256(payload bytes)` and `reference.argsDigest == sha256(canonical(input))`, both already enforced. The arm only redefines which `toolName`/`input` shapes are accepted:

| family                       | toolName            | input keys (closed set)                                                     | constraints                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| foreground Shell (unchanged) | `run_shell_command` | ⊆ {`command`, `timeout`, `description`}                                     | `command` nonempty string; `timeout` integral-valued number 1..600000 (integral doubles like `6e5`/`600000.0` are the same integer the TS mirror accepts after JSON.parse normalization); `description` string                                                  |
| background Shell (new)       | `run_shell_command` | {…foreground keys…, `is_background`}                                        | foreground constraints; `is_background` must be the boolean `true` when present (string forms and `false` are refused — the turn never produces them: it refuses any `is_background` value it did not admit, and emits the marker only as the admitted boolean) |
| Monitor (new)                | `monitor`           | ⊆ {`command`, `idle_timeout_ms`, `max_events`, `description`, `is_monitor`} | `command` nonempty string; `idle_timeout_ms` integral-valued number 1..600000; `max_events` integral-valued number 1..10000 (same integral-double rule as `timeout`); `description` string; `is_monitor` required, boolean `true`                               |

The constraint sets mirror the turn's own admission validation in `hosted-workspace-tool-turn.ts` (including the numeric ranges), so a payload the turn can emit is a payload the contract accepts, and nothing else. Boolean and integral-number canonicalization is byte-compatible across the two implementations (`"true"`/`"false"` and integral `longValue()` rendering on both sides), and the new fixture cases prove it.

## Proposed changes by layer

1. **Java contract** (`ToolPublicationContract.requirePayload`): restructure the single foreground arm into per-family arms per the table above; admission to the families is gated on the shared `PUBLISHABLE_TOOL_NAMES` constant (change 2), leaving the switch as pure dispatch; numeric bounds accept integral-valued numerics (integral doubles included), matching the TS mirror after JSON.parse normalization. The reject text `"Only foreground Shell can publish"` goes away with the arm it names; family-specific reject reasons take its place. No change to binding/request/grant parsing, digests, or any other method.
2. **Store checkpoint gate** (`ToolPublicationStore.requireCheckpoint`, discovered by the end-to-end witness after change 1): the same reserve path hard-codes the checkpoint tool item's `toolName == "run_shell_command"`, refusing a Monitor binding one layer below the payload contract with "Checkpoint execution identity conflicts". Both gates now take the family list from a shared `ToolPublicationContract.PUBLISHABLE_TOOL_NAMES` constant so the two cannot diverge again — the divergence itself was this bug.
3. **Turn checkpoint fork** (`hosted-workspace-tool-turn.ts`, pinned by the witness after change 2 as the third shell-only fork of the same shape): the checkpoint tool item's `inputDigest` is written as the canonical-input digest only when `isShell && publication`, and a Monitor item falls back to the whole-payload digest, so the store's argsDigest identity check still mismatches. The fork is widened to `(isShell || monitoring) && publication` — the canonical-input digest the reserve binding already carries for the same request.
4. **TypeScript mirror** (`assertToolPublicationPayload`): same three families (today it has no explicit `is_background` check and refuses background only via key allow-listing; it gains the explicit boolean-type checks so the two implementations accept and refuse identical inputs).
5. **Shared fixtures** (`packages/core/src/managed-runtime/contracts/managed-tool-publication-v1.fixtures.json`): positive payload vectors for background Shell and Monitor; negative vectors for the new refusal edges (`is_background: "true"` string, `is_background: false`, Monitor without `is_monitor`, unknown keys, out-of-range numbers, wrong toolName); integral-double spellings as hand-written raw payload strings (`6e5`, `600000.0`, `1e4` — `JSON.stringify` would erase the spellings the vectors exist to pin); and boundary positives (1 and 600000 for `idle_timeout_ms`, 1 and 10000 for `max_events`). Digests are pinned from the TypeScript canonicalizer, so an accepted vector also proves byte-identical canonicalization in Java. Both languages replay the same corpus, as for every contract slice.
6. **Contract schema** (`managed-tool-publication-v1.schema.json`): verify (and only if it constrains the payload family, update) — the schema covers binding/request/grant envelopes; the payload lives in the args resource, which is digest-bound rather than schema-bound.
7. **End-to-end witness** — recalibrated A1/A2 repro harness (`HostedRecoveryBlockedWedgeIT.java`, keeping its A2 wedge probes as regression coverage, now fed by a relay-injected reserve 400 for its blocked-session fixture) plus a new `HostedBackgroundPublicationIT.java` driving an admitted background Shell and an admitted Monitor through reserve → dispatch → start on the ephemeral provisioner lane through the same declared test switch; assertions are pinned to whatever the already-landed machinery coherently produces at this slice (see Acceptance).
8. **Unit tests**: `ToolPublicationContractTest` (Java) and `managed-tool-publication.test.ts` per family, including digest-mismatch and field-closure refusals.

No changes to: the reserve route and grant lifecycle, admission gates, record bodies, domain/kind-gate constants, or the broker ledger. Turn wiring changes are confined to the single checkpoint fork in change 3.

## Files affected

- `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/ToolPublicationContract.java`
- `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/ToolPublicationStore.java`
- `packages/cli/src/serve/hosted-workspace-tool-turn.ts`
- `packages/sdk-java/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/ToolPublicationContractTest.java`
- `packages/core/src/managed-runtime/managed-tool-publication.ts`
- `packages/core/src/managed-runtime/managed-tool-publication.test.ts`
- `packages/core/src/managed-runtime/contracts/managed-tool-publication-v1.fixtures.json` (+ `.schema.json` only if needed)
- `packages/sdk-java/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/HostedRecoveryBlockedWedgeIT.java` (recalibrated) and `integration-tests/helpers/hosted-recovery-blocked-wedge-driver.ts`
- `packages/sdk-java/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/HostedBackgroundPublicationIT.java` (new witness)

## Scope boundaries

- **No domain enablement.** `monitor_run`, `child_run` (shell kind) stay outside `MANAGED_SESSION_ENABLED_DOMAINS`/the kind gate; admitting them for submission is its own change after B1, B2 and the Linux acceptance pass, as the issue states.
- **B1 (exit observation) and B2 (capture backpressure) are out of scope.** In particular, a background process's natural exit after turn completion still has no production observation arm; this slice only removes the reserve refusal that prevents the pathway from being exercised at all.
- **A2 is closed separately**: not reproduced at either `ac497aeed9` or `f20ed558e3` on macOS; the remaining mechanism carriers are rig-environment-only (Linux cgroups, real OSS, split connector), to be re-examined on the next Linux acceptance pass. The wedge-probe arms of the witness IT are kept as regression coverage.
- The O4 retention coverage gap for background publications remains as the H3 design records it — a named follow-up, not this slice.
- The Java store's server-side behavior for the reserve beyond the two family gates (payload family, checkpoint tool item) is unchanged — execution state, owner fencing, checkpoint phase checks all stay as they are.
- **Observed rough edge, named follow-up (not this slice):** on the environment-declined `not_started` path (e.g. the ephemeral lane without a cgroup root), the blocked turn's terminal cause surfaces as broker 409 `managed_runtime_identity_conflict` after the proof-close, rather than the model-readable blocked refusal that path otherwise prepares. Recorded from the witness IT's evidence; belongs to the A3/record-coherence family of #13533's thread.

## Acceptance

1. **Contract unit level** (both languages, fixture-driven): the three families accept exactly their shapes and refuse everything else; a fixture that flips `is_background`/`is_monitor` to an unadmitted form fails on both sides; digest recomputation is byte-identical across languages. Mutation check: with the background arm removed, the new positive fixtures and contract tests fail.
2. **End-to-end witness** (`hosted-harness-mysql` lane, gated `-Dqwen.wedge.probe=true`): reserve for an admitted background Shell returns a grant `OPEN` (not 400), the execution dispatches and starts on the ephemeral lane, and a quick-exit command's outcome is handled by the currently landed machinery — pinned to what is coherent at this slice; the same for an admitted Monitor's reserve. If the full result settlement turns out to depend on unlanded B1-side arms, the witness pins reserve-OPEN + dispatch-started + the documented intermediate state and names the dependency instead of asserting the settlement.
3. **Regression**: foreground Shell publication E2E (`HostedWorkspaceToolTurnIT` shell lane) unchanged; the A2 wedge-probe arms still pass.

## Open questions

1. The `monitor` arm admits `description` without a length bound beyond the global 256 KiB payload cap, mirroring the turn admission (which bounds only display length). Acceptable, or bound it in the contract?
2. Naming of the recalibrated witness: keep `HostedRecoveryBlockedWedgeIT` (its A2 arms remain its namesake) or split the A1 arms into a new `HostedBackgroundPublicationIT`? Leaning to splitting, so each IT's name matches what it witnesses.
