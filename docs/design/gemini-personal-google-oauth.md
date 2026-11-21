# Gemini Personal Google OAuth and Code Assist

[English](gemini-personal-google-oauth.md) | [简体中文](gemini-personal-google-oauth.zh-CN.md)

**Status:** Implementation and focused offline verification complete — live Google account acceptance pending. This worktree is not a merged or released state.
**Date:** 2026-11-21

## 1. Problem and current state

Qwen Code already uses `@google/genai` request and response types throughout its core and sends native Gemini Developer API and Vertex AI requests through `LlmContentGenerator`. That path accepts a Gemini API key, a Vertex API key, or Vertex Application Default Credentials.

It does not provide the Gemini CLI-style personal Google sign-in flow. There is no personal Google OAuth `AuthType`, OAuth callback flow, Google refresh-token store, Code Assist onboarding, or Code Assist `ContentGenerator`.

An OAuth access token cannot simply be inserted into the existing `apiKey` field. Personal Google sign-in uses the Code Assist service and its project/tier lifecycle, not the Gemini Developer API key endpoint.

The requested behavior is personal Google sign-in with the same general Code Assist eligibility and quota path as Gemini CLI. The server determines eligibility and quota; this feature cannot grant quota to an ineligible account.

### Reference evidence

- Qwen Code routes `gemini` and `vertex-ai` to `GoogleGenAI` in `packages/core/src/core/contentGenerator.ts` and `packages/core/src/core/llm-content-generator/`.
- Gemini CLI was reviewed at upstream HEAD `eecccfcd5aff25de5e78135ca20f7abe3f566955`:
  - [`oauth2.ts`](https://github.com/google-gemini/gemini-cli/blob/eecccfcd5aff25de5e78135ca20f7abe3f566955/packages/core/src/code_assist/oauth2.ts)
  - [`setup.ts`](https://github.com/google-gemini/gemini-cli/blob/eecccfcd5aff25de5e78135ca20f7abe3f566955/packages/core/src/code_assist/setup.ts)
  - [`server.ts`](https://github.com/google-gemini/gemini-cli/blob/eecccfcd5aff25de5e78135ca20f7abe3f566955/packages/core/src/code_assist/server.ts)
  - [`converter.ts`](https://github.com/google-gemini/gemini-cli/blob/eecccfcd5aff25de5e78135ca20f7abe3f566955/packages/core/src/code_assist/converter.ts)
- A read-only inspection of the local Antigravity 2.33.0 `language_server` binary confirmed the corresponding OAuth scopes, `cloudaicompanionProject`, `user_prompt_id`, keychain token handling, and Code Assist methods. It is supporting evidence only, not a copyable source or API contract.
- The user selected the Gemini CLI public installed-app OAuth client. The Antigravity OAuth identity will not be reused.

## 2. Goals and scope boundaries

### In scope

1. Interactive personal Google sign-in and sign-out.
2. Offline access, refresh-token persistence, access-token refresh, and cached-credential startup.
3. Code Assist `loadCodeAssist`, `onboardUser`, and long-running-operation handling.
4. Server-selected personal tier and project behavior, including the managed project for the free tier.
5. Native text generation and streaming through Code Assist while preserving Qwen Code's existing tools, history, cancellation, logging, and retry behavior.
6. Both interactive CLI authentication surfaces: Ink and OpenTUI.
7. Web Shell authentication through the daemon and a dedicated ACP-hosted Google flow, including authorization URL display, manual-code submission, cancellation, and target-session model activation.
8. Non-interactive use with existing cached credentials, with a clear failure instead of an unexpected browser prompt when credentials are absent.
9. Built-in `gemini-4-argon` (default), `gemini-4-carbon`, and `gemini-4-hydrogen` routes identified in the local Antigravity binary, plus `gemini-2.5-pro` as a stable compatibility route.

### Out of scope for this change

- Antigravity OAuth identity, proprietary UI, AICode-specific routing, or product behavior.
- Vertex AI or Gemini Developer API changes.
- Dynamic model experiments, preview-entitlement resolution, and a remote model catalog.
- Paid-credit auto-enablement, overage billing, credit balances, and a dedicated quota dashboard.
- Admin controls, plugin OAuth, MCP OAuth, enterprise gateway behavior, and service-account impersonation.
- Code Assist embeddings. `embedContent` must fail explicitly rather than silently switch providers.
- A new operating-system keychain backend. Version one uses a protected file store; keychain support can be considered separately.
- Reusing or generalizing Qwen OAuth's credential files or `SharedTokenManager`.

## 3. Proposed architecture

Add an independent `AuthType.GOOGLE_OAUTH = 'google-oauth'` and a dedicated Code Assist generator:

```text
/auth or cached startup
        ↓
Google OAuth2Client + isolated Google credential store
        ↓
setupUser: loadCodeAssist → optional onboardUser → project/tier
        ↓
CodeAssistContentGenerator
        ↓ existing LazyContentGenerator → LoggingContentGenerator
LlmChat, tools, history, cancellation, retries, and usage reporting
        ↓
https://cloudcode-pa.googleapis.com/v1internal
```

This branch must not enter the existing `USE_GEMINI` / `USE_VERTEX_AI` branch. It must not accept a generic provider `baseUrl` or API key. Code Assist project and model behavior is owned by the new provider adapter.

The existing internal `GenerateContentParameters` and `GenerateContentResponse` types remain the boundary. No OpenAI conversion is introduced.

## 4. Component design

### 4.1 Personal Google OAuth

Use `google-auth-library`'s `OAuth2Client` with the Gemini CLI public installed-app client configuration selected by the user. Preserve the upstream notices that this is installed-application configuration; refresh tokens and access tokens are the actual secrets and must never be logged.

Requested scopes:

- `https://www.googleapis.com/auth/cloud-platform`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`

Interactive flows:

- Browser-capable terminal: bind only to loopback, use an available port and `/oauth2callback`, generate an unpredictable `state`, request offline access, open the authorization URL, and redirect the browser to a success or failure page after completion.
- Interactive terminal without browser launch: use the Gemini CLI authorization-code redirect and PKCE S256, display the authorization URL, and accept the code from the user.
- Non-interactive/headless use and derived agent generators: load and refresh cached credentials only. Do not open a browser or wait for an authorization code.

Validate callback path and `state`, support cancellation, close the temporary HTTP server on every terminal path, and bound interactive authorization with the upstream five-minute timeout. Account metadata may use the existing `google_accounts.json` path, but tokens must use a new `google_oauth_creds.json` file and a separate lock name.

Persist refreshed tokens from the OAuth client's token event. Cache writes must preserve the existing refresh token when a refresh response omits it, use atomic replacement, and set mode `0600`. Never write Google credentials to Qwen's `oauth_creds.json` or `oauth_creds.lock`.

### 4.2 Code Assist user setup

The default endpoint is `https://cloudcode-pa.googleapis.com` with API version `v1internal`. `CODE_ASSIST_ENDPOINT` and `CODE_ASSIST_API_VERSION` may be used for controlled tests and compatible environments; generic `modelProviders` and `providerProtocol` cannot redirect personal OAuth tokens to another endpoint.

The setup sequence follows Gemini CLI:

1. Read `GOOGLE_CLOUD_PROJECT`, then `GOOGLE_CLOUD_PROJECT_ID`; reject a purely numeric project number with a targeted error.
2. Call `loadCodeAssist` with the Gemini plugin metadata.
3. If a current or paid tier exists, select paid tier first, then current tier, and obtain the project from the response or explicit environment configuration.
4. Otherwise select the default allowed tier and call `onboardUser`.
5. For `free-tier`, omit the user project so Code Assist assigns its managed project. For other tiers, pass the configured project when required.
6. Poll an unfinished operation every five seconds, honor cancellation, and extract the resulting project ID.
7. Surface validation-required, ineligible-account, region/age restriction, and missing-project errors without silently changing auth type or backend.

Cache setup per OAuth client and project only for a short lifetime to avoid duplicate setup calls. Refreshing setup data must not initiate another interactive login.

### 4.3 Code Assist content generation

`CodeAssistContentGenerator` implements the existing three-method `ContentGenerator` interface.

For generation, wrap the existing Gemini-shaped request as Code Assist expects:

- top-level `model`, `project`, and `user_prompt_id`;
- nested `request.contents`, `systemInstruction`, `cachedContent`, `tools`, `toolConfig`, `labels`, `safetySettings`, `generationConfig`, and `session_id`.

Use:

- `POST /v1internal:generateContent` for non-streaming generation;
- `POST /v1internal:streamGenerateContent?alt=sse` for streaming generation.

Parse SSE `data:` records across chunk boundaries and multi-line events. Propagate transport failures and abort signals. Do not silently discard malformed final JSON or convert an error response into an empty successful response.

Unwrap Code Assist responses into standard `GenerateContentResponse` objects, preserving candidates, automatic function-calling history, prompt feedback, usage metadata, model version, and trace/response ID where available. Existing logging and usage accounting therefore continue to observe the same response shape.

`embedContent` throws a clear unsupported-operation error. It does not fall back to Gemini Developer API or Vertex AI.

## 5. Runtime, model, and UI wiring

### Authentication and validation

- Exempt `google-oauth` from API-key validation in both core and CLI.
- Do not set `GOOGLE_GENAI_USE_VERTEXAI` for this auth type.
- Resolve a dedicated content-generator configuration before generic API-key/base-URL resolution.
- In `createContentGenerator`, obtain the Google OAuth client and run setup before constructing the generator, then retain the existing lazy and logging wrappers.
- Honor `isInitialAuth` / cached-only behavior for derived and unattended generators.
- Classify its telemetry as Gemini `generate_content`, not the default OpenAI-compatible pipeline.

### Model registry

Register `gemini-4-argon` as the default, with `gemini-4-carbon`, `gemini-4-hydrogen`, and stable `gemini-2.5-pro` built-ins. These exact opaque model IDs are passed to Code Assist unchanged; reasoning-effort suffixes and display names are not inferred. Do not route them through `modelProviders.gemini`, inherit `GEMINI_API_KEY`, or allow custom provider declarations to change their backend. Remote catalogs, dynamic experiments, and entitlement resolution are follow-up work after these routes are proven.

### Interactive authentication

Add “Sign in with Google” to Ink and OpenTUI authentication dialogs. The shared controller should expose authorization URL, pending/onboarding state, cancellation, account identity, and errors. Persist `security.auth.selectedType` and refresh the active generator only after OAuth and Code Assist setup succeed.

Sign-out clears only Google OAuth tokens, cached Google account metadata, and Google client/setup caches. It must not clear Qwen OAuth or other provider credentials.

### Daemon and Web Shell authentication

Explicit `browser: 'auto' | 'external' | 'manual'` options separate ordinary terminal login from hosted login. Only the explicit external host modes allow an interactive flow when the ACP runner itself is not a TTY. Manual/headless calls without these options retain cached-only behavior. `external` suppresses daemon-side browser launch; `manual` also selects the authorization-code + PKCE flow so a remote browser is never sent to its own unrelated `127.0.0.1`.

The ACP runner, not a fabricated daemon-side `Config`, owns each flow. Four commands (`qwen/google-oauth/start|status|code|cancel`) update a per-flow AbortController and public status, resolve a deferred manual-code request, run setup, and apply the provider only after setup succeeds. Requests are field-scoped: start, read, cancel, and code submission go through a dedicated workspace-facade method that asserts its runtime generation. Start and cancel return bounded status views; completed flows expire quickly. A separate Google login lock prevents interactive logins in different processes from overwriting one another.

The strict-mutation daemon routes forward these commands without reading credentials or authorization codes. `POST .../flows/:id/code` accepts only a bounded JSON body and returns no code in query strings, status views, or logs. The workspace SDK mirrors these four operations. No placeholder API key is sent to the ordinary provider installer, and the flow does not reuse the Qwen device-flow registry or ACP `authenticate`.

Web Shell adds a separate Google entry after the existing provider entries. It opens the authorization URL once in the client browser, polls with the same workspace selector, collects a manual code when required, and honors cancellation. After the ready event, it calls the existing `setModel` path with `gemini-4-argon(google-oauth)` (or the returned model), preserving standalone/draft handling and refusing to activate after the captured session/workspace target has changed.

## 6. Compatibility and security constraints

- Preserve the existing `gemini` and `vertex-ai` behavior and configuration.
- Do not reuse Qwen token files, locks, selected-account handlers, or logout routines.
- Do not log authorization codes, access tokens, refresh tokens, credential JSON, or token-bearing URLs.
- Bind callbacks to loopback only and validate `state` before exchanging a code.
- Treat the Code Assist endpoint as the destination of bearer credentials; do not inherit arbitrary custom headers or provider endpoints into this route.
- Preserve abort behavior during OAuth, onboarding, HTTP requests, and SSE consumption.
- Preserve source attribution for code adapted from Gemini CLI's Apache-2.0 implementation.
- Antigravity's client IDs, product metadata, and private implementation details are not copied.

## 7. Expected affected files

New implementation and collocated tests:

- `packages/core/src/code_assist/oauth2.ts`
- `packages/core/src/code_assist/setup.ts`
- `packages/core/src/code_assist/server.ts`
- `packages/core/src/code_assist/converter.ts`
- `packages/core/src/code_assist/types.ts`
- `packages/core/src/code_assist/index.ts`

Existing integration points include:

- `packages/core/src/utils/auth-type.ts`
- `packages/core/src/core/contentGenerator.ts`
- `packages/core/src/models/{constants,modelRegistry,modelConfigResolver,modelsConfig}.ts`
- `packages/core/src/telemetry/gen-ai-provider.ts`
- `packages/core/src/config/storage.ts`
- `packages/cli/src/config/{auth,config,top-level-options}.ts`
- `packages/cli/src/utils/modelConfigUtils.ts`
- `packages/cli/src/ui/auth/AuthDialog.tsx`
- `packages/cli/src/ui/auth/useAuth.ts`
- `packages/cli/src/ui/opentui/dialogs-auth.tsx`
- `packages/cli/src/acp-integration/acpAgent.ts`
- `packages/cli/src/serve/routes/google-oauth.ts`
- `packages/cli/src/serve/server.ts`
- `packages/cli/src/serve/run-qwen-serve.ts`
- `packages/cli/src/serve/workspace-service/{types,index}.ts`
- `packages/sdk-typescript/src/daemon/{types,index,DaemonClient}.ts`
- `packages/web-shell/client/daemon/workspace/{types,actions}.ts`
- `packages/web-shell/client/components/messages/{AuthMessage,GoogleOAuthEntry,GoogleOAuthFlowPanel}.tsx`
- `packages/web-shell/client/components/dialogs/ModelDialog.tsx`
- `packages/web-shell/client/App.tsx`
- Web Shell i18n catalogs, ACP/host authentication mappings, and user documentation discovered during implementation.

This is a multi-file feature, not a provider preset change. Any additional consumer found by symbol search must be classified rather than assumed compatible.

## 8. Validation and acceptance criteria

### Offline automated validation

1. OAuth loopback success, callback rejection, state mismatch, cancellation, timeout, and headless refusal.
2. PKCE authorization-code flow and authorization-code redaction.
3. Credential mode, atomic writes, refresh-token preservation, refresh events, and isolation from Qwen token files.
4. Existing-tier, free-tier onboarding, paid-tier/project onboarding, operation polling, validation-required, and ineligible-account cases against a fake Code Assist service.
5. Non-streaming and streaming request envelopes, nested SSE boundaries, aborts, HTTP errors, malformed events, and response/usage mapping.
6. Cached-only headless startup, no unexpected interactive login from a subagent, and explicit embedding failure.
7. Ink, OpenTUI, and Web Shell commit the selected auth type only after successful setup and preserve other providers' state on failure/sign-out.
8. Existing Gemini, Vertex, Qwen OAuth, and model-provider regression suites remain green.
9. ACP flow completion, duplicate-start rejection, cancellation, workspace-scoped daemon forwarding, strict bearer enforcement, SDK JSON contracts, and Web DOM model activation.
10. `npm run build`, `npm run typecheck`, `npm run bundle`, lint/format checks, and focused package tests pass.

### Real-account acceptance

A real Google account completes sign-in, onboard/load, a streaming coding request with a tool call, cached restart, token refresh, and sign-out without an API key. Use `gemini-4-argon` first, then repeat short requests for `gemini-4-carbon` and `gemini-4-hydrogen` when the account exposes them. Record the server-returned tier/project and any quota result as evidence. An ineligible account or unavailable model must produce the corresponding service error rather than a promise of entitlement or quota.

Offline mocks cannot prove Google eligibility or quota. If no real-account run is performed, the implementation may be declared unit/integration-tested but not verified for live Code Assist eligibility and quota.

## 9. Remaining user action

The OAuth client decision is resolved: use the Gemini CLI public installed-app client. A real-account browser login will be required for final live acceptance. No user token or Antigravity credential is needed for offline implementation and tests.
