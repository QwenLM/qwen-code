# Design — remote peers endpoint (`GET /rc/peers`)

**Goal:** Let an owner-authenticated remote client (phone/web) enumerate
sibling `_qwen-rc._tcp` daemons on the LAN over HTTP — the cross-daemon
switching case `add-mdns-discovery` deferred — without a terminal on the
workstation.

**Scope:** Entirely inside `packages/rc-gateway/`. No daemon change
(`packages/cli/src/serve`, `packages/core` untouched). Reuses the existing
`browseDaemons(...)` browse and the optional `bonjour-service` factory that
already backs the `qwen-rc daemons discover` CLI.

## Background: what already exists

- **`browseDaemons({ factory, timeoutMs }): Promise<DaemonRecord[]>`**
  (`mdns/browser.ts`) runs a one-shot, time-boxed browse of
  `_qwen-rc._tcp.local.`, returning `DaemonRecord`s **normalized, deduped by
  service name, and sorted by host then port**. It never throws on an empty
  LAN (returns `[]`) and always tears down its socket.
- **`DaemonRecord`** (`mdns/advert.ts`): `{ name, host, port, version,
tlsRequired, workspace }` — LAN discovery metadata (the `workspace` is the
  operator-chosen advertised label).
- **`loadBonjourFactory(): Promise<BonjourFactory | null>`** (`cli.ts`)
  dynamically imports the OPTIONAL `bonjour-service` dependency, returning
  `null` when it isn't installed. The CLI's `daemons discover` subcommand
  already composes these two: load the factory (null → "needs the optional
  bonjour-service dependency"), then `browseDaemons`.
- **Prior decision:** `add-mdns-discovery`'s design (§ "Alternative
  considered") explicitly deferred a `GET /rc/peers` helper endpoint,
  reasoning that discovery is for _finding_ a daemon you are not yet
  connected to, and leaving the connected-client helper to
  `add-multi-workspace-client` "to consider explicitly." This change realizes
  that endpoint for the cross-daemon switching use case and supersedes that
  deferral.

## Endpoint

`GET /rc/peers`, **`owner`** scope, gateway-global. On success responds
`200 { peers: DaemonRecord[] }` — the `browseDaemons(...)` result verbatim
(already normalized, deduped, sorted). An empty LAN is a normal `200 {
peers: [] }`, never an error. The handler runs one mDNS browse per request
against the gateway's own default browse window (the same default constant
the `daemons discover` CLI uses); the endpoint is therefore intentionally
slow (~1 browse window), inherent to mDNS.

`owner` because the response is LAN reconnaissance (hosts/ports/workspace
labels of every advertising daemon), matching the other global admin
surfaces (`/rc/share`, `/rc/audit`).

## Components & wiring

The route does not know about `bonjour-service`; it depends on an injected
browse capability, mirroring how P4's `/policy/explain` route received live
policy access:

- **`GatewayDeps.browsePeers?: (timeoutMs: number) => Promise<DaemonRecord[]
| null>`** — resolves the discovered peers, or **`null`** when mDNS is
  unavailable (the optional `bonjour-service` dependency isn't installed).
- **`cli.ts`** provides it: lazily `loadBonjourFactory()`, and if the factory
  is present, `browseDaemons({ factory, timeoutMs })`; if the factory is
  `null`, return `null`.
- **`createPeersRoute(browsePeers): RequestHandler`** (`routes/peers.ts`):
  - `await browsePeers(DEFAULT_TIMEOUT)` → `null` ⇒ **`503 { error, code:
'mdns_unavailable' }`** (mirrors the CLI's missing-dependency message).
  - otherwise ⇒ **`200 { peers }`**.
  - a top-level try/catch maps an unexpected browse failure to **`500 {
code: 'peers_unavailable' }`** (guarded by `!res.headersSent`), matching
    the other route factories' shape.
- **Mount** (`server.ts`): `app.get('/rc/peers', requireScope(OWNER, audit),
createPeersRoute(deps.browsePeers))`, guarded by `if (deps.browsePeers)` so
  `createGatewayApp` call sites (and existing tests) that don't supply it are
  unaffected. Gateway-global — no `:id`, no session middleware.

## Error handling

| Condition                               | Response                                   |
| --------------------------------------- | ------------------------------------------ |
| Peers discovered (incl. none)           | `200 { peers: [...] }`                     |
| mDNS unavailable (no `bonjour-service`) | `503 mdns_unavailable`                     |
| Unexpected browse failure               | `500 peers_unavailable`                    |
| Non-owner token                         | `403` (at the `requireScope(OWNER)` mount) |

## Security

- Confined to `packages/rc-gateway/`; daemon untouched; no daemon call.
- `owner`-only; read-only; no mutation, no state change.
- Response carries only LAN discovery metadata (host/port/version/tls/
  operator label) — no session or tool content; it is a request/response,
  not a broadcast sink.

## Spec artifacts (qwen-code-remote)

Ships as OpenSpec change `add-remote-peers` (proposal, design, tasks,
`specs/remote-peers/spec.md` — one ADDED requirement with scenarios for the
owner success path, empty-LAN `200 []`, the `503` when mDNS is unavailable,
and the `403` for a non-owner token). No shared-registry edit: routes are
documented as per-endpoint requirements, and this change adds no SSE event,
notification kind, or audit action. Prose notes the supersession of
`add-mdns-discovery`'s deferral.

## Implementation phasing (fork, `packages/rc-gateway`)

- **B — route factory.** `routes/peers.ts` `createPeersRoute(browsePeers)`
  - unit tests (stub `browsePeers`: records → 200 shape/order; `null` → 503;
    throw → 500).
- **C — wiring + integration.** `GatewayDeps.browsePeers`, the owner mount in
  `server.ts`, and the cli.ts provider (`loadBonjourFactory` →
  `browseDaemons`); integration test via real `createGatewayApp` with an
  injected `browsePeers` stub (owner 200; `null` → 503; write-scope → 403).
