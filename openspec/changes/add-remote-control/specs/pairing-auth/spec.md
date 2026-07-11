# pairing-auth — spec delta

## ADDED Requirements

### Requirement: Owner bootstrap is single-use and time-bounded

The daemon SHALL bootstrap exactly one owner-scope token on first
startup via a single-use bootstrap code. The bootstrap code MUST be
written to stdout AND to `~/.qwen/rc/owner-bootstrap.code` with file
mode `0600`. The code MUST expire after `bootstrapTtlSec` (default 300)
or first successful redemption, whichever is first.

#### Scenario: Bootstrap closes after first redemption

- **GIVEN** the daemon emitted a bootstrap code `C`
- **WHEN** any client successfully redeems `C` for an owner token
- **THEN** further redemption attempts of `C` return `410 Gone`
- **AND** the bootstrap code file is deleted

#### Scenario: Bootstrap expires after TTL

- **GIVEN** the daemon emitted a bootstrap code `C` with TTL 300 s
- **WHEN** 300 s elapse without redemption
- **THEN** redemption of `C` returns `410 Gone`
- **AND** a fresh bootstrap can be produced via `qwen rc bootstrap-reset`

### Requirement: Pairing code lifecycle

An owner-scope client SHALL be able to mint a pairing code via
`POST /rc/pair { name, scope, ttlSec? }`. The daemon MUST return a
9-character Crockford-base32 code (default form `XXXX-XXXX-X`), single-
use, with a default TTL of 90 s and configurable maximum 600 s.

#### Scenario: Owner mints a write-scope pairing code

- **GIVEN** the requester holds an owner token
- **WHEN** the requester posts `{ name: "Laptop", scope: "write" }`
- **THEN** the response is
  `{ code: "X9Q3-4VKW-N", expiresAt: <ISO> }`

#### Scenario: Non-owner cannot mint a code

- **GIVEN** the requester holds a write token
- **WHEN** the requester posts `/rc/pair`
- **THEN** the response is `403 Forbidden`

#### Scenario: TTL above max is clamped

- **WHEN** the requester posts `{ scope: "read", ttlSec: 1000000 }`
- **THEN** the daemon clamps `ttlSec` to 600 and notes this in the
  response body's `clamped` array

### Requirement: Code redemption mints a long-lived token

`POST /rc/pair/redeem { code, name?, userAgent }` SHALL exchange a
valid code for a long-lived token. The response body SHALL include
`{ tokenId, token, scopes, expiresAt }` where `token` is
`qwk_<base64url(32 random bytes)>` and `expiresAt` defaults to 30 days
from issuance with sliding renewal on every authorized request.

#### Scenario: Plaintext token is shown only once

- **WHEN** redemption succeeds
- **THEN** the response includes the plaintext token
- **AND** the daemon stores only `argon2id(token)` in `tokens.db`
- **AND** subsequent listings (`GET /rc/tokens`) return token metadata
  but never the plaintext

#### Scenario: Code is single-use

- **GIVEN** code `C` was redeemed successfully
- **WHEN** any client posts `{ code: "C" }` again
- **THEN** the response is `410 Gone`

#### Scenario: Sliding renewal extends expiry

- **GIVEN** a token issued with 30-day expiry
- **WHEN** the token is used 10 days later
- **THEN** the token's `expiresAt` is advanced to 30 days from the use
- **AND** the renewal is recorded in the audit log

### Requirement: Scope hierarchy and enforcement

Scopes SHALL be enumerated as `owner`, `write`, `approve`, `read` with
the implication hierarchy: `owner ⊃ write ⊃ read` and `approve ⊃ read`.
`write` does NOT imply `approve` and vice versa — sending a prompt and
voting on a permission are independent.

#### Scenario: write token denied permission vote

- **GIVEN** a token with scope `write` only (no `approve`)
- **WHEN** it posts to `/permission/<requestId>`
- **THEN** the response is `403 Forbidden`

#### Scenario: approve token denied prompt send

- **GIVEN** a token with scope `approve` only
- **WHEN** it posts to `/session/S/prompt`
- **THEN** the response is `403 Forbidden`

### Requirement: Revocation is per-token and immediate

`DELETE /rc/tokens/:tokenId` from an owner-scope client SHALL
invalidate that token's authority. Live SSE subscribers using the
revoked token MUST receive a terminal `client_evicted` frame within 1 s
of revocation; new requests with the revoked token MUST return `401`.

#### Scenario: Revoked subscriber kicked

- **GIVEN** client `C` is subscribed to `/session/S/events`
- **WHEN** an owner-scope client deletes `C`'s token
- **THEN** `C`'s SSE stream emits one `client_evicted` frame and closes

#### Scenario: Revoked token immediately denied

- **GIVEN** token `T` was revoked at time `t0`
- **WHEN** any new request arrives with `T` at `t0 + 1`
- **THEN** the response is `401 Unauthorized`

### Requirement: Audit log captures all material actions

The daemon SHALL append an audit entry to `~/.qwen/rc/audit.log` (daily
rotated) for every authorized request whose effect is material:

- session creation, end, prompt send, prompt cancel, model switch
- pairing code mint, redemption, token revocation
- permission vote (approve / deny / cancel)
- file read above `auditFileReadThresholdBytes` (default 1 MiB)
- session config change

Each entry SHALL be a single JSON line with at minimum:
`{ id, ts, tokenId, clientName, ip, method, path, sessionId?, action, outcome, durationMs }`.

#### Scenario: Tool approval is auditable by identity

- **GIVEN** clients `A` and `B` are both attached to session `S`
- **WHEN** `B` approves a `permission_request`
- **THEN** an audit entry records `action: "permission.approve"` with
  `tokenId` corresponding to `B`
- **AND** all `read`-scope subscribers see an `audit_event` SSE frame
  mirroring the entry

#### Scenario: Audit append survives daemon crash

- **GIVEN** the daemon is mid-write to `audit.log`
- **WHEN** the host crashes
- **THEN** on restart, the daemon SHALL detect a truncated final line
  and recover by truncating to the last complete line
- **AND** a `wal_truncated_audit` event is emitted to owners on next
  attach

### Requirement: Pairing-code-only path for new clients

A client that holds no token SHALL be able to call exactly one endpoint
unauthenticated: `POST /rc/pair/redeem`. All other endpoints MUST
return `401 Unauthorized` without revealing whether the path exists.

#### Scenario: Unauthenticated probe gets opaque 401

- **WHEN** an unauthenticated client requests `GET /session/anything`
- **THEN** the response is `401 Unauthorized`
- **AND** the response body does NOT distinguish "no such session"
  from "valid session, unauthorized"

### Requirement: TLS required for non-loopback bind

The daemon SHALL refuse to start when bound to a non-loopback address
unless either `--tls-cert <path>` is provided OR
`--insecure-no-tls` is explicitly passed. The insecure flag MUST log a
warning at every startup and at every pairing-code mint.

#### Scenario: Non-loopback bind without TLS fails fast

- **GIVEN** the daemon is invoked with `--hostname 0.0.0.0` and no TLS
  flags
- **WHEN** startup proceeds
- **THEN** the daemon exits with code 2 and message
  `tls_required_for_remote_bind`

#### Scenario: Explicit opt-out is loud

- **WHEN** the daemon starts with `--hostname 0.0.0.0
--insecure-no-tls`
- **THEN** stdout includes a banner warning about plaintext bearer
  exposure
- **AND** every `/rc/pair` response includes
  `{ warnings: ["insecure_transport"] }`
