# Managed Agent Server package boundaries

[English](2026-10-19-managed-agent-package-boundaries.md) | [简体中文](2026-10-19-managed-agent-package-boundaries.zh-CN.md)

Status: implemented and verified locally on main base `f37e003d9450`. Remote CI and formal review are tracked on [PR #14710](https://github.com/QwenLM/qwen-code/pull/14710). The optional MySQL, Hosted and Linux fault profiles were not run locally for this package reorganization.

## Problem and current state

Managed Agent Server is one Spring Boot application and Maven module. Before this change, its `service` and `store` packages contained unrelated business capabilities, while application and persistence code imported request models, tenant context, Workspace selection and exceptions from `api`. Runtime Broker combined its orchestration, providers and HTTP adapters in one package. This made responsibility and dependency direction difficult to see.

The existing [source-layout decision](2026-10-15-managed-agent-server-layout.md) remains valid: the Broker does not need a separately published artifact for its single production consumer. This change organizes Java packages inside that application.

## Goals and scope

- Keep one Maven module and one service deployment.
- Remove application and persistence dependencies on the HTTP controller package.
- Group Session, Workspace, Artifact, Channel, Automation, catalog and event components by responsibility.
- Separate Broker provisioning, transport and credential protection from its execution and repository core.
- Preserve HTTP contracts, authentication, SQL bytes, transaction boundaries, persisted identities and recovery behavior.

This is a source organization change. It does not redesign persistence, introduce new service interfaces, split the deployment, or change the maintenance application's component-scan boundary.

## Proposed structure

```text
com.alibaba.qwen.code
├── managedagent
│   ├── api              HTTP controllers, filters and response mapping
│   ├── model            Shared request/response and stored value types
│   ├── exception        Shared application errors
│   ├── security         Writer credentials and route policy
│   ├── session          Session and command orchestration
│   ├── workspace        Workspace services and selection
│   │   └── runtime      Workspace runtime integration and recovery commands
│   ├── artifact         Artifact access and object-storage contracts
│   ├── channel          Channel service and adapter models
│   ├── automation       Scheduling and automation service
│   ├── catalog          Agent definitions, skills, hooks and MCP catalogs
│   ├── event            Committed event publication and delivery
│   ├── persistence      Shared SQL aggregate and transaction implementation
│   ├── harness          Hosted Harness integration
│   ├── config           Spring configuration
│   └── preflight        Startup checks
├── runtimebroker
│   ├── provisioning     Physical runtime providers and provider protocols
│   ├── transport        Runtime HTTP transport and wire protocols
│   ├── security         Credential encryption
│   ├── managedschema    Shared database schema
│   └── managedworkspace Workspace contracts
└── maintenance          Independently configured maintenance application
```

## Decisions and constraints

Request/response records and validation annotations move together without changing JSON names, deserializers or validation. The shared application exception keeps its existing status, code, details and cause semantics; only its name and ownership change. HTTP error-envelope translation remains in `api`.

Session, Workspace and publication persistence share package-private transaction operations. Keep that aggregate in one `persistence` package rather than exposing its locks and mutation helpers to divide it by business labels. Independent object-storage contracts and event interfaces move to their owning capability. Move canonical request digests out of the former service package so persistence can use the same digest implementation.

Broker providers and transports use existing protocol validators and value operations. Expose only the existing members consumed across the new package boundaries. Keep local-process state and SQL implementation helpers package-private. Update tests to follow the package whose internals they exercise; avoid making production internals public solely for a test. Two test-only access fixtures forward existing Broker-core and HTTP-transport seams across packages without exposing those production internals.

Broker-core repositories use `transport.ManagedHoldFamily` to classify stored dispatch modes. Its dispatch-mode lookup is public for that core consumer, and `ToolHoldRow` stays in the core with the inventory repositories. Rebase validation compiles the updated core and transport consumers together.

Keep the server's Spring Boot application at its existing root and the maintenance configuration outside that root. Update imports, fully qualified names, launcher configuration, current documentation links and any source-file references together. Preserve resource paths, Maven test profiles, fault gates and the Broker's separate Checkstyle execution.

## Risks and validation

The principal risks are implicit same-package references, accidental Spring component discovery changes, stale command entry points, test helpers that rely on package access and incomplete documentation links. Inventory all production and test classes before and after the move, compile all sources, run affected tests and full Maven verification with JDK 21, and inspect the packaged application. Build the Java SDK from this checkout and prepare Core/CLI outputs for native conformance tests.

Compare source bodies after normalizing package names, imports and required visibility changes. Check that application and persistence packages no longer import `managedagent.api`, Broker remains independent of Spring and control-plane classes, and SQL/OpenAPI resources are unchanged. Run formatting, reference checks and two clean self-audit passes. Report skipped environment-specific profiles separately; ordinary Java tests do not establish MySQL or Linux recovery acceptance.

Local verification with JDK 21 passed:

- `mvn clean verify`: 4,796 tests, zero failures/errors and 18 existing skips; both Checkstyle executions and SpotBugs reported zero findings. All existing Maven verification gates remain enabled.
- Root `npm run build` and `npm run typecheck`, all 39 affected script tests, targeted ESLint, and Javadoc reference checks passed.
- All 322 production source bodies are unchanged after namespace/import/visibility normalization. All 877 compiled classes and 16,860 declaration signatures are retained, with no reduction of existing public access.
- All seven executable JARs contain the expected entry points and unchanged resources. Four maintenance entry points reject empty arguments before file, database or cloud access.

## Acceptance criteria

All original classes and resources remain present under their new ownership, existing routes and wire contracts pass their regression tests, and standard Maven verification passes without disabling a gate. Shared SQL transaction helpers retain their package access. Application and persistence code have no imports from the controller package. Both design documents and current build/maintenance instructions reflect the final structure.

## Open questions

None for this package reorganization. A later independent consumer or a concrete need for compilation isolation can justify Maven modules.
