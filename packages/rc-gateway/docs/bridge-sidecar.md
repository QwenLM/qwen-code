# Running a bridge as a sidecar process

Each chat bridge (Telegram, Discord, Matrix) can run either **in-process** inside
the gateway (the default — set the bridge's env vars before `qwen-rc serve`) or as
a **standalone sidecar process** distinct from the gateway. Both modes run the
same runner code and talk the gateway **only** over the HTTP+SSE contract with an
operator-minted `bridge`-scope token — the sidecar just points that contract at a
remote daemon URL instead of loopback. This is the
`add-{telegram,discord,matrix}-bridge` "Bridge process configuration" requirement.

> **Placement note.** The change specs name three separate binaries
> (`qwen-bridge-telegram`, `-discord`, `-matrix`). To honor this fork's zero-edit
> boundary (everything ships from `@qwen-code/rc-gateway`), the sidecar is a
> single binary that takes the kind as its argument:
>
> ```
> qwen-rc-bridge <telegram|discord|matrix>
> ```

## Configuration (environment only)

The sidecar reads its configuration **exclusively** from environment variables
and **fails fast with exit code 1** if a required one is missing (the error names
the variable, e.g. `TELEGRAM_BOT_TOKEN is required`).

| Variable                   | Bridges  | Required | Notes                                                                  |
| -------------------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `QWEN_DAEMON_URL`          | all      | yes      | Base URL of the gateway — both the transport target and deeplink base. |
| `QWEN_BRIDGE_TOKEN`        | all      | one of   | A `bridge`-scope token (`POST /rc/tokens {scopes:['bridge']}`).        |
| `QWEN_BRIDGE_PAIRING_CODE` | all      | one of   | A one-time pairing code, redeemed on first boot (see below).           |
| `QWEN_BRIDGE_STATE_DIR`    | all      | no       | Persistent storage root. Default `~/.qwen/rc/bridges/<kind>`.          |
| `TELEGRAM_BOT_TOKEN`       | telegram | yes      | Bot token from BotFather.                                              |
| `DISCORD_BOT_TOKEN`        | discord  | yes      | Bot token from the Discord Developer Portal.                           |
| `DISCORD_APPLICATION_ID`   | discord  | yes      | Application id (for slash-command registration).                       |
| `DISCORD_GUILD_ID`         | discord  | no       | When set, slash commands register guild-scoped instead of globally.    |
| `MATRIX_HOMESERVER_URL`    | matrix   | yes      | e.g. `https://home.example.com`.                                       |
| `MATRIX_USER_ID`           | matrix   | yes      | Fully-qualified bot MXID; must match the access token's `whoami`.      |
| `MATRIX_ACCESS_TOKEN`      | matrix   | yes      | From a one-time `/login`.                                              |
| `MATRIX_COMMAND_PREFIX`    | matrix   | no       | Default `!qwen`.                                                       |
| `MATRIX_ENABLE_E2EE`       | matrix   | no       | Opt-in encrypted-room support (default OFF). Live-wired — see below.   |

Exactly one of `QWEN_BRIDGE_TOKEN` / `QWEN_BRIDGE_PAIRING_CODE` must be present.
For Matrix the sidecar also exits 1 with `MXID mismatch` if the access token
resolves to an MXID other than `MATRIX_USER_ID`.

`MATRIX_ENABLE_E2EE` opts into encrypted-room support and is **OFF by default**.
When set, the `matrix-bot-sdk` + olm crypto adapter becomes the bridge's transport
(it owns `/sync`, decrypts encrypted rooms transparently, and sends encrypted
replies) — verified end-to-end against a real Synapse; see
[matrix-bridge.md](./matrix-bridge.md) "End-to-end encryption". The flag is honored
on **both** the sidecar and the in-process bridge (both construct via the shared
`startBridge`). The olm store lives at `$QWEN_BRIDGE_STATE_DIR/olm/`. The Matrix
sidecar also serves `GET /healthz` (default port 9100; `QWEN_BRIDGE_HEALTHZ_PORT`).

## Token bootstrap (pairing code → persisted token)

When `QWEN_BRIDGE_TOKEN` is unset and `QWEN_BRIDGE_PAIRING_CODE` is set, the
sidecar redeems the code against the gateway (`POST /rc/pair/redeem` — a pre-auth
bootstrap call) and writes the resulting token to `$QWEN_BRIDGE_STATE_DIR/token`
with file mode `0600`. **Subsequent boots ignore the pairing code** once that
token file exists, so a restart does not need a fresh code. An explicit
`QWEN_BRIDGE_TOKEN` always wins and is never persisted.

## Example

```bash
# On the workstation: mint a one-time bridge pairing code (owner token required).
curl -s -X POST http://127.0.0.1:4170/rc/tokens \
  -H "Authorization: Bearer <OWNER token>" \
  -H 'content-type: application/json' \
  -d '{"scopes":["bridge"]}'

# On the sidecar host (e.g. a container):
export QWEN_DAEMON_URL=https://qwen.example.com
export QWEN_BRIDGE_PAIRING_CODE=<one-time code>
export TELEGRAM_BOT_TOKEN=<botfather token>
qwen-rc-bridge telegram
```

The sidecar registers itself (`POST /rc/bridges`), heartbeats, and then behaves
exactly like the in-process bridge — binding is still operator-issued via
one-time invites, and every prompt/vote carries the bridge's sub-actor identity.

## Verification ceiling

The config resolution, the pairing-code bootstrap precedence, and the Matrix
MXID-mismatch check (`checkMxid`) are unit-tested. A spawn smoke
(`scripts/rc-gateway-e2e.mjs`) boots the real `qwen-rc-bridge` entrypoint against
a live gateway and asserts the fail-fast contract (missing var → exit 1 + exact
message), the pairing-code bootstrap (real `/rc/pair/redeem` → token persisted at
mode 0600), and the loopback contract (registration succeeds). Only the
**telegram** branch of the shared `startBridge` wiring is spawn-smoked; the
discord/matrix branches are structurally identical (tsc-guarded, review-only).
The live chat-network loops (Telegram long-poll, the discord.js gateway,
Matrix `/sync`) and the Matrix `whoami` round-trip are not CI-exercised — there is
no real Telegram/Discord/Matrix homeserver in this environment.
