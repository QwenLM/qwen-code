# Matrix bridge

The Matrix bridge lets a team approve tool calls and send prompts to a qwen
session from a Matrix room — voting with 👍/👎 **reactions** (Matrix has no
inline buttons). It is the third conformant consumer of the `add-bridge-protocol`
contract (after Telegram and Discord) and runs **in-process** inside the gateway,
talking the gateway only over the loopback HTTP+SSE contract with an
operator-minted bridge-scope token — so it can be promoted to a separate-process
sidecar later by changing only its configuration.

> **Placement note.** The change spec proposes a standalone
> `packages/bridge-matrix/` package and `docs/bridges/matrix.md`. To honor this
> fork's zero-edit boundary (everything lives under `packages/rc-gateway/`), the
> bridge is built in-process at `src/bridges/matrix/` and this doc lives here.

> **Encrypted rooms: supported when `MATRIX_ENABLE_E2EE` is set (sidecar path).**
> By default (flag off) the bridge talks the plain client-server API over `fetch`
> and **refuses to bind** an encrypted room (posts a notice). With the flag on, the
> `matrix-bot-sdk` + olm crypto adapter becomes the bridge's transport: it owns
> `/sync` (subsuming the fetch loop), decrypts encrypted rooms transparently, and
> sends encrypted replies. This full path is **verified end-to-end against a real
> Synapse** (see "End-to-end encryption" below). The flag is honored on both the
> standalone sidecar (`qwen-rc-bridge matrix`) and the in-process bridge (both
> construct via the shared `startBridge`).

## What it does

- Renders each `permission_request` into a room message; the inline surface
  appends "React 👍 to approve, 👎 to deny."
- Turns a 👍/👎 reaction on that message into a gateway vote, attributed to the
  reacting user (👍🏽 / 👍️ skin-tone and variation-selector forms are matched).
- Forwards non-command room messages in a bound room to the session as prompts.
- Edits the original message (via `m.replace`) with the outcome on resolve.
- Sensitive/oversized calls render an "Open in web client" link instead and are
  NOT reaction-votable.

## Setup

### 1. Create a bot user + access token

1. Create a regular Matrix user for the bot on your homeserver (e.g.
   `@qwenbot:home.example.com`) — manual registration or the Synapse admin API.
2. Log in once (e.g. via Element, or a `POST /_matrix/client/v3/login`) and copy
   the **access token** (`MATRIX_ACCESS_TOKEN`).

### 2. Mint a bridge token

```
POST /rc/tokens  { "scopes": ["bridge"] }   # requires an owner token
```

Set the returned `qwk_*` value as `QWEN_BRIDGE_TOKEN`.

### 3. Configure and run

The bridge starts when the gateway boots **and** all required env vars are
present **and** `whoami` confirms the access token resolves to `MATRIX_USER_ID`:

| Variable                | Required | Notes                                                             |
| ----------------------- | -------- | ----------------------------------------------------------------- |
| `MATRIX_HOMESERVER_URL` | yes      | e.g. `https://home.example.com`.                                  |
| `MATRIX_USER_ID`        | yes      | The bot's fully-qualified MXID, e.g. `@qwenbot:home.example.com`. |
| `MATRIX_ACCESS_TOKEN`   | yes      | From a one-time login.                                            |
| `QWEN_BRIDGE_TOKEN`     | yes      | A `bridge`-scope token minted as above.                           |
| `MATRIX_COMMAND_PREFIX` | no       | Default `!qwen`.                                                  |
| `QWEN_DAEMON_URL`       | no       | User-reachable gateway URL for deeplinks; falls back to loopback. |

If the homeserver creds are set but `QWEN_BRIDGE_TOKEN` is missing, or if the
access token's MXID does not match `MATRIX_USER_ID`, the gateway logs a warning
and does **not** start the bridge (it never kills the gateway).

## Usage

### Binding a room

Binding is **operator-issued**. First, on the workstation, mint a one-time invite
for the session you want to expose:

```
curl -s -X POST http://127.0.0.1:4170/rc/bridges/invites \
  -H "Authorization: Bearer <OWNER token>" \
  -H 'content-type: application/json' \
  -d '{"kind":"matrix","sessionId":"<session id>"}'
# → { "token": "inv_…", "expiresAt": … }
```

Then:

1. Invite the bot (`@qwenbot:…`) to an **unencrypted** room — it auto-joins.
2. A room member with **power level ≥ 50** (Moderator) posts:

   ```
   !qwen attach <invite token>
   ```

The bridge redeems the token via `POST /rc/bridges/:id/invite/redeem` and binds
the room to the session the token names — a member never types a session id. An
invalid or expired token is refused with the gateway's error text (no binding).
`!qwen detach` (also power ≥ 50) unbinds; `!qwen status` reports the binding. A
non-moderator attach is refused ("Permission denied: attach requires power level
≥ 50") **before** any redeem; an attach in an encrypted room is refused with the
E2EE notice, also before redeem.

Invites are one-time and short-lived (20 min), held in gateway memory — a restart
drops any unredeemed invite, so just mint a fresh one.

### Sending prompts and voting

Type in chat (non-command messages) to send a prompt. When the agent requests
permission, react 👍 (approve) or 👎 (deny) on the bridge's message. The bridge
posts your vote and, on resolution, edits the message to show the outcome. Voting
is first-responder-wins (resolved daemon-side); the bridge does not tally
reactions.

### Sub-actor identity

Every prompt and vote carries `X-RC-SubActor: matrix:<fully-qualified-mxid>` (the
homeserver suffix is preserved — federation makes `@a:x` and `@a:y` distinct
users). This is what the gateway's per-sub-actor rate limit and bans key on.

## Bans

```
POST /rc/bridges/matrix/ban   { "subActor": "matrix:@spammer:other.org" }
```

The bridge also caches any `403` the gateway returns and drops that user's later
messages and reactions locally (reactions are dropped, never redacted).

## Token rotation

Rotate the bot access token and the bridge token together if either leaks:

- **Access-token leak:** log the bot out on the homeserver (invalidating the
  token) **and** revoke the bridge token.
- **Bridge-token leak:** revoke via `DELETE /rc/tokens/:id`; the audit log
  pinpoints anything it did.

Room bindings live in `~/.qwen/rc/bridges/matrix/rooms.json` and survive a
restart.

## Streaming

As the agent works, its reply (`session_update`) is streamed into the bound
room. Chunks are buffered and flushed on a paragraph break / fenced-code close,
at 16384 bytes, or 1500 ms after the last chunk. Each flush is sent as an
`m.room.message` with `msgtype: "m.text"`, the raw Markdown as `body`, and a
rendered HTML `formatted_body` (`format: "org.matrix.custom.html"`) produced by a
small built-in Markdown converter (bold, italic, inline/fenced code, links, line
breaks — everything else HTML-escaped; no CommonMark dependency). Matrix's
65536-byte event limit is ~4× the flush threshold, so a flush is a single event
(no splitting). After 6 messages in one agent turn, the 7th and later carry an
`m.relates_to { rel_type: "m.thread", event_id: <first message> }` relation,
keeping the room readable; a new turn (after a resolve, or the next inbound
prompt) starts back in the room timeline.

## End-to-end encryption (live-wired; verified against a real Synapse)

E2EE is a **second transport, opt-in and OFF by default** (`MATRIX_ENABLE_E2EE`).
The tested fetch path stays the default for plain rooms, so enabling crypto can
never destabilize the working unencrypted bridge.

**The subsume model.** When the flag is on and the adapter builds, `startBridge`
makes the `matrix-bot-sdk` crypto client the bridge's transport: it owns the single
`/sync` and the runner's fetch `/sync` is **subsumed** (`runInbound` replaces
`syncLoop`). This is not a style choice — two `/sync` loops on one access
token/device would race for the device-global **to-device** events that carry the
megolm room keys, so a second syncer starves the crypto client and decrypts fail
intermittently. The SDK client also becomes the **outbound** transport
(`sendMessage` → `sendEvent`), which encrypts iff the room is encrypted — so no
permission prompt, command reply, or streamed prose ever lands as plaintext in an
encrypted room. With the flag off, the fetch loop runs unchanged and still
detect-and-refuses encrypted rooms.

**Pure layer (unit-tested):** the flag (`parseE2eeEnabled`), the olm-store
convention (`$QWEN_BRIDGE_STATE_DIR/olm/`), `olmStorePresent` (a real fs check),
the truthful first-boot `olm_store_missing` re-key decision (`shouldWarnOlmMissing`
— warns only when E2EE is on AND no store exists), and the per-room transport
decision (`decideMatrixTransport`, used by the fetch dispatch).

**Seams (unit-tested against a fake):** `MatrixBridge.dispatchDecryptedMessage`
(decrypted message → shared `handleMessage`, with the sender's power level so
gated commands work), `dispatchReaction` (👍/👎 → shared `handleReaction`), the
`runInbound` subsume (asserts the fetch sync is **never** called when an inbound
transport is injected), and reconcile-after-dispatch (a decrypted-path `!qwen
attach` picks up the newly bound session).

**Crypto adapter (`cryptoAdapter.ts`, compile-checked ceiling):**
`createMatrixCryptoAdapter` constructs a `matrix-bot-sdk` `MatrixClient` with a
`RustSdkCryptoStorageProvider` (SQLite olm store at `<stateDir>/olm/`), sets up
`AutojoinRoomsMixin`, resolves sender power levels from `m.room.power_levels`, and
implements `MatrixInbound` (`sendMessage`/`joinRoom`) plus `start`/`stop`/
`isReady`, surfacing decrypted messages (`onMessage`) and reactions (`onReaction`).
matrix-bot-sdk is an `optionalDependency`, dynamically imported (absent → adapter
returns `null`, E2EE stays off, plain bridge unaffected). The construction is typed
against the **real** SDK — the ctor calls are signature-checked by tsc (proven via
a deliberate-wrong-argument test that makes the build go red), **not** hand-rolled
`*Like` shapes.

**Live round-trip — verified against a real Synapse (env-gated).**
`crypto.integration.test.ts` provisions two throwaway crypto users on a real
Synapse, has the SENDER create an encrypted room, and asserts the FULL wired path:
the bot decrypts an inbound message; a decrypted message reaches a **bound session**
through dispatch; the bot's reply is real ciphertext the **sender decrypts** (no
plaintext leak); and a 👍 reaction on the bot's tracked message **registers a
vote**. It **skips** in the default suite and runs only when `QWEN_MATRIX_IT_HS_URL`

- `QWEN_MATRIX_IT_REG_SECRET` point at a homeserver — stand one up with
  `integration/matrix/docker-compose.yml` (see that README; mind the key-share
  **ordering** and **unverified-device** gotchas). Both tests have been **run green**
  against a self-hosted Synapse container. The provisioning HMAC
  (`synapseRegisterMac`) also has its own known-answer unit test.

Running it earlier surfaced a real bug the compile-checked path could not:
matrix-bot-sdk's `RustSdkCryptoStoreType` is a **`const enum`** (erased at runtime
under esbuild → `undefined`), so `RustSdkCryptoStoreType.Sqlite` threw at
construction and the adapter silently degraded to `null` (E2EE off) on every real
run. Fixed by sourcing the store-type value from the native
`@matrix-org/matrix-sdk-crypto-nodejs` `StoreType` (a real runtime object), which is
both type-correct and present at runtime — a reminder that "compile-checked" can
hide runtime-erased const enums.

## Healthz

The Matrix bridge exposes `GET /healthz` on a small loopback HTTP server,
returning `{ ok, daemonReachable, homeserverReachable, olmStorePresent,
registeredId, uptimeSec }` — a liveness/observability probe (e.g. a Docker
`HEALTHCHECK`). It is the surface that reflects olm-store status.

- **Port.** The standalone sidecar defaults to **9100** (the spec default);
  override or disable via `QWEN_BRIDGE_HEALTHZ_PORT` (a port number, or
  `off`/`none`/`0`). In-process it is **opt-in** — set `QWEN_BRIDGE_HEALTHZ_PORT`
  to enable it, so the gateway process never binds a surprise port.
- **Loopback only** (`127.0.0.1`): the report is unauthenticated and exposes
  internal reachability + the registered id, so it is not bound to `0.0.0.0`. A
  bind failure (port taken) logs and disables healthz — it never crashes the
  bridge.
- **Fields.** `olmStorePresent` is a live fs check of `<stateDir>/olm/`.
  `registeredId`/`daemonReachable` come from a successful gateway registration;
  `homeserverReachable` is live on the fetch path (flips on sync success/failure)
  but means "reachable at start" on the E2EE adapter path (the SDK owns `/sync`
  and hides later reconnects from the bridge).

## Deferred

- **`MATRIX_ENABLE_E2EE` works on both paths** — the standalone `qwen-rc-bridge
matrix` sidecar and the in-process bridge both honor the flag via the shared
  `startBridge` (`cli.ts` resolves which bridges to start via the unit-tested
  `resolveInProcessBridges`, then hands each to `startBridge`).
- **Un-CI-able:** a _public/federated_ homeserver interop and a fully
  _verified_-device path (our Synapse IT covers same-homeserver + unverified
  devices, the realistic path).

## Other deferred (not yet built)

- Only `agent_message_chunk` (the assistant's prose) is streamed; thought and
  tool-call chunks are skipped to keep rooms readable.
- A fenced code block that spans a flush boundary (split by the idle timer or the
  16384-byte cap mid-fence) renders as two separate messages, the first with an
  unterminated fence — its HTML may look garbled. The paragraph/fence-close flush
  triggers avoid this for well-formed prose; only an oversized or stalled single
  fence hits it. Link targets are restricted to `http`/`https`/`mailto`; any other
  scheme (`javascript:`, `data:`, …) is rendered as plain text, never a live href.
- A pathological single chunk > 65536 bytes is not split (the 16384 flush
  threshold makes this effectively impossible for streamed prose).
- `/sync` is in-memory (a restart does a fresh full sync, which re-establishes
  state but does not replay history); the SSE echo resumes via `Last-Event-ID`.

## Troubleshooting

- **`registration returned 401`:** `QWEN_BRIDGE_TOKEN` is wrong/revoked or not a
  `bridge`-scope token. Mint a fresh one.
- **`MXID mismatch` warning:** the access token belongs to a different user than
  `MATRIX_USER_ID`. Fix the env var or the token.
- **Votes/prompts ignored in a room:** confirm the room is unencrypted and bound
  (`!qwen status`), and that you reacted on the bridge's own tool-call message.
- **Reaction did nothing:** only 👍/👎 vote; other reactions are ignored.

## Verification ceiling

The pure layers — render (incl. reaction-key normalization), sync extraction,
the room store, the REST client, and the dispatcher — are unit-tested, as is the
runner's outbound delivery and the sync-loop wiring (with an injected `/sync`).
The **live `/sync` long-poll against a real homeserver** is not CI-exercised
(there is no Matrix homeserver in this environment). A boot-smoke confirms the
module chain loads and that the bridge authenticates over the loopback contract
(a bad token draws a `401` from the gateway's own auth).
