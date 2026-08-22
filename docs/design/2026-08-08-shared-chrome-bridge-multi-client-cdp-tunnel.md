# Shared Chrome bridge: multi-client `/cdp` tunnel + interactive CLI routing

Fixes the per-session Chrome "Allow remote debugging?" consent dialog reported
in issue #8737.

## Problem

Chrome requires consent **per new client connection** to its remote-debugging
endpoint (no "remember" option). Each interactive Qwen Code process builds its
own `McpClientManager` and spawns one `chrome-devtools-mcp` stdio child per
session (`packages/core/src/tools/tool-registry.ts` constructs it with
`pool: undefined` outside daemon mode), and each child dials Chrome lazily on
the first browser tool call. Dialog count = process count; the MCP health
monitor's `autoReconnect` adds more on transport drops.

The dialog-free equivalent already ships for daemon mode: the Chrome extension
reverse CDP tunnel (`/cdp` puppeteer endpoint tunneled over `/acp` as `cdp_*`
frames, driven through `chrome.debugger`). It is single-puppeteer-client by
design (`CdpBridgeEndpoint.cdpBound` rejects a second `/cdp` client), and the
interactive CLI has no daemon detection at all.

## Fix

1. Make the daemon `/cdp` tunnel multi-client: each puppeteer connection gets
   its own reverse link identified by a `linkId` carried on `cdp_*` frames.
2. Extend the extension `cdp-bridge` to route by `linkId` and refcount the
   single `chrome.debugger` attachment across links.
3. Let the interactive CLI (interactive UI, headless `-p`, editor `--acp`)
   detect a running daemon with a live multi-client bridge and reroute a
   user-configured `chrome-devtools` MCP server from `--autoConnect` to
   `--wsEndpoint ws://<daemon>/cdp`.

All sessions then share the extension's single long-lived `chrome.debugger`
attachment: no remote-debugging consent dialog, once per daemon/extension
lifetime instead of once per session.

## Trust boundary and assumptions

- `/cdp` keeps its existing loopback + host-allowlist + optional-bearer checks
  (acp-http upgrade listener). Multi-client does not widen the surface: a
  single local client could already bind the tunnel and drive the tab.
- `linkId` on inbound frames is untrusted input. It is validated as a short
  string and used only as a routing key; frames carrying an unknown `linkId`
  are dropped (logged), never executed.
- Arbitrary-CDP exposure stays bounded by the channel, as today (see the trust
  note in `packages/chrome-extension/src/background/cdp-bridge.ts`): no method
  allowlist is added.
- The extension path requires the user to have installed the extension
  (explicit consent); Chrome still shows its "started debugging this browser"
  banner while attached.

## Protocol changes (backward compatible)

`linkId?: string` is added to `cdp_attach`, `cdp_command`, `cdp_release`
(daemon → extension) and `cdp_result`, `cdp_attached` (extension → daemon).
`cdp_event` stays untagged and is broadcast to every link. `cdp_detach` is
tagged for links that held the detached tab; legacy frames remain untagged.

Negotiation: the extension's ACP `initialize` carries
`clientInfo.cdpMultiClient: true`. The daemon records this on the registered
`CdpBridgeEndpoint` (`multiClient`). A legacy extension (no flag) keeps
exact single-client semantics: the second `/cdp` connection is rejected as
before. A new extension against an old daemon (no `linkId` on frames) treats
the absent `linkId` as the single default link.

## Entry points that receive the fix

- `packages/cli/src/serve/cdp-tunnel/cdp-tunnel-registry.ts` — endpoint gains
  `multiClient` and a link registry; `routeInbound` dispatches tagged
  `cdp_result`/`cdp_attached`/`cdp_detach` frames to the owning link and
  broadcasts `cdp_event` to all links; legacy (single-link) routing is preserved
  for non-multi-client bridges.
- `packages/cli/src/serve/cdp-tunnel/cdp-ws.ts` — `attachCdpClient` acquires a
  link instead of setting exclusive `cdpBound`; per-link teardown on socket
  close; all-links teardown when the extension bridge is superseded/dropped.
- `packages/cli/src/serve/cdp-tunnel/cdp-reverse-link.ts` — outbound frames
  carry the link's `linkId`.
- `packages/cli/src/serve/acp-http/index.ts` — reads `clientInfo.cdpMultiClient`
  at bridge registration; exposes bridge state to the status route.
- New `GET /cdp/status` (registered next to `/capabilities`): returns
  `{ enabled, bridgeConnected, multiClient, usable }` where
  `usable = bridgeConnected && multiClient && !bearerToken` (a token-gated
  daemon's `/cdp` requires auth a plain puppeteer client cannot supply).
- `packages/chrome-extension/src/background/cdp-bridge.ts` — per-link attach
  refcount over the single `chrome.debugger` attachment; results/acks tagged
  with the requesting `linkId`; events broadcast and detach notices target
  links that held the tab; `cdp_release` decrements and detaches only when the
  last link releases; absent `linkId` maps to the default link (old-daemon
  compat). Tab-switch semantics are unchanged (attach targets the active tab;
  switching tabs detaches the previous one and notifies its links).
- `packages/cli/src/gemini.tsx` + new
  `packages/cli/src/config/shared-chrome-bridge.ts` — after `loadCliConfig`,
  before `config.initialize()`: probe
  `${QWEN_DAEMON_URL || http://127.0.0.1:4170}/cdp/status` (bounded, ~750 ms
  timeout); when `usable`, rewrite a stdio `chrome-devtools` server whose args
  contain `--autoConnect` (dropping `--autoConnect`, adding/replacing
  `--wsEndpoint ws://<host>:<port>/cdp`) via `config.setMcpServers`. Covers
  interactive, headless, and editor-ACP child processes; the daemon serve path
  (`acpAgent.ts`) is untouched.

## Fail-open / fail-closed

- CLI probe fails, bridge absent, legacy extension, or bearer-token daemon →
  the user's original `--autoConnect` config is used unchanged (fail-open to
  today's behavior).
- Daemon with a legacy extension → second `/cdp` client rejected exactly as
  before (fail-closed compatibility).
- Opt-out: `QWEN_NO_SHARED_CHROME_BRIDGE=1` disables the CLI reroute.

## Primitives considered before adding new ones

- `linkId` reuses the existing frame-correlation pattern (like `id`); no new
  protocol version handshake — presence is negotiated through the existing
  `clientInfo` field of the ACP `initialize` the extension already sends.
- The status endpoint reuses the plain GET route pattern of `/capabilities`;
  no new auth mechanism.
- The CLI reroute reuses `Config.setMcpServers` instead of a new config layer;
  settings hot-reload re-assembles from user settings, which restores the
  user's literal config (documented, restart reapplies the reroute).

## Regression points

- Daemon unit: two concurrent `/cdp` clients on a multi-client bridge get
  independent routing (fails before: second client rejected).
- Daemon unit: legacy bridge keeps single-client rejection.
- Extension unit: two links share one debugger attach; detach only after the
  last `cdp_release`; results tagged per link.
- CLI unit: reroute applies only to `--autoConnect` chrome-devtools config
  when the bridge is usable; unchanged otherwise.
- Manual: real Chrome + extension + two concurrent qwen sessions — one
  debugging banner, zero remote-debugging consent dialogs.
