# Copilot Auth — Design Spec (v2, post-review-gates)

**Date:** 2026-08-16
**Status:** Draft v2 — incorporates findings from 5 review gates (CAPI correctness, upstreamability, TDD feasibility, security, UX)
**Approach:** C (Hybrid: self-contained core module + native wizard integration)

## Revision summary (v1 → v2)

| Change                                                                                                                                                           | Source gate                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Collapse 11 files → 4 files                                                                                                                                      | Upstreamability (KISS)                |
| Drop `skipApiKeyStep` → use `protocol === USE_COPILOT` gate                                                                                                      | Upstreamability                       |
| Drop `COPILOT_DUMP`, `COPILOT_CAPI_RELAY_URL`, `COPILOT_LIVE_CATALOG` env, `wire` override (Tier 0), `editor-version` overridable, `quota.ts`, `index.ts` barrel | Upstreamability (speculative config)  |
| Expand file inventory to ~20 `QWEN_OAUTH` sibling branches                                                                                                       | Upstreamability (triage gate honesty) |
| Kebab-case filenames                                                                                                                                             | Upstreamability                       |
| Add stub phase before RED tests                                                                                                                                  | TDD (Critical)                        |
| Add model-enable headers (`openai-intent`, `x-interaction-type`)                                                                                                 | CAPI correctness                      |
| Add `/models` GET static headers + path-aware `X-GitHub-Api-Version`                                                                                             | CAPI correctness                      |
| Run `parseProxyEp` on gho\_ tokens                                                                                                                               | CAPI correctness                      |
| Handle gho\_-only + Claude → device flow fallback                                                                                                                | CAPI correctness                      |
| `mkdir(dir, { recursive: true, mode: 0o700 })`                                                                                                                   | Security                              |
| GHE prompt: default github.com, opt-in enterprise                                                                                                                | UX                                    |
| Model picker: section header + pre-filter                                                                                                                        | UX                                    |
| Add error states (5xx, runtime 403, revoked, not-enabled)                                                                                                        | UX                                    |
| Success confirmation after auth                                                                                                                                  | UX                                    |
| Topological per-file TDD ordering                                                                                                                                | TDD                                   |
| Split live 401 test into mocked + live happy-path                                                                                                                | TDD                                   |
| `live-capi.live.test.ts` + `describe.skip` pattern                                                                                                               | TDD                                   |
| Add CONTROL tests (call-count, sentinel-positive)                                                                                                                | TDD                                   |
| Move stash-and-rerun to post-GREEN                                                                                                                               | TDD                                   |
| Use `ink-link` instead of hand-rolled OSC 8                                                                                                                      | UX                                    |

## Motivation

Add GitHub Copilot CAPI as a new auth method in upstream qwen-code. Two prior
implementations (spectre fork, apex-ontap) shipped but came with headaches.
This design incorporates lessons from both plus the `pi` repo's UX wins to
ship it "right" in the upstream harness, whose auth framework is in better
shape than either prior target.

## Goals

1. Borrow-first + device-flow fallback for `ghu_` token
2. `ghu_` → CAPI bearer exchange (required for Claude; `gho_` is GPT-only)
3. `gho_` shortcut (no exchange HTTP; GPT-only path)
4. 3-wire router: `messages` (claude-\*), `responses` (gpt-5\*), `chat` (else)
5. Native `/auth` wizard integration (4th `MainOption`)
6. Live model catalog from `/models` + model enabling at login
7. Token-parsed base URL from `proxy-ep` (self-healing enterprise routing)
8. Device-flow UX with cancel-everywhere
9. RED→GREEN TDD against real CAPI (using `ghu_` token on this machine)

## Non-goals

- ACP exposure (defer; but add defensive branches to avoid falling into QWEN_OAUTH-only paths)
- Fleet rollout tooling (single-user first)
- Custom Copilot `client_id` (use well-known VS Code id)
- Quota probe (defer to follow-up — non-goal creep per upstreamability gate)
- `COPILOT_DUMP` debug logging (defer — speculative config)
- `COPILOT_CAPI_RELAY_URL` relay (apex-internal; not applicable upstream)

## Architecture

### Module placement

`packages/core/src/copilot/` — self-contained directory, only `node:fs`/`os`/`path`/`util`/`crypto` dependencies. No CLI imports. Sibling to `packages/core/src/qwen/` (the only OAuth precedent). Exports via `packages/core/src/index.ts` with `export * from './copilot/index.js'` (matching the `qwen/` pattern at line 595).

### Subsystems (4 files, not 11 — KISS per upstreamability gate)

```
packages/core/src/copilot/
├── copilot-auth.ts      # discover + deviceFlow + exchange + tokenManager + baseUrl
├── copilot-fetch.ts     # wrapFetchWithCopilotAuth + headers + host rewrite + 401 retry
├── copilot-route.ts     # 3-wire router (messages/responses/chat), 3 tiers (no operator override)
├── copilot-models.ts    # live /models catalog + model enabling + availableModelIds
└── *.test.ts            # collocated tests (kebab-case)
```

Rationale: `QWEN_OAUTH` lives in 3 files (`qwenOAuth2.ts` 1260 lines, `qwenContentGenerator.ts`, `sharedTokenManager.ts`). The upstream pattern is fewer, larger files. `baseUrl.ts` (one regex), `headers.ts` (constants), `quota.ts` (deferred) don't warrant separate files.

### Data flow (first request after auth)

```
User selects Copilot in /auth wizard (4th MainOption)
  → wizard: discover() → if no borrowed token → deviceFlow (RFC 8628 poll)
  → deviceFlow writes ghu_ to ~/.config/github-copilot/hosts.json (chmod 600)
  → wizard installs copilotProvider preset
    (modelProviders.copilot[], security.auth.selectedType='copilot')
  → Config.refreshAuth(USE_COPILOT)
  → createContentGenerator dispatches to createCopilotContentGenerator
  → CopilotTokenManager.snapshot()
    → discover.borrow() finds ghu_ in hosts.json
    → exchange.exchangeGhuForCapi(ghu_) → {bearer, expires_at, endpoints.api}
    → OR gho_ shortcut (no HTTP) if gho_ found in ~/.copilot/config.json
    → baseUrl = parseProxyEp(bearer) ?? endpoints.api ?? fallback (run on BOTH ghu_ and gho_)
    → cache to ~/.config/qwen-code/copilot.json (0o600, atomic, dir 0o700)
  → routeForModel(modelId) → wire (messages|responses|chat)
  → construct sub-generator (existing Anthropic/OpenAI generator) with:
      baseUrl = COPILOT_SENTINEL_BASE_URL
      apiKey = 'copilot-capi-bearer-via-fetch' (placeholder)
      fetch = wrapFetchWithCopilotAuth(tokenManager)
  → sub-generator.makeRequest → wrapped fetch:
      rewrite host → baseUrl (from snapshot)
      inject Authorization: Bearer, Copilot-Integration-Id, Editor-Version, X-Initiator
      on 401 → forceRefresh + retry once
      on 429 → stderr breadcrumb
```

### Key invariants

1. **Bearer + endpointsApi are atomic** — frozen pair from `snapshot()`. Never split getters.
2. **Sentinel base URL** — `COPILOT_SENTINEL_BASE_URL = 'https://copilot-endpoint-rewritten-by-fetch.invalid'`. If this host appears on the wire, routing is broken (asserted in tests).
3. **`ghu_` never used as `apiKey`** — SDK `apiKey` slot gets a placeholder; real Bearer from wrapped fetch.
4. **Token-parsed base URL preferred** — `parseProxyEp(bearer)` on BOTH `ghu_`-minted and `gho_` tokens. Fall back to `endpoints.api` with warning.

## Auth flow (`copilot-auth.ts`)

### Token discovery (borrow-first)

Order:

1. `$GITHUB_TOKEN` env (only if `ghu_`/`gho_` prefix; PATs `ghp_`/`ghs_` ignored)
2. `$COPILOT_GITHUB_TOKEN_PATH` env / `settings.security.auth.copilot.githubTokenPath`
3. `~/.config/github-copilot/hosts.json` (`ghu_`)
4. `~/.copilot/config.json` (`gho_` — Copilot CLI; scanned after hosts.json so `ghu_` wins on dual-boxes since `ghu_` is required for Claude)
5. VS Code `globalStorage/github.copilot/*.json` (platform-aware)
6. If none found → `deviceFlow` fallback

**gho\_-only + Claude fallback** (CAPI correctness gate): if the discovered token is `gho_` and the selected model is `claude-*`, the gho* path can't serve Claude (403). In this case, trigger device flow to mint a `ghu*` rather than failing at request time. Log: "gho* token can't serve Claude models; starting device flow for ghu*."

Accepted JSON shapes (`scanJsonForGhu`): `hosts.json` `{github.com: {oauth_token}}`, VS Code `{accounts:[{token}]}`, flat `{token}`, Copilot CLI `{copilotTokens:{...}}`.

### Device flow (fallback)

- **Client ID:** `Iv1.b507a08c87ecfe98` ("GitHub for VS Code" app)
- **Scope:** `read:user` (minimal)
- **Endpoints:**
  - Device code: `POST https://{domain}/login/device/code`
  - Access token: `POST https://{domain}/login/oauth/access_token`
  - Default domain: `github.com`
- **GHE domain** (UX gate — NOT asked always): default to `github.com`. Surface the enterprise-domain prompt only when (a) `$GITHUB_ENTERPRISE_URL` env is set, or (b) `settings.security.auth.copilot.enterpriseUrl` is set, or (c) the user presses a dedicated "GitHub Enterprise" toggle during the Copilot wizard step. One-step for the 95% common case; opt-in for enterprise.
- **Poller:** RFC 8628 — honors server `interval` (default 5s), `slow_down` → trusts server interval / +5s, `authorization_pending` → keep polling, `expired_token` → fail friendly, `access_denied` → fail friendly. `waitBeforeFirstPoll: true`. Timeout hints clock drift (WSL/VM).
- **Cancel-everywhere:** `AbortController` threads through UI → poller → fetch. On cancel → return to main `/auth` menu (NOT exit the dialog) so the user can pick a different provider.
- **UX:** Use `ink-link` (already imported in AuthDialog) for the URL — not hand-rolled OSC 8 bytes. Print URL twice: once as `ink-link`, once as plain text below ("Or copy: ...") for terminals without OSC 8 support. Render `user_code` in high-contrast with explicit "Code: XXXX-XXXX (copy this)" framing. Auto-open browser via shell-free `spawn('open', ['--', href])` (the `--` prevents flag injection; use `new URL(verificationUri).href` canonical form, never the raw server string).
- **Writes** `ghu_` to `~/.config/github-copilot/hosts.json` (chmod 600), backs up existing to `hosts.json.bak-<epoch>` (also chmod 600). Parent dir `mkdir(dir, { recursive: true, mode: 0o700 })`.

### Token exchange (`ghu_` → CAPI bearer)

- **Endpoint:** `GET https://api.{domain}/copilot_internal/v2/token`
- **Headers:** `Authorization: token ghu_…`, `Accept: application/json`, `User-Agent: qwen-code-copilot/<version>`
- **Response (`CopilotTokenEnvelope`):** `{token, expires_at, refresh_in?, endpoints: {api, telemetry?, proxy?}}`. The `token` is an opaque string that may contain a `proxy-ep=` segment (do not assert `tid=`/`exp=` format in tests — soften to "opaque; may contain `proxy-ep=`").
- **4xx short-circuit** (no retry on auth errors)
- **Corp proxy:** `COPILOT_CAPI_PROXY` env (undici `ProxyAgent`, cached per proxy URL, scoped to this one call only). `getProxyAgent` is NOT exported from `index.ts`; `copilot-fetch.ts` must not import it (structural guard against data-plane leak).

### `gho_` shortcut

- If `gho_` found: **no exchange HTTP**
- `bearer = gho_` itself
- `baseUrl = parseProxyEp(gho_) ?? 'https://api.githubcopilot.com'` (CAPI correctness gate — gho\_ from enterprise seat may carry `proxy-ep`)
- `expiresAt = now + 3600s` (conservative)
- **GPT-only** — Claude returns 403. Fallback to device flow if Claude needed (see above).

### Token cache

- **File:** `~/.config/qwen-code/copilot.json` (mode `0o600`, atomic tmp+rename)
- **Parent dir:** `mkdir(dir, { recursive: true, mode: 0o700 })` (Security gate — apex pattern; spectre has the gap)
- **Schema:** `{bearer, endpointsApi, expiresAtMs, cachedAtMs, ghuSource, availableModelIds?}`
- **Cross-process lock:** `copilot.json.lock` via `open(wx, 0o600)` + 8s deadline / 100ms poll / 30s stale-steal. Loser re-checks disk before minting. **Known limitation** (Security gate): stale-steal has a TOCTOU window between `unlink` and `open(wx)`. Impact is low (double-mint, GitHub rate limit absorbs). Document as limitation; future hardening could use `proper-lockfile` (pi pattern).
- **In-process dedup:** `mintInFlight` mutex — two concurrent `getSnapshot()` calls share a single mint promise (apex had this bug; test required).
- **Double-checked locked refresh** (pi pattern): optimistic expiry check → `modify` (serialized) → re-check under lock → refresh once → persist → release. 15s refresh timeout.
- **Refresh buffer:** 60s before expiry
- **Force-refresh on 401:** for `ghu_` path, clears cache + re-mints from `ghu_`. For `gho_` path, re-discovers from `~/.copilot/config.json` (in case user re-authed), not just re-reads cache (Security gate — gho\_ is long-lived).
- **Redaction:** `[util.inspect.custom]`, `toString`, `toJSON` all redact `bearer` + `ghu_`.

### Base URL resolution (pi pattern)

Priority (run on BOTH ghu*-minted and gho* tokens):

1. **Token-parsed:** regex `/proxy-ep=([^;]+)/` from bearer → rewrite `proxy.`→`api.` → `https://api.individual.githubcopilot.com`
2. **Exchange response:** `endpoints.api` (ghu\_ path only)
3. **`gho_` fallback:** `https://api.githubcopilot.com`
4. **Warning logged** on any fallback (pi doesn't log; we improve)

## Wire routing (`copilot-route.ts`)

`routeForModel(slug, warn, liveModels?)` → `CopilotWire = 'messages' | 'responses' | 'chat'`

**3 tiers** (dropped Tier 0 operator override per upstreamability gate — `wire` field on `ModelConfig` is speculative schema change):

- **Tier 1:** live catalog (`fetchCopilotModels` → `indexModelsBySlug`)
- **Tier 2:** static allowlists (provider-prefix-tolerant via `baseSlug`):
  - `CLAUDE_MESSAGES_SLUGS`: `claude-opus-4.6`, `claude-opus-4.7`, `claude-opus-4.8`, `claude-sonnet-4.5`, `claude-sonnet-4.6`, `claude-sonnet-4.7`, `claude-haiku-4.5` (pinned to apex's more recent set)
  - `GPT5_RESPONSES_SLUGS`: `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5.4`, `gpt-5-mini`, `gpt-5-codex` (non `-chat`)
- **Tier 3:** drift policy — unknown `claude-*`/`gpt-5*` (non `-chat`) throws `CopilotRouteError`; others fall to `chat` with stderr breadcrumb.

## Fetch wrapper (`copilot-fetch.ts`)

`wrapFetchWithCopilotAuth(tokenMgr)` returns a `fetch`-shaped function. Per request:

1. `snap = tokenMgr.getSnapshot()` → atomic `{bearer, endpointsApi}`
2. Rewrite URL host → `endpointsApi` (path preserved; `joinPath` avoids `/v1/v1`). Handles string URLs, relative paths, URL instances, Request instances.
3. Inject headers (all through `Headers.set()` which rejects CR/LF per RFC 7230 — this is the header-injection defense):
   - `Authorization: Bearer <bearer>`
   - `copilot-integration-id: vscode-chat`
   - `editor-version: qwen-code/<version>` (hardcoded from `package.json` — NOT user-overridable per upstreamability gate)
   - `editor-plugin-version: copilot-chat/0.35.0` (static, required for `/models` — CAPI correctness gate)
   - `user-agent: GitHubCopilotChat/0.35.0` (static, required for `/models` — CAPI correctness gate)
   - `x-initiator: user` (or `agent` if last message isn't user — pi dynamic pattern)
   - `anthropic-beta: prompt-caching-2024-07-31` only on `/messages` paths
   - `Copilot-Vision-Request: true` when body has image parts
4. **`X-GitHub-Api-Version` path-aware gate** (CAPI correctness gate — NOT host-aware): send `X-GitHub-Api-Version: 2022-11-28` on `/models` and `/models/{id}/policy` paths (CAPI host accepts it here). Do NOT send on `/v1/messages`, `/responses`, `/chat/completions` (CAPI hosts reject it with 400 on these paths). **Open question:** needs live probe to confirm the exact path boundary — the TDD cycle will resolve this with a live test.
5. **401 → `forceRefresh()` + retry exactly once** (`MAX_FORCE_REFRESH_PER_REQUEST = 1`); second 401 is fatal. Body buffered via `captureRequest` (clone + `arrayBuffer`) for replay.
6. **429 → stderr breadcrumb** (`[copilot] rate limited: retry after Ns`) from `retry-after`/`x-ratelimit-reset`, no retry. (No `recordCopilotFetchRateLimit` — that module doesn't exist upstream per CAPI correctness gate.)

### Sentinel base URL

`COPILOT_SENTINEL_BASE_URL = 'https://copilot-endpoint-rewritten-by-fetch.invalid'` — placeholder in sub-generator config; fetch wrapper rewrites before any wire call. Asserted in `sentinel-invariant.test.ts`.

### Sub-generator construction

`createCopilotContentGenerator(config)` resolves wire → constructs `subConfig`:

- `baseUrl: COPILOT_SENTINEL_BASE_URL`
- `apiKey: 'copilot-capi-bearer-via-fetch'` (placeholder — constant string with no token-like prefix; if it appears on wire, CAPI returns 401 and the 401-retry does NOT loop)
- `fetch: wrapFetchWithCopilotAuth(tokenMgr)`
- Dispatches to existing `createAnthropicContentGenerator` / `createOpenAIResponsesContentGenerator` / `createOpenAIContentGenerator`. **Reuses existing generators unchanged.**

Anthropic SDK constructed with `{apiKey: null, authToken: placeholder, baseURL: sentinel}` (Bearer path — pi verified). Placeholder satisfies `validateHeaders`; real `Authorization: Bearer` from custom fetch.

## Model catalog (`copilot-models.ts`)

### Live catalog

`fetchCopilotModels(tokenMgr)`:

- `GET {endpointsApi}/models` via wrapped fetch (which injects full static headers — CAPI correctness gate)
- Headers: same static block + `X-GitHub-Api-Version: 2022-11-28` (path-aware gate allows it on `/models`)
- Parse `{data: [...]}` or bare array
- Coerce to `CopilotModel {slug, wire, contextWindow?, maxOutput?, capabilities?}`
- Seed `contextWindowSize` from live catalog
- `COPILOT_LIVE_CATALOG` is an **internal constant** (not env — upstreamability gate), always on; returns `null` on failure → degrade to static allowlists

### Model enabling (pi pattern)

`enableAllCopilotModels(tokenMgr)`:

- `POST {endpointsApi}/models/{id}/policy {state: "enabled"}` for every known model
- **Headers** (CAPI correctness gate — pi sends both, required):
  - `openai-intent: chat-policy`
  - `x-interaction-type: chat-policy`
  - Plus the standard static headers + `X-GitHub-Api-Version`
- Run during login (first request just works)
- Best-effort: swallow non-abort errors, but **log a warning** if any enable fails (pi improvement — don't silently fail)
- Handle 429 with `Retry-After` (one retry, capped 10s)

### `availableModelIds` filtering

- Capture at login, store in cache
- Model picker filters to `availableModelIds` **before** building the list (UX gate)
- Re-fetch at session init (not login-only like pi)
- On data-plane 403 with a manually-added model not in `availableModelIds`: emit "Model '{{id}}' is not available on your Copilot seat. Run /auth to refresh your catalog, or remove it from settings."

## Wizard integration

### AuthDialog (4th MainOption)

**File:** `packages/cli/src/ui/auth/AuthDialog.tsx`

- Add `MainOption = 'GITHUB_COPILOT'` to the union
- Add 4th entry to `MAIN_ITEMS`: `{key: 'GITHUB_COPILOT', title: 'GitHub Copilot', description: 'Route claude-* / gpt-5* via Copilot CAPI (uses your GitHub token)'}`
- `handleMainSelect('GITHUB_COPILOT')` → `setupFlow.start(copilotProvider, …)` → `pushView('provider-setup')`
- No sub-menu (like Custom)

### `copilotProvider` preset

**File (new):** `packages/core/src/providers/presets/copilot.ts`

```ts
export const copilotProvider: ProviderConfig = {
  id: 'copilot',
  label: 'GitHub Copilot',
  description: 'Route claude-* / gpt-5* via Copilot CAPI (uses your GitHub token)',
  protocol: AuthType.USE_COPILOT,
  baseUrl: COPILOT_SENTINEL_BASE_URL, // string → skip baseUrl step
  envKey: 'GITHUB_COPILOT_TOKEN', // sentinel value written
  models: [
    {id: 'claude-opus-4.7', ...},
    {id: 'claude-sonnet-4.6', ...},
    {id: 'gpt-5.2', ...},
    // ...
  ],
  modelsEditable: true,
  modelNamePrefix: 'copilot',
  // NO skipApiKeyStep — use protocol-gated shouldShowStep instead (upstreamability gate)
  showAdvancedConfig: true,
  uiGroup: 'copilot',
  uiLabels: {flowTitle: 'Set up GitHub Copilot'},
};
```

### `shouldShowStep` changes (protocol-gated, no new field)

**File:** `packages/core/src/providers/provider-config.ts`

- `apiKey`: return `false` if `config.protocol === AuthType.USE_COPILOT` (matches QWEN_OAUTH's `authType ===` pattern everywhere — no `skipApiKeyStep` boolean)
- `protocol`: already skipped (single protocol)
- `baseUrl`: already skipped (string)
- `models`: shows if `!config.models || config.modelsEditable`

The Copilot wizard shrinks to: `models → advancedConfig → review`.

### Model resolution

**File:** `packages/core/src/models/modelConfigResolver.ts`

Add `resolveCopilotConfig` (mirror `resolveQwenOAuthConfig`):

- `apiKey: 'COPILOT_DYNAMIC_TOKEN'` (sentinel)
- `baseUrl: COPILOT_SENTINEL_BASE_URL`
- `model: from modelProviders.copilot[] or DEFAULT_MODELS.copilot`

### Success confirmation (UX gate)

After `applyProviderInstallPlan` succeeds, emit a chat history item: "✓ GitHub Copilot connected." If the quota probe succeeds (future), append "Quota: X/Y premium, resets DATE." Don't let a quota failure mute the success signal.

### Model picker (UX gate)

**File:** `packages/cli/src/ui/components/ModelDialog.tsx`

- Add `USE_COPILOT` to `authTypeOrder`
- Add a visual section divider ("── GitHub Copilot ──") when authType changes in the rendered list
- Run `availableModelIds` filter **before** building the list

## Settings + validation

### Settings schema

**File:** `packages/cli/src/config/settingsSchema.ts`

- `security.auth.copilot.enabled` (boolean, optional)
- `security.auth.copilot.githubTokenPath` (string, optional)
- `security.auth.copilot.enterpriseUrl` (string, optional — for GHE users)
- `modelProviders.copilot[]` (ModelConfig array)

### `AUTH_ENV_MAPPINGS`

`copilot: {apiKey: [], baseUrl: [], model: []}` (empty — dynamic tokens)

### `validateAuthMethod`

`USE_COPILOT` → `return null` (no pre-flight env check). Do NOT add to `DEFAULT_ENV_KEYS`.

### `validateModelConfig`

`USE_COPILOT` → `return {valid: true}` (short-circuit, like `QWEN_OAUTH`).

### `--authType` flag

Add `AuthType.USE_COPILOT` to allowed `--authType` choices.

## Error UX (expanded per UX gate)

| State                                      | Trigger                                                           | Message                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| No Copilot seat                            | 403 from exchange with `notice_signed_in_as_individual`           | "No Copilot subscription found on this account. Visit github.com/settings/copilot to subscribe."                      |
| Expired device code                        | `expired_token` from poll                                         | "Device code expired. Please re-run /auth and try again."                                                             |
| Access denied                              | `access_denied` from poll                                         | "Authorization was denied. Re-run /auth to start over."                                                               |
| Rate limited                               | 429 from CAPI                                                     | stderr breadcrumb `[copilot] rate limited: retry after Ns` (no retry)                                                 |
| Network / proxy                            | `ENOTFOUND api.github.com`                                        | "Cannot reach api.github.com. If you're behind a corporate proxy, set COPILOT_CAPI_PROXY=http://your-proxy:port/"     |
| Slow_down                                  | `slow_down` from poll                                             | trusts server interval / +5s; timeout hints clock drift                                                               |
| **Copilot unavailable** (new)              | 5xx from CAPI / `/models`                                         | "Copilot is temporarily unavailable. Try again in a few minutes."                                                     |
| **Subscription expired mid-session** (new) | runtime 403 (not login-time)                                      | distinguish token problem (→ re-auth) from seat problem (→ subscribe) using response body                             |
| **Token revoked** (new)                    | exchange 401 (ghu\_ invalid)                                      | "Your GitHub token was revoked. Re-run /auth to reconnect."                                                           |
| **Model not enabled** (new)                | 403 on data-plane, model in `availableModelIds` but enable failed | "Model '{{id}}' could not be enabled on your Copilot seat. Try re-running /auth, or select a different model."        |
| **Fatal 401 mid-session** (new)            | second 401 after forceRefresh                                     | emit chat history "Your Copilot session expired. Run /auth to reconnect." + degrade gracefully (don't crash the turn) |

## Testing strategy (RED→GREEN against CAPI)

### Stub phase (TDD gate — Critical)

Before writing RED tests, create **stub modules** with empty exports and correct signatures:

```ts
// copilot-auth.ts stub
export async function discoverGithubToken(): Promise<{
  token: string;
  source: string;
}> {
  throw new Error('not implemented');
}
export async function exchangeGhuForCapi(): Promise<{
  bearer: string;
  endpointsApi: string;
  expiresAtMs: number;
}> {
  throw new Error('not implemented');
}
// ... etc for every exported function
```

Then RED tests fail with meaningful assertions (`Error: not implemented` or type mismatches), not module-not-found. This proves the test logic is correct before implementation.

### Topological per-file ordering (TDD gate)

Subagent teams work per-file in dependency order:

- **Tier 1 (no deps, parallelizable):** `copilot-route.ts`, `copilot-auth.ts` (discover + exchange + baseUrl stubs)
- **Tier 2:** `copilot-auth.ts` (deviceFlow + tokenManager — depends on discover + exchange)
- **Tier 3:** `copilot-fetch.ts` (depends on tokenManager)
- **Tier 4:** `copilot-models.ts` (depends on fetch)
- **Integration tests** last: `cache-atomicity.test.ts`, `wire-headers.test.ts`, `sentinel-invariant.test.ts`, `live-capi.live.test.ts`

Each file: stub → RED test (capture assertion) → GREEN → next.

### RED tests (written first, must fail with meaningful assertion after stubs)

**Unit tests:**

1. `test_copilot_auth_type_exists` — `AuthType.USE_COPILOT === 'copilot'`
2. `test_discover_finds_ghu_in_hosts_json` — returns `ghu_` from `hosts.json`
3. `test_discover_ignores_ghp_pat` — ignores `ghp_`/`ghs_`
4. `test_exchange_ghu_for_capi` — returns `{bearer, endpointsApi, expiresAtMs}`
5. `test_exchange_4xx_short_circuits` — 4xx → no retry, `fetchImpl` called exactly once
6. `test_gho_shortcut_no_http` — `gho_` path returns bearer without HTTP
7. `test_route_claude_to_messages` — `routeForModel('claude-opus-4.6') === 'messages'`
8. `test_route_gpt5_to_responses` — `routeForModel('gpt-5.2') === 'responses'`
9. `test_route_unknown_claude_throws` — `routeForModel('claude-unknown')` throws
10. `test_route_unknown_falls_to_chat` — `routeForModel('unknown-model') === 'chat'` with warning
11. `test_fetch_wraps_bearer` — injects `Authorization: Bearer`
12. `test_fetch_rewrites_host` — rewrites host to `endpointsApi`
13. `test_fetch_401_force_refresh_retry` — 401 → `forceRefresh` + retry once
14. `test_fetch_429_breadcrumb` — 429 → stderr breadcrumb, no retry
15. `test_sentinel_never_on_wire` — sentinel host never in request URL
16. `test_token_cache_atomic_snapshot` — concurrent reads get atomic pair
17. `test_token_cache_cross_process_lock` — two instances serialize (two instances in one process sharing `cacheFile`, NOT `child_process.spawn`)
18. `test_token_cache_redaction` — `inspect`/`toString`/`toJSON` don't leak
19. `test_mint_inflight_dedup` — two concurrent `getSnapshot()` → `fetchImpl` called exactly once (apex had this bug)
20. `test_base_url_from_proxy_ep` — parses `proxy-ep` → `https://api.individual.githubcopilot.com`
21. `test_base_url_fallback_with_warning` — fallback logs warning
22. `test_base_url_from_gho_proxy_ep` — `parseProxyEp` on gho\_ tokens (CAPI gate)
23. `test_models_list_live_catalog` — parses `{data:[...]}`
24. `test_models_list_timeout_degrades` — 2s timeout → null → static
25. `test_models_enable_headers` — POST includes `openai-intent: chat-policy` + `x-interaction-type: chat-policy` (CAPI gate)
26. `test_device_flow_poll_rfc8628` — honors `interval`, `slow_down`, `authorization_pending`
27. `test_device_flow_cancel_aborts` — `AbortController.abort()` → "Login cancelled"
28. `test_mkdir_mode_0o700` — cache dir + lock dir created with `0o700` (Security gate)

**Integration tests:**

29. `test_cache_atomicity_concurrent` — 100 concurrent `snapshot()` never split bearer/endpoints
30. `test_wire_headers_messages` — `/v1/messages` gets `anthropic-beta`
31. `test_wire_headers_vision` — image body gets `Copilot-Vision-Request: true`
32. `test_retry_request_body_replay` — 401-retry replays buffered body

**Live CAPI tests (`live-capi.live.test.ts`, gated):**

33. `test_live_capi_claude_via_ghu` — `claude-opus-4.7` via `ghu_` → 200
34. `test_live_capi_gpt5_via_ghu` — `gpt-5.2` via `ghu_` → 200
35. `test_live_capi_gpt4o_via_gho` — `gpt-4o` via `gho_` shortcut → 200
36. `test_live_capi_models_endpoint` — `GET /models` returns catalog
37. `test_live_capi_x_gh_api_version_probe` — resolve the path-aware gate: confirm `/models` accepts `X-GitHub-Api-Version` and `/v1/messages` rejects it (CAPI gate open question)

**Mocked 401 test (split from live per TDD gate):**

38. `test_fetch_401_retry_mocked` — mocked fetch: 401 → `forceRefresh` (mocked) → retry → 200. Uses `makeCtx(['tid_OLD','tid_NEW'])` pattern (apex reference). This is the deterministic version of the 401-retry test.

### CONTROL tests (deliberately passing, stay green throughout)

1. `test_openai_still_works` — existing OpenAI auth functions
2. `test_anthropic_still_works` — existing Anthropic auth functions
3. `test_qwen_oauth_still_works` — existing Qwen OAuth functions
4. `test_gemini_still_works` — existing Gemini auth functions
5. `test_sentinel_constant_unchanged` — sentinel string unchanged
6. `test_copilot_not_default_auth` — not the default
7. `test_ghu_never_as_apikey` — token never in SDK `apiKey` slot
8. `test_env_key_not_copilot_token` — `env.GITHUB_COPILOT_TOKEN` is sentinel, never real bearer
9. `test_ghu_path_calls_fetch_once` — `ghu_` exchange calls `fetchImpl` exactly once (prevents degenerate "return fake bearer without fetch" — TDD gate)
10. `test_gho_path_skips_fetch` — `gho_` path: `fetchImpl` not called (prevents degenerate "always call fetch" — TDD gate, reclassified from RED)
11. `test_sentinel_rewritten_to_endpointsApi` — positive assertion: rewritten URL contains the real `endpointsApi` host (prevents degenerate "always return google.com" — TDD gate, spectre `sentinel-invariant.test.ts` pattern)
12. `test_proxy_agent_not_in_data_plane` — `copilot-fetch.ts` does not import `getProxyAgent` (Security gate structural guard)

### Stash-and-rerun (post-GREEN, not RED — TDD gate)

After GREEN (implementation passes tests): `git stash` the implementation, re-run the **full** test suite. Any test that now fails (that wasn't in the RED capture) is a regression caused by your implementation, not a pre-existing failure. Restore and fix. Apply once per file-level GREEN, not per-test.

### Live CAPI test gating (TDD gate)

- File: `live-capi.live.test.ts` (`.live.` infix matching upstream convention)
- Gate: `const describeLive = process.env.COPILOT_LIVE_TEST === '1' ? describe : describe.skip`
- Guard `it`: if `COPILOT_LIVE_TEST=1` but no token discoverable, fail clearly with "COPILOT*LIVE_TEST=1 set but no ghu*/gho\_ token found"
- CI must never set `COPILOT_LIVE_TEST`
- Mutating tests (model enabling, quota) gated behind stricter `COPILOT_LIVE_TEST_MUTATE=1` — not part of the TDD cycle

### Live CAPI logistics

- `ghu_` token on this machine at `~/.config/github-copilot/hosts.json` (user: palanisd)
- `gho_` token likely at `~/.copilot/config.json`
- Live tests are the GREEN target for the TDD cycle

## File inventory (honest ~20-file spread per upstreamability gate)

### New files (`packages/core/src/copilot/`, kebab-case)

- `copilot-auth.ts` + `copilot-auth.test.ts` (discover + deviceFlow + exchange + tokenManager + baseUrl)
- `copilot-fetch.ts` + `copilot-fetch.test.ts` (fetch wrapper + headers + host rewrite)
- `copilot-route.ts` + `copilot-route.test.ts` (3-wire router)
- `copilot-models.ts` + `copilot-models.test.ts` (live catalog + enabling)
- Integration: `cache-atomicity.test.ts`, `wire-headers.test.ts`, `sentinel-invariant.test.ts`, `live-capi.live.test.ts`

### Modified core files (`packages/core/src/`)

1. `core/contentGenerator.ts` — `USE_COPILOT` in `AuthType`, branch in `createContentGenerator`, short-circuit in `validateModelConfig`
2. `models/constants.ts` — `copilot` in `AUTH_ENV_MAPPINGS`
3. `models/modelConfigResolver.ts` — `resolveCopilotConfig` branch
4. `models/modelsConfig.ts` — `USE_COPILOT` siblings at every `QWEN_OAUTH` branch (ordering ~304, setModel ~378, apiKey injection ~857, auth switch ~971)
5. `core/modelCapabilities.ts` — `copilotCapabilityProvider`
6. `providers/provider-config.ts` — `shouldShowStep` protocol-gated for `USE_COPILOT`
7. `providers/presets/copilot.ts` (new) — `copilotProvider`
8. `providers/all-providers.ts` — register
9. `index.ts` — `export * from './copilot/index.js'` (matching `qwen/` pattern at line 595)
10. `core/geminiBuiltinToolRouting.ts` — Copilot-aware branch (if needed)

### Modified CLI files (`packages/cli/src/`)

11. `ui/auth/AuthDialog.tsx` — 4th `MainOption`, `handleMainSelect`
12. `ui/components/ModelDialog.tsx` — `USE_COPILOT` in `authTypeOrder` (line ~329), section divider, `availableModelIds` pre-filter, siblings at QWEN_OAUTH branches (lines ~349, 408, 938, 993, 1145, 1163)
13. `config/auth.ts` — `USE_COPILOT` branch in `validateAuthMethod` returning `null`
14. `config/config.ts` — `--authType copilot` allowed
15. `config/settingsSchema.ts` — `security.auth.copilot` schema
16. `utils/systemInfoFields.ts` — `USE_COPILOT` siblings at QWEN_OAUTH checks (lines ~107, 122)
17. `utils/modelConfigUtils.ts` — `USE_COPILOT` entry (line ~35 pattern)
18. `acp-integration/acpAgent.ts` — **defensive branches** at QWEN_OAUTH gates (lines 4720, 4733, 12359) even though ACP is deferred — prevent `USE_COPILOT` falling into QWEN_OAUTH-only paths
19. `acp-integration/session/Session.ts` — defensive branch at line 7961
20. `gemini.tsx` — `USE_COPILOT` sibling at line 1099

### Mirror (if maintained)

21. `vscode-ide-companion/schemas/settings.schema.json` — `copilot` in built-in provider ids list (line ~48)

## Headache avoidance

| Headache (from references)                                    | How we avoid it                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| No device flow (spectre)                                      | Device flow fallback from bootstrap-copilot + pi's RFC 8628 poller                               |
| Env leakage (apex)                                            | Upstream has no proxy-key hydration; not applicable                                              |
| 3 settings files (apex)                                       | Single `settings.json` with copilot overlay                                                      |
| `ghu_`-before-`gho_` priority wrong on firewalled nets (apex) | `ghu_` first (required for Claude); gho\_-only+Claude triggers device flow                       |
| TUI rewrap bug (bootstrap)                                    | `ink-link` + plain-text fallback + auto-open                                                     |
| VS Code impersonation fragility (pi)                          | Required for Copilot auth; documented; hardcoded not overridable                                 |
| Thin no-seat error UX (pi)                                    | Friendly error + link                                                                            |
| Login-only model list (pi)                                    | Live `/models` refreshes at session init                                                         |
| Regex token parsing fragility (pi)                            | Fallback to `endpoints.api` with warning log                                                     |
| Bearer/endpoints race (apex Rust)                             | Atomic frozen-pair snapshot                                                                      |
| `enableAllModels` silent failures (pi)                        | Log warning if any enable fails                                                                  |
| `availableModelIds` stale (pi)                                | Re-fetch at session init                                                                         |
| Over-modularization (upstreamability)                         | 4 files, not 11 — matches QWEN_OAUTH's 3-file pattern                                            |
| Speculative config (upstreamability)                          | No `skipApiKeyStep`, `wire`, `COPILOT_DUMP`, `COPILOT_CAPI_RELAY_URL`, `editor-version` override |
| Incomplete inventory (upstreamability)                        | Honest ~20-file spread enumerated                                                                |
| Module-not-found RED tests (TDD)                              | Stub phase before RED                                                                            |
| Non-deterministic live 401 test (TDD)                         | Split into mocked unit + live happy-path                                                         |

## Open questions (to resolve during TDD)

1. **`X-GitHub-Api-Version` path boundary** — live test #37 will confirm: `/models` accepts the header, `/v1/messages` rejects it. Update the gate once confirmed.
2. **GHE token endpoint** — `https://api.{domain}/copilot_internal/v2/token` may differ for GHE. Needs live verification against a real GHE instance before shipping. Defer GHE support if untested.
3. **Model picker section divider** — confirm the rendering approach works with the existing `ModelDialog` list component. May need a small component addition.
