# Hosted Java OSS capture admission

[English](2026-10-13-hosted-oss-capture-wiring.md) | [简体中文](2026-10-13-hosted-oss-capture-wiring.zh-CN.md)

Status: implemented. The historical real-bucket acceptance used `main` commit `ec37cec0f3a44c6928a23498de6dd845e3852823` plus this change on one Linux host without an admission relay. Post-rebase validation is recorded separately below.

## Problem and current behavior

The Hosted Harness already accepts `captureBytes` on its private create request. For a Shell profile this selects the remote tool-publication producer, which persists output through Java and OSS. Omitting it selects the existing inline producer. Before this change, the Java SDK create request and Java connector omitted this field even when `qwen.managed-agent.tool-publication.enabled=true`.

Real-bucket acceptance reproduced the gap: the Shell execution and cancellation settled, but there were no publication rows and its public tool-result projection was `UNSUPPORTED / unsupported_receipt_producer`. A test-only trusted admission relay adding a 1 MiB budget proved the existing OSS publication, public download, close and collection chain. This change removes the need for that relay.

## Proposed change

Add an optional `captureBytes(long)` builder field to Java SDK `CreateHarnessSession`. Serialize it only when supplied and reject values outside the Harness contract's inclusive range 1 to `2^41`. Existing SDK requests retain their current shape.

For resolved `hosted-workspace-shell/1`, `/2` and the existing internal `hosted-workspace-team-lead/1` Shell-family Sessions, the Java connector supplies `qwen.managed-agent.tool-publication.execution-bytes` when tool-publication is enabled. This is the existing raw capture ceiling; no new configuration key or default is introduced. Files, MCP and no-tool profiles omit the field. AgentDefinitions retain their resolved profile and approval mode. Public Shell child-agent suppression remains a separate condition; the internal team-lead profile keeps its existing tools and admission rules.

`execution-bytes` covers raw capture only. Publication reserves producer and admission overhead separately against the existing Session and tenant capacities. Operators must leave room for that overhead and retained publications in the aggregate capacities. This change does not clamp budgets or bypass quota refusal.

## Recovery and boundaries

The Harness persists the chosen budget in its managed Session definition. Java load requests continue omitting the current deployment budget so that resident and cold loads recover the original definition. Explicitly conflicting budgets remain rejected by the Harness. An existing inline Session stays inline after a configuration change; opening a new Session selects the enabled producer.

The change adds no route, public API request field, schema, credential transport or Runtime fallback. Tool-publication remains disabled by default. Public original-artifact exposure and garbage collection retain their independent flags. Cloud credentials stay with Java's existing OSS client; they are not added to the Harness request.

Existing publication-dependent Monitor and background paths retain their admission, approval and delegated Linux cgroup requirements. The enabled-publication lifecycle test now executes foreground Shell and verifies immutable object bytes and collection with its in-memory OSS fixture. The remote-publication fixture covers foreground lifecycle behavior; it does not provision the delegated Linux cgroup needed by enabled Monitor/background admission. Those enabled paths require separate qualification. Publication-disabled approval tests retain the existing Monitor and background-command refusal checks.

The four process-recovery cuts also use the remote producer, with a 1 MiB raw budget and 1 GiB aggregate capacities. Their test-only object store uses immutable files under the owned fixture root so that bytes survive the Spring SIGKILL/restart cut. They read the current publication catalog, verify raw output length and SHA-256 before deletion, and require both collected SQL state and physical object absence afterward. Original writer, claim, binding generation, drain receipt, worker-stop, exactly-once effect and companion-Session assertions remain in place. Before storage registration, the fixtures retain main’s deterministic initialized-root mtime preparation, distinct from the actual Linux birth time. The production identity provider and its ambiguity checks are inherited from main.

## Validation and acceptance

- SDK HTTP tests cover omission, minimum/maximum values, an ordinary 1 MiB budget, and invalid bounds.
- Connector tests cover Shell `/1` and `/2` with publication enabled/disabled, non-Shell profiles, create-conflict-to-load, configuration drift, and recovery loads that omit the current budget.
- Existing Harness contract tests verify persisted budget restoration and conflicting explicit loads. Relevant SDK/server tests, full repository build/typecheck/bundle, and static checks must pass.
- Linux acceptance uses the requested `oauth-data-govermence` profile and private, unversioned `qwencode-test` bucket in `cn-beijing`, an isolated MySQL schema and the production Java create path without an admission relay. Configure `execution-bytes=1048576` and aggregate capacities with room for overhead.
- Require real OSS output rows, public REST/WebShell metadata and full/range byte parity, cancellation, a same-Session next Shell/Read Turn, physical worker close, post-close downloads and production collection of only the owned objects. Read back that the owned prefix is empty and restore the test environment.

Controlled model inference, one Linux host and the supplied bucket are the acceptance boundary. Cross-host recovery, real model providers, the complete O4 permission-fault matrix and 100 MiB/1 GiB load gates are not added by this wiring change.

## Historical real-bucket verification results

- macOS build, typecheck and bundle passed, with 75 SDK tests, 115 server tests, 11 selected Harness recovery contract cases, zero Checkstyle violations and zero SpotBugs findings.
- Linux build, typecheck with a 6 GiB Node heap, bundle, the same SDK/server tests and static checks passed on Ubuntu 26.04 arm64, Node 22.22.1, Java 21.0.12.1 and MySQL 8.4.11. All 8 public Workspace integration cases passed with no skipped cases.
- Real OSS acceptance observed a direct Java-to-Harness connection, a saved definition and grant budget of 1 MiB, 2 publication rows, 4 public raw-output Artifacts and 8 unique objects containing 1,201,297 bytes. Full/range downloads, cancellation, the next Shell/Read Turn, physical worker close and post-close downloads passed. Public DELETE collected both publications and removed all 8 objects; an independent CLI list confirmed the exact owned prefix contained zero objects.
- Budget restoration and conflicting loads were verified at the Java request and existing Harness contract layers. This change did not add a real deployment-budget-change or VM reboot acceptance run.

## Post-rebase regression verification

The change was rebased onto `main` commit `bb9d7957991ef93761bfbbb9c93806a0701b4e47`, which contains the current persistence catalog. macOS and Linux build/typecheck/bundle, 75 SDK tests, 118 server tests, Checkstyle and SpotBugs passed; 11 selected Harness recovery contract cases passed on macOS. The final native Linux gate used a fresh MySQL 8.4 schema and passed all 16 selected cases without skips: four process-recovery cuts, all eleven public Workspace cases, and the shared output-probe caller exercising four fault arms. All four original workers were stopped and bindings released, effects remained exactly once, and publication state plus physical object collection were verified. Companion Sessions remained active.

The regression fixtures resolve canonical storage aliases to physical owners and compare remote manifest identity to the `deferred_v3` reference's prefixed `argsDigest`. Public fixture ports are reserved together while model/relay listeners bind. After Spring restart, the existing retirement-ledger scan and capture-GC retry can each take one minute; the process fixture gives collection a bounded 150-second wait while retaining its overall 240-second timeout and every physical assertion. These are test-only adaptations; production identity checks and scheduling are unchanged. Earlier failed runs were retained separately.

This new gate used local test object stores. The historical real-bucket, public-download and cancellation evidence above was not rerun against this rebased persistence baseline. Full GitHub CI, fresh cloud qualification, enabled Monitor/background cgroups, VM reboot and cross-host recovery remain separate validation boundaries.

## Current main rebase

The current source is rebased onto `main` commit `97fb4a547d`, including the Hosted fixture repairs from #14131. Its canonical alias-to-physical owner query replaces this PR’s equivalent shared-probe delta, and its root preparation replaces the earlier sentinel files. Public fixture port reservation, immutable restart objects, raw capture budget, physical collection and original fencing assertions are retained. The production capture patch is unchanged.

On this base, macOS and Linux each passed full repository build/typecheck/bundle, 75 SDK tests, 118 server tests, Checkstyle with zero violations and SpotBugs with zero findings. The 11 selected Harness recovery contract cases passed on macOS. A fresh native Linux MySQL schema passed all 28 cases with zero failures, errors or skips: four Shell lifecycle recovery cuts, eleven public Workspace cases, nine Workspace tool-turn cases, three internal TeamLead cases and one process-crash case covering six fault cuts. These include the seven previously failing main fixture cases. The four lifecycle cuts verified the original worker stop proof, binding release, exactly-once effects, publication collection and physical object absence while companion Sessions remained active. The test used current SDK/runtime-broker artifacts installed into an isolated Maven cache.

This gate used local test object stores. The historical cloud evidence and earlier GitHub CI results remain qualified to their recorded revisions; fresh cloud qualification and full CI on the new head are separate gates.
