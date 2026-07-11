# add-mdns-discovery

## Why

Operators running `qwen rc` daemons on a LAN today must remember
hostname-and-port combinations or hard-code them into config files.
On a typical home network with a workstation, a homelab box, and a
shared family PC, the operator may run several daemons (one per
workspace per host). Discovery is currently a manual chore: run
`ss -tlnp`, recall `:7070` is the kitchen workstation, `:7080` is
the office.

mDNS / DNS-SD (Bonjour / Avahi / Zeroconf) is the standard solution
for service discovery on a LAN. Every modern OS speaks it; it is
the same protocol AirPlay, Chromecast, and CUPS use. Advertising the
daemon as a `_qwen-rc._tcp.local.` service lets the terminal client
discover nearby daemons in one command without any network-wide
registry or operator config.

This change keeps discovery strictly LAN-local. It does NOT add WAN
discovery, does NOT publish secrets, and is operator-toggleable per
daemon.

## What Changes

- **Service advertisement.** When the daemon binds a non-loopback
  address, it advertises itself as type `_qwen-rc._tcp.local.` with
  the host's `.local` name. The instance name defaults to
  `<hostname>-<workspace-basename>` and is operator-overridable.
- **TXT records.** `version=<rc protocol version>`,
  `name=<display name>`, `workspace=<basename only>`,
  `tlsRequired=true|false`. No secrets, no token hints, no path
  data beyond the workspace's basename.
- **Disable flag.** `--no-mdns` CLI flag and `QWEN_RC_NO_MDNS=1`
  env var. When the daemon binds only loopback, advertisement is
  disabled by default (advertising loopback is meaningless on a
  LAN).
- **Workspace name override.** `--mdns-workspace-name <s>` for
  operators who don't want the basename leaked (the basename can
  hint at a private project).
- **Terminal client discovery.** `qwen rc daemons discover [--timeout
5s]` browses for `_qwen-rc._tcp.local.` advertisements and prints
  a table of `name | host | port | version | tlsRequired`.
- **Web client.** Browsers cannot speak mDNS. The web client gains
  no direct discovery. `add-multi-workspace-client` (a separate
  change) can offer "Import discovered" via a small helper endpoint
  that the user proxies manually.

## Capabilities

### New Capabilities

- `mdns-discovery` — service-type registration on
  `_qwen-rc._tcp.local.`, TXT record schema, advertise-on-non-
  loopback default, operator toggles, the `qwen rc daemons
discover` browse command, and the explicit prohibition on
  exposing any sensitive material in the advertisement.

## User Stories

**M1. Find the kitchen daemon.** On my laptop I run
`qwen rc daemons discover` and see:

```
NAME                       HOST          PORT  VERSION  TLS
kitchen-workstation-app     kitchen.local 7070  1        yes
office-pi-homelab           pi.local      7080  1        no
```

I pick the one I want and `qwen rc attach --host kitchen.local:7070`.

**M2. Privacy-conscious operator.** I'm working on `secret-project`
and I don't want anyone on my coworking-space network to see the
project name. I run `qwen serve --mdns-workspace-name app` so the
advertisement reads `workspace=app`.

**M3. Operator opts out entirely.** I run `qwen serve --no-mdns` on
a hostile network. No advertisement is broadcast. Operators on
that network must know the host and port to connect.

**M4. Loopback-only run.** I `qwen serve --host 127.0.0.1`. No
mDNS announcement is sent regardless of `--no-mdns` because nothing
on the LAN can reach me anyway. `qwen rc daemons discover` skips
my entry.

**M5. Daemon shutdown.** I stop the daemon. The mDNS service is
withdrawn (Goodbye packet sent); the next `discover` from another
host does not list me.

## Impact

- **qwen-code repo**: new module
  `packages/cli/src/serve/remoteControl/mdns/` containing the
  advertisement service and the browse helper.
- **Dependency**: one new npm package for the mDNS protocol. See
  `design.md` D1 for library candidate evaluation; current
  recommendation is `bonjour-service` (TypeScript, maintained,
  no native deps, MIT). Fallback: `multicast-dns`.
- **Capability advertisement**: `/capabilities` gains
  `remoteControl.mdns: { advertising: bool, instanceName }`. The
  daemon does NOT advertise this back over HTTP unless asked,
  since HTTP callers must already know the daemon URL — but it's
  useful for `qwen rc daemons list-self` debugging.
- **Out of scope** (deliberately):
  - WAN / public-internet discovery. Reachability across networks
    is the operator's problem (Tailscale, Cloudflare Tunnel,
    reverse proxy).
  - Discovery via DNS-SD on a corporate DNS server (i.e. unicast
    DNS-SD). LAN multicast only.
  - Authenticating advertisements. Anyone on the LAN can spoof an
    `_qwen-rc._tcp.local.` service; clients MUST still
    authenticate via the pairing flow regardless.
  - Browser-side discovery. No browser API exists.
  - Pushing the operator's name, token, scopes, or any user-
    identifying info into TXT records.
