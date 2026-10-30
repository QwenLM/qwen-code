# Qwen Subscription integration

[English](qwen-subscription.md) | [简体中文](qwen-subscription.zh-CN.md)

Related issue: [#15180](https://github.com/QwenLM/qwen-code/issues/15180).

## Scope and availability

CLI (Ink/OpenTUI), Desktop and VS Code share Core subscription credentials, membership queries and OpenAI Chat inference. `DEV=true` is the existing preproduction capability gate. Production enablement and changes to legacy OAuth are excluded. Product simulation flags, mock transports, preview pages and native debug launchers are removed; regression-test doubles remain.

Desktop adds Qwen to the existing provider dialog, without a separate onboarding page or persistent subscription button. VS Code retains its native provider picker and opens the shared sidebar subscription flow after Qwen is selected. Native QuickPick account actions handle only logout and upgrade.

## Authorization, purchase and recovery

1. Request a device code, display/open its authorization link and poll for tokens. Core enforces the returned `expires_in`; GUI adds no fixed 600-second deadline. Link copying expires with the original grant. Legacy OAuth retains its separate title, countdown and cancellation.
2. Save the complete token pair, then query identity and `member_type`. A failed initial membership query retains credentials: Check again queries identity without reauthorizing. Browser callbacks are unnecessary.
3. Normalize case only when displaying plan names; preserve Free, Lite and other returned names. Only case-insensitive Plus/Pro qualifies for activation. Fresh browser authorization already displays plans, so do not automatically open a second tab, including after query recovery. Restoring saved credentials without browser authorization opens plans once.
4. Purchase waiting checks membership every five seconds, for at most two minutes from its first confirmed unpaid state. Timeout/query failure permits manual Check again while retaining Open plans again and Sign out. Disable duplicate checks during a request.
5. Closing cancels pending work. Temporary network failures retain credentials. Errors distinguish authorization, exchange, storage, membership, refresh, cleanup and revoke stages without exposing arbitrary response bodies. Only refresh-stage `invalid_grant` means expired refresh credentials. Shared persisted cooldowns enforce Retry-After for device authorization, refresh and userinfo.
6. Signout deletes local credentials before remote revocation. Remote failure must still synchronize local logout and explain that remote revocation failed; failed local deletion must not announce logout. Cancelling a host view must suppress updates to a replacement owner.

## Desktop and sidebar presentation

Desktop text follows its language setting, including entry descriptions, New badge, dialog titles, errors and actions. Product/plan names, model IDs, commands and URLs remain literal. The entry label is Qwen in both languages. When available, this first entry is selected by default; highlight, direct click and Next resolve to the same visible selection. Other type indexes account for the leading entry; without subscription capability the first ordinary type remains selected.

Desktop authorization is step 2 of Connect Provider. Previous cancels authorization and returns to selection; Next remains disabled during authorization, membership confirmation or errors. Successful confirmation proceeds automatically. Authorization failure has no Sign in again button. Browser fallback and pending text use provider-description muted colors; the link remains blue. Query failures retain Check again.

Purchase guidance is a separate accessible dialog, retaining the authorization flow's lifetime. Use the CLI content order, adapted to the desktop locale: heading, unpaid-plan explanation, waiting state, Open plans again, Use Alibaba ModelStudio instead, Sign out and muted descriptions. Omit a duplicate account line, retain monospace text and keep Cancel in a separate footer. Reuse provider option styles: full-width secondary background, 6px radius and blue selected label. Up/Down moves selection without invoking actions; no terminal chevron or browser focus outline. Closing returns to selection without revocation.

Sidebar uses VS Code fonts and semantic colors, 13px typography, 1.6 line height, 14px section spacing and wrapping host-themed buttons. Purchase guidance remains English in either host language, as requested; authorization and readiness remain localized. Show signed-in email and actual membership before the purchase heading, explanation and waiting state. Use primary Open plans/retry actions, outlined secondary actions and muted descriptions. Use normal Tab/Shift+Tab and Enter/Space. Authorization errors return below Get Started; purchase/query errors retain recovery inside the flow.

## Activation, models and ownership

Plus/Pro confirmation automatically activates once per authorization/transport lifetime, whether restored, freshly authorized, recovered by query or discovered by purchase polling. Callback rerenders cannot repeat activation. Pending work shows progress; ordinary failures offer explicit Retry. Cancellation, unmounting and owner replacement suppress late success. Before the first session, update the welcome composer's pending model before closing authentication so its first request cannot restore a previous provider model.

Load all IDs from `GET /compatible-mode/v1/models`, without an allowlist. The recorded preproduction catalog included `qwen3.8-max`, `qwen3.7-flash` and `qwen3.7-plus`. Initially prefer returned `qwen3.8-max`, otherwise the first model. A removed saved choice must not silently fall back. Network/server discovery failures retain credentials and may use the last successful list; without a cache, report failure rather than inventing models. HTTP errors use their status and the existing `error_description` field, without interpreting response business codes or guessing alternative error structures. HTTP 403 displays that description verbatim and never returns a cached list. Clear account-owned caches on logout/new authorization.

CLI model recovery points to `/model` and permits Escape to the composer even during startup. Desktop and VS Code close subscription authentication on `subscription_models_unavailable` or `subscription_model_unavailable`, retaining credentials and the existing session model, without a dedicated retry/model-picker screen or success announcement. HTTP 403 is an exception: keep its backend business message in the current error area. The existing composer handles ordinary model loading, selection and refresh. Activation reads the saved workspace model; it has no temporary model override parameter.

Activation forwards the error stage, HTTP status, message and Retry-After through both hosts. OAuth keeps its existing `error`/`error_description` parsing and business-code decisions for polling and credential refresh; model/search HTTP errors use status-based client categories instead of response business codes. Expired refresh credentials leave the ready state without implicitly authorizing again. Activation retries respect the returned cooldown. Inference credential failures and MCP search failures preserve typed refresh/permission/rate-limit errors instead of replacing them with generic reauthorization guidance. Unknown local exceptions and non-JSON response bodies are not displayed; fallback GUI messages follow the host language.

Account daemon routes are process-global; activation and model refresh address the selected workspace runtime, enforcing trust, generation and lifecycle without fallback to the primary runtime. CLI writes trusted workspace settings, never user settings as a fallback. Cancellation stops pre-commit checks; an admitted install transaction finishes consistently while cancelled views ignore its result.

VS Code captures the daemon, canonical workspace and selected session. Sidebar activation uses a flow/request-correlated bridge, explicitly activates the captured workspace, verifies runtime synchronization, then updates only its captured session. Initial onboarding must not send an unregistered Web Shell client ID. Re-bootstrap, session/workspace change, daemon replacement and view disposal abort the owner. Short-lived account clients retain their original daemon address/token so late starts are cancelled on the correct daemon.

Logout/upgrade commands use native status rows and Done/Retry actions. Check actual daemon capability even when palette availability is enabled by development mode. Cold-start commands wait for bootstrap with bounded timeout and disposal/error cleanup. Do not replace an in-flight account action; uncancellable logout must finish and synchronize its result. Log only safe codes, HTTP status and action names. A browser-open rejection offers Retry.

## Protocol and credential security

| Purpose                | Endpoint                      |
| ---------------------- | ----------------------------- |
| Device authorization   | `POST /api/oauth/device/code` |
| Token exchange/refresh | `POST /api/oauth/token`       |
| Identity/membership    | `GET /api/oauth/userinfo`     |
| Revocation             | `POST /api/oauth/revoke`      |

Preproduction uses auth origin `https://pre-auth.qwen.ai` and OAuth `client_id=qwen-code-cli`. Browser authorization is `https://pre4-chat.qwen.ai/authorize?user_code=<code>&client=qwen-code`; the browser client parameter is distinct from OAuth client_id. Plans use `https://pre4-chat.qwen.ai/?memberPlan=qwen_code`, shared by upgrade and purchase actions, without device-code parameters. This website entry was checked against qwen-chat-fe feat/qcode_authorize commit 127d20ad8 on 2026-10-29 and requires a signed-in web account.

Core owns private atomic storage, restoration, cross-process refresh locking and revocation. Hosts share sessions only with the same effective `QWEN_HOME`. Subscription storage is separate from legacy OAuth. Refresh replaces the complete token pair; tokens and device codes never enter GUI responses.

Inference uses the fixed `https://pre-api.qwen.ai/compatible-mode/v1` gateway with OpenAI Chat Completions. Configuration stores the auth selector, model ID, fixed gateway and placeholder credential. Supply Bearer tokens at the transport boundary; preserve proxy/cancellation and reject redirects or other destinations before sending credentials. HTTP work runs outside credential locks. Retry a rejected token once on HTTP 401, comparing current/rejected tokens inside the lock to avoid double rotation. Do not refresh for 403/404/429 or replay a delivered stream. Missing credentials fail without implicit authorization; logout clears cached credentials for later requests.

## Thinking and search

Reuse ModelReasoningControls and the existing session/ACP reasoning settings. For subscription `qwen3.8-max` and `qwen3.8-flash`, off sends top-level `enable_thinking: false` without a budget; low/medium/high sends true with 4096/16384/32768. Existing xhigh/max map to high. Remove competing reasoning/reasoning_effort and nested chat-template thinking switches while preserving unrelated options. Explicit native budgets remain effective; per-request opt-out removes budgets, and mandatory-thinking metadata remains respected. Untouched defaults, unknown models and other providers remain unchanged.

Max has shared UI capabilities; Flash has request mapping without a new capability declaration. Default strength still requires a product decision. A real Max gateway probe accepted off and all three budgets, with reasoning_content absent when off and present when on. This proves parameter acceptance/toggle behavior, not strict long-running budget enforcement or Flash support. Subscription search uses the existing MCP backend with dynamic Bearer tokens, a single rejected-token refresh on HTTP 401 and cancellation tied to the tool request. See [Subscription MCP web search](subscription-mcp-web-search.md).

## CLI success and account commands

Both renderers return to chat after activation and append account, confirmed plan and selected-model usage guidance. Synchronize the displayed model from active Config. Show the confirmed Plus/Pro plan without guessing a plan before confirmation. Respect hidden-tip/screen-reader settings, omit the default subscription-header spacer and preserve custom subtitles. Retain complete OpenTUI submission metadata/admission results and canonical history metadata.

Subscription input offers `/usage`, `/status`, `/upgrade`, `/logout`, each underlined separately. Usage is existing local CLI statistics, not server remaining quota. Development-only interactive upgrade opens the shared plans URL and retains a copyable URL when opening fails or is suppressed. Development-only interactive logout is restricted to an idle main response. After local logout, cancel background agents/side questions, clear subscription runtime/model/auth caches and selected subscription settings, then return to auth selection. Preserve other providers' API keys and settings; local cleanup failure must not clear the active runtime. Existing `/auth` behavior remains.

## Development and verification

Run `npm run dev` for CLI. GUI daemons inherit `DEV=true` and fixed preproduction configuration in Core oauth-config.ts. After build/bundle, stage VS Code with `node packages/vscode-ide-companion/scripts/copy-bundled-cli.js`; Desktop uses `npm run build:runtime` then `npm run dev` in its package. Restart an existing daemon to load new code/environment. Replace fixed origins with confirmed production configuration before release.

Focused coverage includes authorization expiry, recovery without reauthorization, Retry-After, rotation/revoke/cleanup, complete catalogs and removed selections, activation lifetime/ownership, both renderers, default provider selection, localized desktop navigation, sidebar host integration, serialized thinking parameters, streaming and unchanged providers. Use disposable credentials/local HTTP fixtures, never the developer's real account. Keep test plans/results under ignored `.qwen/e2e-tests/`. Build, typecheck, bundle and audit the complete diff before delivery.

Recorded evidence on 2026-10-29 includes a real Pro-token SDK smoke returning HTTP 200 and OK for streaming/non-streaming with usage. It establishes the SDK conversation path only. Complete native-host OAuth, browser/payment activation, agent/tool workflows, quota/error contracts, per-model thinking support and long-budget enforcement still require acceptance. Local mocks/builds do not establish deployment or production availability.
