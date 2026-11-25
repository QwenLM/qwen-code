# Managed Agent public Java client

[English](2026-11-24-managed-java-client.md) | [简体中文](2026-11-24-managed-java-client.zh-CN.md)

## Context and scope

A Java service integrating a standalone Managed Agent needs session discovery, execution, approval and asset publication. The Java SDK already covers managed extensions through `ManagedExtensionsClient`. Its daemon and Hosted Harness transports target different API surfaces.

Add `ManagedAgentClient` to `qwencode-sdk`. Cover AgentDefinition and Workspace access, session creation and listing, lifecycle operations, input and cancellation, Turns and Items, approval, recovery and resource catalogs. Reuse `ManagedExtensionsClient` for package publication and binding. Server routes and schemas stay under the existing OpenAPI contract. Workspace-filtered session listing requires a server API change and is outside this client change.

## Design

The public methods on `ManagedAgentClient` use Java request and response types for structured data. Keep the existing method names and scalar arguments. Agent creation and update share a definition request and return the same saved revision summary. Session creation, input blocks, approval responses and MCP management commands use typed requests. Use a common typed page for ordinary lists and retain the extra fields on Workspace, Items and event pages.

Expose fixed fields on the responses, including nested data. Keep caller-defined Agent metadata, tool-defined JSON Schema and unknown event data as JSON. An MCP tool schema exposes common keywords alongside its complete JSON. Session title, known event fields and resource descriptors have named accessors. The current server contract determines request field names, omission rules and status codes.

The caller supplies tenant, actor, signing key and mutation idempotency keys. Share the signed HTTP transport with the existing extension client, preserve base path prefixes, and surface HTTP outcomes without automatic retries. The existing `extensions()` accessor returns the extension client. SDK consumers of the earlier Map signatures recompile against the typed methods and migrate to builders and getters.

Expose SSE as a closeable reader backed by the existing frame parser. Ordinary frames carry the event sequence. Return the resync frame without advancing the cursor so the caller can read Items and open a new stream at the rebuilt snapshot sequence. A submission receipt confirms admission and exposes the identifiers needed to observe settlement.

## Validation

Use Java 11 compilation and a loopback HTTP server to check typed requests and responses, signed wire fields, omission rules, query encoding, status and error handling, and SSE resume behavior. Verify a typed create, query and message workflow against a standalone server. Run the existing extension tests alongside the client tests.
