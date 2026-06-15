# Bind security (loopback / TLS / behind-proxy)

The gateway speaks plain HTTP, and the `add-remote-control` design deliberately
delegates TLS to an upstream terminator (reverse proxy / Tailscale / Cloudflare
Tunnel) rather than terminating it itself (design.md non-goals + threat model
row "Network passive"). That is safe on loopback — traffic never leaves the host
— but a **non-loopback bind over plain HTTP would put bearer tokens on the wire
in cleartext**. This gate enforces the design's own rule (design.md:231 /
open question design.md:448): a non-loopback bind is refused without a TLS story.

## How to bind

```
qwen-rc serve                                   # default: 127.0.0.1, plain HTTP (safe)
qwen-rc serve --host 0.0.0.0 --tls cert.pem --tls-key key.pem   # native TLS
qwen-rc serve --host 0.0.0.0 --insecure-behind-proxy           # TLS terminated upstream
```

| Flags                                                | Result                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| (none) / `--host 127.0.0.1` / `localhost` / `::1`    | **loopback-http** — plain HTTP, no TLS needed.                                                                                |
| `--host <non-loopback>` with no TLS story            | **REFUSED** at startup (exit 1), before the daemon spawns.                                                                    |
| `--host <non-loopback> --tls <cert> --tls-key <key>` | **native TLS** — the gateway serves HTTPS itself.                                                                             |
| `--host <non-loopback> --insecure-behind-proxy`      | **plain HTTP on the LAN** — only safe if a TLS-terminating reverse proxy fronts the gateway. The startup banner warns loudly. |

`--tls` and `--tls-key` must be supplied together; `--tls` and
`--insecure-behind-proxy` are mutually exclusive. The resolved mode also yields a
`tlsRequired` signal (`false` only for loopback-http) that the mDNS advertisement
slice will surface as its `tlsRequired` TXT key — so a discovering client learns
whether it must connect over TLS.

## Why not built-in Let's Encrypt / a private CA?

Both are possible, but they are a different architecture than the design chose,
and they fit a LAN daemon poorly:

- **Let's Encrypt** needs a public DNS name + inbound reachability (HTTP-01) or a
  domain with DNS-API access (DNS-01), plus 90-day renewal — awkward for a
  `*.local` / private-IP daemon. The design's answer is Tailscale / Cloudflare
  Tunnel, which provide TLS _and_ a name for free (use `--insecure-behind-proxy`).
- **Self-signed / private CA** fits a LAN but relocates the cost to client trust
  distribution (every web/terminal/mobile client must trust the CA). If you have
  a cert+key for the host, `--tls` terminates it natively.

## Verification ceiling

The bind-mode decision (loopback detection, the refuse / tls / insecure-proxy
branches, flag-combination validation) is unit-tested, and the refusal paths are
smoke-tested through the real `qwen-rc serve` entrypoint (each exits non-zero with
its message and spawns no daemon). The live HTTPS listen with a real cert is
standard `node:https` wiring and is not exercised in CI (no cert fixture / network
bind in the test env).
