# Managed BTW and recap implementation plan

[English](2026-11-09-managed-btw-recap.md) | [简体中文](2026-11-09-managed-btw-recap.zh-CN.md)

Status: all five increments implemented locally; focused verification passed and integrated acceptance is pending. Date: 2026-11-09. Reviewed baseline: `56ea1bc3fbb794bd42e62c532c7962164e7f3786`; local implementation base: `d32faa247dfed4e0612d6a52cdf3f467ca38e934`. The [design](../design/2026-11-09-managed-btw-recap.md) is the behavior and protocol contract. The user chose explicit Session `model_config` only for v1.

## 1. Delivery order and completion rule

Deliver five increments in order: durable admission and frozen reads → isolated Harness execution → public/provider integration → BTW UI → recap UI and integrated acceptance. Keep generation disabled until the complete chain is available. These increments are reviewable implementation boundaries, not authorization to create or merge PRs.

Retain the original product decisions: private persistent BTW with 20 successful pairs; manual and optional automatic recap; automatic default off, five-minute absence, three completed user turns initially and two new turns afterward; ACTIVE cold Sessions supported. Catalog/default-model Sessions and message deletion are excluded. No pending product decision remains.

Each increment includes its consumers and focused verification. A DTO, mock test, H2 pass or working UI alone does not establish durable execution. Record unavailable integration evidence as pending rather than completing the acceptance checklist.

## 2. Storage and execution increments

### Increment 1 — Durable admission and frozen reads

- Add `ma_side_query`, `SIDE_QUERY` receipt namespace/resource ownership, scoped indexes and active slots. Reuse request receipts for same-key replay, conflict detection, cached-result aliases and durable automatic-version deduplication. Preserve existing lock order and SQL-enforced race protection.
- Add the small conversation projection with completed real-user count and content boundary/version from verified native journal evidence. Advance the separate main-input boundary transactionally at primary-input admission, including queued inputs, without advancing on idempotent replay. Backfill without acquiring a writer and keep unavailable evidence explicit.
- Add query-authorized prefix/resource reads and input publication. Reuse the 120-second non-renewing retention lease, fixed source digest and resource chunk encoding. Extract only the pure model projection shared with existing restoration; do not create a second history implementation or a live authority.
- Build successful-turn membership, verify safe compaction coverage and fall back to original successful records when proof is missing. Freeze selected BTW pairs too. Allow live journal append while the frozen prefix is read and the input is published.
- Associate staged chunks with the query/claim at upload; publish the complete input closure and `inputReady` atomically only while preparing and still eligible. Add terminal/staging cleanup, collection of side-query input kinds, lifecycle fencing and permanent-retirement cleanup. Update shared V1, schema inventory/enums, lock inventory, collector allowlists and schema tests together.

Exit evidence: same-key and cross-tab races produce one admitted identity; private reads cannot escape actor/Session/cutoff; compressed failed/current input is excluded; chunked input survives a concurrent main append; active-Session input bytes are reclaimed after termination. Prove SQL/GC races on MySQL, not only H2.

### Increment 2 — Isolated Harness execution

- Extend the private Hosted protocol and Java SDK with `side-query/1`, instance-level submit/status/cancel and claim-bound model/input access. Add pool selection that never assigns Session placement or calls the Runtime Broker.
- Build a dedicated model executor from the immutable explicit configuration. Share the existing provider adapter/parser, not host settings, Session initialization, the Hook runner or main Turn state. Verify correct endpoint/key routing with two concurrent Sessions using the same model ID but different configurations.
- Fully load and validate the final bounded request and attachments before the `inputReady`/claim CAS to `running`; serialize this CAS with cancellation and perform no resource reads afterward. Use one attempt, no provider/application retries or model fallback, a five-minute overall deadline, four execution slots per Harness and 300 output tokens for recap. Preserve normal/partial/failed completion reasons and safe usage; only complete visible answers qualify for BTW history or recap cache.
- Implement independent abort, fenced snapshot publication and orphan reconciliation. A lost/uncertain owner becomes interrupted and is never automatically redispatched. Keep actual execution accounting until the provider promise settles; include claims in pool retention and asynchronous work in drain.

Exit evidence: the actual Java→SDK→Hosted process route runs from a cold Session without changing writer generation, placement, Runtime count or main model metrics. Kill or disconnect at dispatch/CAS/output boundaries; replay submits, late results, cancelled providers that ignore abort and drain after 202 cannot duplicate execution or revive terminal state.

## 3. API and product increments

### Increment 3 — Public and provider integration

- Implement the Public REST and WebShell POST routes specified in the design, including actor-scoped context, list/get, create/cancel and private SSE. Add optional `provider.sideQueries`, concrete Java-client/provider wiring, Session capabilities and capability-parity fixtures.
- Update OpenAPI, route mapping, `SurfaceRegistry`, contract tests and generated WebShell types as one change. Generate types with the repository script; never edit generated types by hand. Use snake_case on Public and camelCase on WebShell/provider surfaces.
- Make receipts, automatic deduplication and manual cache/join behavior transactional. Revalidate visibility before replay and before every read/stream delivery. Test stale expected content versions, actor changes, permission revocation and same-key changed payloads.
- Persist coalesced full-text snapshots at most once per second and terminal state immediately. Every SSE connection reads current SQL state immediately and polls newer revisions every second, so completion between GET and subscribe is not lost; reject stale revisions in the client. Send no private question, answer, error body or token event through shared Session events.

Exit evidence: contract gates pass; actual provider calls exercise every advertised method; another actor or tenant cannot list/read/subscribe/cancel a query; reconnect and duplicate submission preserve exactly one durable logical query.

### Increment 4 — BTW panel and follow-up

- Intercept `/btw` before main-submit busy/queue handling and provide a dedicated panel action. Bare `/btw` reopens saved history. Reuse existing WebShell UI primitives and portal/ref conventions.
- Show actor-private persisted history, source completion boundary, streaming text, independent Stop and explicit retry. Only normal completed answers enter the latest-20-pair input. Failed, truncated and interrupted results remain distinguishable.
- Save original create parameters and the idempotency key before submission under product + opaque actor scope + Session; replay the same payload/key after an uncertain response, even when its query ID is unknown, then clear the payload once admission is confirmed. Persist no credentials or answer bodies. Clear in-memory data and subscriptions on identity change. Closing the panel or disconnecting SSE leaves execution running.

Exit evidence: ask a follow-up using a fact present only in a prior BTW answer, then refresh and use a second device; it remains available only to that actor. Run this during main generation, a tool call and an approval wait. Stop, navigation and reconnection do not modify the main task.

### Increment 5 — Manual/automatic recap and acceptance

- Extract/share pure transcript filtering, recap prompt construction and output extraction. Do not call the live recap service, inherit its fast-model/host-language defaults, or swallow failures into empty successful results. Reconcile shared fixes with the current #12430/#8783/#16636 changes before editing.
- Wire `/recap` and the manual action to persisted queries. Cover insufficient context without a model call, equivalent active-query joining, version/model/processing-aware successful cache reuse and explicit failed-query retry.
- Add the default-off actor-scoped setting and qualifying away-window state. On return, wait for main/queue idle, reload context and submit automatic recap with both expected content version and expected main-input boundary. Server admission compares both atomically and enforces the three-turn/two-new-turn gates and automatic at-most-once attempt per version.
- Bind result display to actor, Session, setting epoch, captured main-input boundary and source version. Refresh context immediately before automatic display and require matching boundaries and main/queue idle, including when another tab's new input failed without changing completed content. Discard stale results after any relevant change; do not retroactively count an absence that began before the setting was enabled. Keep hidden tabs quiet and automatic errors silent.

Exit evidence: fake-clock/UI tests prove five-minute timing, busy-to-idle deferral, first/subsequent turn thresholds, manual-success baselines, cross-tab deduplication, setting changes, input races, language and Hook/memory filtering. Complete the integrated matrix below before enabling admission.

## 4. Verification matrix and workflow

Before implementation, create `.qwen/e2e-tests/managed-btw-recap.md` with commands, fixtures and evidence paths. Use the repository `test-engineer` workflow to observe the baseline through the global `qwen` CLI and applicable Java/API fixture. Record the unsupported feature honestly; a daemon-only baseline cannot prove Managed behavior.

Required scenarios:

1. **Model and identity isolation:** explicit-config Sessions work; catalog/default and invalid configs refuse generation; two tenant/actor/config combinations never exchange answers, credentials, browser state or model routing. Revoked access stops streams and settlement.
2. **Concurrent and cold context:** main generation/tool/approval activity continues; no writer/placement/Runtime changes; compaction containing earlier failed or current turns falls back safely; corrupt/missing resources fail rather than silently shortening history; oversized input respects chunk and model budgets.
3. **Durability:** refresh after a lost create response with unknown query ID, second device, SSE gaps including completion between GET and subscribe, duplicate keys, conflicting keys, concurrent automatic/manual recap and process restart preserve receipts and results. Partial/filtered/tool-only output does not enter successful history or cache.
4. **Failure and cleanup:** inject faults during snapshot preparation/publication, before/after running CAS, during streaming, cancellation and close. Verify stale-owner fencing, no automatic model replay, drain accounting, orphan cleanup, active-Session byte collection and permanent deletion of query rows/receipts/owners.
5. **Recap policy:** default off; five-minute absence; three real-user turns then two new ones; no counting background/tool/BTW turns; delayed idle; stale source/actor/setting/input results discarded; one automatic attempt per content version; manual retry and cache semantics remain correct.

Run focused package tests from their package directories, root build/typecheck and bundle for process E2E, plus lint/format checks on changed sources. Run `ManagedAgentApiContractTest` and `SurfaceRegistryGateTest`, schema/lock/retirement gates and affected Java consumers. Java work uses JDK 21, a matching installed SDK and one isolated Maven repository within the module's shared ten-minute local budget, including setup/builds/retries across agents. Full verify/SpotBugs, MySQL and Hosted/fault profiles remain CI gates. H2 and deterministic model fixtures must not be described as production/provider acceptance; record real-provider smoke evidence separately when available.

After implementation, self-audit the complete diff until two consecutive clean passes, then perform repository code review. A fix invalidates only affected evidence but resets the clean-pass count. Capture commands, exact tested source, selected cases, exit status and remaining CI/deployment gaps.

## 5. Enablement and completion checklist

- [x] All five increments have actual consumers, with selected local evidence recorded below.
- [ ] Complete the integrated acceptance matrix; selected tests do not cover every required scenario.
- [ ] MySQL and Hosted/fault gates cover the accepted revision; unavailable required checks remain explicitly pending.
- [x] Server/Broker schema readers, new enums/retirement, SDK and Harness agree on V1 and `side-query/1`; recreate development catalogs instead of silently repairing them.
- [ ] Deploy matching backend/Harness before the WebShell entry points; enable the single admission flag only after cross-layer acceptance. Older/unsupported combinations keep generation unavailable.
- [ ] Disabling admission leaves authorized result reads available; accepted work can finish/cancel, and no rollback bypasses persisted query fencing or schema compatibility.
- [x] Both design and plan languages stay synchronized. Record documentation checks separately from feature validation.

## 6. Local implementation and verification record

The implementation includes durable query admission, conversation/input boundaries, actor-scoped history and receipts, claim-bound frozen reads, staged-input ownership/collection, lifecycle fencing and retirement. The instance-scoped SDK/Hosted executor uses explicit model configuration without Session attachment or Broker calls. Public/WebShell routes, generated types and the Java provider connect to the private panel, command interception and optional automatic recap.

Selected checks passed against this working tree:

- Root `npm run build`, `npm run typecheck` and `npm run bundle`; the final Hosted route change also passed the CLI build and actual-process fixture. A standalone CLI build exceeded Node's default 4 GiB heap; the same build passed with `NODE_OPTIONS=--max-old-space-size=8192`.
- Focused Core input/provider/projection/recap tests, CLI side-query/contract tests, and WebShell hook/provider/page tests. These cover model completion classifications, bounded successful-history input, automatic recap races and command routing; they are not browser acceptance.
- Maven `test checkstyle:check` with the side-query store/service, main-input, API contract, admission, schema/time and lock/registry selectors. Real MySQL 8.4.11 ran the 11 selected `ManagedSideQueryStoreMySqlIT` cases, including concurrent admission, frozen workspace/lease boundaries, publication/GC and cancellation. Local macOS configuration used `lower_case_table_names=2`, a 128 MiB packet limit and disabled binary logging. These selected cases do not exercise permanent retirement cleanup.
- `HostedSideQueryProcessIT` passed through the actual Java SDK and bundled Hosted process. Its evidence reports `modelAttemptsPerQuery=1`, `failureRetries=0`, `attachedSessions=0`, `brokerCalls=0`, separate explicit endpoints for the same model name, and partial text retained on cancellation. It uses an empty frozen journal and an in-memory callback fixture, so full SQL-to-Harness execution remains unproven.

Evidence files are under `/tmp/qwen-btw-adba/` (Java ledger and Maven reports), `/tmp/qwen-btw-adba-build-verified.log`, `/tmp/qwen-btw-adba-typecheck-verified.log`, `/tmp/qwen-btw-adba-bundle-route-fixed.log`, `/tmp/qwen-btw-adba-core-input-final.log` and `/tmp/qwen-btw-adba-web-hook-final.log`. The detailed baseline, failures, corrections and E2E scope are recorded in `.qwen/e2e-tests/managed-btw-recap.md`.

Keep full `mvn verify`/SpotBugs, full MySQL/Hosted/fault profiles, the complete durable SQL-to-Harness path, browser refresh/second-device testing and real-provider smoke tests pending. CSI application images with side-query rows remain unsupported. Inherited branch history without original provenance and remote file attachments fail closed. The deployment flag `qwen.managed-agent.side-queries-enabled` / `QWEN_MANAGED_AGENT_SIDE_QUERIES_ENABLED` defaults to false. No production deployment or acceptance has been performed.

### PR integration refresh — 2026-11-10

Rebased onto main `e104c7026e`, retaining its Runtime Skill import interfaces and updating the combined OpenAPI to 1.107.0. All upstream routes and schemas remain unchanged except for the two new capability fields; WebShell types were regenerated from the merged contract. Root build/typecheck/bundle, 19 CLI tests, 114 WebShell provider/hook tests, 491 Java API/admission/service/registry tests with Checkstyle, and the actual Java SDK-to-Hosted process fixture passed on the integrated source. Generated API/configuration references were checked again. Earlier Core, page and MySQL evidence remains applicable to the unchanged source it exercises.

Integration logs are `/tmp/qwen-btw-adba-build-pr.log`, `/tmp/qwen-btw-adba-typecheck-pr.log`, `/tmp/qwen-btw-adba-bundle-pr.log`, `/tmp/qwen-btw-adba-cli-pr.log`, `/tmp/qwen-btw-adba-web-pr.log`, `/tmp/qwen-btw-adba/java-contracts-pr.log` and `/tmp/qwen-btw-adba/java-hosted-process-pr.log`. The shared Java setup/verification/cleanup ledger totals about 431 of 600 seconds. The acceptance gaps above remain open.
