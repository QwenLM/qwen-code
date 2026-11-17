# Local Control pairing

[English](local-control-cli.md) | [简体中文](local-control-cli.zh-CN.md)

## Goal

Make phone access to an existing `qwen serve` session a single explicit command:

```bash
qwen serve --local-control
```

The command keeps the primary daemon on loopback, starts one selected LAN listener, mints a revocable pairing token, prints its QR code, and inhibits system sleep until Local Control is disabled. Desktop exposes the same daemon-owned workflow from the Web Shell Settings card.

## Behavior

`--local-control` is an opt-in shortcut over the existing daemon and Web Shell. It leaves the daemon's runtime token, configured origins, and resolved port intact, adds one LAN listener on a selected IPv4 address — private/link-local by default, or an explicit pick named with `--local-control-address` — allowlists that advertised origin while the session is active, and puts the pairing token in the URL fragment before rendering the QR code.

The terminal remains the visible enabled indicator. `Ctrl+C` ends the whole daemon, not just Local Control: the graceful drain closes the LAN listener, invalidates the pairing token, and releases the existing cross-platform sleep inhibitor before the process exits. Turning Local Control off while the daemon keeps running is done from the Web Shell Settings card, which is also the only in-process re-enable path.

The mode rejects a non-default `--hostname` and `--no-web` instead of silently creating incomplete configurations. It composes with `--token`, `--allow-origin`, and ephemeral port `0`; `--local-control-address` selects the LAN address when several candidates exist, and is also the explicit opt-in for an address outside private/link-local space or one on a VPN/tunnel interface. Existing explicit `qwen serve` deployments are unchanged.

## Security

- LAN exposure requires an explicit operator action: `--local-control` at boot, or an enable request served only by the primary loopback listener; enable requests arriving over the LAN listener are rejected.
- Every enable gets a new pairing token from `crypto.randomBytes(32)`; environment tokens are not reused on the LAN listener.
- Local Control adds the advertised LAN origin to the daemon-wide origin allowlist (`--allow-origin` patterns remain in effect on both listeners while the session is active); every protected LAN route still requires the pairing token.
- The token stays in the URL fragment, so browsers do not send it in HTTP requests, access logs, or referrers before the Web Shell stores it.
- Existing bearer authentication, timing-safe comparison, and non-loopback boot checks remain the enforcement boundary.
- Only private/link-local IPv4 interface addresses are advertised automatically, and that path is unchanged: the automatic filters (the RFC 1918/3927 range check and the software-interface name heuristic) are the only way an address is ever offered without an explicit flag. Multiple interfaces surface an explicit choice rather than guessing which network is correct. An operator can explicitly opt in to an address outside those ranges — or one on a VPN/tunnel interface, e.g. phone and laptop on the same corporate VPN — by naming it with `--local-control-address`. Acceptance requires the host to actually have the address, and that is necessary but not sufficient: reserved shapes (0/8, 127/8, 224/4 and above) are refused as `reserved_lan_address` even when an interface holds them, because the unspecified address would listen on every interface and multicast/reserved ranges can never pair a phone. Picks the automatic filters would have refused (out-of-private-space or VPN/tunnel-interface) are logged with a loud warning. The opt-in is bound to that CLI provenance: the HTTP enable route accepts only current automatic candidates or the address the operator named at daemon start, so a local process cannot move the listener onto an address the operator never chose. "VPN/tunnel interface" is an interface-name heuristic (`isSoftwareNetwork`), not a structural property: it matches common tunnel, bridge, and VPN-adapter names (`utun`, `wg`, `tailscale`, `docker`, OpenVPN Wintun, and similar), so the opt-in's reach is exactly the set of interface names that heuristic recognizes.

## Desktop behavior

Desktop keeps its bundled daemon bound to authenticated loopback. The Web Shell Settings card enables the same daemon-owned Local Control service, which starts the LAN listener, generates a separate pairing token and QR code, and acquires the platform sleep inhibitor. The listener validates its public Host and Origin and accepts only the pairing credential for LAN traffic. The Desktop PID, daemon PID, loopback address, and live sessions do not change.

Turning Local Control off from Settings closes the listener and active connections, releases sleep inhibition, and invalidates the pairing token. A later enable gets a new token. The LAN listener does not exist while the mode is off, so the normal Desktop runtime remains loopback-only.

By default this mode covers same-network access only. The `--local-control-address` opt-in can bind a routable address the host holds, which puts the gateway beyond the local network — that is exactly why the opt-in requires the host to actually hold the address and logs a loud warning. The grant is recorded when the named address is first enabled successfully, survives disable so the Web Shell card can re-post it, and is revoked by the first successful enable on a different address — one click on another row in the Settings card ends it for the daemon's lifetime. Pair such a pick with `--tls-cert`/`--tls-key`, and note the LAN listener presents that same certificate: its subjectAltName must cover the picked address, or pairing clients fail the TLS handshake with `ERR_TLS_CERT_ALTNAME_INVALID` — the daemon validates the certificate only against the primary/worker dial host, never against the LAN address. Internet remote control as a product feature still requires an account-authenticated outbound relay with reconnectable session state; it must not be implemented by exposing this LAN gateway through port forwarding or an unauthenticated tunnel.

## Verification

- Unit tests cover flag conflicts, generated-token handoff, LAN URL construction, QR output, and sleep inhibition.
- Desktop Rust tests cover the gateway's Host/Origin boundary, HTTP bearer translation, WebSocket subprotocol translation, and loopback-only target requirement.
- A real local daemon run verifies that the QR URL authenticates `/capabilities`, the Web Shell loads, and the sleep inhibitor lives only for the Local Control process.
- A packaged macOS app pass verifies that enabling Local Control preserves the existing daemon/session, the QR opens that session from a second browser, and disabling it revokes the LAN listener and sleep assertion.
- Existing `serve` command and sleep-inhibitor tests remain green, followed by build and typecheck.
