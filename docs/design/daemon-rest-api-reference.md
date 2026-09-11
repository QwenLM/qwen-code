# Daemon REST API Reference

[English](daemon-rest-api-reference.md) | [简体中文](daemon-rest-api-reference.zh-CN.md)

## Status

Implemented in this change.

## Problem

`qwen serve` has a detailed HTTP protocol document and a shorter integration
guide, but it does not publish a machine-readable API definition. Integrators
must combine prose, route handlers, capability documentation, and TypeScript
SDK methods to answer basic interface questions. Eight routes in the curated
REST integration surface also lack dedicated protocol sections.

## Goals

- Publish an OpenAPI 3.1 definition for the 25 routes that the REST integration
  guide presents as the supported integration surface.
- Give every operation its request parameters or body, success and common error
  responses, capability requirement, ownership scope, stability, and
  TypeScript SDK equivalent when one exists.
- Complete the eight missing protocol sections and make the quickstart commands
  directly runnable.
- Fail CI when the guide, OpenAPI paths, protocol sections, or registered
  Express routes drift apart.
- Produce artifacts that `qwen-code-docs` can render as a dedicated Daemon REST
  API Reference.

## Non-goals

- The daemon's Web Shell-only and conditional internal routes are not promoted
  to a public integration contract.
- This change does not add an `/openapi.json` runtime route or alter daemon
  request handling.
- This change does not claim support for a multi-user security-principal model,
  container orchestration, or an unvalidated reverse-proxy deployment.
- ACP-over-HTTP and WebSocket APIs remain in their existing references.

## Public surface

The public REST reference is the 25-operation set already named by
`docs/developers/rest-api-integration.md` and guarded by
`rest-integration-docs-contract.test.ts`. It covers discovery, session
lifecycle, prompting and SSE, permissions, and read-only workspace context.
The current daemon registers many additional routes for first-party UI and
conditional features; documenting those in OpenAPI would incorrectly turn an
implementation surface into a compatibility promise.

## Artifacts

### OpenAPI definition

`docs/developers/daemon-rest-api.openapi.json` is the checked-in OpenAPI 3.1
contract. JSON is used so the existing Node/Vitest toolchain can parse it
without another dependency or a second generated source representation. Each
operation contains:

- a stable `operationId`, capability group, and summary;
- path, query, and header parameters;
- request and response schemas with their relevant wire constraints;
- `x-qwen-capability`, `x-qwen-scope`, `x-qwen-stability`, and
  `x-qwen-sdk-method` metadata;
- bearer authentication on every operation; the loopback-only `/health`
  exemption is recorded in that operation's description, not as an anonymous
  `security` alternative;
- `text/event-stream` plus the shared event envelope on the SSE operation.

The specification describes the current wire contract; the TypeScript SDK
remains the typed client implementation and does not become generated code in
this change.

### Human-readable reference

`docs/developers/daemon-rest-api-reference.md` explains how to consume the
OpenAPI artifact and provides one capability-grouped operation index. Detailed
behavior stays in `qwen-serve-protocol.md`; the reference links there instead
of copying thousands of lines of lifecycle prose.

The integration guide remains task-oriented. It links to the reference and
keeps the runnable lifecycle walkthrough.

### Protocol completion

The protocol document gains dedicated sections for:

- `GET /session/:id/status`
- `GET /session/:id/export`
- `GET /session/:id/pending-prompts`
- `POST /session/:id/permission/:requestId`
- `GET /workspace/tools`
- `GET /stat`
- `GET /list`
- `GET /glob`

## Source-of-truth and drift control

Runtime handlers remain authoritative for behavior. The OpenAPI definition is
the authoritative portable interface artifact. The existing docs contract test
is extended to compare exact HTTP method/path pairs across:

1. the integration guide;
2. the OpenAPI document;
3. dedicated protocol headings; and
4. registered Express route literals.

The test also requires every OpenAPI operation to declare the Qwen metadata,
authentication posture, and at least one success response. This catches route
renames and incomplete new reference entries without loading the full daemon.
Detailed field semantics still require ordinary review because the handlers do
not currently use a shared runtime schema system.

## Documentation-site handoff

After this change merges, `qwen-code-docs` will receive a separate change that
copies the OpenAPI artifact into the static site, adds the reference navigation
entry, and renders it. This repository owns the API contract; the site
repository owns presentation, translation, and deployment.

## Security and compatibility

- No server behavior or authentication default changes.
- Binding to a non-loopback address is documented next to the launch command as
  requiring TLS at the daemon or a validated TLS terminator.
- Bearer values stay in an environment variable and curl header file
  descriptor, not process arguments.
- The reference explicitly preserves ownership distinctions such as
  process-global, selected-runtime, persisted-workspace, live-session-owner,
  and legacy-primary routes.

## Validation

- Run the focused REST documentation contract test from `packages/cli`.
- Parse and validate the OpenAPI JSON through the contract test.
- Run formatting and the relevant package type/build checks once after all
  implementation is complete.
- Build the documentation site in the follow-up repository change.

## Acceptance criteria

- All 25 integration operations appear exactly once in OpenAPI and have a
  dedicated protocol section.
- The integration guide contains no "no dedicated reference section" caveat.
- Its minimal flow assigns `SID`, separates the SSE terminal, and shows how a
  `permission_request` supplies `REQUEST_ID`.
- The bridge link resolves outside the documentation-site route space and the
  non-loopback example carries a TLS warning.
- CI fails for a missing, renamed, or metadata-incomplete referenced operation.
- No additional daemon route is presented as public by this change.
