# Managed Agent public Java client

[English](2026-11-24-managed-java-client.md) | [简体中文](2026-11-24-managed-java-client.zh-CN.md)

## Context and scope

A Java service integrating a standalone Managed Agent needs session discovery, execution, approval and asset publication. The Java SDK already covers managed extensions through `ManagedExtensionsClient`. Its daemon and Hosted Harness transports target different API surfaces.

Add `ManagedAgentClient` to `qwencode-sdk`. Cover AgentDefinition and Workspace access, session creation and listing, lifecycle operations, input and cancellation, Turns and Items, approval, recovery and resource catalogs. Reuse `ManagedExtensionsClient` for package publication and binding. Server routes and schemas stay under the existing OpenAPI contract. Workspace-filtered session listing requires a server API change and is outside this client change.

## Design

Use the public `/v1/agents` routes and JSON field names directly. Keep structured request and response objects as maps, as the extensions client does, to preserve optional fields and operation variants. Give each operation a named method. The caller supplies tenant, actor, signing key and mutation idempotency keys. Share the signed HTTP transport with the existing extension client, preserve base path prefixes, and surface HTTP outcomes without automatic retries.

Expose SSE as a closeable reader backed by the existing frame parser. Ordinary frames carry the event sequence. Return the resync frame without advancing the cursor so the caller can read Items and open a new stream at the rebuilt snapshot sequence. A submission receipt confirms admission and exposes the identifiers needed to observe settlement.

## Validation

Use a loopback HTTP server to check signed requests, query encoding, wire fields, status and error handling, and SSE resume behavior. Run existing extension tests alongside the new tests to check that the transport extraction preserves behavior.
