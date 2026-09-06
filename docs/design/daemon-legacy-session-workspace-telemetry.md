# Legacy Session Workspace Telemetry

## Context

The daemon telemetry middleware classifies HTTP requests before Express route
handlers run. Legacy singular session routes can resolve to any registered
workspace, but the middleware cannot know the selected runtime from the URL
alone. Resolving the live owner in both middleware and the handler duplicates
work and can disagree if the registry changes between the two lookups.

This design gives every explicit legacy `/session`, `/sessions`, and
`/permission` route a stable request span while attributing dynamic routes to
the runtime selected by the handler.

## Route inventory

The route catalog contains all 48 explicit legacy routes. Each entry declares
its HTTP method, Express path template, canonical route label, and one of two
attribution modes:

- `handler_resolved` (41 routes): `POST /session`, load/resume, the legacy
  transcript route, and every singular session route that resolves a live
  owner. The handler publishes the selected runtime workspace to telemetry.
- `pre_resolved` (7 routes): legacy export, A2UI action, legacy organization,
  the three global batch mutations, and the global permission vote. These
  routes remain bound to the primary workspace.

The catalog matcher follows the relevant Express 5 defaults: static segments
are case-insensitive, one trailing slash is accepted, and parameter segments
are decoded only after their raw path boundary has been captured. A malformed
session id is retained as its raw value. Permission request ids are decoded
before their existing length and character-set validation. The emitted
`http.route` always uses the canonical catalog template.

## Deferred attribution

Handler-resolved requests start without `qwen-code.workspace.hash`. The
middleware stores a private context on the Express response. Route code calls
`setDaemonTelemetryWorkspace(res, runtime.workspaceCwd)` after a unique runtime
has been selected. The setter is best-effort and first-selection-wins: a
repeated identical value is idempotent and a later different value is ignored.

The four publication seams are:

1. `requireSessionRuntime`, shared by live-owner routes.
2. Session creation after workspace selection.
3. Session load/resume after target runtime selection.
4. Legacy transcript resolution after a unique live or persisted owner is
   found.

Publication precedes later trust, unsupported-secondary, conflict, and request
validation checks. Consequently those failures retain the uniquely selected
runtime. Requests that fail before unique selection, including not-found,
ambiguous, and workspace-mismatch cases, omit the workspace hash. Attribution
uses `runtime.workspaceCwd`, not a session's requested or temporary cwd.

On response `finish` or `close`, the middleware hashes the published workspace,
sets the span attribute, records the response, and ends the span. Resolution,
hashing, and span updates are best-effort and cannot affect request handling or
metrics settlement. The context is cleared after one settlement.

Pre-resolved requests continue to hash the middleware-selected workspace when
the span starts. Removing the middleware's live-owner callback ensures a live
owner is resolved no more than once per request.

## Streaming and metrics

All 48 catalog routes create request spans. A successful
`GET /session/:id/events` response ends its span when the SSE connection closes,
but is excluded from the ordinary HTTP request count/duration and the Web Shell
status metrics ring because its duration is the connection lifetime. SSE
handshake failures are recorded as ordinary short HTTP requests.

`POST /session/:id/generate` is a bounded request-scoped SSE operation. Its
connection ends when generation completes, so its duration remains meaningful
request latency and continues to enter ordinary HTTP metrics.

Heartbeat requests remain in OpenTelemetry HTTP metrics but stay excluded from
the status metrics ring. `GET /daemon/status` also remains excluded only from
that ring. A shared settlement guard prevents duplicate recording when both
`finish` and `close` fire.

HTTP metrics and the Web Shell metrics ring remain daemon-global. Adding a
workspace metric dimension requires a separate cardinality and dashboard
compatibility review.

## Compatibility and boundaries

This change does not alter routes, request or response schemas, SDKs,
capabilities, persistence, authentication, trust ordering, archive leases,
bridge error mapping, or session execution. It does not add public telemetry
attributes.

The telemetry middleware is installed after bearer authentication, rate
limiting, and JSON parsing, so requests rejected by those earlier gates remain
outside this request-span coverage. Implicit HEAD/OPTIONS, access-log behavior,
rate-limit path normalization, workspace session-group routes,
workspace-qualified organization, ACP/WebSocket telemetry, and enabling
secondary branch/fork/cd execution are out of scope.

## Verification

- A drift guard compares the explicit legacy routes registered with Express to
  the catalog and asserts the 48/41/7 inventory.
- Matcher tests cover case, trailing slash, encoded slash, Unicode, malformed
  encoding, permission id validation, method/path mismatch, and canonical
  labels.
- Middleware tests cover deferred attribution, first-selection-wins, hash
  caching, telemetry failures, one-time settlement, SSE metrics, heartbeat, and
  status exclusions.
- Route tests cover live-owner, creation, restore, and transcript publication
  for primary, secondary, untrusted, missing, ambiguous, and conflict cases.
- A dual-workspace outfile test verifies secondary, primary-bound, and omitted
  hashes without exposing raw workspace paths.
