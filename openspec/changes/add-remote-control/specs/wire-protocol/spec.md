# wire-protocol — spec delta

## ADDED Requirements

### Requirement: Capability advertisement includes remoteControl block

The `GET /capabilities` endpoint SHALL return a top-level
`remoteControl` object describing the protocol version, supported
transports, supported scopes, and feature flags.

#### Scenario: Client negotiates transport from capabilities

- **WHEN** a client GETs `/capabilities`
- **THEN** the response body contains:
  ```jsonc
  {
    "v": 1,
    "features": [
      /* Stage 1 features */
    ],
    "remoteControl": {
      "version": 1,
      "supportedTransports": ["sse", "ws"],
      "supportedScopes": ["owner", "write", "approve", "read"],
      "pairingEnabled": true,
      "auditEnabled": true,
      "walHorizonSec": 86400,
      "walMaxEvents": 10000,
    },
  }
  ```

#### Scenario: Mismatched protocol version refused

- **GIVEN** the daemon advertises `remoteControl.version: 1`
- **WHEN** a client sets `X-RC-Version: 2` on a request
- **THEN** the response is `426 Upgrade Required`
- **AND** the body includes `{ requiredVersion: 1 }`

### Requirement: SSE event envelope

Every SSE frame emitted on `/session/:id/events` SHALL conform to the
envelope:

```jsonc
{
  "id": "<hex monotonic per-session>",
  "v": 1,
  "type": "<event type>",
  "originatorClientId": "<tokenId or null>",
  "data": {
    /* type-specific payload */
  },
}
```

The SSE `id:` line MUST equal `data.id` so that `Last-Event-ID` replay
works.

#### Scenario: All emitted frames carry envelope fields

- **WHEN** any event is emitted on the SSE stream
- **THEN** the frame's JSON body contains `id`, `v`, `type`, and `data`
- **AND** the SSE `id:` header equals the body's `id`

### Requirement: New event types beyond Stage 1

The daemon SHALL emit the following additional event types in addition
to Stage 1's set:

- `client_joined` — `data: { tokenId, clientName, scopes, attachedAt }`
- `client_left` — `data: { tokenId, reason: "disconnect"|"revoked"|"evicted" }`
- `audit_event` — `data: { auditId, action, actorTokenId, material, payload }`
- `ui_command` — `data: { command, args, result }`

Stage 1 event types (`session_update`, `permission_request`,
`permission_resolved`, `model_switched`, `model_switch_failed`,
`session_died`, `client_evicted`, `stream_error`) SHALL be retained
verbatim.

#### Scenario: Cross-client presence

- **WHEN** a new client connects to `/session/S/events`
- **THEN** all other subscribers receive a `client_joined` frame
- **AND** the new client's first frame is a synthetic `client_joined`
  for itself

#### Scenario: Material audit events are mirrored to read-scope subscribers

- **WHEN** a `write`-scope client successfully posts a prompt
- **THEN** all subscribers with `read` scope receive an `audit_event`
  frame describing the action

### Requirement: Optional WebSocket transport

The daemon SHALL accept a WebSocket upgrade at `GET /session/:id/ws`
that carries the identical event envelope payloads as SSE.

#### Scenario: WS frames carry the same JSON envelope

- **GIVEN** a client opens a WS at `/session/S/ws` with
  `Sec-WebSocket-Protocol: qwen-rc.v1`
- **WHEN** the daemon emits a `session_update`
- **THEN** the WS message body is identical to the JSON that would have
  been emitted on the SSE channel

#### Scenario: WS supports Last-Event-ID via query

- **WHEN** the client opens `/session/S/ws?lastEventId=<hex>`
- **THEN** the daemon replays the same range it would have replayed for
  an SSE reconnect with that `Last-Event-ID`

### Requirement: Tokens transit only in Authorization header

The daemon SHALL accept bearer tokens only via the `Authorization`
request header (`Authorization: Bearer <token>`). Tokens MUST NOT be
accepted as query parameters or path segments.

#### Scenario: Token in query parameter is rejected

- **WHEN** a client requests `/session/S/events?token=qwk_xxx`
- **THEN** the response is `401 Unauthorized`
- **AND** no event is emitted to the client

#### Scenario: Web client uses fetch-streaming for SSE

- **GIVEN** a browser client cannot set headers on the native
  EventSource
- **THEN** the web client SHALL use a `fetch`-based SSE reader that can
  attach `Authorization`

### Requirement: Browser CORS allowlist derived from pairing

The daemon SHALL accept CORS preflight from origins recorded in paired
clients' `userAgent`/`origin` metadata. Unrecognized origins SHALL
receive an opaque CORS denial.

#### Scenario: Paired origin is preflight-approved

- **GIVEN** a client paired from origin `https://qwen.local:4170`
- **WHEN** a browser preflights with `Origin: https://qwen.local:4170`
- **THEN** the response carries `Access-Control-Allow-Origin:
https://qwen.local:4170`
- **AND** `Access-Control-Allow-Credentials: true`

#### Scenario: Unknown origin is denied

- **WHEN** a browser preflights with an origin not on the allowlist
- **THEN** the response omits `Access-Control-Allow-Origin`
- **AND** logs a structured `cors_denied` audit event

### Requirement: Read-only file access endpoints

The daemon SHALL expose workspace-rooted, read-only file access for the
`@`-autocomplete and diff-preview features used by clients:

- `GET /files?glob=<glob>&limit=<n>` — returns matching paths.
- `GET /files/content?path=<workspace-relative>` — returns file content
  with content-type sniffed.

Both endpoints SHALL refuse paths that escape the workspace root
(`..`, absolute paths, symlinks pointing outside).

#### Scenario: Path traversal blocked

- **WHEN** a client requests
  `/files/content?path=../../etc/passwd`
- **THEN** the response is `400 Bad Request` with code
  `workspace_escape`

#### Scenario: Glob is sandboxed

- **WHEN** a client requests `/files?glob=/etc/**`
- **THEN** the response is `400 Bad Request` with code
  `absolute_glob_not_allowed`

### Requirement: Audit query endpoint

The daemon SHALL expose `GET /rc/audit` for tokens with `owner` scope.
It MUST support `since` (event id or ISO timestamp), `limit` (max 1000),
and `tokenId` (filter by actor) query parameters.

#### Scenario: Read scope cannot read full audit

- **GIVEN** a token with scope `read`
- **WHEN** it requests `/rc/audit`
- **THEN** the response is `403 Forbidden`

#### Scenario: Owner reads filtered audit

- **GIVEN** a token with scope `owner`
- **WHEN** it requests `/rc/audit?since=2026-05-15T00:00:00Z&limit=100`
- **THEN** the response is a JSON array of audit entries in
  ascending-id order

### Requirement: Versioning and forward compatibility

Clients SHALL ignore unknown event types and unknown envelope fields.
Daemons SHALL preserve unknown fields when echoing client-originated
payloads (e.g., `prompt`) so future clients can extend the protocol
without breaking older daemons within the same `v`.

#### Scenario: Forward-compatible client survives a new event type

- **GIVEN** a daemon emits a future `metric_snapshot` event the client
  does not know
- **WHEN** the client receives it
- **THEN** the client logs and discards the event
- **AND** continues processing subsequent events
