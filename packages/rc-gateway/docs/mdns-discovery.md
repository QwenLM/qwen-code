# mDNS / DNS-SD discovery

Implements `add-mdns-discovery`: the daemon advertises itself on the LAN as a
`_qwen-rc._tcp.local.` service so a client can find its host:port without the
operator looking up an IP, and `qwen-rc daemons discover` browses for them. mDNS
is **discovery only** — it carries no auth material; the pairing flow remains the
trust boundary (`add-remote-control` / `pairing-auth`).

## When the daemon advertises

Advertising is reachable only through the step-1 bind-security gate
(`bind-security.md`), which reshapes the spec's defaults:

| Bind mode (from `bindSecurity.ts`) | mDNS                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `loopback-http` (default)          | **suppressed** — a loopback service tells the LAN about a daemon it cannot reach (design D2). |
| `tls` (native HTTPS)               | **advertises** — honest `tlsRequired=true`, real host:port.                                   |
| `insecure-proxy`                   | **suppressed** — see below.                                                                   |

`--no-mdns` or `QWEN_RC_NO_MDNS=1` suppress in every mode.

### Deviation from the spec: advertise only in `tls` mode

The spec's headline scenario is `qwen serve --host 0.0.0.0 --port 7070` with no
other flags. After step 1 (`do step 1 before mdns`) that bare form is **refused**
by the bind gate (non-loopback + no TLS story → bearer tokens in cleartext). So
the advertising path is now reachable only with a TLS story, and the two such
modes are not symmetric:

- **`tls`** — the gateway serves HTTPS on the advertised host:port. Advertising
  its own endpoint with `tlsRequired=true` is honest. ✅ advertise.
- **`insecure-proxy`** — the gateway serves **plain HTTP** locally while the real
  TLS endpoint is an upstream proxy whose host:port the gateway does not know.
  Advertising our cleartext bind as `tlsRequired=true` would mislead clients, so
  we suppress and let the proxy advertise itself (design D2: "the proxy is the
  better mDNS source"). ⛔ suppress.

Net: **advertising happens only on a native-TLS bind.** This is a deliberate
reconciliation, not an omission. `mdnsDecision()` encodes it and is unit-tested.

## TXT record

Strict four-key schema, all string values (`buildTxtRecord`):

| Key           | Value                                | Notes                                                    |
| ------------- | ------------------------------------ | -------------------------------------------------------- |
| `version`     | `RC_PROTOCOL_VERSION` (`"1"`)        | Same constant `/rc/capabilities` reports — never drifts. |
| `name`        | `<hostname>-<workspace>` or override | Service display name.                                    |
| `workspace`   | cwd **basename** or override         | NEVER an absolute path (design D3).                      |
| `tlsRequired` | `"true"` / `"false"`                 | From the bind decision.                                  |

Nothing else is advertised: no absolute paths, owner/token state, pairing-code
presence, scope listings, audit counts, or session ids.

## Flags

```
qwen-rc serve --host 0.0.0.0 --tls cert.pem --tls-key key.pem   # advertises
qwen-rc serve ... --no-mdns                                     # disable
qwen-rc serve ... --mdns-workspace-name app-public             # override TXT workspace
qwen-rc serve ... --mdns-instance-name kitchen-box             # override instance name
QWEN_RC_NO_MDNS=1 qwen-rc serve ...                            # disable via env
```

Name overrides are validated (1–63 printable ASCII, no `/`/`\`, no `.`/`..`
traversal) **before any side effect** — a bad value refuses to start with a clean
`MdnsConfigError` (exit 1) and spawns no daemon.

## Capability surface

`GET /rc/capabilities` (any authenticated token) now always mounts and reports:

```jsonc
{ "remoteControl": {
    "version": 1,
    "mdns": { "advertising": true, "instanceName": "kitchen-app" },
    "costTracking": { "enabled": true, ... }   // only when a usage store is wired
} }
```

`advertising` is `false` (and `instanceName` absent) whenever suppressed. The
route was previously gated behind cost-tracking (404 when off); it is now always
200 so mDNS state is reachable independent of cost tracking. No gateway-side
consumer keyed off the old 404.

## Browse: `qwen-rc daemons discover`

```
qwen-rc daemons discover [--timeout <5s|500ms|3>] [--format json|table]
```

Daemon-free and read-only. Browses `_qwen-rc._tcp.local.` for the timeout
(default 5 s), normalizes each hit to `{ name, host, port, version, tlsRequired,
workspace }`, dedupes by service name (latest wins), and sorts by host then port.
Exits **0 even when nothing advertises** (empty result is not an error).

- `table` (default): `NAME HOST PORT VERSION TLS WORKSPACE` columns + a
  `N daemon(s) found in <elapsed>s` summary (no header when empty).
- `json`: a bare array of the six-field objects, suitable for scripting.

Discovery never bypasses auth: a discovered daemon still requires the full
pairing flow before any session interaction.

## Goodbye on shutdown

The existing SIGINT/SIGTERM `shutdown` handler calls `MdnsAdvertiser.stop(500)`,
which sends Goodbye packets (`unpublishAll`) and waits up to 500 ms before
destroying the socket, so a stale record does not haunt the LAN for the 75-minute
mDNS TTL (design D4). A SIGKILL still leaves a stale record — unavoidable.

## Verification ceiling

`bonjour-service` is an **optional, dynamically-imported** dependency (mirrors
`better-sqlite3` / `matrix-bot-sdk`): if it is not installed, advertising is
simply off and the gateway runs normally. The decision logic, name validation,
TXT schema, browse normalize/dedupe/sort/format, and the advertiser publish/
Goodbye lifecycle are all unit-tested against a fake bonjour instance. The **live
multicast publish/browse is not exercised in CI** — it needs a real LAN socket
and is frequently broken under WSL2. The serve path was smoke-tested manually:
loopback suppresses, a TLS bind advertises `<host>-<workspace>` with
`tlsRequired=true`, env/flag disable, and a path-traversal override refuses at
startup with no orphaned daemon.
