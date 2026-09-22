# Web Shell dynamic pairing

[English](web-shell-dynamic-pairing.md) | [简体中文](web-shell-dynamic-pairing.zh-CN.md)

## Problem and scope

The mobile-access button currently requires Local Control, which adds a LAN
listener to a loopback daemon. It cannot enable on an existing non-loopback
listener. Its QR also contains a long-lived bearer. This change makes the
Web Shell button work by default on an authenticated non-loopback primary
listener, without another listener or a settings prerequisite. Terminal QR
output and the existing loopback Local Control workflow remain outside scope.

## Design

The existing mobile-access popover requests a pairing invitation from the
connected daemon. The invitation has 256 random bits, expires after 60 seconds,
and can be exchanged once. The popover refreshes every 45 seconds and displays
remaining validity; a failed refresh hides an expired QR and allows retry.
Closing the popover stops refreshes. Previously issued invitations retain only
their original expiration, allowing an in-progress scan to complete.
The response carries `expiresInMs`; the browser starts its countdown on receipt
so different daemon and browser clocks cannot postpone refresh. The daemon
always enforces expiration using its own clock.
The page's QR character block uses `lang="en"` locally: CJK font fallback can
otherwise give block glyphs and spaces different widths and destroy the QR
grid. Nearby labels continue to use the selected UI language.

The URL carries `#pairing=`, never the daemon bearer. Standalone startup removes
the fragment and exchanges the invitation only with the page's own origin,
before the normal authentication gate. The independent device bearer is stored
through the existing per-tab token mechanism and works for HTTP, SSE and
WebSocket authentication on the primary listener. Device credentials last for
the daemon process, with at most 128 paired devices; reaching the limit refuses
new pairings rather than disconnecting existing devices. Restart revokes all
invitations and device credentials. QR expiration does not end device access.

Both new routes are process-global, unrelated to workspace selection.
`POST /web-shell/pairing` requires existing primary-listener authentication.
`POST /web-shell/pairing/exchange` authenticates only the invitation, sent in
the Authorization header, before the ordinary bearer gate. It accepts only
the origin for which the invitation was issued and only on the primary
listener. An invitation never authorizes API requests or WebSockets.
Responses containing credentials use `Cache-Control: no-store`.
When `--rate-limit` is enabled, both routes use the existing mutation-tier
limiter. Issuance checks a valid primary-listener bearer first. Exchange attempts,
including invalid invitations, use a separate socket-IP bucket before validation so
untrusted client IDs cannot bypass throttling. A 429 response does not consume
the invitation.

Primary HTTP Host validation is unchanged. On authenticated non-loopback
primary listeners, WebSocket upgrades now accept an Origin matching the actual
socket scheme and Host. They skip the loopback-socket Host allowlist in that
case, matching REST's existing non-loopback policy, and still require a valid
bearer — on that path the DNS-rebinding Host defence rests on the bearer
alone. This applies to all primary WebSocket features, including ACP,
terminal, and voice, for runtime and device credentials alike. Loopback and
Local Control listeners keep their existing gates. Proxies that terminate TLS
or rewrite Host still need `--allow-origin` for the browser's origin. The
daemon never trusts forwarded headers, so behind a TLS-terminating proxy the
pairing QR keeps the socket's `http` scheme and the exchange's origin binding
rejects the proxied `https` page — pair from the daemon's direct address or
with the token there.

Same-origin exchange requests receive only a narrow exception from the
runtime-bearer Origin check; the exchange handler verifies its own credential
and rejects foreign origins even when they are explicitly allowlisted for
other API requests. Device bearers use the same credential store as REST and
WebSockets. No new pre-auth cold-start exception is needed: an invitation can
only exist in an initialized runtime.

Use the daemon address through which the browser connected. For a wildcard
listener reached over loopback, offer the existing eligible LAN interfaces
and let the user choose when there is more than one. Loopback classification
follows the operator's `--hostname` spelling, never resolution: a name that
resolves to loopback (for example `lvh.me`) is treated as a remote bind, so
pairing stays available there and can advertise a loopback-only address. Pairing preserves HTTP
or HTTPS and explains that HTTP traffic is unencrypted. It does not add TLS.
At most 64 live invitations are retained; issuing more discards the oldest,
which may still be unexpired — a burst of issuance can void a QR currently on
screen, and that code then fails at exchange as expired.

## Affected components

- CLI credential store, primary same-origin authentication, startup guidance,
  daemon route wiring, and new pairing route/service tests.
- Web Shell mobile-access popover, standalone token bootstrap, bilingual copy,
  and focused client tests.
- Existing Local Control routes remain the fallback for loopback daemons.

## Validation and acceptance

Dry-run the global `qwen` baseline, then run the built daemon and browser flow.
Verify default availability on non-loopback, automatic QR rotation, countdown,
single-use and expiry rejection, no runtime bearer in the QR, independent
device access after rotation, primary/Local Control isolation, same-origin and
cross-origin checks, wildcard address selection, and unchanged loopback flow.
Also cover allowlisted foreign origins and configured throttling of issuance
and invalid exchanges, including a successful retry of a throttled invitation.
Build, typecheck, run focused tests, inspect the full diff twice, and review.
See `.qwen/e2e-tests/web-shell-dynamic-pairing.md` for results.

## Open questions

None. Device-management UI, individual revocation, terminal rotation and
converting the separate Local Control workflow are deferred.
