# Blaze Runtime Sandbox MVP Handoff

This document is a detailed prompt for a follow-up coding agent. The agent may
be a weak model, so the instructions are intentionally explicit and repetitive.

## Role

You are an AI coding agent working in a fork of `qwen-code`.

Your task is to reproduce and continue the Blaze Runtime MVP:

1. Build the repository.
2. Run `blaze-runtime serve` locally.
3. Verify DP/Nestor auth wiring.
4. Package or run the same runtime in the company sandbox infrastructure.
5. If anything fails, collect enough precise diagnostics so another engineer can
   understand and fix the problem without guessing.

Do not start by refactoring. Do not rename large parts of the repository. First
prove that the runtime works end-to-end.

## Product Context

The product is **Nessy Blaze**.

The team does not want Nessy Blaze to depend on another team's `nessy-cli` as a
product boundary. The current strategy is:

- Start from the `qwen-code` fork.
- Add a Blaze-owned public runtime entrypoint.
- Keep internal Qwen Code implementation for now.
- Add Blaze-owned DP/Nestor auth wiring.
- Prove the runtime can run inside sandbox.
- Only later extract/rename/clean package boundaries.

This means the current repository can still contain many names such as `qwen`,
`qwen serve`, and `@qwen-code/...`. That is acceptable for this MVP.

## What Was Added

The public runtime entrypoint is:

```bash
blaze-runtime serve
```

Important files:

- `scripts/blaze-runtime-entry.js`
- `packages/cli/src/blaze-runtime.ts`
- `packages/cli/package.json`
- root `package.json`
- `esbuild.config.js`

The daemon process runs:

```text
blaze-runtime serve
  -> HTTP daemon
      -> ACP bridge
          -> blaze-runtime --acp
              -> long-lived agent process
```

The important detail is that the ACP child must also be `blaze-runtime --acp`,
not the old public `qwen` executable. This is why `BLAZE_RUNTIME_ENTRY` exists.

## DP/Nestor Auth

A new auth type exists:

```text
dp-auth
```

The implementation lives in:

```text
packages/core/src/dp/
```

Key files:

- `packages/core/src/dp/dpConfig.ts`
- `packages/core/src/dp/dpTokenManager.ts`
- `packages/core/src/dp/dpTokenExchangeClient.ts`
- `packages/core/src/dp/dpContentGenerator.ts`
- `packages/core/src/dp/nestorOpenAICompatibleProvider.ts`
- `packages/core/src/dp/nestorAuthHeader.ts`

The auth type is registered in:

- `packages/core/src/core/contentGenerator.ts`
- `packages/core/src/models/constants.ts`
- `packages/core/src/models/modelConfigErrors.ts`
- `packages/core/src/models/modelRegistry.ts`
- `packages/cli/src/config/auth.ts`
- `packages/cli/src/utils/modelConfigUtils.ts`
- `packages/cli/src/acp-integration/acpAgent.ts`

## Environment Variables

### Runtime HTTP daemon auth

Use:

```bash
export BLAZE_RUNTIME_TOKEN="some-random-token"
```

Legacy fallback:

```bash
export QWEN_SERVER_TOKEN="some-random-token"
```

For secure sandbox/demo runs, use `--require-auth`.

### ACP child entrypoint

Use:

```bash
export BLAZE_RUNTIME_ENTRY="$PWD/dist/blaze-runtime.js"
```

Legacy fallback:

```bash
export QWEN_CLI_ENTRY="$PWD/dist/blaze-runtime.js"
```

This is important when the daemon spawns the long-lived ACP child.

### DP/Nestor credentials

Preferred exchange-token path:

```bash
export BLAZE_DP_TOKEN="<dp-token>"
```

Legacy fallback:

```bash
export DP_TOKEN="<dp-token>"
```

Delegated JWT path:

```bash
export BLAZE_DP_JWT="<delegated-jwt>"
```

Legacy fallback:

```bash
export NESSY_CLI_DP_AUTH_TOKEN="<delegated-jwt>"
```

Do not confuse `DP_TOKEN` with the final LLM API key. `DP_TOKEN` is exchanged
against Nestor:

```text
DP_TOKEN / BLAZE_DP_TOKEN
  -> POST https://code-completion-nestor.tcsbank.ru/api/v2/token
  -> Nestor JWT
  -> OpenAI-compatible request to Nestor
```

JWTs produced by the exchange are sent as:

```text
Nestor-Token: <jwt>
```

Delegated JWTs from `BLAZE_DP_JWT` or `NESSY_CLI_DP_AUTH_TOKEN` are sent as:

```text
Authorization: Bearer <jwt>
```

### Nestor defaults and overrides

Default model:

```text
tgpt/qwen3-next-80b-a3b-instruct
```

Override if needed:

```bash
export BLAZE_NESTOR_MODEL="tgpt/..."
```

Default Nestor server:

```text
https://code-completion-nestor.tcsbank.ru
```

Override if needed:

```bash
export BLAZE_NESTOR_SERVER_URL="https://..."
export BLAZE_NESTOR_BASE_URL="https://.../api/v1/cli/openai-like/v1"
```

Credential cache:

```text
~/.blaze-runtime/dp_auth_creds.json
```

Legacy read-only fallback:

```text
~/.nessy/dp_auth_creds.json
```

## Important Behavior

`blaze-runtime serve` currently does **not** accept `--auth-type=dp-auth`.

This is expected.

The correct MVP path is env-based:

```bash
export BLAZE_DP_TOKEN="<dp-token>"
# or:
export DP_TOKEN="<dp-token>"
```

Then the ACP child should infer `dp-auth` from the environment via:

```text
packages/cli/src/utils/modelConfigUtils.ts
```

Do not waste time trying to pass `--auth-type` directly to `serve`.

## Local Build

Use Node.js 22+.

From repository root:

```bash
npm install
npm run build --workspace=packages/core
npm run build --workspace=packages/cli
npm run bundle
```

If `npm install` is not allowed in your environment, report the exact package
manager error and do not edit `package-lock.json` blindly.

## Local Smoke Test

From repository root:

```bash
export BLAZE_RUNTIME_TOKEN="local-dev-token"
export BLAZE_RUNTIME_ENTRY="$PWD/dist/blaze-runtime.js"
export BLAZE_DP_TOKEN="<real-dp-token>"

node scripts/blaze-runtime-entry.js serve \
  --port 4170 \
  --hostname 127.0.0.1 \
  --workspace /tmp/blaze-runtime-workspace \
  --require-auth
```

Create the workspace first if it does not exist:

```bash
mkdir -p /tmp/blaze-runtime-workspace
```

Health check:

```bash
curl -i http://127.0.0.1:4170/health
```

Expected without token:

```text
HTTP 401
```

With token:

```bash
curl -i \
  -H "Authorization: Bearer local-dev-token" \
  http://127.0.0.1:4170/health
```

Expected:

```text
HTTP 200
{"status":"ok"}
```

Preflight:

```bash
curl -s \
  -H "Authorization: Bearer local-dev-token" \
  http://127.0.0.1:4170/workspace/preflight | jq
```

Expected important details:

- auth should not be unknown for `dp-auth` if env credentials exist;
- CLI entry should resolve to `BLAZE_RUNTIME_ENTRY`;
- workspace should match the `--workspace` path.

## Real Agent Loop Test

After health/preflight work, test a real prompt through the HTTP/ACP interface.

Use the repository's existing daemon API docs:

```text
docs/developers/qwen-serve-protocol.md
docs/developers/blaze-runtime-extraction.md
```

The goal is to prove:

1. The HTTP daemon stays alive.
2. The ACP child starts as `blaze-runtime --acp`.
3. The model client uses `dp-auth`.
4. The first prompt reaches Nestor/Qwen.
5. A second prompt in the same session keeps context.

If you cannot quickly find the exact prompt endpoint shape, do not invent it.
Read the protocol docs and server route code first.

Useful route/code areas:

```text
packages/cli/src/serve/server.ts
packages/cli/src/serve/acpHttp/
packages/acp-bridge/src/bridge.ts
packages/cli/src/acp-integration/acpAgent.ts
```

## Sandbox MVP Goal

The target architecture is:

```text
Nessy Blaze UI / BFF
  -> company sandbox API
      -> sandbox container
          -> blaze-runtime serve
              -> long-lived ACP child
                  -> Nestor API
                      -> Qwen model
```

For the sandbox MVP, the runtime should be started once per user/project
session and should stay alive while the user sends many prompts.

Do not call sandbox-agent `ExecuteCommand` for every prompt if that creates a
new process each time. That loses agent context. The daemon process must stay
alive and expose HTTP/ACP routes through sandbox proxy URLs.

## Suggested Sandbox Runtime Command

Inside the sandbox container:

```bash
export BLAZE_RUNTIME_TOKEN="$RANDOM_RUNTIME_TOKEN"
export BLAZE_RUNTIME_ENTRY="/app/qwen-code/dist/blaze-runtime.js"
export BLAZE_DP_TOKEN="$DP_TOKEN"

node /app/qwen-code/scripts/blaze-runtime-entry.js serve \
  --hostname 0.0.0.0 \
  --port 4170 \
  --workspace /workspace \
  --require-auth
```

The sandbox platform must proxy port `4170` outward.

The external client should call the proxied URL with:

```text
Authorization: Bearer <BLAZE_RUNTIME_TOKEN>
```

## What Not To Do

Do not:

- replace this with `nessy-cli`;
- reintroduce a dependency on a public `nessy` binary;
- remove `blaze-runtime --acp`;
- run one short-lived CLI command per prompt;
- commit real tokens;
- print real tokens in logs;
- refactor package boundaries before proving the MVP works;
- change many unrelated files to rename `qwen` strings.

## Verification Commands

Run these before claiming success:

```bash
npm run typecheck --workspace=packages/core
npm run typecheck --workspace=packages/cli
npm run typecheck --workspace=packages/acp-bridge
```

Run targeted tests:

```bash
npm run test --workspace=packages/core -- \
  src/core/contentGenerator.test.ts \
  src/dp/nestorAuthHeader.test.ts \
  src/dp/dpTokenManager.test.ts \
  src/models/modelConfigResolver.test.ts

npm run test --workspace=packages/cli -- \
  src/config/auth.test.ts \
  src/acp-integration/authPreflight.test.ts \
  src/utils/acpModelUtils.test.ts
```

Build:

```bash
npm run build --workspace=packages/core
npm run build --workspace=packages/cli
npm run bundle
```

## If It Fails

Do not guess. Collect this information and report it exactly:

1. Git commit SHA:

   ```bash
   git rev-parse HEAD
   git status --short --untracked-files=all
   ```

2. Runtime versions:

   ```bash
   node --version
   npm --version
   uname -a
   ```

3. Exact command used to start the runtime.

4. Environment variable presence, with secrets redacted:

   ```text
   BLAZE_RUNTIME_TOKEN=<set/unset, do not print value>
   BLAZE_RUNTIME_ENTRY=<value, safe to print>
   BLAZE_DP_TOKEN=<set/unset, do not print value>
   DP_TOKEN=<set/unset, do not print value>
   BLAZE_DP_JWT=<set/unset, do not print value>
   NESSY_CLI_DP_AUTH_TOKEN=<set/unset, do not print value>
   BLAZE_NESTOR_MODEL=<value if set>
   BLAZE_NESTOR_BASE_URL=<value if set>
   BLAZE_NESTOR_SERVER_URL=<value if set>
   ```

5. Full stdout/stderr from `blaze-runtime serve`.

6. Health response:

   ```bash
   curl -i http://127.0.0.1:<port>/health
   curl -i -H "Authorization: Bearer <runtime-token>" \
     http://127.0.0.1:<port>/health
   ```

7. Preflight response:

   ```bash
   curl -s -H "Authorization: Bearer <runtime-token>" \
     http://127.0.0.1:<port>/workspace/preflight
   ```

8. Sandbox-specific information:
   - sandbox image name/tag;
   - sandbox service/job id;
   - exposed/proxied URL;
   - exposed port list;
   - command/entrypoint used by the sandbox;
   - whether the sandbox allows long-lived processes;
   - whether the sandbox proxy supports SSE/WebSocket;
   - container logs from startup to failure.

9. If Nestor auth fails:
   - HTTP status;
   - sanitized response body;
   - whether the failing path was `/api/v2/token` or OpenAI-compatible `/chat/completions`;
   - whether the token was `DP_TOKEN` exchange path or delegated JWT path.

10. If agent context is lost between prompts:
    - confirm whether the same daemon process stayed alive;
    - confirm whether the same ACP child stayed alive;
    - include session ids from responses/events;
    - include whether the caller used one session or created a new session.

## Expected Success Statement

Only say the MVP works when all of these are true:

1. `blaze-runtime serve` starts in the target environment.
2. `/health` returns 401 without token and 200 with token.
3. `/workspace/preflight` shows sane runtime/auth/entrypoint state.
4. A real prompt reaches Nestor/Qwen.
5. A second prompt in the same session preserves context.
6. The process is long-lived and not recreated per prompt.

If any item is not true, report which item failed and provide the diagnostics
listed above.
