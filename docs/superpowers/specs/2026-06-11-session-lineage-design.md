# Cycle 47 — Fork lineage chain (`GET /rc/session/:id/lineage`)

**Proposal:** `add-session-forking` (lineage queryability; design.md "Lineage
model" + `GET /session/:id/lineage`, user story F4, threat-model "Deep fork
chain -> walk DoS").

**Status:** read-only inspector slice. Spreads off `add-webpush` (cycle 46) into
a fresh proposal per the cycle-selection heuristic.

## Deviation from the OpenSpec design

The design is daemon-centric: it has the daemon hold an in-memory adjacency map
(rebuilt by reading the first line of every `<cwd>/chats/*.jsonl` at startup)
and serve `GET /session/:id/lineage` from it. We deliver the **same capability
gateway-side**, with two deliberate deviations:

1. **No in-memory adjacency map; walk on demand.** The gateway owns no daemon
   process state and re-derives lineage per request by reading transcript files
   directly. Forks are infrequent and chains are shallow (design D4), so an
   O(depth) walk reading one file per ancestor is cheap and avoids any
   startup-scan / staleness machinery. The map (and the reverse `forks: [...]`
   child counter in session listing) is **deferred** — that needs a
   workspace-wide `chats/*.jsonl` scan and a session-listing surface the gateway
   does not yet expose.

2. **Lineage source of truth is the per-record `forkedFrom.sessionId` we already
   write, not a dedicated `type:"fork"` header line.** Our cycle-21 fork
   (`forkTranscript.ts`) replicates core `SessionService.forkSession` exactly:
   every copied record carries `forkedFrom: { sessionId: <parent>, messageUuid }`.
   So a session's parent is read straight off its **first record's**
   `forkedFrom.sessionId`. A session whose first record has no `forkedFrom` is a
   **root**. This means lineage works identically for gateway-created forks AND
   core-native `/branch` forks (same on-disk format), with zero new write path.

## Decisions

1. **Scope = `OWNER`, not `SESSION_READ` + session-lock.** A lineage chain
   enumerates ancestor session ids. A session-locked share token (cycle: share
   tokens are pinned to one session via `sessionLockFor`) must never learn the
   ids of sibling/ancestor sessions it isn't locked to. Gating on `OWNER`
   (mirroring `/rc/search`, `/rc/tokens`) makes `requireScope` 403 a share token
   before the handler runs, so **no `enforceSessionLock` is needed** (owner
   tokens are never session-locked). This is the single riskiest line —
   downgrading to `SESSION_READ` would leak topology to a confined guest.

2. **`forkedFrom` read from the FIRST record only.** `forkRecords` stamps
   `forkedFrom` on every record uniformly, so the first record is authoritative.
   We do not scan for "the first record that has a forkedFrom" — first-record
   absence == root, matching our own writer's guarantee.

3. **Hard depth cap = 100 ancestors (design threat model).** Beyond 100 the walk
   stops and the response carries `truncated: true`. A `visited` set also stops a
   self/cyclic `forkedFrom` reference (defense-in-depth — our writer can't
   produce a cycle, but a hand-edited transcript could). Cycle / cap / a
   referenced-but-missing parent file all set `truncated: true`.

4. **Truncate-on-missing-parent (design D4).** "If a mid-chain JSONL is deleted,
   lineage walks truncate naturally." A node is appended to the chain only after
   its file is read successfully; a `forkedFrom` pointing at a now-deleted parent
   stops the walk with `truncated: true` (the deleted id is NOT fabricated into
   the chain).

5. **Validate every id with `isValidSessionId` before touching the filesystem.**
   The start `:id` and every `forkedFrom.sessionId` must match the session-id
   shape (`chatsPath.SESSION_FILE_RE`) before being joined to a path — no request
   or on-disk string ever reaches a path otherwise. An invalid/parent-shaped id
   in `forkedFrom` stops the walk (`truncated: true`); an invalid start `:id`
   returns 404 (it cannot name a file, so it is "not found").

6. **Audit a count-only `session_lineage_read` (new action).** Mirrors
   `search_performed`: record `{ depth, truncated }` — ids count + flag only,
   never session ids or content. New action added to BOTH the `AuditAction`
   union and the `AUDIT_ACTIONS` array (gotcha). `void`-ed, never throws.

7. **Pure walk with injected reader.** `walkLineage(startId, { readRecords,
isValidId, maxDepth })` is a pure async function (filesystem injected as
   `readRecords`) so the cap/cycle/truncate/root logic is unit-tested without
   touching disk. The route is thin glue: resolve workspace cwd -> `chatsDir` ->
   `walkLineage` with `readParentRecords` + `isValidSessionId`.

## Endpoint

```
GET /rc/session/:id/lineage        (OWNER scope)

200 { sessionId, chain: [{ sessionId }, ...], truncated }
      chain[0] is the queried session itself, then parent, grandparent, ... root.
404 { code: 'session_not_found' }   start id invalid OR its transcript missing
502 { code: 'daemon_unavailable' }  workspace cwd unresolvable (daemon down)
500 { code: 'lineage_failed' }      unexpected (EACCES etc.); async-route try/catch
```

## Deferred (explicit)

- `forks: [<childId>...]` reverse child counter + the tree-formatted session
  listing (F4) — needs a workspace-wide `chats/*.jsonl` scan + a listing surface
  the gateway doesn't expose.
- Per-node `name` / `forkedAtEvent` enrichment in the chain (design example) — the
  gateway stores neither a fork name nor a parent event id; chain nodes carry
  `sessionId` only.
- The `empty` / `summary` fork transcript modes (separate, daemon-loadability-
  gated slice — `summary` needs an out-of-band agent call).
- A `GET /workspace/.../sessions`-level lineage overlay.

```

```
