# rc-gateway — `X-Commands-Revision` ETag on `GET /rc/commands` (cycle 35)

## Context

`add-custom-slash-commands` spec (`specs/custom-slash-commands/spec.md:110`):

> The response SHALL carry `X-Commands-Revision: <hex>` where the
> revision is a content hash of the registry; clients MAY use
> `If-None-Match` to short-circuit polls.

Scenario "304 on unchanged revision": a client that previously saw
`X-Commands-Revision: abc123` and re-requests with `If-None-Match: "abc123"`
against an unchanged registry gets `304 Not Modified` with no body.

This is the conditional-GET caching for the command palette: a phone/web
client polls `GET /rc/commands`; when nothing changed it should pay only a
header round-trip, not re-download the whole list.

Design open-Q2 ("expose a versioned ETag … leaning yes") is resolved: yes.

## Deviation from the daemon-centric spec

As with every cycle, the spec says "the daemon" exposes this; we deliver it
gateway-side in the existing `createListCommandsRoute` (`routes/commands.ts`),
which already owns the registry projection. No upstream edit.

## Decisions

- **D1 — Strong validator = hash of the exact serialized body.** The revision
  is `sha256(JSON.stringify({ v: 1, commands }))` over the very object the route
  returns. A 304 is sound iff `revision == revision' ⟹ the body is byte-stable`;
  hashing the bytes makes that hold _by construction_. No reasoning about
  token-scope immutability is needed.
- **D2 — Scope is auto-folded; do NOT separately incorporate caller scopes.**
  `invocableByYou` (the only per-caller field) is already inside the hashed
  bytes, so two callers with different scopes naturally get different revisions.
  This is a per-representation hash, a deliberate _deviation_ from the spec's
  "shared registry hash" wording — still satisfies the single-client scenario,
  and is a strictly stronger validator. Documented so the review doesn't flag it.
- **D3 — Revision covers listing METADATA, not the command body template.** The
  route map already omits `c.body`; therefore a body-only edit does not bump the
  revision and a polling client will get a 304. This is _intentional and correct_
  — the listing never exposed `body`, and an invoke resolves the body server-side
  fresh anyway. A reviewer reading "content hash of the registry" might expect a
  body edit to invalidate; it does not, by design.
- **D4 — `X-Commands-Revision` is set BEFORE the `If-None-Match` check**, so it
  is echoed on both the `200` and the `304` (a 304 must carry the validator).
- **D5 — Lean `If-None-Match` parser.** Node delivers `if-none-match` as a single
  string. The parser: split on `,`, trim each, strip an optional `W/` weak prefix
  and surrounding double-quotes, compare to our hex. We deliberately do NOT honor
  `If-None-Match: *` (a polling cache never sends it; out of scope) and treat an
  array-valued header (duplicate header, not expected here) by joining with `,`.
  Quote-stripping is the only real bug surface → it is unit-tested directly.
- **D6 — `load()` still runs on a 304.** Computing the revision requires the full
  registry, so a 304 saves serialization + transfer, NOT the disk read. There is
  no mtime/watcher cache this slice (deferred). The conditional-GET win is real
  (bytes off the wire) but bounded; an `mtime`/fsnotify revision cache is a later
  cycle.
- **D7 — No new audit.** `GET /rc/commands` is not audited today (listing is a
  read); a 304 is even less eventful. No `AuditAction` change.

## Safety / fail-safe

- Pure-additive read-path. The route already exists and is imported; no notifier,
  auth-hot, or new-throw path is touched (`createHash` over a string and the
  header parser are total — no new rejection into the no-error-middleware server).
- Worst case of a hash bug is a _wrong 304_ → a client shows a slightly stale
  palette until its next poll. Not a security or safety property (the route is
  `requireScope(SESSION_READ)`-gated; the revision is a one-way hash of metadata
  already returned in full to the same authorized caller). sha256 collision is
  the only other failure mode → not reachable.

## Commit order (fail-safe)

1. docs (this file + plan).
2. `ifNoneMatchSatisfied(header, revision)` — pure, exported, **inert** (not yet
   called by the handler) + its unit tests.
3. Wire into `createListCommandsRoute`: compute revision, set header, 304 on
   match, else `res.json` as before; barrel-export the helper; route round-trip
   tests.

## Deferred (unchanged from cycle 28 list)

`tool:` direct invoke (no SDK API), file watcher / 250 ms debounce,
mtime/fsnotify revision cache (cheap-poll without a full `load()`),
`sessionScope:none`, `${file}` server-side resolution,
`slash_command_prompt_submitted` resolved-text audit, web/terminal palette UI.
