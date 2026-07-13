# @qwen-code/rc-gateway

A self-hosted sidecar reverse-proxy that adds remote control to `qwen serve`.

## Overview

`rc-gateway` supervises an unmodified `qwen serve` Stage 1 daemon and sits in
front of it as the sole externally-bindable surface. It lets you start a
qwen-code coding session on a workstation and control it from any device —
phone, laptop, browser — without depending on a vendor relay.

The gateway owns everything a public-facing endpoint needs that the daemon
itself does not: TLS termination and certificate management, bind-address
security, authentication, CORS, chat/notification bridges, push delivery,
policy enforcement, cost accounting, and cross-session search. Plain session
traffic is proxied straight through to the daemon, which keeps running on
loopback exactly as it would in local-only use.

## Architecture

`rc-gateway` runs as a transparent proxy in front of a loopback-only
`qwen serve` process:

- The gateway claims the bare `/session/:id/*`, `/capabilities`, and
  `/workspace/*` namespace and proxies matching requests to the daemon.
- Every remote-control feature lives under `/rc/*`, entirely on the gateway
  side — the daemon is never modified and is not aware the gateway exists.
- The daemon binds to loopback only; the gateway is the one process allowed
  to bind a public address, and it validates that bind against an explicit
  bind-security policy (see `docs/bind-security.md`).
- State that must survive a restart — auth tokens, pending events, the audit
  log — is kept in a durable, append-only write-ahead log (WAL) with replay
  and bounded retention, so the gateway can recover cleanly after a crash or
  redeploy without losing in-flight notifications.

```
client (phone/laptop/browser)
        │  HTTPS (TLS via ACME or manual cert)
        ▼
   rc-gateway  ── /rc/*              → auth, CORS, bridges, push, policy,
                                        cost tracking, search, audit log
              └── /session/:id/*     ┐
                  /capabilities      ├─→ proxied to loopback qwen serve
                  /workspace/*       ┘
```

## Features

- **Authentication** — Argon2id-hashed tokens with a `qwk_` prefix, a 180-day
  maximum age, and sliding renewal on use.
- **Owner bootstrap** — one-time pairing codes issued on first `serve`,
  written to a 0600-permission file for local retrieval.
- **TLS** — automatic certificates via ACME (Let's Encrypt) or a manually
  supplied certificate/key pair.
- **CORS** — an allowlist derived from device pairing, gated by
  `Sec-Fetch-Site` to resist cross-origin abuse.
- **Audit log** — SHA-256 hash-chained entries (each record links to the
  previous via `prevHash`) with daily rotation, verifiable with
  `qwen-rc audit verify`.
- **Durable event WAL** — bounded retention with replay and
  truncation-recovery so notification/event delivery survives restarts.
- **Chat bridges** — Telegram, Discord, and Matrix (with E2EE), each
  supporting sub-actor identity and cardinality caps to prevent runaway fan-out.
- **Push delivery** — Web Push (VAPID) for browsers and native push (APNs)
  for mobile shells.
- **Policy engine** — YAML-defined rules to auto-approve or auto-deny tool
  calls, with `qwen-rc policy lint` / `policy explain` for authoring and review.
- **Notification routing** — per-subscription routing with quiet hours.
- **Cost tracking** — per-session usage attribution in integer microcents.
- **Cross-session search** — FTS5 full-text search with highlight offsets
  and session-lineage filtering.
- **Session forking** — fork a session with configurable transcript modes.
- **Sharing and convenience** — link sharing, custom slash commands, and
  idle-session suggestions.
- **LAN discovery** — mDNS/Bonjour advertisement and discovery of daemons on
  the local network.
- **Scopes** — a hierarchy of `owner > write > read`, plus dedicated `bridge`
  and `approve` scopes for narrower delegation.

## Prerequisites

- Node.js 22 or later
- npm
- A checkout of the qwen-code monorepo (this package depends on
  `@qwen-code/sdk` as a workspace package)

## Quick start

```bash
# 1. Install dependencies and build the SDK the gateway depends on
npm install
npm run build --workspace @qwen-code/sdk

# 2. Build rc-gateway
npm run build --workspace @qwen-code/rc-gateway

# 3. Start the gateway (supervises `qwen serve` on loopback and binds
#    the gateway on a public port)
npx qwen-rc serve
# or, without the bin link:
node packages/rc-gateway/dist/cli.js serve
```

On first run, a one-time pairing code is printed to stdout. Redeem it from a
client to obtain a bearer token, then use that token on every subsequent
request:

```
Authorization: Bearer qwk_<token>
```

## CLI reference

| Command                         | Description                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `qwen-rc serve`                 | Start the gateway: supervise a `qwen serve` daemon on loopback and bind the gateway on a public port. |
| `qwen-rc policy lint <file>`    | Lint a policy YAML file.                                                                              |
| `qwen-rc policy explain <file>` | Explain a policy's rules in plain language.                                                           |
| `qwen-rc routing rules`         | Show resolved notification routing rules.                                                             |
| `qwen-rc routing test`          | Test a routing rule against a simulated event.                                                        |
| `qwen-rc search <query>`        | Cross-session full-text search.                                                                       |
| `qwen-rc daemons discover`      | Discover `qwen serve` daemons on the LAN via mDNS/Bonjour.                                            |
| `qwen-rc audit verify`          | Verify audit log integrity by walking the SHA-256 `prevHash` chain.                                   |
| `qwen-rc usage`                 | Inspect recorded per-session cost/usage data.                                                         |
| `qwen-rc usage prune`           | Prune old usage records.                                                                              |
| `qwen-rc reindex`               | Rebuild the cross-session search index.                                                               |

A separate `qwen-rc-bridge` binary runs chat bridges (Telegram, Discord,
Matrix) as an isolated sidecar process; see `docs/bridge-sidecar.md`.

## Testing

```bash
npm test --workspace @qwen-code/rc-gateway
```

The suite covers auth, bind security, bootstrap, CORS, the audit log,
policy, routing, bridges, cost tracking, search, and the WAL — roughly 1,900
tests in total.

## Specs

Design and specification documents for remote control — including the
OpenSpec proposals this package implements — live in the
[`Qwen-Code-Remote`](https://github.com/InfiniteInsight/Qwen-Code-Remote)
repository. Package-local design notes for individual subsystems (ACME,
bind security, bridges, cost tracking, mDNS discovery, idle suggestions,
etc.) are under `docs/` in this package.

## License

Apache-2.0
