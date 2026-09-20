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
The page's QR character block uses `lang="en"` locally: CJK font fallback can otherwise
give block glyphs and spaces different widths and destroy the QR grid. Nearby
labels continue to use the selected UI language.

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

The existing Host and Origin checks remain in force. Same-origin exchange
requests receive only a narrow exception from the runtime-bearer Origin check;
the exchange handler verifies its own credential. Device bearers use the same
credential store as REST and WebSockets. No new pre-auth cold-start exception
is needed: an invitation can only exist in an initialized runtime.

Use the daemon address through which the browser connected. For a wildcard
listener reached over loopback, offer the existing eligible LAN interfaces
and let the user choose when there is more than one. Pairing preserves HTTP
or HTTPS and explains that HTTP traffic is unencrypted. It does not add TLS.
At most 64 live invitations are retained; issuing more discards the oldest.

## Affected components

- CLI credential store, primary same-origin authentication, daemon route wiring,
  and new pairing route/service tests.
- Web Shell mobile-access popover, standalone token bootstrap, bilingual copy,
  and focused client tests.
- Existing Local Control routes remain the fallback for loopback daemons.

## Validation and acceptance

Dry-run the global `qwen` baseline, then run the built daemon and browser flow.
Verify default availability on non-loopback, automatic QR rotation, countdown,
single-use and expiry rejection, no runtime bearer in the QR, independent
device access after rotation, primary/Local Control isolation, same-origin and
cross-origin checks, wildcard address selection, and unchanged loopback flow.
Build, typecheck, run focused tests, inspect the full diff twice, and review.
See `.qwen/e2e-tests/web-shell-dynamic-pairing.md` for results.

## Open questions

None. Device-management UI, individual revocation, terminal rotation and
converting the separate Local Control workflow are deferred.
