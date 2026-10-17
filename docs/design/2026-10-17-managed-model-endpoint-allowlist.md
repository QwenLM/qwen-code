# Managed model endpoint allowlist (`model.allowedBaseUrls`)

[English](2026-10-17-managed-model-endpoint-allowlist.md) | [简体中文](2026-10-17-managed-model-endpoint-allowlist.zh-CN.md)

## Status and scope

Implemented in PR #14231 (fix rounds 1–3). `model.allowedBaseUrls` is a managed allowlist of model endpoint base URLs. It is a settings-only mechanism: no new CLI flags, no new protocols. Out of scope: per-request endpoint policy enforcement inside the SDK, and generalizing workspace non-overriding to the whole `modelProviders` map (see Open questions).

## Problem

Before this design, the allowlist filtered only model registration. Outbound endpoints were resolved through a separate path (`resolveCliGenerationConfig` → `resolveModelConfig`) without consulting the policy, so a managed deployment could still dial an off-list endpoint via `--model`, `--openaiBaseUrl`, env vars, `security.auth`, or the preserve/capture credential paths. Additional gaps: a workspace (trusted repository) could replace an operator-configured list; a non-array value crashed startup with a raw `TypeError`; degenerate entries (e.g. `"https://"`) silently matched every HTTPS URL; the qwen-oauth empty-list pin was honored from any scope without a warning; and the advisor-model error never named the responsible setting while interpolating the raw selector (credentials included) into stderr.

## Matching semantics

Matching is URL-semantic via `new URL()`:

- Scheme and host are compared case-insensitively (URL origin normalization); the path is case-sensitive.
- An explicit default port counts as absent: `https://corp.example:443/v1` matches entry `https://corp.example`, because URL origin elides default ports. Non-default ports (`:8443`) must match exactly.
- Path matching is a path-boundary prefix: entry `https://corp.example` matches `https://corp.example/v1` but not `https://corp.example.evil.com` (different host) and not a sibling that merely shares a string prefix. Trailing slashes are ignored.
- Non-parseable values fall back to the legacy string comparison (trim + boundary prefix), so partially valid entries degrade to the old behavior instead of matching everything.
- A model without an explicit `baseUrl` is judged against its protocol default endpoint (the one the SDK would dial). An empty list blocks everything (fail closed); `undefined` means no policy.

## Enforcement points

The same predicate (`isBaseUrlAllowed`) gates every place an outbound model endpoint becomes effective:

1. **Registration** — `ModelRegistry` drops off-list models at registration (picker/`--model` list offer only allowed endpoints) and records each drop (`getAllowlistDroppedModels`).
2. **Resolution** — `resolveModelConfig` throws a `FatalConfigError` naming `model.allowedBaseUrls` when the effective endpoint (explicit `baseUrl`, or the protocol default when none is set) is off-list. This closes the `--model`/`--openaiBaseUrl`/env/`security.auth` escape.
3. **Credential restore/capture** — `ModelsConfig` (preserve branch of `syncAfterAuthRefresh`, `detectAndCaptureRuntimeModel`) refuses off-list endpoints, so stored credentials cannot re-admit an endpoint the registry never registered.
4. **Sibling `ModelsConfig` sites** — voice model source, daemon voice config, workspace provider status, fast-model ACP check, and the provider-install conflict probe all receive the same policy (`undefined` = no policy; never coerced to `[]`).
5. **Live Voice** — the realtime wss path reads raw settings and never touches the registry, so it applies the policy to the final endpoint (wss judged in its HTTPS form). A rejected route throws; it cannot fall through to the free-standing `liveVoice.endpoint`. The existing DashScope-host validation remains as an additional control.

## Input validation

- `model.allowedBaseUrls` must be an array. A non-array value is a startup `FatalConfigError` naming the key (the CLI validates before construction; the registry also fails closed defensively).
- Entries must be non-empty strings that parse as URLs with a hostname. Non-string, empty, unparseable, or hostname-less entries (e.g. `"https://"`) are warned about and skipped — a degenerate entry can never become a match-everything wildcard.
- The list is boot-frozen like `providerProtocol`: reloads preserve the policy.

## Scope precedence and the qwen-oauth pin

- The system scope takes precedence over user; a **workspace-scope list is honored only when no User, System, or SystemDefaults scope defines one** (the setting is in `WORKSPACE_NON_OVERRIDING_SETTINGS`, the same mechanism as `security.allowedHttpHookUrls`), with a warning when a workspace value is stripped.
- The built-in Qwen OAuth models are hard-coded. They can be disabled only by the **operator-scope pin**: an explicitly empty model list for a provider id that resolves to `qwen-oauth` through the effective `providerProtocol` mapping, in System, User, or SystemDefaults settings. A workspace-scope pin is stripped from the merge (a repository must not disable personal Qwen login for its users), and both the stripped workspace pin and an active operator pin produce load-time warnings.
- When the pin is active, Qwen OAuth resolution fails closed with a `FatalConfigError` instead of falling back to the default built-in model, so `--model` and a persisted `model.name` cannot re-admit the dynamic endpoint.
- Note: setting `model.allowedBaseUrls` also disables the built-in Qwen OAuth models, because their endpoint is discovered dynamically at login and cannot be listed. A deployment that needs personal Qwen login must neither set the allowlist nor pin the list.

## Advisor-model diagnostics

The advisor-model startup error names `model.allowedBaseUrls` when the allowlist is the reason the model is unavailable (off-list endpoint, or model dropped from the registry), and the selector is sanitized for display: an endpoint-qualified selector (`modelId\0baseUrl`) is shown with credentials stripped, never raw.

## Validation plan and acceptance criteria

- Unit/behavioral tests per enforcement point, each with a named mutant that turns the test red: default-port matching, degenerate entry skip, non-array startup error, workspace list non-overriding, workspace pin strip, mapped-id pin, qwen-oauth `--model`/persisted-name fail-closed, resolution gate with protocol defaults, Live Voice route gate, advisor message content, and the `loadCliConfig` → `Config` → `ModelsConfig` hand-off.
- Full affected suites (core + CLI `tsc`/eslint/vitest) in Docker per the repository test policy.

## Open questions and follow-ups

- **Dynamic Qwen OAuth endpoint:** any allowlist disables the built-in Qwen OAuth models (the dynamic endpoint cannot be listed). This is documented, not changed; making the built-ins overridable by allowlist is a separate design decision.
- **Generalized workspace non-overriding:** a trusted workspace can still replace a non-empty operator `modelProviders` list for non-qwen-oauth provider ids with an empty (or other) list. Generalizing the pin strip to all provider ids is a follow-up with broader behavior impact.
- The Live Voice path additionally restricts endpoints to DashScope hosts; a managed deployment that wants a non-DashScope realtime endpoint needs a separate design decision.
