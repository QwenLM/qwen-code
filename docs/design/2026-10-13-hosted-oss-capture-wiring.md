# Hosted Java OSS capture admission

[English](2026-10-13-hosted-oss-capture-wiring.md) | [简体中文](2026-10-13-hosted-oss-capture-wiring.zh-CN.md)

Status: implemented and locally verified against `main` commit `ec37cec0f3a44c6928a23498de6dd845e3852823` plus this change. Single-host Linux acceptance used the real bucket without an admission relay.

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

Existing publication-dependent Monitor and background paths retain their admission, approval and delegated Linux cgroup requirements. The enabled-publication lifecycle test now executes foreground Shell and verifies immutable object bytes and collection with its in-memory OSS fixture. Publication-disabled approval tests retain the existing Monitor and background-command refusal checks.

## Validation and acceptance

- SDK HTTP tests cover omission, minimum/maximum values, an ordinary 1 MiB budget, and invalid bounds.
- Connector tests cover Shell `/1` and `/2` with publication enabled/disabled, non-Shell profiles, create-conflict-to-load, configuration drift, and recovery loads that omit the current budget.
- Existing Harness contract tests verify persisted budget restoration and conflicting explicit loads. Relevant SDK/server tests, full repository build/typecheck/bundle, and static checks must pass.
- Linux acceptance uses the requested `oauth-data-govermence` profile and private, unversioned `qwencode-test` bucket in `cn-beijing`, an isolated MySQL schema and the production Java create path without an admission relay. Configure `execution-bytes=1048576` and aggregate capacities with room for overhead.
- Require real OSS output rows, public REST/WebShell metadata and full/range byte parity, cancellation, a same-Session next Shell/Read Turn, physical worker close, post-close downloads and production collection of only the owned objects. Read back that the owned prefix is empty and restore the test environment.

Controlled model inference, one Linux host and the supplied bucket are the acceptance boundary. Cross-host recovery, real model providers, the complete O4 permission-fault matrix and 100 MiB/1 GiB load gates are not added by this wiring change.

## Verification results

- macOS build, typecheck and bundle passed, with 75 SDK tests, 115 server tests, 11 selected Harness recovery contract cases, zero Checkstyle violations and zero SpotBugs findings.
- Linux build, typecheck with a 6 GiB Node heap, bundle, the same SDK/server tests and static checks passed on Ubuntu 26.04 arm64, Node 22.22.1, Java 21.0.12.1 and MySQL 8.4.11. All 8 public Workspace integration cases passed with no skipped cases.
- Real OSS acceptance observed a direct Java-to-Harness connection, a saved definition and grant budget of 1 MiB, 2 publication rows, 4 public raw-output Artifacts and 8 unique objects containing 1,201,297 bytes. Full/range downloads, cancellation, the next Shell/Read Turn, physical worker close and post-close downloads passed. Public DELETE collected both publications and removed all 8 objects; an independent CLI list confirmed the exact owned prefix contained zero objects.
- Budget restoration and conflicting loads were verified at the Java request and existing Harness contract layers. This change did not add a real deployment-budget-change or VM reboot acceptance run.
