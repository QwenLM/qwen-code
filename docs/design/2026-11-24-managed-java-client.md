# Managed Agent public Java client

[English](2026-11-24-managed-java-client.md) | [简体中文](2026-11-24-managed-java-client.zh-CN.md)

## Context and scope

A Java service integrating a standalone Managed Agent needs session discovery, execution, approval and asset publication. The Java SDK already covers managed extensions through `ManagedExtensionsClient`. Its daemon and Hosted Harness transports target different API surfaces.

Add `ManagedAgentClient` to `qwencode-sdk`. Cover AgentDefinition and Workspace access, session creation and listing, lifecycle operations, input and cancellation, Turns and Items, approval, recovery and resource catalogs. Reuse `ManagedExtensionsClient` for package publication and binding. Server routes and schemas stay under the existing OpenAPI contract. Workspace-filtered session listing requires a server API change and is outside this client change.

## Design

Use the public `/v1/agents` routes. Expose typed workspace and session operations through `ManagedAgentClient.workspaces()` and `sessions()`. A request builder names the creation fields and requires the Agent ID. Inputs, Skills, model configuration and extension pins have Java types. Pagination exposes typed entries, the next cursor and, for Items, the snapshot sequence. Session, Turn, Turn admission, and command operation have distinct types. Events expose common fields and text deltas directly. Status and event discriminators accept future server values.

Expose typed extension import, published pins, settings revisions and session configuration through `extensionPackages()`. A published pin can select a settings revision explicitly. Surface the Skill resources, Hook catalog and MCP catalog on the session client. AgentDefinition administration and advanced extension operations use the existing Map API. Published SNAPSHOT callers can continue to call the existing methods. Response metadata and polymorphic event data retain their JSON representation. The SDK omits unset request fields and preserves an explicit empty extension selection. Wire field names and capability checks are owned by the existing contract and server.

The caller supplies tenant, actor, signing key and mutation idempotency keys. All entry points share the signed HTTP transport, preserve base path prefixes and surface HTTP outcomes without automatic retries.

Expose SSE as a closeable reader backed by the existing frame parser. Ordinary frames carry the event sequence. Return the resync frame without advancing the cursor so the caller can read Items and open a new stream at the rebuilt snapshot sequence. A submission receipt confirms admission and exposes the identifiers needed to observe settlement.

## Validation

Compile with Java 11. Use loopback HTTP fixtures to verify request signatures, query encoding, typed pages and receipts, omitted versus empty values, server errors, and SSE terminal and resync events. Run the existing client and extension tests for compatibility.
