# API leader with local workers

## Scope

Reuse native subagents and Agent Team model routing. A leader stays on its API
provider while a named worker selects a separately registered local model.
No new orchestrator, account switching, OAuth integration, or terminal backend.

## Credential boundary

An auth type identifies a protocol, not an endpoint or account. Two `openai`
models can address unrelated services.

- A model's explicit `envKey` is authoritative. If unset or empty, the worker
  must fail validation instead of inheriting the leader's key.
- An explicit per-agent key takes precedence over the model's `envKey`.
- Changing endpoints must not carry the leader's key or custom headers into
  the worker. A worker needs its own credential configuration.
- Preserve implicit credential inheritance for workers on the same endpoint
  and auth type with no separate credential declaration.
- Keep the leader's configuration unchanged. Model-specific request options
  for a different endpoint come from the worker's registered configuration.

Local servers without authentication still use a dedicated dummy key through
their own environment variable. This is explicit configuration, not a special
case that disables validation for localhost.

## Existing consumers

The shared content-generator builder is used by ordinary subagents,
InProcessBackend (Agent Team and Arena), forked agents, and BaseLlmClient's
per-model requests. Tests must cover both the shared builder and actual
leader/worker requests. InProcessBackend rejects failed generator creation
before starting a worker. BaseLlmClient's optional fallback for auxiliary model
queries is unchanged; it is not the named-worker execution path.

## Verification

Use two loopback mock servers and fictional keys. Check independent model IDs,
endpoints and authorization headers, successful delegation and return, missing
worker credentials, and an unchanged leader. No real inference is required.
Include regression coverage for explicit keys, custom headers, same-endpoint
inheritance, and registered versus explicit endpoint overrides.

## Limitations and review

Use distinct model IDs for local and remote registrations: the current agent
selector contains auth type and model ID, not the endpoint. Endpoint-qualified
selectors and Codex OAuth are separate work.

This is a small core credential change and requires the maintainer review gate
described in AGENTS.md. It does not claim complete isolation of arbitrary
process environment, proxies, tools, or external provider SDKs.
