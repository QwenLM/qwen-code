# Session model configuration at creation

[English](managed-session-model-config.md) | [简体中文](managed-session-model-config.zh-CN.md)

## Problem and current behavior

Hosted execution resolves model connections from operator CLI settings. WebShell
can select a registered model ID, while the public creation API has no model
selection field. An application cannot supply its own model connection for one
Session without changing the Harness deployment.

## Proposed behavior

Public creation accepts optional `model_config`; WebShell creation accepts
`modelConfig`. Both use the same object: `protocol`, `model`, `base_url`,
`api_key`, and optional `generation_config`. Supported key-based protocols are
`openai`, `openai-responses`, `anthropic`, and `gemini`. Generation parameters are
explicitly validated sampling parameters; they cannot replace connection fields.
OAuth, ADC, arbitrary headers, environment-variable expansion and credential
rotation are outside this change. No browser credential editor is added.

The complete connection is immutable for the Session. An explicit `modelId` and
complete configuration cannot be supplied together. Existing Sessions and
requests without the new field retain their behavior. A configured Session
cannot switch to the host catalog; create another Session to use another
connection. Children inherit the parent's connection.

## Control plane and persistence

Validate configuration before admission, include its canonical digest in the
creation idempotency digest, and persist the encrypted configuration in the same
transaction as the Session and initial Turn. Reuse `SecretProtector`, binding
encryption to tenant and Session identity. Store only the ciphertext, key ID and
configuration digest on the Session. Keep credentials out of API responses,
public events, receipts and journal resources.

The deployment must configure permitted model base URLs through
`qwen.managed-agent.model-config-base-urls` and provide a `SecretProtector`.
The default empty list disables new inline configurations. URLs must match a
permitted endpoint and cannot contain user information, query strings or
fragments. This policy controls the new caller-selected outbound connection;
it does not register model IDs or credentials in the Harness.

Update the unreleased shared V1 schema in place. Existing development databases
must be recreated according to the repository's schema policy; do not modify
running user databases. Copy and re-encrypt configuration when admitting a child
Session. Include the new columns in schema inventory and recovery projections.

## Private execution protocol

Advertise `session-model-config/1`. Carry only `modelConfigDigest` in private
create/load requests and persist it in the managed definition. Check it on
resident reuse and cold load. An older Harness must refuse attachment rather
than execute with deployment defaults.

Add a Session Store read protected by tenant, workspace, writer token, writer ID
and generation. It returns the configuration only for the matching digest and
current execution owner, with `Cache-Control: no-store`. Lifecycle reads retain
the existing lifecycle authority checks. Missing, changed or unavailable
configuration fails closed. Reading secrets does not create journal resources.

## Harness configuration isolation

Resolve configuration through the authenticated store only when a digest is
bound. Inject it into each new execution Config through a host-only option.
Bypass environment and user provider resolution for this connection, remove
ambient model registries, auxiliary model selectors and fallbacks, and preserve
all unrelated operator settings. Do not change process environment or settings
files. Do not look up the supplied model in the host registry.

Apply the same binding to normal Turns, approval continuations, workflow Turns,
context compression and lifecycle model Hooks. Existing provider-pin checks
continue to protect resumed requests and child execution. A child request for a
different route must not reuse the configured connection's credentials.

## Multi-tenant deployment boundary

The intended caller is a trusted application service that authenticates tenant
and actor identity before supplying a connection. The platform signing key must
remain with that service or its trusted gateway. Tenant/Session-bound storage
and writer authorization provide application-level isolation; a shared Harness
process remains in the same operational trust domain.

The endpoint allowlist is deployment-wide. This change does not grant or check
tenant-specific model permissions. Deployments with different tenant policies
must enforce allowed endpoints, protocols and generation limits in the trusted
caller. Tenant-level quotas and outbound network restrictions remain deployment
responsibilities.

Each Session retains its own encrypted, immutable credential snapshot, including
after child inheritance. Provider credential revocation can make existing
Sessions unable to execute; changing a key requires a new Session under this
contract. A future tenant-owned connection/secret reference would need explicit
version, rotation and recovery semantics. Applications that already manage
credentials can continue supplying them without a second model registry here.

## Affected components

- Public/WebShell contracts, creation services and SQL Session admission.
- Session configuration validation, encrypted persistence and owner-only read.
- Java SDK create/load requests and single/pool Harness connectors.
- Hosted create/load definitions and all model execution entry points.
- CLI configuration construction, OpenAPI and generated WebShell types.
- Shared schema inventory, focused regression and process integration tests.

## Validation and acceptance

Use isolated fake providers and synthetic keys. Create two concurrent Sessions
with the same model ID but different endpoints, keys and sampling parameters;
verify each provider receives only its own connection. Cover omitted configuration,
invalid protocols/fields/URLs, idempotency replay and conflict, encrypted SQL
storage, read denial for wrong tenants/writers, and absence of secrets in public
responses and journal resources. Reattach after Harness restart and verify the
same binding. Cover workflow, compression, Hooks and child inheritance.

Run the global CLI baseline before implementation, then focused Java/SDK and
TypeScript tests, build, typecheck and bundle. Java local verification shares the
module's ten-minute budget; unavailable MySQL or process checks remain explicit
CI acceptance gaps. Finish with two clean self-audit passes and independent
review. This document describes the proposed implementation, not completed
acceptance.

## Open questions

None required for the initial immutable, API-key-based connection. Updating
credentials on an existing Session requires a separate revision and recovery
contract.
