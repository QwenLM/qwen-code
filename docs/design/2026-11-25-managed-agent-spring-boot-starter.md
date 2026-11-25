# Managed Agent Spring Boot Starter

[English](2026-11-25-managed-agent-spring-boot-starter.md) | [简体中文](2026-11-25-managed-agent-spring-boot-starter.zh-CN.md)

Status: implementation candidate for #18311. DataAgent-specific assembly, identities and execution-provider selection remain outside this change.

## Problem and current state

A Spring Boot host can depend on the ordinary `qwen-managed-agent-server` library, but that dependency does not enable `ManagedAgentConfiguration`. Every host must import Qwen's internal configuration explicitly. This makes embedding depend on package scans instead of an official artifact contract.

The existing embedding code already isolates the managed data source, transaction manager, mapper, execution resources and schedulers. Its core configuration intentionally mounts no public or internal controllers. These properties must remain unchanged.

## Goals and scope

Add `qwen-managed-agent-spring-boot-starter` as a thin, independently publishable Maven module. Enabling `qwen.managed-agent.enabled=true` imports the existing `ManagedAgentConfiguration` through Boot auto-configuration. The default is disabled, so adding the dependency has no application side effects.

The starter:

- exposes the existing Java services and the existing optional host-provided storage SPI implementations;
- preserves runtime-provider selection by explicit Maven dependency, with no runtime backend bundled by the starter;
- does not mount Managed public, WebShell or internal controllers;
- permits deployment-managed schemas when `qwen.managed-agent.schema.initialize-enabled=false`: the application validates the existing baseline and refuses missing, partial or foreign catalogs instead of executing DDL;
- supports the host's explicit `managedAgentDataSource` bean or the existing `qwen.managed-agent.datasource.*` settings.

The property defaults preserve current behavior: server startup and explicit `ManagedAgentConfiguration` import do not check `enabled`, and schema initialization remains enabled when that existing setting is absent.

The starter does not implement host authentication, business Session routing, definition or material ownership, Muster orchestration, a second Session facade, runtime-provider selection, or DataAgent-specific configuration. Internal callbacks remain a separate explicit configuration if a future embedding contract requires them.

## Implementation

`ManagedAgentAutoConfiguration` lives in a new `com.alibaba.qwen.code.managedagent.starter` package and does nothing except conditionally import `ManagedAgentConfiguration`. Its Maven module is located at `packages/managed-agent-server/qwen-managed-agent-spring-boot-starter/`; directory and artifact name stay identical. The starter POM depends on the ordinary server library and the directly used Boot auto-configuration API. It registers through `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`.

`ManagedAgentProperties` owns the new `enabled` and `schema.initialize-enabled` properties. `ManagedAgentPersistenceConfiguration.managedJdbcTemplate` chooses `ManagedSchema.validate(source)` when initialization is disabled, otherwise retains `ManagedSchema.initialize(source)`. The same public `ManagedSchema` methods apply in both paths; no bypass, repair or weaker database admission is added.

The parent reactor includes the starter before `verification`, and dependency management shares the same version. Verification imports starter classes directly, while the independent embedding fixture consumes only the new artifact to prove there is no reliance on reactor-only wiring.

## Host contract

A host which provides its own Managed catalog uses the starter, the chosen runtime artifacts, and configuration equivalent to:

```yaml
qwen:
  managed-agent:
    enabled: true
    schema:
      initialize-enabled: false
    datasource:
      url: ${MANAGED_JDBC_URL}
      username: ${MANAGED_JDBC_USER}
      password: ${MANAGED_JDBC_PASSWORD}
```

The Managed catalog is distinct from the host business catalog. Its schema and application account are prepared by the deployment process. The starter does not turn `spring.datasource` into a Managed data source.

A host that wants no controllers uses the default Java surface. The standalone application retains its existing web assembly; the starter does not remove it.

An embedding host may provide an `ExternalRuntimeClient` bean for physical Runtime placement instead of routing through its own loopback controller. `RuntimeProviderDependencies` selects this implementation in the external factory; the ordinary HTTP transport remains the compatibility fallback. Only the external provider URL/token validation is unnecessary for a Java transport, while Workspace identity, capability, isolation and timeout validation remain unchanged.

`ManagedRuntimeAttachmentService` is the optional Java host surface for Workspace attachments. `acquire` and `inspect` first authorize the explicit `SessionPrincipal`, then bind or read the attachment through the durable RuntimeSession→RuntimeBinding relation. `inspect` requires the caller's exact binding ID and generation rather than selecting a latest READY binding.

`ManagedAgentService.findSubmission(principal, key, sessionId)` is the read-only recovery lookup for an existing `SUBMIT_TURN` admission. The caller's Session read grant and original receipt identity are enforced, and lookup uses the original request digest and operation relation; it never writes a new Turn. Neither these Java surfaces nor an injected Runtime client bypass Workspace/actor authorization or create a public HTTP/controller facade. Their focused tests, real process verification, full CI and artifact publication remain distinct acceptance requirements.

## Validation

- Context tests: dependency disabled by default, explicit enablement, owned or host-supplied Managed data source, and no public/internal controller beans.
- Schema tests: initialization remains the default; validation-only accepts a prepared catalog and refuses an empty catalog without creating tables; real MySQL verifies that boundary when available.
- Architecture tests: starter classes belong only to the starter module and depend only on the server assembly, not on host types.
- Independent fixture: consume the new artifact with Spring Boot 3.5.3 and no `@Import`, both with an owned pool and a host-supplied pool. Existing explicit-import coverage remains executable.
- Configuration reference and README are regenerated or updated with the new properties and artifact contract.
- Relevant focused Maven/Checkstyle checks and the independent fixture provide local evidence; the complete Java, MySQL and packaging suites remain CI gates.

## Acceptance and limits

The artifact is accepted only when dependency-alone inertness and explicit enabled startup both work, host resources remain isolated, no extra controllers are mounted, and validation-only does not execute DDL.

Starter success does not prove DataAgent's business adapter, real Runtime provisioning, multi-replica recovery, an end-to-end Issue/AgentRun, or deployed E2E acceptance. Those results and the fixed Qwen artifact version consumed by DataAgent are tracked independently. Rollback removes the new module and properties without changing existing Managed catalogs or server behavior.
