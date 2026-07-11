# Design — add-mdns-discovery

## Context

`add-remote-control` made the daemon network-accessible and added
pairing-based auth. Discovery — knowing the daemon's host and port
in the first place — was left as the operator's problem. For a LAN
that's a real friction point: a casual user shouldn't need to look
up an IP to attach a phone.

mDNS / DNS-SD is the obvious tool. The protocol has been stable for
twenty years, every desktop OS already runs an mDNS resolver
(`systemd-resolved` / `Avahi` on Linux, `mDNSResponder` on macOS,
the Windows Bonjour service on Windows), and the TS ecosystem has
several maintained libraries.

This is a small, well-scoped change. The hard parts are picking the
right library, getting TXT records right, and being conservative
about what we advertise.

## Goals / Non-Goals

**Goals:**

- One-command LAN discovery from a paired or unpaired terminal
  client.
- Conservative TXT records (no secrets, no paths).
- Operator can disable per-daemon.
- Withdraw advertisement cleanly on shutdown so stale records do
  not haunt the LAN.

**Non-Goals:**

- WAN discovery.
- Browser discovery (no API).
- Identity. Advertisements are unauthenticated; the pairing flow is
  the trust boundary.
- mDNS itself as a transport (we use it only to find host:port, then
  the existing HTTPS API takes over).

## Architecture

```
qwen serve startup
        │
        ▼
bind HTTP server
        │
        ▼
if (bound on non-loopback) AND !--no-mdns AND !env disable:
    create Bonjour publisher
    register service:
        type = "_qwen-rc._tcp.local."
        port = <http port>
        name = "<instanceName>"
        txt  = {
            version: "1",
            name: "<display name>",
            workspace: "<basename or override>",
            tlsRequired: "true" | "false"
        }
        │
        ▼
register signal handler:
    on SIGINT/SIGTERM:
        publisher.unpublish()  (sends Goodbye packets)
        exit

`qwen rc daemons discover [--timeout 5s]`
        │
        ▼
Bonjour browser for type "_qwen-rc._tcp.local."
        │
        ▼
Collect responses for `timeout` seconds, dedupe by `name`
        │
        ▼
Print table sorted by host then port
```

## TXT records

Strict schema, expressed as comma-separated `key=value` pairs:

| Key           | Value example         | Notes                                                                                   |
| ------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `version`     | `1`                   | The `remoteControl.version` advertised on `/capabilities`.                              |
| `name`        | `kitchen-workstation` | Operator-visible display name. Default = `<hostname>-<workspace-basename>`.             |
| `workspace`   | `app`                 | Basename only, never absolute path. Operator can override with `--mdns-workspace-name`. |
| `tlsRequired` | `true` / `false`      | `true` if the daemon refuses non-TLS; `false` if it allows plain HTTP.                  |

NOT advertised:

- absolute workspace path
- daemon's owner-bootstrap state
- token count, pairing-code presence, anything about auth state
- the daemon's actual hostname (the mDNS service already resolves
  `.local` for that)

If the operator wants ZERO leak (the LAN itself is untrusted), they
disable mDNS.

## CLI

### `qwen serve` flags

- `--no-mdns` — disable advertisement.
- `--mdns-workspace-name <s>` — override the TXT `workspace` value.
- `--mdns-instance-name <s>` — override the service instance name.
- `QWEN_RC_NO_MDNS=1` env var — same as `--no-mdns`.

### `qwen rc daemons discover`

```
$ qwen rc daemons discover --timeout 5s
NAME                       HOST                PORT  VERSION  TLS
kitchen-workstation-app    kitchen.local       7070  1        yes
office-pi-homelab          pi.local            7080  1        no
2 daemons found in 5.0s
```

Columns are derived from the TXT records and the resolved address.
`--format json` produces structured output for scripting.

### `qwen rc daemons list-self`

Operator debug helper. Hits its own `/capabilities` (loopback) and
prints what's being advertised. Useful when something seems off.

## Decisions

### D1 — Library choice: `bonjour-service`

**Choice**: `bonjour-service` (npm).

**Alternatives considered**:

- `bonjour` (the original): unmaintained since 2018; many open
  bugs about IPv6 and multi-interface support.
- `mdns-js`: pure-JS, looks abandoned.
- `multicast-dns`: low-level, requires us to implement DNS-SD
  semantics on top. Maintained but more code on our side.
- Native bindings to system Avahi / Bonjour: cross-platform pain,
  GPL surface (Avahi).

**Why `bonjour-service`**: actively maintained (2024 commits), TS
support out of the box, fork of original `bonjour` with bug fixes,
no native deps, MIT licensed, used by other production projects
(notably `tinyssh-server`, `nodecg`). API surface is exactly what
we need (`publish`, `unpublish`, `find`).

**Cost**: One new npm dependency. Acceptable given the alternative
is hand-implementing DNS-SD on top of `multicast-dns`.

### D2 — Advertise only on non-loopback binds, by default

**Choice**: If the daemon bound `127.0.0.1` only, mDNS advertising
is suppressed regardless of `--no-mdns`.

**Alternative considered**: Advertise always.

**Why**: An mDNS service on a loopback address tells the LAN
"there is a daemon you cannot reach." Information leak with zero
benefit.

**Cost**: An operator who wants to advertise a loopback-bound
daemon (maybe behind a system reverse proxy on the same host that
listens on 0.0.0.0) must explicitly bind to the public interface
or run the proxy with its own mDNS layer. Acceptable; the proxy is
the better mDNS source in that topology.

### D3 — TXT records carry no path-revealing data

**Choice**: The `workspace` TXT value is the basename only, never a
full path. Operator can override to any string.

**Alternative considered**: Full path so the user knows which
project the daemon is for.

**Why**: A path like `~/projects/secret-acquisition-target/` is
sensitive. Even basenames can be — that's why we offer
`--mdns-workspace-name` to override.

**Cost**: An operator with two daemons both serving repos named
`api` (one in `~/work/api`, another in `~/personal/api`) sees two
identical advertisements unless they override one. Documentation
suggests overriding.

### D4 — Clean withdrawal on SIGINT/SIGTERM

**Choice**: Register a signal handler that calls `unpublish()` and
delays exit by up to 500 ms to let Goodbye packets propagate.

**Alternative considered**: Rely on mDNS TTL to expire stale
records.

**Why**: Default mDNS TTL is 4500 s (75 minutes). A daemon that
crashes or is killed will haunt the LAN for that long otherwise.
`bonjour-service` supports `unpublish` with a Goodbye sequence;
500 ms suffices for it to send.

**Cost**: A 500 ms delay added to graceful shutdown. Trivial. A
killed-by-SIGKILL daemon still leaves a stale record — unavoidable.

### D5 — Web client gets no direct discovery

**Choice**: The web client cannot do mDNS (no browser API). It
does not gain any discovery affordance from this change.

**Alternative considered**: A helper endpoint on the daemon
(`GET /rc/peers`) that runs the browse on the user's behalf and
returns JSON.

**Why**: That endpoint exists per device; the discovery surface is
"daemons the operator's LAN has." If a daemon is already paired
and serving the web client, the user already knows it. Discovery
is for FINDING a daemon, not for cross-host federation. The
helper-endpoint idea is left for `add-multi-workspace-client`
(separate change) to consider explicitly.

**Cost**: Phone users on a LAN with two daemons must know each
URL or use the terminal-side `qwen rc daemons discover` to find
them, then visit. Acceptable.

## Threat model

| Attacker                                              | Capability                            | Mitigation                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LAN observer                                          | See advertised TXT records            | TXT records carry only non-sensitive metadata; operator can disable per daemon.                                                                                            |
| LAN observer                                          | Learn the daemon's IP/port            | mDNS is broadcast; this is the inherent design. Tokens still required to actually do anything.                                                                             |
| LAN attacker spoofs an `_qwen-rc._tcp.local.` service | Lure a user to a fake daemon          | Clients authenticate via the pairing flow; pairing codes are short-lived and the user types them. A spoof daemon cannot satisfy that round-trip without owner cooperation. |
| Hostile co-resident on host                           | Read sigterm timing to learn presence | Out of scope (already had root on the host).                                                                                                                               |

## Risks

| Risk                                                           | Likelihood | Impact | Mitigation                                                                                            |
| -------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------- |
| Multicast disabled on operator's network (some corporate WiFi) | M          | L      | Documented. Browse just returns empty; manual `--host` still works.                                   |
| Multiple network interfaces produce duplicate advertisements   | M          | L      | `bonjour-service` handles this in default mode; operator can pin to one interface via library option. |
| Library churn / abandonment                                    | L          | M      | Acceptance criteria allow swap to `multicast-dns`; thin wrapper module.                               |
| IPv6-only LAN segments                                         | L          | M      | `bonjour-service` supports IPv6 by default; tested in Phase 2.                                        |
| Operator forgets to override workspace name; basename leaks    | M          | L      | Documented in startup banner: "Advertising `workspace=foo`; use --no-mdns to disable."                |

## Open questions

1. **Should the daemon log the advertisement on startup so the
   operator sees what's being broadcast?** Leaning yes —
   transparency by default. A line like `mDNS: advertising
"kitchen-workstation-app" at <ip>:7070 (use --no-mdns to
disable)`.

2. **Default `--mdns-workspace-name` for repos under `~/Downloads`
   or other generic paths?** Probably no auto-handling — operators
   know their repo names.

3. **Should `qwen rc daemons discover` cache results across runs
   (e.g., for autocomplete)?** Leaning no — every invocation is
   cheap, and a cached list is a footgun when daemons move ports.

4. **Should browse return only daemons whose advertised `version`
   is compatible?** Leaning yes — print only same-or-newer
   versions; print older with a warning row. Phase 2.
