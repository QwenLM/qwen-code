# Cycle 61 — Cross-session search web UI (`GET /rc/search` consumer)

Proposal: `add-cross-session-search`. The backend is ALREADY built (an
earlier cycle): `search/transcripts.ts` (`searchTranscriptsDetailed`, snippet,
recency sort, timeout), `search/query.ts` (phrase/AND/OR/NOT/prefix operators),
and the OWNER-only route `GET /rc/search` mounted in server.ts. The missing
piece is the proposal's client search surface (X1 "where did we talk about
that?"). This adds a browser search section.

## Deviation note

The proposal's client UX is a `Ctrl/Cmd-K` modal; this ships the same
capability as a plain self-contained `<section>` (consistent with the other
cycle-54..60 panels). No daemon change; consumes the existing route. A modal /
keyboard shortcut / click-to-open-session is Deferred.

## Route contract (read from source)

`GET /rc/search?q=<query>&kind=<user|assistant|tool|all>&sessionId=<opt>&limit=<n>`
OWNER-only. 200 -> `{hits:[{sessionId,eventId,kind,ts,snippet}], truncated,
elapsedMs}`. 400 `invalid_query` (empty q) / `query_too_long` (>1024) /
`invalid_kind`; 503 `search_timeout`; 500 `search_error`; 401/403 non-owner.

## What it adds

A "Search" `<section>`: a query `<input>`, a kind `<select>` (all/user/
assistant/tool), a Search button (and Enter-to-search on the input), and a
results `<div>`. On search -> `GET /rc/search` -> render each hit as a row:
`kind · ts · <sessionId>` header + the snippet beneath. A footer line shows
`N hits in <elapsedMs>ms` (+ "(truncated)" when the flag is set).

## Decisions

1. **The `snippet` is transcript text — rendered via `textContent` ONLY**
   (the single most important XSS line this cycle; a transcript can contain
   arbitrary user/model/tool text incl. `<script>`/`<img onerror>`). Every
   field (snippet, sessionId, ts, kind) is a textContent sink; ZERO innerHTML.
2. Surface the backend error codes: 400 `invalid_query`/`query_too_long`/
   `invalid_kind` -> the code; 503 -> "search timed out (narrow the query)";
   401/403 -> "needs an owner token".
3. Empty q is guarded client-side (don't fire) AND the 400 is handled. Limit
   fixed at 50 (the route default; a limit control is Deferred).
4. Self-contained section (new ids `search-q`/`search-kind`/`search-btn`/
   `search-results`), touches no existing handler. No src change (public/
   served raw).

## Feasibility / harness

The cycle-58 harness writes minimal parent/fork transcripts with no searchable
text. Enhanced (still /tmp): write a record with
`message:{parts:[{text:'... oauth refresh token ...'}]}` + a `timestamp`/`uuid`
into the chats dir so `/rc/search?q=oauth` returns a real hit with a snippet.
No product code depends on the harness.

## Verification

Playwright in-session: pair OWNER -> type `oauth` -> Search -> a hit row
renders with the snippet containing "oauth" (and NOT as live markup — XSS
probe: a transcript record whose text contains `<img src=x onerror=...>`
renders inert) -> type a no-match term -> "(no hits)". lint/build/test
unchanged (no src change), e2e 45/45.

## Deferred

The Ctrl-K modal + keyboard shortcut; click-a-hit-to-open-the-session-at-event;
kind filter chips; a limit/since control; highlighting the matched term in the
snippet.
