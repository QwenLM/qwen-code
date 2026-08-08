# Local Control CLI slice

## Goal

Make phone access to an existing `qwen serve` session a single explicit command:

```bash
qwen serve --local-control
```

The command binds to the IPv4 LAN, generates a fresh 256-bit bearer token, prints a QR code for each usable LAN address, and inhibits system sleep until the process exits.

## Behavior

`--local-control` is an opt-in shortcut over the existing daemon and Web Shell. It forces `0.0.0.0`, supplies a generated token directly to the daemon, allowlists each advertised LAN origin, and keeps the Web Shell enabled. It replaces the wildcard host with each non-loopback IPv4 interface address and puts the token in the URL fragment before rendering the QR code.

The terminal remains the visible enabled indicator. `Ctrl+C` turns Local Control off, closes the daemon, invalidates the generated token, and releases the existing cross-platform sleep inhibitor.

The mode rejects a non-default `--hostname`, `--token`, `--allow-origin`, `--no-web`, and ephemeral port `0` instead of silently overriding settings or creating incomplete configurations. It also fails if the requested port is busy because retrying would make the printed pairing URLs and allowed origins incorrect. Existing explicit `qwen serve` deployments are unchanged.

## Security

- LAN exposure requires the explicit flag.
- Every invocation gets a new token from `crypto.randomBytes(32)`; environment tokens are not reused.
- Only the advertised LAN origins and the daemon's loopback self-origin are admitted for browser REST and WebSocket requests, and every protected route still requires the generated bearer token.
- The token stays in the URL fragment, so browsers do not send it in HTTP requests, access logs, or referrers before the Web Shell stores it.
- Existing bearer authentication, timing-safe comparison, and non-loopback boot checks remain the enforcement boundary.
- Only non-internal IPv4 interface addresses are advertised. Multiple interfaces produce separate labelled QR codes rather than guessing which network is correct.

## Deferred desktop slice

The Desktop toggle is not included here. Enabling LAN binding by restarting the current bundled daemon would terminate an active shared session, while always binding publicly would violate explicit opt-in. The Desktop slice therefore needs a listener lifecycle that can be enabled and revoked without replacing the live session, plus a native visible indicator. Per #8595 triage, that should land separately after the daemon client-identity and pair-token revocation direction is agreed.

## Verification

- Unit tests cover flag conflicts, generated-token handoff, LAN URL construction, QR output, and sleep inhibition.
- A real local daemon run verifies that the QR URL authenticates `/capabilities`, the Web Shell loads, and the sleep inhibitor lives only for the Local Control process.
- Existing `serve` command and sleep-inhibitor tests remain green, followed by build and typecheck.
