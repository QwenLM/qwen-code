# ACP-over-HTTP — Resumable session event stream (`Last-Event-ID`)

> Status: design + implementation in this PR.
> Closes the resumability gap tracked as RFD Phase 4 in
> [`README.md`](./README.md) §7 / row "Resume cursor (ring `Last-Event-ID`)".

## Problem

The `/acp` Streamable-HTTP session event stream (`GET /acp` with an
`Acp-Session-Id` header) is **live-only**: it neither emits an SSE `id:`
sequence nor honours a `Last-Event-ID` request header on reconnect.

When a control-plane proxy idle-closes the long-lived SSE connection
mid-turn (the daemon itself sends `retry: 3000`, and ingress proxies cut
long SSE frequently), the client reconnects and re-claims ownership, but
**every content frame the daemon produced during the gap is lost** —
`session/update` notifications carrying `agent_thought_chunk` /
`agent_message_chunk`. The turn still reaches a terminal state (a
`turn_complete` is produced / synthesised), so the UI shows "done" with an
empty or truncated body. Re-sending the same prompt works, which is the
tell: the loss is in the transport gap, not the model.

Symptom and field evidence are catalogued in the integration notes as
**§1.8** (`sdk-known-issues.md`).

## What already exists (and why this is small)

The replay engine is **already built and battle-tested** — the gap is only
that the `/acp` transport is not wired to it.

`packages/acp-bridge/src/eventBus.ts`:

- Monotonic per-session `id`, starting at 1 (`nextId`, assigned in
  `publish()`).
- Bounded ring buffer per session (`DEFAULT_RING_SIZE = 8000`, operator
  override `qwen serve --event-ring-size`).
- `subscribeEvents(sessionId, { lastEventId, signal })` replays ring frames
  with `id > lastEventId` before live events flow, and emits the synthetic
  control frames `replay_complete`, `state_resync_required` (ring-evicted /
  epoch reset on daemon restart), `client_evicted`, `slow_client_warning`.

The **REST** surface `GET /session/:id/events` already consumes all of
this: it reads `last-event-id` (`server.ts` → `parseLastEventId`), passes
it to `subscribeEvents`, and serialises each frame with an SSE `id:` line
(`formatSseFrame`). The bug is that the **`/acp` transport** does none of
this:

| Layer                                     | REST `/session/:id/events` | `/acp` GET (today)                            |
| ----------------------------------------- | -------------------------- | --------------------------------------------- |
| reads `Last-Event-ID` header              | yes                        | **no**                                        |
| passes `lastEventId` to `subscribeEvents` | yes                        | **no** (`dispatch.ts pumpSessionEvents`)      |
| emits SSE `id:` line                      | yes (`formatSseFrame`)     | **no** (`SseStream.send` writes `data:` only) |

`acp-http/sse-stream.ts` even says so in a comment: _"no ring-buffer `id:`
sequencing — resumability is RFD Phase 4, deferred."_ This PR removes that
deferral.

## Wire decision — SSE `id:` line (not in-payload `_meta`)

The two SSE surfaces carry **different payloads**:

- REST streams **`BridgeEvent` envelopes** (`{ id, v, type, data, _meta }`).
  The SDK parser (`sdk-typescript/src/daemon/sse.ts`) extracts the cursor
  from the **JSON envelope's `id` field** (it only reads `data:` lines).
- `/acp` streams **raw JSON-RPC 2.0 objects** (`session/update`
  notifications, `session/request_permission` requests, responses). These
  have no envelope `id` to carry a bus cursor, and a JSON-RPC `id` means
  something else (request id).

So for `/acp` the resume cursor is the **standard SSE `id:` line**:

- It is EventSource-native — a spec-compliant SSE client (incl. the
  vendored `AcpHttpTransport`) auto-tracks the last `id:` and auto-sends it
  back as the `Last-Event-ID` header on reconnect.
- It keeps the JSON-RPC payload clean (no non-standard `_meta.qwen.eventId`
  injection into protocol frames).
- It mirrors what `formatSseFrame` already emits on REST, so both surfaces
  share the **same** `eventBus` ids and the same `Last-Event-ID` semantics.

Only **bus-originated** frames carry an `id:` (`session/update`,
`session/request_permission`, daemon-pushed notifies). JSON-RPC
**responses/replies** that ride the session stream are _not_ bus events and
carry **no** `id:` — they are not in the ring and are intentionally not
replay-tracked (a lost in-flight prompt _response_ is the separately-tracked
§1.7 concern, out of scope here; §1.8 is about lost _content_ frames, which
are all bus `session/update` events).

Synthetic terminal frames (`client_evicted`, `stream_error`, …) have no bus
`id` and so emit no `id:` line — matching REST, so they don't burn a slot in
the monotonic sequence the client resumes from.

## Changes

1. **`transport-stream.ts`** — `send(message, id?: number)`. The optional
   `id` is the bus event id for SSE cursor tracking.
2. **`sse-stream.ts`** — `send(message, id?)` prepends `id: ${id}\n` before
   the `data:` line when `id !== undefined` (mirrors `formatSseFrame`).
3. **`ws-stream.ts`** — `send(message, id?)` accepts and **ignores** `id`:
   WebSocket is a stateful connection, no SSE replay (consistent with
   `AcpWsTransport.supportsReplay = false`).
4. **`connection-registry.ts`** — `sendSession(sessionId, frame, id?)`
   threads `id` to `stream.send`. The per-session pre-attach **buffer**
   stores `{ frame, id? }` pairs so a buffered frame keeps its cursor when
   flushed on attach. (The connection-scoped buffer is unchanged — those
   frames are JSON-RPC responses with no bus id.)
5. **`dispatch.ts`**
   - `translateEvent` passes `event.id` through every `sendSession` /
     `binding.stream.send` call for bus events.
   - `pumpSessionEvents(conn, sessionId, signal, lastEventId?)` forwards
     `lastEventId` to `subscribeEvents` — directly reusing the existing
     ring replay.
6. **`index.ts`** — the `GET /acp` session-stream branch reads the
   `Last-Event-ID` header (via a strict `parseLastEventId`, same accept-only-
   decimal-digits rule as REST) and passes it to `pumpSessionEvents`.

No `eventBus`/bridge changes — the engine is reused verbatim.

## Backward compatibility

- **Old clients that don't send `Last-Event-ID`** → `lastEventId` is
  `undefined` → `subscribeEvents` starts live, exactly as today.
- **Adding `id:` lines is backward-compatible SSE** — a client that ignores
  the field is unaffected; an EventSource-based one starts tracking it for
  free.
- **The vendored `AcpHttpTransport` keeps `supportsReplay = false`** until
  it opts in; the daemon change is inert for it until then. Once it flips
  `supportsReplay = true` and resends `Last-Event-ID`, gap frames are
  replayed from the ring and the §1.8 content loss is closed — **no further
  daemon change needed**.
- The REST surface is untouched.

## Test plan

- `sse-stream.test.ts` — `send(msg, 7)` emits `id: 7\n` before `data:`;
  `send(msg)` (no id) omits the `id:` line; ordering `id:` → `data:` →
  blank line.
- `transport.test.ts` (end-to-end over the `/acp` transport):
  - live `session/update` frames now arrive with an `id:` line;
  - a `GET /acp` reconnect carrying `Last-Event-ID: N` replays buffered
    events with `id > N` (gap content recovered), then continues live;
  - a fresh stream with no `Last-Event-ID` behaves as today (no replay).

## Out of scope (still deferred)

- WebSocket / HTTP/2 transports.
- §1.7 (lost in-flight _prompt response_ on the session stream) — a
  separate concern; this PR recovers **content** frames, which all flow
  through the `eventBus` ring.
- Consumer-side `supportsReplay` flip in the external `agent-web`
  `AcpHttpTransport` (lives in a different repo; unblocked by this PR).
