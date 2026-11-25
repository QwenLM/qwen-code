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

Extension archive storage is imported through `ManagedAgentConfiguration`, not registered separately in the server-wide auto-configuration index. The existing factory method receives `ManagedAgentProperties` as a parameter and uses `@ConditionalOnMissingBean`, so host-provided `ExtensionArchiveStorage` takes precedence. It does not depend on a class-level `@ConditionalOnBean` evaluated before that configuration has registered the properties. With `qwen.managed-agent.enabled=false`, the Starter does not import `ManagedAgentConfiguration` or create Managed resources.

A host may provide one `ExternalRuntimeClient` for same-process placement through `RuntimeProviderDependencies.externalRuntime()`, removing the provider URL/token requirement. It may also provide an external `RuntimeTransport` through `RuntimeProviderDependencies.externalRuntimeTransport()`, retaining the default `HttpRuntimeTransport` when absent. The supplied transport reaches both the outer Workspace execution path and external Shell publication rather than only the provisioner's attestation calls. Neither port authorizes Workspace access or allocates native facts; the original boot, lease and attestation semantics stay unchanged.

`ExternalWorkspaceMaterializationStore.findByPhysicalKey` finds the tenant's active root Workspace from its registered storage identity. A host can recover the original Workspace, generation, storage alias and owner receipt before deciding whether to materialize a new alias. The lookup does not change ownership or execution state; it returns no receipt when the association is missing and refuses an ambiguous one. Neither result permits registering the same storage again.

## Validation

- Context tests: dependency disabled by default, explicit enablement, owned or host-supplied Managed data source, and no public/internal controller beans.
- Schema tests: initialization remains the default; validation-only accepts a prepared catalog and refuses an empty catalog without creating tables; real MySQL verifies that boundary when available.
- Architecture tests: starter classes belong only to the starter module and depend only on the server assembly, not on host types.
- Independent fixture: consume the new artifact with Spring Boot 3.5.3 and no `@Import`, both with an owned pool and a host-supplied pool. Verify that a host-declared `@Transactional` bean is an AOP proxy. Existing explicit-import coverage remains executable.
- Configuration reference and README are regenerated or updated with the new properties and artifact contract.
- Relevant focused Maven/Checkstyle checks and the independent fixture provide local evidence; the complete Java, MySQL and packaging suites remain CI gates.

## Acceptance and limits

The artifact is accepted only when dependency-alone inertness and explicit enabled startup both work, host resources remain isolated, no extra controllers are mounted, and validation-only does not execute DDL.

Starter success does not prove DataAgent's business adapter, real Runtime provisioning, multi-replica recovery, an end-to-end Issue/AgentRun, or deployed E2E acceptance. Those results and the fixed Qwen artifact version consumed by DataAgent are tracked independently. Rollback removes the new module and properties without changing existing Managed catalogs or server behavior.
