# Managed preview synchronization with main

[English](2026-11-03-managed-preview-main-sync.md) | [简体中文](2026-11-03-managed-preview-main-sync.zh-CN.md)

## Scope and status

This is a private preview integration candidate, pending compilation, focused tests, complete CI, artifact validation and preproduction acceptance. Synchronize the existing `7e79b000ef1f1013a9c14ce15a81d8499ac1b0b5` preview with upstream `cb6df9d90170ec00d6563f07280bd617d8c466d3`; preserve its Session ownership and external Workspace contracts. This does not authorize a production rollout or a database migration.

The refreshed upstream Java SDK adds the Session model configuration digest and capability negotiation, so the old SDK payload can no longer be reused. Build Server and SDK from the same exact source revision and freeze unique private versions for both. The Java Maven versions remain distinct from the CLI package version.

## Integration decisions

Retain main's Store decomposition: the public facade preserves transaction entry points, admissions write Session ownership in the creation transaction, commands enforce immutable principals and receipt grants, and queries apply the same principal visibility rules. Keep the existing principal authority shared by these components. Preserve migration admission locks, Session-before-Turn ordering, native journal transactions, and refusal of legacy ownership rows.

Retain main's optional runtime modules and provider registry. The external provider owns configuration validation and acquisition/terminal/recovery proof. An `ExternalWorkspaceProvider` contracts SPI carries these three operations to server assembly without a compile dependency on the optional external implementation. The existing recovery gateway still delegates durable recovery to the Broker. Other providers do not gain external capabilities.

Keep the preview's verified-payload concurrent dispatch and terminal failed/cancelled retirement fixes. Preserve tenant/user/actor identity, exact registrations, original-worker proof, Session close isolation and fail-closed recovery. Do not implement additional tools, Shell support, implicit readiness or startup DDL.

The existing preview incorrectly restricted persisted result acknowledgements to SSH. Admit fully formed external Workspace requests to the same acknowledgement path, preserving settled results, native-reference checks, durable Session membership and binding generation. Only shared external Workspace isolation may omit the single-Harness isolation key. Project the current transient lifecycle authority into the transport Session without persisting it. Regression evidence must cover both shared members receiving their own acknowledgement, releasing one while retaining the other, and the existing lost-ACK, expired-claim and original-stop ordering cases.

Keep missing-principal rejection and authorization order unchanged. Model operations use the validated actor and authorized Session tenant; task views carry that authorized tenant through their existing page projections instead of dereferencing a nullable principal after authorization.

## Artifact and schema contract

Build a new unique private Server version, preserving third-party dependencies in its real consumer POM. The user authorized isolated macOS JDK 21 compilation for this run; after the shared local budget was exhausted, remaining checks and packaging moved to CI. Aggregate production modules only; union and deduplicate `META-INF/services` entries rather than overwriting providers. Freeze source, source revision, licenses, checksums and validation evidence. Never mutate old artifact bytes or publish the verification module.

The shared V1 baseline retains `ma_session_principal`, external registration receipts and shared dispatch classification, and includes upstream's three model configuration columns and all-null-or-all-present CHECK. Session creation writes ownership and encrypted model configuration in the same transaction, with replay preceding current capability and model endpoint admission. Development/preproduction catalogs must match the final artifact exactly. Legacy, partial and foreign catalogs remain refused; no Flyway repair, schema-version increment, automatic migration or mixed business catalog is allowed.

## Validation and acceptance

Select Session principal ownership, external materialization/ownership, recovery/retirement, external drain, shared dispatch, runtime dispatch, provider assembly and schema tests. Required MySQL 8.4 and real-process recovery evidence remains explicit if unavailable within the shared ten-minute local Java budget. Complete suites, Checkstyle and SpotBugs belong to CI.

Consumer acceptance additionally requires DataAgent compilation and its Java/MySQL gates, exact packaged schema and provider-resource checks, deployed source/artifact/database identity, two concurrent read-only Sessions sharing one Worker, cancel then continue, and closing one Session without affecting the other. Keep deployment and E2E status separate from source integration. A failed or unavailable gate is not acceptance.
