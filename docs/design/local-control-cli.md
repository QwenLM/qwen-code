# Local Control pairing

## Goal

Make phone access to an existing `qwen serve` session a single explicit command:

```bash
qwen serve --local-control
```

The command binds to the IPv4 LAN, generates a fresh 256-bit bearer token, prints a QR code for each usable LAN address, and inhibits system sleep until the process exits. The Tauri Desktop app exposes the same workflow from its Control menu without restarting the live Desktop daemon.

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

## Desktop behavior

Desktop keeps its bundled daemon bound to authenticated loopback. Choosing **Control → Local Control…** opens a native app window; enabling it starts a temporary LAN gateway to that same daemon, generates a separate pairing token and QR code, and acquires the platform sleep inhibitor. The gateway validates its public Host and Origin, translates the short-lived pairing credential to the private daemon credential, and forwards HTTP, SSE, and WebSocket traffic. The Desktop PID, daemon PID, loopback address, and live sessions do not change.

Closing the Local Control window or choosing **Turn off Local Control** closes the listener and active connections, releases sleep inhibition, and invalidates the pairing token. A later enable gets a new token. The LAN listener does not exist while the mode is off, so the normal Desktop runtime remains loopback-only.

This mode intentionally covers same-network access only. Internet remote control requires an account-authenticated outbound relay with reconnectable session state; it must not be implemented by exposing this LAN gateway through port forwarding or an unauthenticated tunnel.

## Verification

- Unit tests cover flag conflicts, generated-token handoff, LAN URL construction, QR output, and sleep inhibition.
- Desktop Rust tests cover the gateway's Host/Origin boundary, HTTP bearer translation, WebSocket subprotocol translation, and loopback-only target requirement.
- A real local daemon run verifies that the QR URL authenticates `/capabilities`, the Web Shell loads, and the sleep inhibitor lives only for the Local Control process.
- A packaged macOS app pass verifies that enabling Local Control preserves the existing daemon/session, the QR opens that session from a second browser, and disabling it revokes the LAN listener and sleep assertion.
- Existing `serve` command and sleep-inhibitor tests remain green, followed by build and typecheck.
