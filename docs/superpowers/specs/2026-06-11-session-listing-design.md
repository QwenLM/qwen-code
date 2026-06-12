# Cycle 50 — Session listing with fork lineage (`GET /rc/sessions`)

Proposal: `add-session-forking`, task **1.3** ("Lineage in
`GET /workspace/:cwd/sessions`"): the session listing gains a derived
`forks: [...]` per session plus `parentSessionId`, so a UI can render a
fork tree.

## Deviation from the proposal (gateway-side)

The proposal frames task 1.3 as _extending the daemon's
`GET /workspace/:cwd/sessions`_ with lineage fields. Two primary-source
reads reshape this into a NEW gateway endpoint that scans disk:

1. **The SDK exposes no passthrough for the daemon's listing route, and
   `DaemonSessionSummary` (sdk `daemon/types.ts:158`) carries no
   `forkedFrom`/parent field** — so lineage must be overlaid from the
   transcripts regardless.
2. **The daemon's `listWorkspaceSessions` is ACTIVE-ONLY, not a disk
   listing.** `httpAcpBridge.ts:3001` iterates `byId.values()` — the
   in-memory map of currently restored/active sessions. A parent you
   forked from and then stopped attending is NOT in that map. Keying a
   fork-tree listing on the active set would therefore HIDE exactly the
   dormant-parent nodes the tree exists to show. **That is the deviation
   rationale: we scan the on-disk chats dir** (the same `forkedFrom`
   source `GET /rc/session/:id/lineage` already reads), so the listing is
   complete over everything that exists on disk, dormant parents
   included.

The symmetric gap is acceptable: a dir-scan misses a brand-new session
whose transcript has not flushed yet — but a zero-message session has no
lineage to show, so it is irrelevant to a fork tree (whereas dormant
parents are essential). A future "complete" listing could take the union
(daemon-active ∪ on-disk); see Deferred.

Architecturally this makes `/rc/sessions` mirror `/rc/session/:id/lineage`
exactly: both resolve only the trusted `workspaceCwd` via
`capabilities()`, build `chatsDir` via `resolveChatsDir`, and read the
same first-record `forkedFrom.sessionId` source. No request input ever
reaches a filesystem path.

## Endpoint

`GET /rc/sessions` — **OWNER-scoped** (a flat workspace-wide topology
enumerates sibling/ancestor session ids; a session-locked share token
must never see it — same posture as `/rc/session/:id/lineage`).

Response `200`:

```json
{
  "sessions": [
    { "sessionId": "<root>", "forks": ["<childA>", "<childB>"] },
    { "sessionId": "<childA>", "parentSessionId": "<root>", "forks": [] }
  ],
  "truncated": false
}
```

- `parentSessionId` is OMITTED for a root (no `forkedFrom`).
- `forks` is the reverse index: child ids **present in this listing**
  whose `forkedFrom.sessionId` is this session. A child whose parent file
  is absent (orphan) still lists with its `parentSessionId`, but the
  missing parent does not appear as a node and the child appears in no
  `forks[]` (truncate-don't-fabricate, mirroring lineage D4).
- `truncated` is true when the on-disk session count exceeded the scan
  cap (`MAX_LIST_SESSIONS = 500`).

`502 daemon_unavailable` when `workspaceCwd` is unresolvable (mirrors
lineage). `500 session_list_failed` on an unexpected read error
(try/catch — server.ts has no global error middleware; this is an ASYNC
handler so the catch is mandatory). A missing chats dir (ENOENT) is a
clean `200 { sessions: [], truncated: false }`, not an error.

## Decisions

1. **Set source = on-disk chats-dir scan, NOT the daemon's active list.**
   (Deviation rationale above.) `/rc/sessions` becomes architecturally
   identical to lineage; `listWorkspaceSessions` is dropped from the
   design entirely.
2. **Bounded first-line read (`readFirstRecord`).** A dir-scan opens
   every transcript ever written in the workspace; we need only line 1
   (the `forkedFrom` source) of each. `readFirstRecord` accumulates raw
   **bytes** to the first `\n` (or EOF, or a 1 MiB cap), then decodes the
   range **once** (`Buffer.concat` → `toString('utf8')`) so a multibyte
   char split across two `read()`s never corrupts. A first line over the
   cap fails to parse → `null` (treated as a root), never a truncated
   prefix. This is load-bearing, not optional: unlike the active-list
   path, the scan is otherwise O(all transcript bytes in the workspace).
3. **File-count cap with a `truncated` flag.** Filenames are sorted
   lexically and the first `MAX_LIST_SESSIONS` scanned, so the cap is
   STABLE across calls. `truncated:true` signals the listing is partial
   (a parent within the cap may have children beyond it — accepted).
   This bounds an OWNER endpoint a UI may poll; the scan is NOT silent.
4. **Pure `assembleListing` is the bug-prone core.** It builds the nodes
   - the reverse `forks[]` index + deterministic sort, over plain
     `{ sessionId, parentSessionId }` entries — unit-tested without disk.
     Self-referential `forkedFrom` (hand-edited) is defended: a
     self-parent is treated as a root and never indexed.
5. **An unreadable first line lists the session as a root** (no parent),
   not dropped — better UX than hiding a session because its line 1 is
   corrupt. The same id-shape guard (`isValidSessionId`) that lineage
   uses filters non-session filenames before any path join.
6. **New audit action `session_list_read`** with `detail { count,
truncated }` only — never session ids (privacy). Added to BOTH the
   `AuditAction` union AND the `AUDIT_ACTIONS` runtime array.

## Deferred (not in this slice)

- `forkedAt`, `transcriptMode`, `name` — the gateway fork writer
  (`forkTranscript.forkRecords`) stores NONE of these; only
  `forkedFrom:{sessionId, messageUuid}`. Out of reach without a richer
  on-disk header.
- `parentEventId` — available as the first record's
  `forkedFrom.messageUuid`, but it is a message uuid, not the daemon
  "event id" the proposal means; deferred rather than mislabel it. One
  honest future add (`parentMessageUuid`).
- Daemon-summary enrichment (`displayName`/`createdAt`/`clientCount`)
  and the active ∪ disk union listing — a conscious future choice, not
  an oversight.
- mtime/recency sort (needs a `stat` per file); lexical `sessionId`
  sort for now (deterministic, test-friendly).
- Pagination / `forkedAt`-cursor; concurrent `readFirstRecord`
  (`Promise.all`) — sequential reads avoid an fd storm on a large dir.
