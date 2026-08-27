# Direct External Context Mem0 Presets

**Status:** Implemented in the private direct integration

**Date:** 2026-08-27

**Related designs:**
[Direct External Context Provider](./direct-external-context-provider.md),
[Direct External Context Mem0 Write](./direct-external-context-mem0-write.md),
[External Context Provider Extensions](./external-context-provider-extensions.md)

## Decision

The private Direct External Context integration uses one `mem0` provider type
with an administrator-selected, versioned built-in preset for Mem0-compatible
REST services. A preset owns the upstream wire contract; instance
configuration owns only the deployment endpoint, credential reference, fixed
scope, and timeout inherited from the direct profile.

This replaces provider types that combine a product name with one hard-coded
protocol, such as `polardb-mem0`. It does not expose a free-form API version,
request template, custom header map, JSONPath expression, or dynamic provider
module. The model-facing MCP contract remains `context_search({ query })` and,
only for an explicitly enabled version 1 configuration whose preset defines a
verified direct-import operation, `context_remember({ content })`.

The existing `mem0-platform-v3` configuration remains accepted for backward
compatibility. New deployments use `type: "mem0"`.

## Why a preset instead of `apiVersion`

One upstream product can mix operation versions. PolarDB Mem0 search and
direct import, for example, use different versioned paths. Authentication,
scope placement, result fields, write response semantics, and trailing-slash
requirements also vary independently of a numeric API version.

A preset therefore identifies one complete, verified contract. Published
preset identifiers are immutable. An incompatible upstream change receives a
new identifier rather than silently changing an existing mapping.

The first built-in presets are:

- `mem0-platform-v3`
- `mem0-server-rest-2026-08`
- `polardb-mysql-2026-08`

## Where preset immutability stops

Preset immutability binds this repository, not the deployed service. The
endpoint is operator-supplied and its build is not guaranteed: a Mem0-family
service can be self-hosted, packaged by a cloud vendor, or pinned to an old
release, and the stock Mem0 REST server carries no API version in its paths at
all. An administrator selecting a preset is therefore asserting which contract
they believe is deployed, and can be wrong.

The integration does not probe, negotiate, or fall back. It manages that
uncertainty three ways instead, none of which requires knowing the build:

- **Prefer a request both known shapes accept.** Where one fixed request is
  read identically by an older and a newer build, the preset sends that
  request. `body-and-filters` scope placement is the only current instance.
- **Never report an unverified write as `stored`.** A write outcome is claimed
  only from evidence in the response itself, so a build that ignores a request
  field degrades to `unknown` rather than to a false confirmation.
- **Make a mismatch legible to the operator.** Provider failures are written
  to the MCP server's stderr with the HTTP status, which separates a wire
  contract mismatch from an outage. The model-facing error stays opaque.

A preset that cannot be made safe this way documents the build it requires.

Selection is evidence-based on the operator's side too. `preset` is the only
field of a `mem0` block that is a judgement rather than a fact the
administrator holds, so the workspace ships a read-only probe that runs a
candidate preset against the endpoint and reports whether it works. Adding a
preset requires authoritative protocol evidence; choosing one should not
require less.

## Configuration

```json
{
  "version": 1,
  "timeoutMs": 5000,
  "provider": {
    "type": "mem0",
    "preset": "polardb-mysql-2026-08",
    "endpoint": {
      "origin": "https://memory.example.com",
      "basePath": ""
    },
    "credentialEnv": "MEM0_API_KEY",
    "scope": {
      "userId": "repository-memory",
      "agentId": "qwen-code"
    }
  }
}
```

`origin` contains only scheme and authority. `basePath` is a static optional
reverse-proxy prefix. They are validated separately so joining a preset path
cannot discard a configured prefix or reinterpret endpoint authority.
Embedded URL credentials, query strings, fragments, dot segments, encoded path
material, whitespace, and control characters are rejected from endpoint
configuration.

HTTPS is required by default. Loopback HTTP is accepted for local relays.
Non-loopback HTTP requires the explicit `allowInsecureHttp` flag and sends the
credential and memory content in cleartext; it is intended only for deployments
whose trusted private network is deliberately part of the boundary.

The preset declares which scope values it consumes and whether each value is
required or optional. Startup fails closed when a required value is missing or
when configuration supplies a value the selected preset does not use. Scope is
administrator input and never appears in tool arguments.

One absolute `QWEN_EXTERNAL_CONTEXT_CONFIG` path is loaded once per MCP child.
The path, file contents, endpoint, preset, scope, and credential-to-corpus
binding must remain immutable for the whole Qwen session, including MCP child
restarts. Switching any of them requires a new Qwen session and a new config
path.

## Bounded preset contract

Built-in presets select only reviewed constants:

- `Authorization: Token`, `Authorization: Bearer`, or `X-API-Key`
- one static POST search path
- `top_k` or `limit` as the result-limit field
- `user_id`, `agent_id`, and `app_id` placed at the JSON root, under
  `filters`, or omitted
- a closed set of fixed search options such as `threshold` and `rerank`
- a `results` response collection with reviewed identifier and content fields
- an optional static direct-import path and one reviewed response mapping

The engine always sends at most five as the provider limit and retains at most
five valid results. It does not retry, redirect, probe alternate paths, or
fallback between presets. A malformed item is dropped independently; a
malformed response envelope fails the request.

Adding a preset requires authoritative protocol evidence plus request and
response contract tests. A service that cannot fit this grammar uses its own
local or remote MCP Extension under the External Context Provider Extensions
design instead of expanding this configuration into a programming language.

## Initial mappings

### Mem0 Platform V3

- Search: `POST /v3/memories/search/`
- Authentication: `Authorization: Token`
- Scope: required `appId` under `filters.app_id`
- Limit: `top_k`
- Direct import: `POST /v3/memories/add/`, `infer: false`
- Write response: `PENDING` plus `event_id` is `accepted`; only
  `SUCCEEDED` is `stored`

The legacy `mem0-platform-v3` configuration remains a fixed-endpoint shorthand
for this mapping.

### Mem0 Server REST 2026-08

- Search: `POST /search`
- Authentication: `X-API-Key`
- Scope: required `userId` and optional `agentId`, sent both at the request
  root and under `filters`
- Limit: `top_k`
- Direct import: `POST /memories`, `infer: false`
- Write response: a valid `results[].id` whose echoed `memory` matches the
  submitted content is `stored`; otherwise `unknown`

This mapping follows the stock `mem0ai/mem0` REST server — the FastAPI service
in that repository's `server/`, which is what "self-hosted Mem0" means here.
The identifier avoids "OSS" because that abbreviation names an object storage
service in some of the clouds these deployments run in.

The server moved session identity from the request root into `filters` and
kept reading both, so the dual placement is one request that both shapes
resolve to the same scope. Builds predating that change reject a
`filters`-only search outright; builds predating `infer` silently run fact
extraction instead, which the write-result content check catches.

Bearer-authenticated deployments need a separately verified preset rather than
a per-instance authentication override.

### PolarDB MySQL 2026-08

- Search: `POST /v2/memories/search`
- Authentication: `Authorization: Token`
- Scope: required `userId` under `filters`, optional top-level `agentId`
- Limit: `top_k`
- Direct import: `POST /v1/memories`, `infer: false`
- Write response: a valid `results[].id` is `stored`; otherwise `unknown`

An `event_id` alone is never treated as proof of storage. If a later PolarDB
contract documents asynchronous event polling, that behavior requires a new
preset and write design rather than changing this preset in place.

The identifier names the contract, not a cloud. PolarDB Mem0 is offered by
more than one provider, and a preset scoped to one vendor would read as
inapplicable to an operator running the same contract elsewhere. The mapping
was verified against an Aliyun deployment; an operator on another provider
should confirm it with the preset probe before relying on it, which is the
same evidence this repository asks for when a preset is added.

## Relationship to provider Extensions

This provider is a bounded compatibility feature inside the already private
`integrations/external-context` process. It is not a public provider registry.
Third-party teams still own independently distributed integrations through
MCP Extensions. The direct preset path is appropriate only for Mem0-family
contracts that Qwen maintainers explicitly verify and agree to maintain.

Operators must enable either this direct server or another Mem0 Extension for
one corpus, not both. Exposing two `context_search` tools for the same corpus
would make provider selection model-controlled and could duplicate queries.

## Verification

The implementation must prove:

- strict configuration parsing and fail-closed preset/scope validation
- safe `origin` plus `basePath` joining
- exact authentication, path, scope, and limit mapping for every preset
- per-item response normalization and the five-result cap
- conservative synchronous versus asynchronous write outcomes
- refusal to report `stored` when the provider echoes rewritten content or a
  delete event
- no retry on search or write failures
- loadability of the shipped PolarDB and Mem0 server examples
- compatibility of the existing `mem0-platform-v3` configuration
- that the preset probe is read-only, never renders the credential, and
  refuses to conclude anything from an empty corpus
