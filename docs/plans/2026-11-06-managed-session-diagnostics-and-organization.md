# Managed Session Diagnostics Implementation Plan

[English](2026-11-06-managed-session-diagnostics-and-organization.md) | [简体中文](2026-11-06-managed-session-diagnostics-and-organization.zh-CN.md)

Status: D1–D4 are implemented locally; D5 has focused evidence, with full CI acceptance pending. Date: 2026-11-06. Baseline: `1bac51b7d9`. This plan implements the three parts in the [design](../design/2026-11-06-managed-session-diagnostics-and-organization.md): context/model statistics, Skills/MCP inventory, and direct child-agent relationships. Stage IDs are local planning labels, not issue numbers. Organization, Sources and PR metadata implementation have been removed from this plan. Section 8 separates implementation from verified acceptance.

## 1. Order and completion rule

```mermaid
flowchart LR
  D1["D1 Resources"] --> D2["D2 Direct trace"]
  D2 --> D3["D3 Model stats, protocol and recovery"]
  D3 --> D4["D4 Request context"]
  D4 --> D5["D5 Cross-layer acceptance"]
```

D1/D2 are the preferred delivery order, not a runtime dependency. D4 relies on D3's bounded versioned resources, snapshot revisions and recovery. Every stage includes its actual API/provider/UI consumer and focused evidence. Foundation code or a generated DTO alone does not complete a stage. No stage introduces a table, DDL, native domain, Stage H family or a second request journal.

## 2. D1 — Passive resource inventory

1. Add the authorized Public `/resources` and WebShell `session-resources/query` contracts and shared query service. Read under one short read-only `REPEATABLE_READ` transaction; return an honest persisted `readRevision`.
2. Resolve full base Skills plus activated extension Skills/commands, preserving invocation policy and attribution. Keep composer catalog semantics unchanged.
3. Read latest config directly, following predecessors when necessary within a total of 64 configuration records including the current one. Resolve the earliest baseline only after reaching the actual boundary; otherwise configuration is partial/unknown.
4. Scan at most 256 MCP configuration rows plus a sentinel using the existing Session/domain/delivery index. Bound total resource reads to 8 MiB and public output to 1 MiB. Separate selection, attempt, catalog and live unknown state, including the attempt's server revision and logical/physical states. Incomplete history leaves latest-attempt fields null and retained catalogs historical. No derived MCP index or Runtime traffic.
5. Wire the resources tab through optional provider `diagnostics`, regenerate OpenAPI types, update `SurfaceRegistry`, and add unavailable/partial states.

Extend `ManagedSessionCreationSkillsTest`, `ManagedMcpCatalogServiceTest`, `ManagedMcpSettingsStoreTest` and extension tests. Add query/service, authorization, budget and MySQL snapshot-consistency tests. Cover model-only/manual-only Skills, extension commands, enabled/disabled/removed MCP, failed new attempts with old catalogs, 64/65 config steps, 256/257 history rows, 8 MiB/1 MiB boundaries, malformed resources and offline/no-acquire behavior. Use MySQL EXPLAIN to verify the intended existing-index plan.

Done when authorized users can read known configuration offline without falsely claiming complete history or live health. New tests are required; existing green tests alone do not prove this stage.

## 3. D2 — Direct invocation trace

1. Add Public `/agent-trace` and WebShell `session-agent-trace/query`, with parent-scoped cursors and limit 1–100.
2. Filter `task_kind='child_agent'` before SQL keyset pagination by `(gmt_create, record_key)` descending. Preserve invocation identity separately from child Session identity; no recursive traversal or `rootAgentId`.
3. Reuse task details, validate stored parent/run lineage and independently authorize child links. Missing or inaccessible child details retain the visible parent invocation.
4. Add the trace tab and reuse `ManagedChildSessionView`. Visible active trace refreshes every 5 seconds; hidden/closed views stop polling and scope changes discard old responses.

Extend `ManagedExtensionRecordStoreTest.pagesTasksNewestFirstThenByTaskId`, child/task tests, `use-managed-tasks.test.tsx` and child-view consumers. Add mixed-kind pagination, equal timestamps, repeated invocations, invalid/foreign cursors, deleted/restricted child and permission-revocation cases. Show persisted direct relationships only; legacy deeper parser support is not a nested-execution promise.

Done when pages have no duplicate/skipped child invocations and only verified authorized detail links open. No child is started or recovered by reads.

## 4. D3 — Model statistics, protocol and recovery

1. Add one collector with ContentGenerator invocation units, outcomes `success/error/cancelled/interrupted`, normalized tokens, observed timing/TTFT and backoff retries. Cover `main/hook/compression`; auxiliary calls follow the owner and parent/child totals stay separate.
2. Bound data to 16 model buckets plus overflow and 20 whole-Session recent samples. Enforce a 64 KiB UTF-8 resource envelope: stats 40 KiB, context 8 KiB, envelope/budget 12 KiB, reserve 4 KiB. Keep `rawOutputTokensTotal` separate and do not serialize raw prompts/errors or legacy `models` maps.
3. At native `runSerial`, freeze deltas, fold from the latest committed baseline, allocate `snapshotRevision` and retry identical bytes. Add main/hook usage v2, automatic-compression terminal/`turn.settled` usage refs and maintenance v2 `modelStatsRef` with the candidate before `PostCompact`. Existing active v1 chains finish with partial coverage; leave `context.compacted.tokenCountsRef` unchanged.
4. Project `hosted_session_statistics/latest` alongside `hosted_context_usage/latest`, preserving highest snapshot revision, resource closure, retention and replay. Recover committed accumulators and retain sticky gaps for unclosed native owners.
5. Read storage 1/2/3 before enabling the first v2 writer's storage-3 floor; reject old workers with 409. Keep CSI old/v1 behavior and add independent `csi-files-retirement/2` manifest/proof without expanding supported execution paths.
6. Add Public `/stats`, WebShell `session-stats/query` and the model-statistics tab. Refresh visible active stats every 5 seconds and expose partial, gap, overflow and unavailable metrics.

Use shared Java/TypeScript fixtures, collector and Hosted source tests, SQL projection/retention tests, API gates and actual restart/replay paths. Verify main r1 → Hook r2 → old r1 never rolls back totals; interleaved/manual/automatic compression, retry, cancellation and replay do not double count. Test Unicode byte budgets, source/model overflow, cold owner recovery, control-plane/worker rollout order and both CSI profile versions. Real MySQL and process-recovery evidence are required; full gates remain in CI.

Done when every intended model source/outcome is collected and the accepted revision has the required evidence. Fixture-only correctness is not durability acceptance.

## 5. D4 — Last committed main request context

1. Preserve safe attribution at the actual prepared-request boundary. Extract only the pure measurement helper needed from daemon context logic.
2. Collect `systemPrompt`, `builtinTools`, `mcpTools`, `instructionFiles`, `memoryFiles`, `skills`, `startupContext`, `messages`; keep provider totals and cached overlap separate.
3. Publish the bounded main context with durable main output using D3's envelope/revision mechanism. Hook/compression samples do not replace main context. Track model/configuration/compaction changes and mark stale/partial evidence.
4. Add Public `/context-usage`, WebShell `session-context-usage/query` and the Context tab. Use actual model/window/compaction policy and display last-request semantics, never a next-request preview.

Extend context measurement, prepared Hosted model, `ManagedModelContextTest`, retention/CSI and provider/UI tests. Cover actual tool selection, imported/extension Skills, instructions/startup, provider usage missing, fallback, attachments, compression, empty history, two concurrent Sessions and offline reopen. Validate all eight categories against the captured prepared request without retaining private bodies.

Done when context is request-correct, bounded and visibly distinct from provider totals, and older or Hook observations cannot be mislabeled as current main context.

## 6. D5 — Cross-layer acceptance

Run the plan in `.qwen/e2e-tests/managed-session-diagnostics.md`. Baseline uses the global `qwen`; implementation verification uses the built local CLI plus the local Java service. A CLI-only smoke check cannot prove Java/API, MySQL or WebShell behavior. Mark unsupported or unavailable baseline paths explicitly.

Keep four Public/WebShell operations, `SurfaceRegistry`, OpenAPI, generated types, provider methods, capability parity and the four visible tabs consistent. Test both home and non-home entry points, closed/archived/offline reads, visible-only 5-second polling, explicit resources/context refresh, abort-ignoring late responses, actor/provider/Session changes and permission loss. Reads must produce no model, acquire, attach, recover or discovery traffic.

Run required root build/typecheck and focused package tests from their package directories. Use the module's JDK/Maven preflight and one task-specific Maven repository. All preparation/build/test/retry work across agents shares the ten-minute local Java budget; record remaining real MySQL/Hosted/fault and full verify/SpotBugs checks for CI. Do not reset the budget after a commit or review.

Record commands, revision, selected cases, exit status and evidence paths. Self-audit the full diff with two consecutive clean passes, resetting after fixes, and follow repository review rules. No issue, PR, commit, push or deployment is implied by this plan.

## 7. Final acceptance checklist

- All three requested parts have real provider/UI consumers and authorized passive reads.
- Resources obey 64/256/8 MiB/1 MiB limits and distinguish current selection from partial historical discovery.
- Trace is a correctly paginated direct-invocation list with independent child authorization.
- Model calls, source attribution, normalization, timings, retry counts and recovery follow the declared bounded accumulator semantics.
- Context has the eight exact categories and main-request-only freshness semantics.
- Snapshot revisions, storage-3 reader floor and CSI diagnostics-only versioning preserve compatibility and retention.
- Required tests for the accepted revision have actual evidence; any missing gate remains explicitly pending.
- Both languages and user-facing documentation match the implemented scope. No organization, Sources, PR metadata or unrequested statistics work is counted as part of delivery.

## 8. Implementation and verification record

All three parts now have persisted query services, four Public/WebShell operation pairs, a generated provider contract and four visible WebShell tabs. Home, ordinary Session and child Session views expose diagnostics when supported. Actor/Session changes discard old results; a failed Session read closes diagnostics and aborts pending reads. No database table, DDL, native domain or Stage H family was added.

The writer publishes bounded model statistics and main-request context through existing native commits, projects two latest pointers and restores committed totals. Main/Hook/compression attribution, highest-revision folding, duplicate/replay handling, abandoned observations and sticky recovery gaps are covered by focused tests. Storage readers now advertise version 3 at both HTTP exits. CSI `/1` remains immutable; `/2` adds diagnostics awareness and preserves existing execution restrictions. Deploy the updated control plane before enabling updated writers.

The required root build, typecheck and bundle passed. After the last reader-header and permission-gate fixes, affected Core/WebShell builds, WebShell typecheck and the bundle passed again. Focused TypeScript evidence is 466 Core tests (465 originally, replacing the 209-test HTTP subset with its final 210-test run), 416 CLI tests and 280 WebShell tests; these counts do not add repeated executions. ESLint, generated-contract checks, formatting and reference checks are recorded separately in the local evidence report.

Java evidence includes the repaired 68-test contract/projection/service selection, surface admission/registry and retention tests, capability guards, ClassSizeRatchet and all-module Checkstyle. Nine selected real MySQL 8.4 cases passed with zero skips, covering projection ordering, conflicts, stale/missing context, direct-child pagination and persisted MCP state. Two selected CSI activation/session tests also passed with zero skips. The packaged Hosted Harness + Spring + MySQL case passed after reproducing and repairing the HTTP reader-version mismatch: four actual model requests yield three successes and one cancellation; replay, close/load and detach/load preserve totals. Earlier failures and their explanations remain in the evidence report.

Chromium fixtures passed at 1280 px and 390 px, covering the four tabs, closed-Session reads, restricted-child links, focus restoration, layout and absence of unexpected/mutating requests. These browser tests use API fixtures; the real Hosted integration is a separate test. Commands, selected cases, toolchain, exit codes and local log paths are in `.qwen/e2e-tests/managed-session-diagnostics.md`; the shared Java budget ledger is `/tmp/qwen-managed-diagnostics-java-budget.jsonl`.

Acceptance remains pending full Java verify/SpotBugs, complete MySQL/Hosted/fault CI profiles and full cross-language CI on the revision being accepted. Real backend-to-browser integration, stopped-Runtime passive-read instrumentation, kill/restart fault scenarios, all eight context categories compared with an actual prepared request, concurrent configuration/MCP snapshot interleaving and MySQL EXPLAIN are not established by the selected local checks. They remain explicit follow-up validation requirements; local green checks do not imply deployment or full acceptance.

## 9. PR integration with current main

PR preparation rebased the implementation from tested commit `bb12bb572e` onto main `478c2f87ab`. Conflict resolution preserves structured-question action-options v4 promotion to storage 2, diagnostic promotion to storage 3, and the upstream Session-root-before-binding lock order. The new upstream execution-control path now recognizes both CSI profiles. The OpenAPI version advances to `1.101.0`.

On the integrated TypeScript tree, the root build/typecheck/bundle, 282 WebShell tests, 26 structured-question tests, four selected Hosted Session tests (687 deliberately unselected cases) and two Chromium fixture cases passed. The shared Java ledger reached 599.08 of 600 seconds, including a conservative charge for the entire prerequisite workspace rebuild. No additional local Java run is authorized by this plan's budget.

The bounded Java increment completed ClassSizeRatchet and the CSI `/1` case, failed the new CSI `/2` missing-request-key case, then stopped while the structured-question test was starting. The failure showed that the old generated guard marker omits `/2` when the request key is absent. The same primary-key locking read now also checks the tool profile, preserving the regression assertion and avoiding DDL. The corrected Java source has not been rerun locally; its compilation, focused tests and full acceptance remain pending CI. The earlier 9-case MySQL, packaged Hosted and 2-case CSI passes belong to the pre-rebase implementation and do not certify this final Java increment.

## 10. Review and CI correction round

The review increment repairs CSI test admission fixtures, caches the immutable profile read, avoids prepared-request copying for diagnostics-only observers, bounds context after final attempt metadata, and rejects invalid model capacities. It reconciles Java outcome totals and overflow monotonicity with the shared TypeScript contract, corrects resource truncation coverage, and adds real `/2` diagnostics commit/replay and `/1` refusal cases. CSI still excludes Hook and manual maintenance; corrupt committed diagnostics remain fail-closed. Repeated projection scans are deferred until measured evidence justifies a separate performance change.

The WebShell trace request now rejects unknown fields and bounds limit/cursor consistently with OpenAPI. Capability parity includes the four implemented diagnostic surfaces; source-derived route and SQL captures contain 178 routes and 356 SQL ownership entries. Child context refresh includes active Turn and workspace context revisions. Unknown timestamps, specific coverage reasons and partial discovery are visible; failed trace pagination retains Previous. Tabs wrap with their actual height, and the 390 px regression forces Verdana and checks all four tabs for overflow and overlap without weakening existing assertions.

Selected evidence is 40 Core context/Hook/statistics cases and the final 66-case restore/Hook/sink selection (overlapping cases are not added), plus 14 prepared-request cases (703 deliberately unselected), 210 CLI cases plus 210 capability-parity cases, 15 WebShell cases and two Chromium fixtures. Independent CSI retirement/admission verification passes 10 cases from the CLI selection; this is a repeat, not ten additional distinct tests. The root TypeScript build, typecheck and bundle completed; formatting and focused lint are recorded in the local report. The build log is complete, although its command exit metadata was lost during context compaction. No Java, Maven or MySQL verification was restarted; the shared ledger remains 599.08/600 seconds.

CI at reviewed head `42562a31bd` confirmed the earlier CSI guard correction but found stale route/SQL captures, model-selection assertions and two `/2` Hosted fixtures missing collector activation; these inputs are corrected in this increment. The approval failover runner now expects the diagnostics storage floor of 3. Two Hosted fake-model tool lists now include the already-admitted question tool, a drift also present at the base commit. These Java/real-process corrections are unverified locally and require new-head CI. The retained Hosted fault artifact identifies the automation DELETE 503: cold recovery settled Turn B with the budget restored from Turn A, so the server correctly rejected the statistics and stopped writes. Settlement carriers must receive the actual Turn identity and omit an unrelated budget; the Java guard remains intact. This real-process correction still requires new-head CI; no blind rerun or passing claim is made. Earlier CI failures and the selected pre-review successes remain separate evidence.

The final Core package build first rejected the new cold-recovery fixture for a missing required `endedAt` field. After correcting that fixture, the selected cold-recovery case and Core build passed; the broader 66-case result is retained separately, without counting the repeated case twice.

## 11. Latest-main CI freshness integration

The first correction commit `75f72f708f` reached CI but Lint & Static stopped at the freshness guard: main had updated the CI host-asset handoff. The two PR commits were rebased without conflicts onto `80fd7c3353`. That base also changes Hosted basic tools, local journal-prefix refresh, WebShell entry layout, JDBC helpers/locking and package version 0.26.9. The latency fake-model expectation now includes the newly admitted `glob`, matching the upstream workspace driver without weakening exact tool-list comparison.

Static integration review preserves the upstream shared JDBC helpers, digest implementation and lock scopes, plus both CSI profiles and the diagnostics budget/restore corrections. Java validation is not restarted; its shared ledger remains 599.08/600 seconds. Earlier successful checks remain evidence only where their tested inputs are unchanged; updated TypeScript foundations and affected consumers receive focused verification before the refreshed branch is published.

The refreshed tree passes the full root TypeScript build, root typecheck (including integration consumers), bundle, Core restore/Hook/sink 66 cases plus local journal snapshot 30 cases, CLI diagnostics consumers 210 cases plus 21 selected basic-tool/recovery cases (1,336 deliberately unselected), and three host-asset handoff meta-tests (78 deliberately unselected). The first Core selector named the journal file under the wrong directory and ran only the 66-case set; the corrected selector ran all 30 journal cases separately. The diagnostics browser fixture does not mount the changed Sidebar, and its page/Dialog/Tabs sources are unchanged, so the earlier 2/2 controlled-layout result remains valid and was not repeated. WebShell and capability-parity evidence is likewise reused only for unchanged consumers. All new Java and real Hosted/fault checks remain pending CI on the published head.

## 12. Java CI boundary and producer corrections

At `30a7e354f7`, the fast H2 suite executed 6,387 tests and reported two failures, one setup error and 17 skips. The route capture, protected-SQL owner gate, model context suite, real Hosted files cases and CSI binding guard selection passed individually; the overall suite remained red. The failures exposed the diagnostic safe-integer maximum being silently capped by the unrelated extension-record count helper, a legacy test's binary tenant comparison against a text SQL literal, and a native producer collector grant that omitted its supported storage version. The corrections keep the extension-record ordinal contract intact, bind binary tenant/Session identities explicitly, and advertise collector support for storage 3 while retaining the initial stored floor of 1.

Node-only reproduction of the complete legacy producer then exposed a fourth failure: the new integer-only diagnostic contract rejected the raw output ledger after a fractional usage sample. Raw budget values now retain their original finite nonnegative numbers, including fractions, through publication and warm/cold restoration; normalized token counters stay integer. Java cumulative comparisons preserve fractional ordering. This changes internal carriers only; the public projection continues to omit the raw budget scalars. The original five-turn sample and real Java profile refusal assertions remain in place.

The correction passes 142 affected Core tests and targeted ESLint, followed by the full root TypeScript build, typecheck and bundle with captured exit status. The five-turn warm/cold unit regression preserves a 38.25 next-Turn baseline and a 50.25 final raw total. Independent Node 22 execution of the unchanged five-turn producer succeeds and records five actual loopback model requests; its intentional tool refusal means the retained raw baseline is 28.25 and the final raw total is 40.25. Its normalized statistics retain five requests, four successes, one interruption and missing usage coverage. The previously passing two-turn `/2` producer and diagnostics-disabled `/1` control retain applicable evidence and were not repeated.

The shared local Java ledger remains 599.08/600 seconds. No Maven, Java or MySQL verification is restarted. Java counter, precision and binary-key regressions require new-head CI; Node producer checks cover fixture generation only and do not certify Java admission or retirement.
