# Managed Agent Server source layout

[English](2026-10-15-managed-agent-server-layout.md) | [简体中文](2026-10-15-managed-agent-server-layout.zh-CN.md)

Status: implemented and validated locally. Remote CI and real MySQL/Linux deployment acceptance have not been run for this change.

## Problem and current state

Before this change, Managed Agent Server sources lived under `packages/sdk-java/managed-agent-server`. Its Runtime Broker was a separate Maven artifact under `packages/sdk-java/runtime-broker`, even though the server was its only production consumer in this repository. Development, Docker packaging and CI installed the Broker artifact before building the server, and the server imported a Broker test JAR to reuse repository contract tests.

## Proposed layout

Move the application to `packages/managed-agent-server`, alongside `packages/sdk-java`. Move the Broker production sources, resources, tests and fixtures into the corresponding server source roots. Keep the existing `com.alibaba.qwen.code.runtimebroker` and `com.alibaba.qwen.code.managedagent` packages. Remove the separate Broker POM, version property, main dependency and test-JAR dependency. The server continues to depend on the Java SDK in `packages/sdk-java/qwencode`.

The resulting application has one POM, one dependency graph and one set of build outputs. Broker repository contracts become ordinary tests in that module. Preserve its fault-gate profile, coverage instrumentation and existing style checks when combining Maven configuration. Update repository-relative paths, Docker build inputs, development launchers, packaging, CI, workflow contract tests and documentation together.

## Decisions and constraints

- Source ownership follows the application. Independent Java packages retain the internal responsibility boundary without requiring another published artifact.
- Preserve Java package names, public API behavior, private HTTP protocols, runtime identity, leases, cancellation and recovery semantics.
- Preserve classpath resource names and migration contents. This is not a database migration or a change to schema authority.
- Preserve existing default test exclusions and explicit MySQL, Hosted and fault-gate lanes. Do not turn optional external prerequisites into default unit-test requirements.
- Keep the framework-independent Broker classes independent of Spring. Relocation does not require introducing application dependencies into their implementation.
- Use the existing Server dependency management for runtime libraries, and retain the Broker's H2 and JUnit test dependency versions in the combined module.
- Keep existing workflow names and triggers unless a path or obsolete separate-module build step requires an update.

## Scope and affected areas

The change covers the two Java source trees, the combined Maven configuration and Dockerfile, repository scripts and their tests, integration-test launch paths, GitHub workflow/dependency configuration, and current source/build documentation. It does not change SDK APIs, add a new deployment topology, rename Java packages, or introduce compatibility directories at the retired paths.

## Risks and validation

The main risks are relative paths that still assume three levels to the repository root, loss of Broker resources or tests, changed Maven test selection, dependency-version differences, and scripts or CI jobs that continue installing a removed artifact. Check source/resource inventories against the original trees, compile and package the combined application with JDK 21, run the combined Java unit tests and focused script/workflow tests, and inspect the packaged JAR. Run the repository build and typecheck. Run the existing fault/process gates when their prerequisites are available and report unavailable external services separately.

## Acceptance criteria

`packages/managed-agent-server/pom.xml` builds the server and Broker together after installing the Java SDK, without an installed `qwen-managed-runtime-broker` artifact. Both original Java package trees and all their classpath resources and tests are present. Build, development, packaging and CI references use the new application location. Existing protocol and schema fixtures remain unchanged, and validation reports distinguish local results from unrun CI or environment-specific gates.

## Open questions

None for this relocation. A future consumer can justify extracting a shared library when it actually needs one.
