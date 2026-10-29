# Qwen Subscription integration

[English](qwen-subscription.md) | [简体中文](qwen-subscription.zh-CN.md)

Related issue: [#15180](https://github.com/QwenLM/qwen-code/issues/15180).

## PRD follow-up (2026-10-29)

This iteration loads every model ID from `GET /compatible-mode/v1/models`, without a client allowlist. The preproduction response contains `qwen3.8-max`, `qwen3.7-flash`, and `qwen3.7-plus`. Prefer a returned `qwen3.8-max` for initial selection, otherwise the first returned model. Keep an existing selection when it disappears and ask the user to choose with `/model`; never silently replace it. Authentication dialogs show this instruction without inline model choices. Escape (CLI) or Cancel (GUI) returns to the composer with credentials intact, even before a session initializes; `/model` opens the existing picker. The CLI startup authentication error must also allow Escape for this specific recovery case. Discovery failures retain credentials and the last successful list. Without a cache, report the failure instead of inventing available models.

The catalog belongs to the membership session and is cleared by logout or a new account authorization. Core owns discovery, caching, and registration. CLI `/model` and the existing GUI model refresh update the catalog within the selected workspace runtime, without adding process-global configuration mutation routes. Membership rechecks retain the plans and sign-out actions while disabling duplicate checks.

Desktop reuses ModelReasoningControls and the ACP settings path. A real Max gateway probe accepted `enable_thinking=false` and enabled `thinking_budget=4096/16384/32768`; disabled responses omitted reasoning_content and enabled responses included it. This verifies parameter acceptance and toggle behavior, not strict enforcement of long reasoning budgets. Other models' capabilities cannot be inferred from their names. This iteration records the approach and evidence without enabling these capabilities for every model. Subscription search is integrated through the staging MCP endpoint; see [Subscription MCP web search](subscription-mcp-web-search.md). `DEV=true` remains the existing preproduction development gate.

Validation covers complete server catalogs, unknown new IDs, failed or empty discovery with and without cache, removed selections without fallback, cancellation and account changes, concurrent recheck/plans actions, and other auth types. Build, typecheck, bundle, focused tests and self-audit precede completion. Public documentation explains development availability and the search boundary; no publication is performed.

### Thinking controls: proposed follow-up

Reuse `ModelReasoningControls` in the shared Web Shell editor. Desktop and VS Code already send its selection through session actions and ACP `reasoning_effort`; they do not need a separate subscription settings page. Declare capabilities only for models whose gateway behavior has been confirmed, with thinking enabled by default, a supported off state, and low/medium/high choices. The default strength still needs a product decision; the PRD's default-on requirement does not identify a default strength.

At the shared Core request boundary, map off to `enable_thinking: false` and omit `thinking_budget`. Map low/medium/high to `enable_thinking: true` plus `thinking_budget: 4096/16384/32768`. Do not emit OpenAI `reasoning_effort` or nested `chat_template_kwargs` in place of the verified top-level fields. Existing Qwen toggle-only profiles cannot express the three budget levels; add a narrowly scoped subscription mapping and capability validation rather than changing DashScope behavior for other providers.

Verify desktop switch/strength changes against the emitted request, preserve the selected strength across off/on and session reload, and verify model switching does not carry unsupported capabilities. Gateway acceptance was checked only on Max; per-model support and long-running budget enforcement remain to be confirmed. This follow-up is a design and probe result, not an implemented thinking feature.

## Scope and status

The subscription authorization view is separate from the legacy OAuth progress view, preserving the legacy title, countdown and cancellation behavior. Core owns subscription authorization expiry; the subscription view only renders its state and permits link copying until the grant's original expiresAt deadline. Remove unused initial-checking states and the unused CLI paid-summary branch; the active CLI history summary and GUI paid summary remain unchanged.

Desktop only adds Qwen sign-in to the existing `/auth` dialog. The separate login onboarding page and persistent subscription button are struck out in the PRD and excluded from development tasks.

CLI (Ink and OpenTUI), VS Code, and Desktop use the new device authorization
protocol. Real OAuth request handling, credential storage, membership queries,
and purchase waiting are implemented for opt-in development testing.
Product Mock entries, simulated purchases, and simulated model lists are removed.
Unit-test doubles and local synthetic HTTP fixtures remain for regression tests.

Development mode can activate models returned by the subscription service through the shared OpenAI Chat pipeline after confirming Plus/Pro membership. After confirming Plus/Pro, the login flow automatically saves the selected workspace configuration and prepares the runtime, then returns to the conversation. There is no separate Connect step; the first conversation request establishes actual gateway availability. Dynamic model discovery and [subscription MCP web search](subscription-mcp-web-search.md) are implemented for development sessions. The discontinued OAuth provider and its inference implementation remain unchanged.

## Login and purchase flow

1. Request a device code. Display the authorization link and open the browser
   while polling the token endpoint.
2. After browser approval, save the token pair and query `/api/oauth/userinfo`
   for identity and `member_type`. A failed first query retains credentials and offers `Check again` to query identity and membership without reauthorizing; only confirmed Free/Go opens plans. No browser callback to the CLI is required.
3. Plus/Pro shows the account summary. Free/Go opens the plans page and queries
   membership every 5 seconds, for at most 120 seconds from the first confirmed Free/Go state and entry into purchase waiting.
4. Normal purchase waiting shows `Open plans again`. Query failure or timeout
   shows `Check again` while retaining `Open plans again`.
   A manual check is disabled while its request is running.
5. Closing the flow cancels pending work. Sign out clears local credentials before requesting revocation; remote failure reports local signout without confirmed remote revocation, while local cleanup failure is reported separately.
   Expired access tokens refresh automatically; only `invalid_grant` during refresh means the refresh credentials have expired. Temporary network errors retain credentials and allow another query. Authorization, exchange, credential storage, membership, refresh and signout errors identify their stage without exposing arbitrary backend bodies.
   A 429 respects Retry-After; device authorization, refresh and userinfo cooldown deadlines are stored with shared credentials so repeated operations do not request early.

Use the agreed PRD/PD copy. Do not add a visible countdown, a separate device-code
label, or an initial membership-query card. GUI uses buttons; terminal keyboard
hints stay in CLI. Membership status is decided by the backend. Core enforces the device grant's expires_in; GUI adds no fixed 600-second cutoff. CLI retains the timeout box until a keypress. GUI uses `Sign in again` for authorization and reserves `Check again` for identity and membership queries.

## Protocol and credential ownership

| Purpose                    | Endpoint                      |
| -------------------------- | ----------------------------- |
| Device authorization       | `POST /api/oauth/device/code` |
| Token exchange and refresh | `POST /api/oauth/token`       |
| Identity and membership    | `GET /api/oauth/userinfo`     |
| Sign out                   | `POST /api/oauth/revoke`      |

The preproduction auth origin is `https://pre-auth.qwen.ai`, with OAuth
`client_id=qwen-code-cli`. The browser link is
`https://pre4-chat.qwen.ai/authorize?user_code=<code>&client=qwen-code`.
The browser's `client` parameter is separate from OAuth `client_id`.
The plans page is `https://pre4-chat.qwen.ai/?memberPlan=qwen_code`.
`/upgrade`, post-login purchase, and reopening plans share this URL, including
the daemon configuration used by desktop clients. Purchase links never reuse
the device authorization URL or its `user_code` and `client` parameters.
This entry is confirmed against `qwen-chat-fe` branch `feat/qcode_authorize`,
commit `127d20ad8` (2026-10-29). The website requires a signed-in web account.

`QwenSubscriptionSession` in core owns private atomic credential storage,
restoration, cross-process refresh locking, and revocation. Clients share the
session only when they use the same effective `QWEN_HOME`. The new credential
file is separate from legacy OAuth credentials. Refresh replaces the entire
returned token pair. Tokens and device codes never enter GUI responses.

GUI calls authenticated local daemon `/auth/subscription` routes for capability,
start, read, cancel, userinfo, and revoke. These are process-global account
operations, independent of conversation/workspace configuration. Subscription requests use short-lived clients with the originating daemon
address and token, so workspace transport disposal does not interrupt a late
start or redirect its cancellation to the new daemon. Closing a view also cancels late start results.

VS Code queries capability when the user starts authentication. While pending,
it does not open another login flow; failure shows the existing authentication
error and permits another attempt. Web Shell exposes the entry only after
capability succeeds. Disabled capability keeps existing provider login available.

## Development setup

Run `npm run dev` from the repository root. Subscription uses the fixed
preproduction configuration in `packages/core/src/qwen/oauth-config.ts`:
OAuth origin `https://pre-auth.qwen.ai`, client ID `qwen-code-cli`, and Web origin
`https://pre4-chat.qwen.ai`. No OAuth environment overrides or isolated home are
required. Authorization links include `user_code` and `client=qwen-code`.
Replace these configuration values with the confirmed production values before
release.

GUI hosts use `DEV=true`, inherited by their local daemon, and the same fixed
configuration.
After rebuilding and bundling, stage the VS Code CLI with
`node packages/vscode-ide-companion/scripts/copy-bundled-cli.js` and launch the
extension development host. Desktop uses `npm run build:runtime` followed by
`npm run dev` in `packages/desktop`. Restart an existing daemon to apply its new
code and environment. Production entry enablement is not part of this setup.

## Validation and remaining dependencies

Acceptance covers first-query recovery without reauthorization, stage-specific errors, cross-instance Retry-After, device grants shorter and longer than 600 seconds, timeout retention until keypress, remote revocation versus local cleanup failures, both terminal renderers, VS Code capability pending/failure,
Web Shell connection changes and cancellation, coexisting purchase and Check again
buttons, credential refresh/revoke, and preservation of existing provider login.
Focused tests and local HTTP/browser fixtures verify these paths without user
credentials. Native VS Code/Desktop hosts and real preproduction authorization
must be verified separately; local fixture results do not establish those results.

Before release, confirm server-provided model IDs/defaults, inference and search
endpoints, token support, quota/error responses, and purchase activation. Complete
those adapters and end-to-end verification before treating membership login as a
working model session or updating public docs to announce availability.

## Subscription inference integration

Status: local implementation, with verification recorded in the test plan. The preproduction gateway is `https://pre-api.qwen.ai/compatible-mode/v1`; use OpenAI Chat Completions and load the server model catalog. On 2026-10-29, after backend fixes, a real Pro-token OpenAI SDK smoke against this gateway returned HTTP 200 and `OK` for both streaming and non-streaming requests, including usage. Earlier 404/401 failures are retained in the test evidence. This establishes the SDK conversation path; native-host and complete agent/tool workflows still need separate acceptance.

Add a distinct `qwen-subscription` authentication type. Keep legacy OAuth unchanged. Register server-returned subscription models only in development mode and reject arbitrary gateway overrides. Reuse the existing OpenAI Chat pipeline and default compatible provider without automatically enabling DashScope-specific fields, search, or unverified model capabilities. Config and settings contain only an authentication selector, model ID, fixed gateway and a placeholder credential.

The subscription session supplies valid access tokens using its existing credential file, cross-process lock and cooldown. Extract the existing refresh operation so membership and inference share it. A rejected token may be refreshed once before retrying an HTTP 401; compare the rejected token with the current token inside the lock to avoid rotating a token twice. Do not refresh for HTTP 403, 404 or 429, and do not replay a stream after response delivery. Model HTTP work must run outside the credential lock. Inject Bearer credentials at the transport boundary, preserve cancellation/proxy behavior, and reject redirects or other destinations before a credential can leave the fixed gateway.

After confirmed Plus/Pro membership, clients automatically activate a subscription model through existing workspace/session selection infrastructure and return to the conversation after activation succeeds. If the saved model has been removed, users can instead return to the composer for `/model` without a success message; GUI hosts refresh the existing catalog before leaving authentication. Account login routes remain process-global; any new activation route must be selected-runtime scoped, resolve the requested workspace, honor trust and generation lifecycle, and never fall back to the primary runtime. CLI Ink/OpenTUI and GUI hosts share Core credentials, while updating only the selected conversation/workspace. CLI activation writes the trusted workspace scope and never falls back to user settings. Cancellation stops pre-commit checks; once the install transaction starts it finishes consistently, while cancelled views suppress late success callbacks. Missing credentials fail without launching an implicit device flow. Restart restores the selected subscription authentication; signout prevents later requests from reusing a cached access token.

Affected layers: Core subscription configuration/session/transport, authentication and model resolution, CLI/SDK authentication literals, terminal login activation, daemon workspace activation, and shared GUI authentication. Extend focused tests for expiry, concurrent rotation, signout, route ownership, normal/streaming requests and tool-result roundtrips. Keep English/Chinese design synchronized and record baseline and local verification in `.qwen/e2e-tests/qwen-subscription-inference.md`. Build, typecheck, bundle, run focused package tests, then audit and independently review. Search, production enablement, and changes to legacy OAuth remain out of scope. Gateway routing and business error-code contracts remain external dependencies.

## Automatic activation after membership confirmation

Remove the extra Connect confirmation from CLI (Ink/OpenTUI), VS Code, and Desktop. Initial login/restoration, a successful membership-query retry, and purchase polling that discovers Plus/Pro all start activation automatically. Free/Go retains the existing purchase flow.

Each authorization or transport lifetime attempts automatic activation once. Parent rerenders and changing callback identities must not restart it. Pending activation shows progress and does not return to chat early. Failure stays visible with safe copy and an explicit Retry action; no automatic retry loop or reauthorization is introduced. Success uses existing host completion callbacks to close authentication and return to the conversation. CLI authentication completion also synchronizes the displayed model from the active Config so the header/footer show the selected model immediately.

GUI activation must belong to the lifecycle and transport that confirmed membership; a new transport must not consume an old ready state. Cancellation, unmounting and owner changes still suppress late success. Before a first session exists, successful activation also updates the welcome composer's pending model through its existing selection callback, before closing authentication, so the first prompt cannot reapply the old provider's model. Preserve the existing workspace-scoped install transaction, account credentials and daemon routes. Changes are limited to terminal hooks/views, the shared GUI subscription flow and hook, related host tests, localized retry/progress copy and both design versions. Regression coverage includes Plus/Pro, Free/Go, purchase/query recovery, pending/error/retry, callback rerenders, transport changes and cancellation.

## CLI login success and account commands

After confirmed Plus/Pro membership, both CLI renderers automatically activate a subscription model. Successful activation closes authentication and appends the account, plan, and `Model: <selected model> · Run /usage to see your plan usage` summary to the conversation. Ordinary activation failures retain a retry action; removed models only point to `/model` and allow a return to the composer. Cancellation suppresses late success. The normal input uses `Type your request, or /usage` and shows `Try: /usage /status /upgrade /auth` while subscription authentication is selected.

Reuse `/usage` (the existing `/stats` alias) and `/status`. `/usage` continues to show the CLI's local usage statistics; it does not fetch server-side remaining plan quota. Add development-only, interactive `/upgrade` to open the existing Qwen Code plans page, retaining the URL if browser launch is suppressed or fails. Account management continues through the existing `/auth` command, without changing its behavior or adding a separate `/logout` command. This change is CLI-only.

Acceptance: restored paid credentials, new authorization, purchase polling, and query recovery all activate without a second Connect step; activation failure and cancellation cannot show success; normal input is usable; existing usage/status/auth commands remain unchanged and upgrade works through both renderers. Verify with focused tests, build, typecheck, bundle, and the isolated test-script fallback in `.qwen/e2e-tests/subscription-login-success.md`.
