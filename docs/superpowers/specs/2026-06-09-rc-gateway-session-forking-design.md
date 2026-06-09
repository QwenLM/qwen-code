# Design — rc-gateway session forking (cycle 21, part 1)

**Proposal:** `add-session-forking` (slice 1 of N).
**Date:** 2026-06-09.
**Branch:** `add-remote-control-spec`.

## Goal of this slice

`POST /rc/session/:id/fork` → fork a settled session into a brand-new
daemon-hosted session that inherits the parent's full transcript, then
goes its own way. Delivers proposal story **F2** (try a parallel
approach from the current state) and **F5** (audit trail). The fork is a
normal session thereafter — every existing gateway route (watch /
approve / prompt) works on it unmodified.

## Feasibility — confirmed by an existing shipping feature

This is NOT speculative. qwen-code core already ships `/branch` (a TUI
slash command, `useBranchCommand.ts`) that does exactly:
`SessionService.forkSession(oldId, newId)` → `loadSession(newId)`. That
is the existence proof that the daemon **restores a session from a file
at an id its create-API never minted** — restore resolves purely by path
(`SessionService`: `path.join(chatsDir, ` `${id}.jsonl` `)`,
`SESSION_FILE_PATTERN = /^[0-9a-fA-F-]{32,36}\.jsonl$/`), with no
"ids-I-issued" registry gate. (The ACP-bridge "allow-list of ids being
restored" is a transient during-restore set, not a persistent registry.)

The gateway can't call `forkSession` (it's in the daemon's process and
no daemon HTTP fork route exists), so we **replicate its disk logic from
outside** and then drive the daemon's public `loadSession` via the SDK.

## THE ARCHITECTURAL DEVIATION (headline — read this first)

Every prior cycle (1–20) consumed the daemon's **public contract** via
the SDK and owned its own state. **This cycle is a deeper coupling: it
writes into the daemon's private on-disk session storage and depends on
the daemon's undocumented restore-by-path behavior.** It still breaks no
merge-cleanliness rule (zero source edits outside `packages/rc-gateway/`)
and it reuses the same on-disk JSONL format cycle-19 already reads — but
_writing + depending on restore semantics_ is more than _reading_.

Justification: (a) it's the only gateway-clean path (`createOrAttach`
takes no sessionId — the daemon mints it — so "invent-id + pre-write +
load" is the sole option, and it's precisely what `/branch` does
internally); (b) the **real-daemon e2e is the drift detector** — if
upstream changes the JSONL schema, the path derivation, or restore-by-
path, the e2e fails loudly. **Opus reviewer: attack exactly this — what
breaks if upstream changes the JSONL schema / path derivation / restore
semantics, and does the e2e actually catch it?**

## What we replicate from `SessionService.forkSession`

Read source JSONL → for every record, copy **verbatim** except three
fields:

- `sessionId` → `newSessionId`
- `parentUuid` → rebuilt as a linear chain in write order (`prevUuid`,
  starting `null`)
- stamp `forkedFrom: { sessionId: sourceId, messageUuid: record.uuid }`

**Do NOT touch `cwd`** — `loadSession` re-checks the first record's `cwd`
for project ownership, so a verbatim `cwd` passes the daemon's own check.
Write to `<chatsDir>/<newId>.jsonl` with exclusive create (`wx`, mode 0600) so we never clobber an existing session file. `newId =
randomUUID()` (matches `SESSION_FILE_PATTERN`).

## The chats-dir path resolver (the subtle part)

Core derives the chats dir as
`getRuntimeBaseDir()/projects/<sanitizeCwd(cwd)>/chats` where:

- `sanitizeCwd(cwd) = cwd.replace(/[^a-zA-Z0-9]/g, '-')` (lowercased
  first only on win32).
- `getRuntimeBaseDir()` precedence: `QWEN_RUNTIME_DIR` env →
  _`setRuntimeBaseDir()`/contextual (settings-based, INVISIBLE to the
  gateway)_ → `getGlobalQwenDir()` (= `QWEN_HOME` env → `~/.qwen`).

New `src/sessions/chatsPath.ts` `resolveChatsDir(cwd)` replicates this
**exactly** (env precedence + `sanitizeCwd`). **`cwd` comes only from the
trusted `daemon.capabilities().workspaceCwd`** — no request input touches
a path (same trust model as cycle-19 search).

> **NOTE — cycle-19 has a latent path bug.** `search/transcripts.ts`
> `resolveChatsDir` used `cwd.replace(/[/.]/g,'-')` under a hardcoded
> `~/.qwen` — an approximation that diverges from `sanitizeCwd` for cwds
> containing `_`/spaces/etc. and ignores the base-dir env vars. NOT fixed
> here (would touch shipped search + need its own regression pass);
> recorded as a follow-up. This cycle ships the correct resolver; a later
> cycle should point search at it.

**Fail-loud guard:** because the gateway can't see a settings-based
`setRuntimeBaseDir` override, before forking we assert the parent file
exists at the derived path (`<chatsDir>/<parentId>.jsonl`). If absent →
`404 parent_transcript_not_found` (never write a fork to a wrong dir).
This converts a derivation mismatch into a clear error, not silent
corruption.

## Endpoint

### `POST /rc/session/:id/fork`

Pipeline (same as prompt/command routes):
`requireScope(WRITE)` → `recordActivity` → `enforceSessionLock` →
handler.

Body: `{}` this slice (mode defaults to `include` full-copy). A body
with `transcript` set to anything other than `include` (or `fromEventId`
present) → `400 unsupported_fork_mode` (so deferred modes fail clearly,
not silently as full-copy).

Handler:

1. `cwd = await capabilities().workspaceCwd` (errors / absent →
   `502 daemon_unavailable`). `chatsDir = resolveChatsDir(cwd)`.
2. Parent path `<chatsDir>/<:id>.jsonl`. Not a readable non-empty file →
   `404 parent_transcript_not_found`.
3. `newId = randomUUID()`. Replicate the fork copy → write
   `<chatsDir>/<newId>.jsonl` (`wx` 0600). `EEXIST` (astronomically
   unlikely) → `500`/retry-once.
4. `await daemon.loadSession(newId)` so the fork is live + listable.
   Throws → best-effort unlink the just-written fork file, `502`.
5. Audit `session_forked { parentSessionId: :id, newSessionId,
copiedCount }` — ids + count only, never transcript content.
6. `200 { sessionId: newId, parentSessionId: :id, forkedAt: <ISO> }`.

`forkedAt` is the gateway's wall-clock at response time (injectable
`nowFn` for tests).

## Decisions

### D1 — Full-copy include only (defer `fromEventId` truncation)

The proposal's `fromEventId` selects a parent event to fork _up to_. But
the SSE event id is a **monotonic numeric bus sequence** (`lastEventId:
number`), a different namespace from a JSONL `record.uuid` (string) —
there is no gateway-side mapping from one to the other. So precise
back-out (F1) is deferred until a correlation exists; this slice copies
the **whole** flushed transcript (exactly what `/branch` does), which
delivers F2 (parallel approach from current state).

### D2 — Fork the flushed (on-disk) transcript; document "settled session"

`/branch` calls `chatRecordingService.finalize()` to flush before
snapshotting. The gateway can't call `finalize()` from outside, so it
forks whatever is **flushed to disk**. Reading the parent while the
daemon may append is safe (we only read it and write a brand-new file —
no write conflict), but a fork of a mid-turn session may miss the
unflushed tail. **Documented: fork a settled/idle session.** No
flush-coordination built.

### D3 — `loadSession` (not `resumeSession`) to register the fork

`/branch` uses `loadSession(newId)`. We mirror it: `loadSession` makes
the fork a live, listable, promptable session without resuming an agent
turn.

## Deferred (NOT in this slice)

- `fromEventId` truncation / precise back-out (F1) — no event-id↔uuid
  mapping.
- `empty` mode — `forkSession` throws on empty; a near-empty transcript
  may not restore. Low value.
- `summary` mode — needs a model turn (agent emits the summary); can't
  e2e headless. Separate slice, verified-locally-only at best.
- Lineage in the session listing / tree (F4) — needs a gateway
  `GET /rc/sessions` that reads every transcript's `forkedFrom`; separate
  slice.
- Setting the fork's `name`/customTitle — needs appending a
  `custom_title` record; deferred (endpoint takes no `name` this slice).
- Fixing cycle-19's `resolveChatsDir` approximation (follow-up).

## Security / correctness notes for review

- `:id` (parent) and `newId` are validated against
  `SESSION_FILE_PATTERN` before any path join — `../` etc. can't escape
  the chats dir. `newId` is a fresh `randomUUID` (always valid).
- Parent path is built from trusted `workspaceCwd` + a pattern-validated
  id; no request body reaches the filesystem.
- Exclusive `wx` create prevents clobbering an existing session.
- Audit carries ids + `copiedCount` only — never record content.
- **Primary review target: the upstream-coupling/drift risk** (schema,
  path derivation, restore-by-path) and whether the e2e truly exercises
  the real-daemon restore (it must fork a real on-disk parent and assert
  the fork _loads + lists_, not just that a file was written).

## Verification

- vitest: the fork-copy transform (verbatim except sessionId/parentUuid-
  chain/forkedFrom; parentUuid chain correctness; first record `cwd`
  untouched); `resolveChatsDir` (sanitizeCwd exactness incl. `_`/space
  cases, `QWEN_RUNTIME_DIR`/`QWEN_HOME` precedence); the route (404 on
  missing parent, 400 on unsupported mode, 403 without WRITE, happy path
  → writes a rewritten file + calls `loadSession` + audits ids/count not
  content; daemon `loadSession` throw → unlink + 502).
- `npm run typecheck|lint|build|test --workspace @qwen-code/rc-gateway`.
- `node scripts/rc-gateway-e2e.mjs` extended (THE drift detector): write
  a real parent transcript into the real daemon's derived chats dir
  (fabricate a minimal valid `ChatRecord`, or create a session via the
  daemon if that yields a non-empty JSONL) → `POST .../fork` → assert
  200 + the fork's JSONL exists + the fork **appears in
  `listWorkspaceSessions`** (proves real-daemon restore-by-path works
  against our derived path). Fork unknown parent → 404; fork without
  WRITE → 403. Clean up both transcripts in a `finally`. Promptability of
  the fork is **verified-locally-only** (no provider headless).
