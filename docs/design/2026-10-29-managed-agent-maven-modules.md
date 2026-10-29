# Managed Agent Server Maven modules

[English](2026-10-29-managed-agent-maven-modules.md) | [简体中文](2026-10-29-managed-agent-maven-modules.zh-CN.md)

Status: implemented in the working tree; final acceptance is pending CI. The
investigation used `523be857db`. This design supersedes the single-module
boundary in the [source layout](2026-10-15-managed-agent-server-layout.md) and
[Java package design](2026-10-19-managed-agent-package-boundaries.md).

## Problem and constraints

The baseline has 391 production Java sources, 614 test Java sources and 18 Maven
profiles. Lexical dependency analysis found cycles spanning 83 and 35 production
sources. Models import stores, orchestration recognizes concrete JDBC classes,
services contain SQL, and repositories call business services and external tools.
Configuration, test fixtures, launchers and CI also assume one source tree.

The change establishes internal compile-time boundaries in one coordinated
migration. Modules share one version and release. Java source compatibility may
change; repository consumers migrate together. HTTP routes, JSON, configuration
keys and defaults, database bytes, transaction boundaries, identity, fencing and
recovery behavior remain unchanged. There is no database migration, service split,
new product feature, independent module versioning or unrelated large-class
decomposition. Product-specific integrations remain outside this application.

## Modules and dependencies

The parent is `com.alibaba:qwen-managed-agent-parent`, with `pom` packaging.
Production children use `qwen-managed-agent-<directory>`; `server` preserves
`com.alibaba:qwen-managed-agent-server`. All children inherit the parent version.

| Directory        | Responsibility                                                                             | Internal production dependencies |
| ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| `contracts`      | Interfaces, values, errors, read-only settings and pure protocol rules                     | None                             |
| `control-plane`  | Session, Workspace, task, lifecycle, automation, Channel and extension orchestration       | `contracts`                      |
| `runtime-broker` | Runtime bindings, execution, leases, cancellation, draining and recovery                   | `contracts`                      |
| `persistence`    | Control-plane and Broker JDBC/memory stores, schema and transactions                       | `contracts`                      |
| `adapters`       | Harness SDK, physical providers, HTTP clients, OSS, MQ, Git and filesystem implementations | `contracts`                      |
| `server`         | HTTP servers, Spring composition, startup, preflight and operator entry points             | All other production modules     |
| `verification`   | Existing tests, fixtures, architectural checks and artifact acceptance; never published    | All production modules           |

The four implementation modules do not depend on one another. The server injects
their implementations through contracts. A production Java package belongs to one
artifact. No sibling source directories, aggregate compilation classpath, shading,
generic service registry or catch-all common module bypasses these boundaries.

Contracts may use the existing JSON, validation annotation and Commons libraries.
They must not reference Spring, JDBC, the Java SDK or cloud clients, or perform
database, network or process operations. Control-plane code may retain Spring
components, scheduling and transaction support, but not JDBC or concrete external
clients. Broker orchestration remains independent of Spring.

Separate Maven artifacts make forbidden implementation imports fail during compilation: sibling implementations are absent from each module's compile classpath. Dependency rules and ArchUnit checks supplement that boundary; a single artifact would leave all implementations on the same classpath. The coordinated package migration gives each package one artifact owner without preserving cross-JAR package-private access. This is the agreed internal-isolation scope, with shared versioning and one service delivery.

Source counts do not determine module ownership. Broker requests, identities, records and deterministic wire validators belong to contracts when multiple modules consume them without I/O. Runtime scheduling and recovery decisions belong to the Broker implementation. A small Broker implementation module is therefore expected; moving its shared protocol rules back would introduce implementation dependencies in consumers.

## Contract and implementation changes

Move existing storage, Harness, Runtime, event and object-store interfaces and
their shared values into contracts. Extract only interfaces needed at actual
module boundaries. Move externally used nested store records with their value
semantics; shared models no longer depend on store implementations. Represent
application HTTP status as an integer and translate it in the HTTP layer without
changing codes, details or causes. Preserve protocol strings, JSON names, nulls,
ordering, encodings and digest inputs. Move pure request-identity calculations and
provider-kind constants out of JDBC/provider classes.

`ManagedAgentSettings` supplies read-only views needed outside server. Authentication,
internal listeners, the service account, trusted headers and credential-loading
state remain server settings without shared contract declarations.
`ManagedAgentProperties` remains server-owned and implements those views, retaining
binding annotations, duration units, environment access, credential-file reads and
startup checks. Consumers receive views or existing scalar values. This introduces
neither configuration snapshots nor dynamic refresh.

The seven transactional default entry points on `AgentStateStore` receive explicit
overrides on the JDBC implementation with their existing transaction semantics.
Removing the interface annotations must not lose proxy interception on delegating
overloads. Existing Spring and native JDBC transaction mechanisms stay distinct.
Same-connection operations and package-private locking helpers remain together in
persistence; `Connection` does not escape into ordinary repository contracts.
Move each existing transaction body as a whole, never as independently committed
CRUD operations.

`NativeCsiExecutionRepository` carries the existing private CSI preparation and
batch-read capabilities. The original JDBC binding store implements it; memory
stores do not. The Broker consumes the capability instead of concrete JDBC types.
Capability discovery never substitutes for transactional admission, original
DataSource identity, writer/generation checks or locking. Missing capabilities keep
the existing refusal behavior. A neutral store failure preserves genuine-outage
classification without exposing JDBC exception types. A Broker operations
interface includes the operations consumed outside its implementation module.
Convenience overloads without those consumers remain on the implementation only.

Move recovery queries and SQL-backed evidence into persistence. Inject the
existing Channel repository interfaces rather than constructing JDBC repositories
inside the service. Separate extension transactions, archive access and business
coordination without changing their order. Extract user-message authorization and
input policy without moving authorization outside its original transaction or
introducing a policy-to-message-store dependency. Git and SSH work cross explicit
ports at the same call sites as before.

Only adapters depend directly on the Java SDK and cloud clients. Map Harness
results and synchronous, asynchronous and callback errors into contract values.
Keep HTTP, transport, protocol, generation, capability and refusal distinctions,
including retry inputs, status, reason and cause. Delegate SDK payload-digest and
permission-rule algorithms through narrow ports instead of duplicating them.
Workspace scope and authorization wrappers stay in the control plane. Physical
provisioning and communication belong to adapters; construction and listeners
belong to server composition.

CSI maintenance retains its durable sequence: lock and save the original attempt,
perform the bounded Kubernetes operation, then fence and save the receipt or
unknown outcome. Preserve UID/resourceVersion, request bytes and receipt digests.
A lost response remains UNKNOWN and does not authorize blind replay. Operator
entry points retain their isolated application context and do not start the public
server or business schedulers.

## Build, resources and verification

Keep JDK 21, Spring Boot 3.5.16 and existing build-plugin versions. The parent
manages versions; children declare their own libraries. The reactor builds all
modules, with Boot repackage only in `server`. Preserve the executable and operator
classifiers and published server coordinate; outputs move to `server/target`.
The SDK retains its existing separately installed build prerequisite. Publish the
parent and every production dependency at the same version; never publish the
verification module.

Server composition preserves non-servlet embedding, explicitly enabled internal
callbacks and standalone serving. Keep named managed data sources, transaction
managers, mappers, executors and schedulers separate from host defaults. Restrict
component scans and maintain a single owner for closing each resource.

| Resource                                      | Owner          |
| --------------------------------------------- | -------------- |
| OpenAPI and shared protocol schemas           | `contracts`    |
| V1 schema and CSI persistence declarations    | `persistence`  |
| Application YAML and Spring registration      | `server`       |
| Test fixtures and JUnit service registrations | `verification` |

Classpath resource names stay unchanged and each resource has one artifact owner.
The TypeScript tool-result schema remains authoritative. Update launchers, Docker,
distribution/version checks, WebShell contract reads, historical-path fallbacks
and CI consumers together. Resource moves do not increment protocol/schema versions.

Move all existing tests and fixtures to verification, preserving their execution
families and all 18 profiles. Artifact tests run after server packaging and read
the server output directory. Keep MySQL fork routing, JUnit extensions, fault-test
environment and real-process parameters. Report completeness checks examine the
complete relocated test tree. Checkstyle and SpotBugs still cover every production
module. Aggregate coverage includes production classes and source, not only test
execution data. Verification directly depends on production modules at compile
scope for that aggregation, without becoming a published artifact.

Tests keep `verification` as their working directory so local `src/test/resources` paths remain valid. Surefire and Failsafe pass `managed.module.root` for shared repository fixtures and `qwen.cli.entry` for the built CLI, including profile overrides. Repository paths are resolved from the module root instead of assuming the old process working directory.

Use test-scoped `com.tngtech.archunit:archunit:1.5.1` under existing JUnit to enforce
the module matrix, forbidden dependencies, package ownership and nonempty scans.
No additional test engine is introduced. Framework/client types must not leak
through signatures, inheritance, annotations or exception references.

## Implementation and acceptance

Implement as one change: record source/test/resource/entry-point inventories;
extract contracts and remove cycles; move sources and define POMs; migrate
composition, tests and delivery tooling; verify and audit the complete result.
Maintain this design in both languages and update the development instructions.

Acceptance covers independent module compilation; contract purity; unchanged
configuration and host isolation; rollback through all seven transaction entry
points; native CSI refusal and admission; restart, takeover and lost-response
recovery; SDK conversion and digest parity; HTTP/tenant/actor/Workspace security;
all ordinary/executable/operator artifacts and unique nested-JAR resources; and
unchanged CI test-family completeness.

Follow the module AGENTS.md shared ten-minute local Java verification budget.
Prioritize architectural, transactional and composition regressions and affected
real integration paths. CI retains complete Java, MySQL, Hosted, fault and MQ/OSS
gates. Cross-language edits also require repository build, typecheck and affected
script/meta-tests. Do not convert skipped or unavailable integrations into passes.
Audit the full diff and evidence until two consecutive clean passes. Report local,
CI, skipped and pending results separately. Rollback replaces application and
distribution artifacts and does not rewrite persistent data.

## Implementation notes and local evidence

The seven-module reactor, contract extraction, composition changes, relocated
tests/resources and delivery-script updates are implemented together. All 614
original test source files and all 18 profile names are retained. The six original
production resources retain their bytes and each has one production owner. New
regressions cover compiled module boundaries, transactional default-method
overrides, SDK failure conversion and single-instance Harness composition.

The Harness SDK boundary wraps both single-instance and pooled connectors. The
single-instance factory explicitly supplies skills, extension records and the
managed mapper to the wrapped connector; Spring cannot inject fields into a
delegate hidden behind a returned wrapper. The settings views preserve existing
collection references and read timing. Existing filesystem identity/admission
checks remain at their original business/transaction positions; physical Git,
SSH, provider and storage-identity operations cross the extracted ports.

Local evidence was collected on macOS with JDK 21, Maven 3.9.14, an isolated Maven
repository, Node 26.12.1 and Bash 5 for workflow shell fixtures. It does not establish
Linux, remote-cloud or production behavior.

| Area                          | Observed local result                                                                                                                                                                                   | Limit                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production reactor            | All six production modules compiled with their declared dependencies; production Checkstyle and SpotBugs passed; ordinary, executable and six operator JARs were built                                  | These complete quality/package results precede the last composition and collection-reference fixes                                                                   |
| Architecture and transactions | Bytecode architecture check passed; all seven former default transaction entries committed and rolled back through a real Spring proxy and dedicated H2 transaction manager; 44 lock-order cases passed | H2 and proxy evidence does not establish MySQL concurrency behavior                                                                                                  |
| Configuration and embedding   | 31 property-binding cases, non-servlet embedding and explicit internal-callback tests passed                                                                                                            | The independent Maven embedding-host fixture remains unrun                                                                                                           |
| Broker and lifecycle          | 199 Broker cases, 33 resident-retirement cases and 47 cancellation/command/automation cases passed                                                                                                      | Full restart, Hosted, failure and MySQL profiles remain pending                                                                                                      |
| SDK, HTTP and packaging       | SDK conversion, 23 API-contract cases and three packaging cases passed; inspected executable archives contain the five internal dependency JARs with no duplicate production classes/resources          | The packaged artifacts predate the final audit fixes                                                                                                                 |
| Final composition fix         | The two changed production classes and the new Harness wiring regression compiled; the regression method ran successfully                                                                               | This focused check was not a full Maven/Surefire run; the subsequent collection-reference-only fix still needs compilation on CI                                     |
| TypeScript and scripts        | Repository build and typecheck passed; affected CLI tests passed 288 cases and integration-helper tests passed 22; focused ESLint and affected script/workflow rechecks passed                          | The broad script run initially failed under macOS Bash 3.2; Bash 5 rechecks resolved those failures, while one unchanged 600 ms timing case passed only in isolation |

The shared local Java ledger totals about 598 seconds. An earlier quality run
stopped on verification-module formatting, which was corrected and rechecked.
The configuration failures in a later selected run were corrected and all 31
cases reran successfully. The final `mvn -DskipTests verify` attempt reached server
SpotBugs but hit its bounded timeout; it is **not** a passing full-reactor result.
No further Java runs were started after the final focused composition check.

Acceptance still requires the final source revision to pass the unfiltered Java
reactor, aggregate coverage generation, independent embedding-host fixture and
the existing MySQL, Hosted, fault, MQ and OSS CI gates. New Java test formatting
and the final collection-reference fix also await that run. CI was not dispatched,
Central publication was not attempted, and no deployment or database migration
was performed. Rebuild the deliverables from the final revision before using or
publishing them; local intermediate JARs are verification artifacts only.

## PR integration baseline

PR preparation incorporates `main@68f181b885` on top of the original investigation.
The newer bounded-history queries and models remain in the repository contracts
and persistence implementation. The upstream cleanup retry coordinator depends on
a cleanup-debt repository contract and neutral Harness failures; its SQL scan and
unchanged keyset/backoff behavior remain intact. The resolved-configuration entry
point and upgrade packaging stay in server composition. All 619 current-main test
sources plus the two embedding-fixture sources are retained, including the five
tests added since the investigation. All six production resources are byte-identical
to this newer main revision; the refactor adds no further protocol/schema change.

After integration, repository build and typecheck passed again. Reference packaging
tests passed 25 cases with one existing skip, the five affected script suites
passed 196 cases, CLI consumers passed 288 cases, and selected Maven/workflow checks
passed 22 cases. The earlier Java results above predate this integration. The shared
598-second budget was not reset: compilation, style checks and Java regressions for
the integrated revision remain pending CI, including the new repository boundary
and migrated upstream tests. Final acceptance requires those checks to pass.

## Boilerplate reduction

The server configuration classes use Lombok `@Getter` and `@Setter` for 349 simple
accessors. Keep normalization, defensive copies, fallback values and the
`EnvironmentAware` callback explicit. Internal credential-loading state remains
excluded from generated accessors. Existing records, field defaults and
`@DurationUnit` annotations remain unchanged; `@Data` is not used. Lombok is an
optional provided dependency of `server`, with its version inherited from Spring
Boot and an explicit compiler annotation processor. Exclude it from every Boot
executable and operator archive; other production modules do not require it.

The SDK wrapper retains explicit interface implementations and delegates repeated
runtime-exception conversion to two private helpers for value and void calls.
Its size falls from 693 to 422 lines without reflection or a proxy framework.
Context-compression submission stays deferred, and stream epoch reads, event
reads, recovery checks and close operations still convert SDK failures after
stream creation. Preserve result identity, arguments, call order, unrelated
exceptions and `Error` propagation.

Regression coverage adds nested configuration binding, hidden internal state,
normalization and collection semantics, immediate and deferred SDK failures, both
stream entry points and archive exclusion. Standalone Harness composition is checked
through session creation, resource publication and the resulting SDK request, rather
than connector private fields. Unused test-factory overloads and private service
forwarders are removed; existing behavioral test cases are retained.
Source comparison confirms unchanged JavaBean signatures and SDK delegate call
sites. These new Java regressions have not
run locally: the shared budget remains exhausted, and earlier Java passes do not
validate this increment. Final compilation, quality checks and regressions remain
pending CI.
