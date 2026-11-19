# Managed Runtime backend modules

[English](2026-10-31-managed-runtime-backend-modules.md) | [简体中文](2026-10-31-managed-runtime-backend-modules.zh-CN.md)

Status: implemented; Java acceptance pending. Based on main `73474ef094ea1c6bb2a95a9a2a33a28b0ec58e9e`, including its Store constructor injection. Scope narrowed on 2026-11-02 to independently consumable Maven backends and their assembly. The existing shared local Java verification budget is exhausted at 599.048/600 seconds; earlier Local/External results do not certify the revised SPI and module graph.

## Objective and boundaries

After #15871, backend implementations still share the adapters artifact and server assembly directly constructs them. SSH additionally requires a Local provider. Split Local, SSH, Kubernetes, External and Static into independent Maven artifacts so another service can depend on the server and explicitly install only its chosen backend. Preserve the default full executable and operator distributions.

Backend availability comes from the application's trusted classpath; enabled selection comes from existing configuration. No live JAR loading, automatic download or untrusted-plugin isolation is introduced. Selective standalone builds, variant archives, deployment examples and their CI matrix are deferred. Kubernetes scratch, Session/Turn prewarm changes and further database/Harness/messaging dependency trimming are outside this change.

## Module boundaries

Modules remain reactor siblings with the same parent version and release process. Each production Java package has one artifact owner; package-private tests move with their classes.

| Module               | Responsibility                                                           | Internal dependencies                                      |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `contracts`          | Runtime settings, identities and construction/access ports               | None                                                       |
| `runtime-local`      | Local Worker, persistent state, factory and offline recovery             | `contracts`, `runtime-http`, `runtime-host`                |
| `runtime-ssh`        | SSH Worker, connections/tunnels and factory                              | `contracts`, `runtime-http`, `runtime-host`                |
| `runtime-kubernetes` | Kubernetes client, resident/CSI provisioning, protection and reclamation | `contracts`, `runtime-http`                                |
| `runtime-external`   | External Runtime client, scratch/workspace providers and factory         | `contracts`, `runtime-http`                                |
| `runtime-static`     | Preconfigured endpoint/lease and factory                                 | `contracts`                                                |
| `runtime-http`       | Shared HTTP transport                                                    | `contracts`                                                |
| `runtime-host`       | Shared process/file exchange and host identity/state utilities           | `contracts`                                                |
| `runtime-broker`     | Lease/execution coordination and backend-neutral routing                 | `contracts`                                                |
| `adapters`           | Harness, filesystem and other non-provider adapters                      | Shared modules; no backend implementation                  |
| `server`             | Selection, SQL-backed wiring, HTTP and operator entry points             | Application/shared modules; five optional runtime backends |
| `verification`       | Tests and independent classpath/embedding fixtures; unpublished          | All production modules                                     |

The five backends never depend on one another. Routing belongs to `runtime-broker`; process/file exchange shared by Local and SSH belongs to `runtime-host`, which does not install a Local provider. SQL stores, reservation transactions, retirement authorization and shared CSI application-store wiring remain in their original layers. Kubernetes Harness discovery remains a separate Harness concern. New modules declare directly used libraries and participate in the existing compilation, architecture, Checkstyle, SpotBugs, source/Javadoc and aggregate coverage gates.

## Factory and dependency contracts

Each backend registers `RuntimeProviderFactory` through `META-INF/services`. The registry rejects duplicate/reserved kinds, checks the selected factory and verifies the returned provider's kind. Factory construction and discovery are inert; validation checks configuration only. Preflight keeps common listener, credential and Workspace checks, then delegates provider diagnostics. Remote providers do not require a local workspace directory. Existing Local executable/state checks and External workspace warnings remain.

Creation uses `create(settings, transport, dependencies)`. `RuntimeProviderDependencies` has exactly four named ports: `bindings()` for the original Broker repository, `externalStorage()` for the lazy SQL storage adapter, `csiReservations()` for the original datasource/transaction authority, and `ssh()` for borrowed node/storage lookup and connections. A backend requests only its required ports. Kubernetes retains JDBC repository, datasource identity, transaction manager and Workspace execution checks before reservation construction.

The discovered SSH factory also supplies connection construction through `SshRuntimeSupport`; the Kubernetes factory supplies operator/client/protection construction through `KubernetesRuntimeSupport` and the typed `WorkspaceCsiRuntimeSpec`. These are capabilities of the same factory, with no second discovery mechanism. The internal SPI and moved implementation imports require same-version recompilation. Persisted kinds, identity bytes, SQL schema, wire protocol and recovery algorithms do not change. Only `kubernetes-workspace` is registered; `kubernetes-scratch` remains unregistered and `kubernetes` remains rejected.

An additional trusted provider can implement the contract, register its factory and use `provider-options` without another server selection branch. It must preserve existing fencing, identity and HTTP contracts. Discovery does not establish whether a saved resource can be recovered; existing durable checks remain authoritative.

## Selection, admission and resource lifetime

`RuntimeBackendSelection` computes the enabled set before resource allocation. Disabled Broker means an empty set with no discovery or connections. SSH primary requires configured nodes and selects SSH alone. Local primary with nodes selects Local+SSH; any other primary with nodes is rejected. Otherwise only the primary backend is enabled. All selected factories and configuration are checked before clients, connections or Worker state are created.

SSH-only constructs no Local provider/state or routing wrapper. Local+SSH retains its shared endpoint resolver and original node identity, while the Local delegate uses its direct HTTP transport. SSH-only refuses unbound Session execution, Local workspace settings and historical Local path resolution. Static retains directory preflight; Kubernetes retains credentials, resident registration and physical-retirement authorization.

`ssh.enabled` still governs new registrations, bindings, Sessions and file access. When false, already-admitted work can execute, close, recover and perform permitted idempotent replay with its original node identity. When SSH is absent from the enabled set, historical registration queries remain available but do not claim or dispatch work, and parked acceptance stays unknown rather than becoming FAILED.

Online file-upload reconciliation checks the backend of the saved target before exchange or status dispatch. A historical Local upload after switching to SSH-only stays pending and retains its storage holder without executing the saved Local command. Restoring the backend resumes reconciliation. This guard does not disable independent offline storage maintenance.

Spring exclusively closes the shared SSH connections bean; providers and `SshWorkspaceService` borrow it, and the service closes only its executor. Failed startup and normal shutdown must release controller ownership. Factories close partially constructed resources; resident assembly closes earlier delegates if a later registration fails.

## Maven consumption and maintenance

The server declares five `optional` dependencies with `runtime` scope. Library consumers receive none transitively and explicitly add their chosen same-version backend artifacts. For example, Kubernetes requires the ordinary server and `qwen-managed-agent-runtime-kubernetes`; Local+SSH requires both corresponding artifacts. A disabled Broker needs no backend. Including several artifacts does not enable arbitrary composition or fallback.

The standalone build still includes all five backends. Keep the fixed `exec` classifier, existing operator classifiers and Central-release policy, application YAML/configuration metadata and Lombok exclusion. The ordinary library contains no standalone application YAML. Keep the reference packager and release names unchanged; no backend selector or variant metadata is added. Update only module-related Maven cache exclusions and their CI meta-tests.

Maintenance requests capabilities per action: missing Kubernetes rejects CSI `serve`, protection rendering and physical retirement, while CSI `text`/`retire` and SQL-only resident `inspect`/`begin` remain available. Local-dependent recovery requires Local before persistent side effects. Online validation belongs to normal configuration and explicit preflight, not shared properties initialization used by the SQL-only maintenance context. Missing capabilities never fall back to another backend.

## Verification and remaining risks

Keep independent compilation and bytecode dependency checks. Isolated classpaths cover absent backends, each single backend, Local+SSH, full and an independent contract-only provider; the ordinary Maven embedding fixture checks that no optional backend leaks transitively. Default executable packaging checks all five JARs and service registrations, configuration resources and operator launchers. These checks do not claim seven standalone variant products.

Retain regressions for unused-provider initialization, missing/duplicate factories before side effects, SSH admission, pending upload/registration recovery, failed-startup controller lock reacquisition and partial-construction cleanup. Preserve the existing full unit/H2, Checkstyle, SpotBugs, embedding, MySQL and Hosted/fault CI gates. Real enabled SSH/Kubernetes and complete cross-platform acceptance remain required; mocked connections or H2 do not establish that evidence.

New and revised Java tests await CI because the shared local budget is closed. Root script/workflow tests, formatting, link checks and static review cover the scope reduction; prior root build/typecheck/bundle evidence applies only while its inputs are unchanged. Detailed results remain in `.qwen/e2e-tests/runtime-provider-plugins.md`. Retain an owning backend until its work drains, or deliberately keep pending operations and storage claims until it is restored. No unresolved design decision blocks this scope.
