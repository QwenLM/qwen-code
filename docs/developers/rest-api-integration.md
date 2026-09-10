# REST API integration guide

For teams putting Qwen Code inside their own product over HTTP: run `qwen serve`
as a backend and drive it from your own front end.

This page is the entry point. The full route reference is
[`qwen-serve-protocol.md`](./qwen-serve-protocol.md); the internals are the
[daemon deep dive](./daemon/00-index.md); a runnable TypeScript walkthrough is
[`examples/daemon-client-quickstart.md`](./examples/daemon-client-quickstart.md).

## Which paths exist

Six ways to build on the daemon, separated by one question — **how much of the
front end do you own?**

| Path                                 | You own                           | Status                                                                                                                                                                                                                         |
| ------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| daemon + bundled Web Shell           | nothing — use it as shipped       | ships today ([user guide](../users/qwen-serve.md))                                                                                                                                                                             |
| daemon `--no-web` + your own UI      | the entire front end              | ships today — **this page**                                                                                                                                                                                                    |
| daemon + branded Web Shell           | branding, not code                | not built ([#11357](https://github.com/QwenLM/qwen-code/issues/11357))                                                                                                                                                         |
| daemon + self-hosted Web Shell build | the front-end build               | not built ([#11358](https://github.com/QwenLM/qwen-code/issues/11358))                                                                                                                                                         |
| daemon via SDK `DaemonClient`        | client code, never raw HTTP       | ships today ([TS](./sdk-typescript.md), [Java](./sdk-java.md)) — the [Python SDK](./sdk-python.md) is process-transport-only and has no daemon client, so a Python integration drives path 2 over raw HTTP                     |
| daemon via MCP bridge                | nothing — another agent drives it | ships as `qwen-serve-mcp` in `@qwen-code/sdk` — see the [bridge README](../../packages/sdk-typescript/src/daemon-mcp/serve-bridge/README.md); `QWEN_BRIDGE_ALLOW_GLOBAL_SCOPE` optionally permits global-scope write mutations |

Headless `qwen -p` and ACP over stdio for editors are separate integration
paths. Channels and extensions can also run through the daemon; see the
[channel guide](../users/features/channels/overview.md) and
[Extension reference](./qwen-serve-protocol.md#extension-management-v2-wire-contract).

## Two things to know before designing

**The daemon does not run inference in-process.** It spawns `qwen --acp` child
processes and brokers between them and HTTP. It runs the CLI entry script under
the same Node binary, using `QWEN_CLI_ENTRY` or otherwise `process.argv[1]`.
An embedding Node backend must point `QWEN_CLI_ENTRY` at the installed Qwen CLI
entry script; there is no `qwen` lookup on `PATH`. A missing entry point surfaces
as `MissingCliEntryError`.

In steady state there is **one child per active workspace runtime**, not one per
session. Every session in a workspace multiplexes onto that child and shares its
process, OAuth state, file cache and hierarchy-memory parse. So the fault domain
is the workspace: if the child exits, every session multiplexed onto it is torn
down together. Size the container for the daemon plus one child per registered
workspace, with headroom for one extra child per runtime during a channel swap.
When sessions must fail independently, run separate daemons —
`--max-sessions` caps concurrency, not blast radius.

**Authentication is single-operator.** The runtime bearer token grants the
whole bearer-gated API, and a trusted loopback caller gets full authority
including code execution as the daemon user. There is no per-end-user principal
model. If you are putting
this behind a multi-user product, your backend owns user identity and must not
hand the daemon token to browsers. Containerised and multi-tenant deployment
are explicitly deferred — see "v0.16-alpha known limits" in the
[user guide](../users/qwen-serve.md).

Configured channel webhook ingress (`POST /channels/:channelName/webhooks/:source`)
uses its own `x-qwen-webhook-secret` authentication before bearer
authentication; it is inert until a channel webhook source is configured.

## Start the daemon

```bash
export QWEN_SERVER_TOKEN="$(openssl rand -hex 32)"

qwen serve --no-web --require-auth \
  --hostname 0.0.0.0 --port 4170 \
  --workspace /srv/project
```

`--no-web` preserves the routes listed below, but disables Web Shell assets and
dependent surfaces: on macOS the `/live/*` routes and `/live/host` socket, and on
every platform `GET /mcp-app-sandbox`. Pass the token by environment rather than
`--token`, which is readable by any local user through `/proc/<pid>/cmdline`.

The Bash examples below pass the Authorization header through a file descriptor
using the shell's `printf` builtin, keeping the token out of curl's arguments.

## The routes an integration actually uses

Most of what the daemon registers exists to drive the Web Shell — git
operations, extension install, workspace trust, voice, scheduled tasks — and
changes with that UI. The subset below is an order of magnitude smaller.

These are the ones a REST integration needs. Treat the rest as internal.

### Discovery

| Route                                                            | Purpose                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`GET /health`](./qwen-serve-protocol.md#get-health)             | Liveness probe                                                               |
| [`GET /capabilities`](./qwen-serve-protocol.md#get-capabilities) | Preflight — read `workspaceCwd` and `policy.permission` before anything else |

### Session lifecycle

| Route                                                                                                                                | Purpose                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| [`POST /session`](./qwen-serve-protocol.md#post-session)                                                                             | Create. Send `sessionScope: "thread"` for an independent conversation |
| [`DELETE /session/:id`](./qwen-serve-protocol.md#delete-sessionid)                                                                   | Close. The persisted session survives and can be reloaded             |
| [`POST /session/:id/load`](./qwen-serve-protocol.md#post-sessionidload) · [`/resume`](./qwen-serve-protocol.md#post-sessionidresume) | Restore a persisted session                                           |
| [`POST /session/:id/heartbeat`](./qwen-serve-protocol.md#post-sessionidheartbeat)                                                    | Defer the idle reaper                                                 |
| [`PATCH /session/:id/metadata`](./qwen-serve-protocol.md#patch-sessionidmetadata)                                                    | Session metadata                                                      |
| [`POST /session/:id/model`](./qwen-serve-protocol.md#post-sessionidmodel)                                                            | Switch model within the bound service                                 |
| `GET /session/:id/status`                                                                                                            | Runtime status — _no dedicated reference section yet_                 |

### Prompting and streaming

| Route                                                                             | Purpose                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [`POST /session/:id/prompt`](./qwen-serve-protocol.md#post-sessionidprompt)       | Submit. Returns `202` on **admission**, not completion |
| [`POST /session/:id/cancel`](./qwen-serve-protocol.md#post-sessionidcancel)       | Cancel the active prompt only                          |
| [`GET /session/:id/events`](./qwen-serve-protocol.md#get-sessionidevents-sse)     | SSE stream. Subscribe **before** prompting             |
| [`GET /session/:id/transcript`](./qwen-serve-protocol.md#get-sessionidtranscript) | Conversation history                                   |
| [`GET /session/:id/context`](./qwen-serve-protocol.md#get-sessionidcontext)       | Context window usage                                   |
| `GET /session/:id/export` · `GET /session/:id/pending-prompts`                    | _No dedicated reference sections yet_                  |

### Permissions

| Route                                                                              | Purpose                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /session/:id/permission/:requestId`                                          | Answer a `permission_request`. Routed to the runtime that owns the session, so it is correct in every workspace state — _no dedicated section yet_                                                                                                                                          |
| [`POST /permission/:requestId`](./qwen-serve-protocol.md#post-permissionrequestid) | Process-global form, wired to the **primary** workspace's bridge only: it `404`s for a session owned by another registered runtime, with the same body as a lost vote under the default `first-responder` policy — so a `404` here does not by itself mean the request was already answered |

### Read-only workspace context

| Route                                                                                                      | Purpose                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`GET /file`](./qwen-serve-protocol.md#get-file) · [`/file/bytes`](./qwen-serve-protocol.md#get-filebytes) | Read a file, or a byte range                                                                                                                                     |
| `GET /stat` · `GET /list` · `GET /glob`                                                                    | Path metadata, directory listing, glob — _no dedicated sections yet_                                                                                             |
| `GET /workspace/tools`                                                                                     | Tools reported by the live ACP child; without one, the response has `acpChannelLive: false`, `tools: []`, and a `not_started` error — _no dedicated section yet_ |

> **Reference coverage.** 17 of the 25 routes above have dedicated sections.
> Of the 8 marked otherwise, some are mentioned only in passing and three are
> absent entirely: `GET /session/:id/pending-prompts`,
> `POST /session/:id/permission/:requestId`, and `GET /workspace/tools`.
> Closing that gap is tracked in
> [#11359](https://github.com/QwenLM/qwen-code/issues/11359).

## Minimal flow

**1. Preflight.** Read `workspaceCwd` (so you can omit `cwd` on create) and
`policy.permission` (so you know who may answer permission requests).

```bash
curl -sH @<(printf 'Authorization: Bearer %s\n' "$QWEN_SERVER_TOKEN") http://daemon:4170/capabilities
```

**2. Create a session.** Use `sessionScope: "thread"` unless callers are meant
to share one conversation — the default `"single"` makes a second
same-workspace create _reuse_ the existing session, serialising unrelated
callers through one queue.

```bash
curl -sX POST http://daemon:4170/session \
  -H @<(printf 'Authorization: Bearer %s\n' "$QWEN_SERVER_TOKEN") -H 'Content-Type: application/json' \
  -d '{"sessionScope":"thread"}'
# → {"sessionId":"…","workspaceCwd":"/srv/project","attached":false}
```

**3. Subscribe before prompting.** `Last-Event-ID: 0` replays from the oldest
retained event, which is how you catch events fired between create and
subscribe — notably `model_switch_failed`. On an **attach** (the default
`sessionScope: "single"` reusing an existing session) that event is the only
signal that a bad `modelServiceId` was rejected, because the failure is
deliberately not propagated as an HTTP error. On a **fresh create** that carries
`modelServiceId` — which step 2's body does not — the `200` body also carries
`modelApplied`, `false` when the switch was rejected, and that is the
deterministic one to act on rather than an event on a bounded ring. A create
without `modelServiceId` has no `modelApplied` key at all.

```bash
curl -N http://daemon:4170/session/$SID/events \
  -H @<(printf 'Authorization: Bearer %s\n' "$QWEN_SERVER_TOKEN") \
  -H 'Accept: text/event-stream' -H 'Last-Event-ID: 0'
```

Each `data:` line is a full envelope on one line; the envelope's `type` matches
the `event:` line.

Replay is limited by `--event-ring-size` and a fixed 8 MiB per-subscription byte
budget. If the stream emits `state_resync_required` with
`reason: "replay_budget_exceeded"`, recover through `POST /session/:id/load`
instead of treating the replay as complete.

**4. Prompt.** `202` means admitted, not finished. Correlate `turn_complete` /
`turn_error` on the stream by `promptId`. Read `stopReason` on `turn_complete`;
on `turn_error`, read `message` and any optional `code` / `errorKind` — see
[`POST /session/:id/prompt`](./qwen-serve-protocol.md#post-sessionidprompt).

```bash
curl -sX POST http://daemon:4170/session/$SID/prompt \
  -H @<(printf 'Authorization: Bearer %s\n' "$QWEN_SERVER_TOKEN") -H 'Content-Type: application/json' \
  -d '{"prompt":[{"type":"text","text":"What does src/main.ts do?"}]}'
# → 202 {"promptId":"…","lastEventId":42}
```

**5. Answer permission requests.** When the agent wants to run a tool _and its
approval mode asks for confirmation_, it emits `permission_request` and the turn
blocks until someone answers or you cancel — **by default there is no timeout**
(`--permission-response-timeout-ms` defaults to `0` = wait indefinitely), so an
unanswered request keeps holding a slot in the session's prompt queue until you
cancel or close the session. Arm your own deadline if the flow needs one.

The mode is the child's own Qwen setting `tools.approvalMode`, resolved from the
daemon host's and the `--workspace` directory's settings; the daemon pins
nothing at spawn. Its default is `auto`, which approves one class of tool calls
without asking — those publish no `permission_request` at all — and still asks
for the rest. An untrusted workspace folder is forced down to `default` (ask),
which is why one deployment sees these events and another sees none, and
`GET /capabilities` reports the vote-mediation policy rather than the approval
mode, so preflight will not tell you which posture you are in. If your
integration depends on approval gating, pin `tools.approvalMode` explicitly and
decide up front how it answers: auto-approval can already be in effect without
anyone having chosen it.

Answer on the session-scoped route: it is routed to the runtime that owns the
session, so it works whatever the workspace configuration.

```bash
curl -sX POST http://daemon:4170/session/$SID/permission/$REQUEST_ID \
  -H @<(printf 'Authorization: Bearer %s\n' "$QWEN_SERVER_TOKEN") -H 'Content-Type: application/json' \
  -d '{"outcome":{"outcome":"selected","optionId":"proceed_once"}}'
```

**6. Close.** `DELETE /session/$SID` → `204`. The on-disk session is retained.

## Operations

| Concern          | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrency caps | `--max-sessions`, `--max-total-sessions`; over-cap creates return `503` with `Retry-After`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Rate limiting    | `--rate-limit` plus the per-class `--rate-limit-*` flags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Idle cleanup     | `--session-idle-timeout-ms`; keep alive with `POST /session/:id/heartbeat`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Memory           | `--child-heap-mode` is observe-only. `--memory-budget-mb` controls the adaptive live-journal growth pool for `POST /session/:id/load`, not SSE replay; pinning either `--max-journal-bytes` or `--max-journal-events` disables growth. Neither flag sizes children or refuses spawns, nor governs their actual heap ceiling (`--max-old-space-size`, derived from host memory). See [Configuration](./daemon/17-configuration.md) for budget calculation. SSE replay is separately bounded by `--event-ring-size` and a fixed 8 MiB per-subscription budget; an omitted tail produces `state_resync_required` with `reason: "replay_budget_exceeded"` |
| Prompt deadlines | `--prompt-deadline-ms`; expiry emits `turn_error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Errors           | [Error taxonomy](./daemon/18-error-taxonomy.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Observability    | [Observability](./daemon/19-observability.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Full flag list   | [Configuration](./daemon/17-configuration.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
