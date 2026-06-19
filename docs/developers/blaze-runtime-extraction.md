# Blaze runtime extraction boundary

This repository is being used as the starting point for a standalone Blaze agent
runtime. The first extraction stage intentionally keeps most of the existing
Qwen Code implementation in place and adds a narrow, separately runnable entry
point around the HTTP daemon plus ACP child process.

The goal of this stage is not a clean package split yet. The goal is to prove
that Blaze can start and own an agent runtime surface without depending on a
separate `qwen` executable as the public product boundary.

## What exists now

The new public entry point is:

```bash
blaze-runtime serve
```

It is wired in two places:

- root package bin: `package.json` -> `scripts/blaze-runtime-entry.js`
- CLI package bin: `packages/cli/package.json` -> `dist/src/blaze-runtime.js`

The root wrapper launches:

```bash
node --expose-gc dist/blaze-runtime.js ...
```

The compiled runtime entry is built from:

```text
packages/cli/src/blaze-runtime.ts
```

The top-level bundle is produced by:

```text
esbuild.config.js -> dist/blaze-runtime.js
```

## Why this is enough for the first boundary

`qwen serve` already has the right daemon shape for Blaze:

- one long-lived HTTP server bound to one workspace
- session creation over HTTP
- prompt streaming over SSE
- an ACP bridge between HTTP clients and the underlying agent
- one long-lived ACP child process that can keep agent/session state alive

The bridge spawns the ACP child using:

```text
process.execPath + process.argv[1] + --acp
```

That detail is the key reason the new entry point works. When the daemon is
started as `dist/blaze-runtime.js`, its ACP child is also started as
`dist/blaze-runtime.js --acp`. In other words, the daemon no longer needs to
find or call a public `qwen` binary for the inner agent process.

## Current process model

```text
Blaze / sandbox launcher
  -> blaze-runtime serve --workspace <workspace> --port <port>
      -> HTTP daemon
          -> ACP bridge
              -> blaze-runtime --acp
                  -> existing agent loop, tools, MCP, model client
```

The daemon process is the stable thing Blaze talks to. The ACP child is the
long-lived agent process that should survive across many prompts in the same
workspace session.

## What is intentionally still not clean

The first stage still reuses the existing monorepo internals:

- package names are still mostly `@qwen-code/...`
- many logs and help strings still say `qwen serve`
- most environment variables still use names like `QWEN_SERVE_*`
- serve tests and docs still describe the original Qwen surface

Two launcher-level aliases already exist for the Blaze-owned runtime contract:

- `BLAZE_RUNTIME_TOKEN`: daemon bearer token. Falls back to legacy
  `QWEN_SERVER_TOKEN`.
- `BLAZE_RUNTIME_ENTRY`: ACP child entrypoint override. Falls back to legacy
  `QWEN_CLI_ENTRY`, then `process.argv[1]`.

The first Blaze-owned model/auth adapter also exists:

- auth type: `dp-auth`
- default model: `tgpt/qwen3-next-80b-a3b-instruct`
- default base URL:
  `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1`
- exchange token env: `BLAZE_DP_TOKEN`, falling back to legacy `DP_TOKEN`
- delegated JWT env: `BLAZE_DP_JWT`, falling back to legacy
  `NESSY_CLI_DP_AUTH_TOKEN`
- Nestor URL overrides: `BLAZE_NESTOR_SERVER_URL`,
  `BLAZE_NESTOR_BASE_URL`, `BLAZE_NESTOR_MODEL`
- cache file: `~/.blaze-runtime/dp_auth_creds.json`, with read-only fallback
  to legacy `~/.nessy/dp_auth_creds.json`

This adapter is intentionally server/sandbox-oriented. It does not include the
Nessy interactive DP CLI/device-flow/downloader stack. In sandbox MVPs the
expected path is:

```text
BLAZE_DP_TOKEN or DP_TOKEN
  -> POST /api/v2/token at Nestor
  -> cached JWT
  -> OpenAI-compatible requests with Nestor auth headers
```

If `BLAZE_DP_JWT` or `NESSY_CLI_DP_AUTH_TOKEN` is supplied instead, the runtime
treats it as a delegated Spirit IAM JWT and sends `Authorization: Bearer`.
JWTs obtained from the DP token exchange are sent as `Nestor-Token`.

This is acceptable for stage 1 because the runtime behavior is the important
thing to prove first. Renaming everything now would create a huge diff without
making the boundary safer.

## Next cleanup stages

1. Keep `blaze-runtime` as the public launcher and use it in Docker/sandbox
   experiments.
2. Add a small Blaze-specific configuration layer for runtime branding and env
   names while keeping compatibility with the old Qwen env vars.
3. Use the new `dp-auth` adapter in the sandbox image and prove a real Nestor
   request through `blaze-runtime serve`.
4. Move the minimum needed packages into a smaller runtime package or repo once
   the dependency graph is known from real usage.
5. Only after the runtime is stable, rename internal diagnostics and docs from
   `qwen serve` to Blaze-owned terminology.

The important rule is: first isolate the executable surface, then isolate the
configuration/auth boundary, and only then physically split packages.
