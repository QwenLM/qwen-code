# REST API integration guide

For teams building on Qwen Code as a backend: run the daemon as a standalone
process and drive it over HTTP, without the Web Shell UI.

- **Machine-readable contract**: [`qwen-serve-openapi.yaml`](./qwen-serve-openapi.yaml)
- **Full prose reference**: [`qwen-serve-protocol.md`](./qwen-serve-protocol.md)
- **Internals**: [Daemon deep dive](./daemon/00-index.md)

## Start the daemon

```bash
export QWEN_SERVER_TOKEN="$(openssl rand -hex 32)"

qwen serve \
  --no-web \
  --api-profile=minimal \
  --require-auth \
  --hostname 0.0.0.0 \
  --port 4170 \
  --workspace /srv/project
```

| Flag                    | Why                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--no-web`              | Don't serve the Web Shell SPA at the daemon root. API only.                                                          |
| `--api-profile=minimal` | Serve only the routes in the OpenAPI spec; everything else answers 404. See [API profiles](#api-profiles).           |
| `--require-auth`        | Require the bearer token on every route, including `/health`. Boot fails without a token.                            |
| `--hostname 0.0.0.0`    | Non-loopback binds always require a token. Put a TLS-terminating proxy in front, or pass `--tls-cert` / `--tls-key`. |

Pass the token via `QWEN_SERVER_TOKEN` rather than `--token`: a command-line
token is readable by any local user through `/proc/<pid>/cmdline`, while the
env var lives in `/proc/<pid>/environ`, which is owner-only.

### The daemon needs the CLI on its host

The daemon does not run inference in-process. It spawns `qwen --acp` child
processes and brokers between them and HTTP — so **the `qwen` executable must
be installed and on `PATH` inside the daemon's container or host.** A missing
entry point surfaces as `MissingCliEntryError`.

This is deliberate: each session's agent runs in its own process, so a crash or
runaway allocation is contained to one session instead of taking down the
daemon. Size the container for the daemon plus its concurrent children, and cap
concurrency with `--max-sessions`.

## API profiles

`--api-profile` selects how much of the HTTP surface exists:

| Profile          | Surface                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full` (default) | Every route the daemon registers. This is what the Web Shell drives; it changes with the UI and carries **no stability promise** for external callers. Not covered by the spec. |
| `minimal`        | Session lifecycle, prompting, the SSE stream, permission responses, and read-only workspace context — exactly the routes in `qwen-serve-openapi.yaml`.                          |

Build against `minimal`. Two reasons:

1. **Stability.** The spec is the contract, and a drift guard in CI fails the
   build if the profile and the spec disagree in either direction.
2. **Least privilege.** Every route shares one bearer token. Under `full`, a
   leaked token can change the workspace trust policy, install extensions, push
   git commits, and rewrite settings. `minimal` removes those routes entirely,
   so the blast radius is session operations.

Requests outside the profile get `404 {"code": "api_profile_disabled"}`. The
gate runs _after_ authentication, so an unauthenticated caller still gets a
uniform `401` and cannot map the enabled surface by comparing 401 against 404.

`GET /capabilities` reports the active profile as `apiProfile`.

> **Caveat on `features` under `minimal`.** The `features` array still lists
> every capability tag the build supports, so the usual "tag present means
> behavior present" rule from
> [capabilities versioning](./daemon/11-capabilities-versioning.md) does not
> hold. The OpenAPI spec is the authority on what is reachable. Preflighting a
> tag is still meaningful for routes _inside_ the profile.

## Minimal session flow

### 1. Preflight

```bash
curl -sH "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  http://daemon:4170/capabilities
```

Read `workspaceCwd` (so you can omit `cwd` when creating sessions) and
`policy.permission` (so you know who is allowed to answer permission requests).

### 2. Create a session

```bash
curl -sX POST http://daemon:4170/session \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sessionScope":"thread"}'
# → {"sessionId":"…","workspaceCwd":"/srv/project","attached":false}
```

Send `sessionScope: "thread"` for one independent conversation per caller. The
default `"single"` makes a second same-workspace create _reuse_ the existing
session, so unrelated callers end up sharing one FIFO — almost never what a
multi-tenant frontend wants.

### 3. Subscribe before prompting

```bash
curl -N http://daemon:4170/session/$SID/events \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -H 'Accept: text/event-stream' \
  -H 'Last-Event-ID: 0'
```

Subscribe first. `Last-Event-ID: 0` replays from the oldest retained event,
which is how you catch events fired between session creation and your
subscribe — notably `model_switch_failed`, the only signal that a bad
`modelServiceId` was rejected (the create itself still returns 200).

Each `data:` line is a complete envelope `{id, v, type, data}` on one line.

### 4. Prompt

```bash
curl -sX POST http://daemon:4170/session/$SID/prompt \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":[{"type":"text","text":"What does src/main.ts do?"}]}'
# → 202 {"promptId":"…","lastEventId":42}
```

`202` means admitted, not finished. Correlate `turn_complete` / `turn_error` on
the event stream by `promptId`. `turn_complete.data.stopReason` is one of
`end_turn`, `cancelled`, `max_tokens`, `error`, `length`.

### 5. Answer permission requests

When the agent wants to run a tool it emits a `permission_request` event. Until
someone answers, the turn is blocked — and it times out after 5 minutes by
default, resolving as cancelled.

```bash
curl -sX POST http://daemon:4170/permission/$REQUEST_ID \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"outcome":{"outcome":"selected","optionId":"proceed_once"}}'
```

Every connected client then sees `permission_resolved` with the same
`requestId`. If your integration runs unattended, decide up front how it
answers — an auto-approve policy is a security decision, not a default.

### 6. Close

```bash
curl -sX DELETE http://daemon:4170/session/$SID \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN"
# → 204
```

The on-disk session is retained and can be restored with
`POST /session/{id}/load`.

## Client libraries

Generate from [`qwen-serve-openapi.yaml`](./qwen-serve-openapi.yaml), or use
the maintained SDKs — note they target the `full` surface, so keep to the
methods that map to profile routes:

- [TypeScript](./sdk-typescript.md) — `@qwen-code/sdk`, `DaemonClient`
- [Python](./sdk-python.md) (alpha)
- [Java](./sdk-java.md) (alpha)

## Embedding in a Node process

If you'd rather host the app inside your own server than run a separate
process, the Express app factory is exported:

```ts
import { createServeApp } from '@qwen-code/qwen-code/serve';
```

This is a lower-level entry point than the CLI: you own the listener, the
bridge wiring, and the lifecycle. Note that `@qwen-code/qwen-code` is the CLI
package, so installing it pulls in the terminal UI dependency tree. For most
integrations the standalone process above is the better trade.

## Operations

| Concern          | Where to look                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Liveness         | `GET /health`                                                                                              |
| Concurrency caps | `--max-sessions`, `--max-total-sessions`; over-cap creates return `503` with `Retry-After`                 |
| Rate limiting    | `--rate-limit` plus the per-class `--rate-limit-*` flags                                                   |
| Idle cleanup     | `--session-idle-timeout-ms`; keep sessions alive with `POST /session/{id}/heartbeat`                       |
| Memory           | `--memory-budget-mb`, `--child-heap-mode` — the budget covers the daemon **and** its `qwen --acp` children |
| Prompt deadlines | `--prompt-deadline-ms`; expiry emits `turn_error` with `errorKind: "prompt_deadline_exceeded"`             |
| Errors           | [Error taxonomy](./daemon/18-error-taxonomy.md)                                                            |
| Observability    | [Observability](./daemon/19-observability.md)                                                              |

## Adding a route to the partner surface

1. Add the path to `MINIMAL_PROFILE_PATHS` in `packages/cli/src/serve/api-profile.ts`.
2. Document it in `docs/developers/qwen-serve-openapi.yaml`.

The drift guard in `packages/cli/src/serve/api-profile.test.ts` fails if you do
one without the other. It does **not** catch a new route added to neither —
that stays a review question.
