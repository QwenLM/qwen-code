# Plan — rc-gateway session forking (cycle 21, part 1)

Design: `docs/superpowers/specs/2026-06-09-rc-gateway-session-forking-design.md`.

**Branch:** `add-remote-control-spec` — stay on it; do NOT create a
branch. Run all git/npm from repo root `/home/evan/projects/qwen-code`
with absolute paths. Strict TDD: red → green, one commit per task, never
`--no-verify`. License header on every new `src/*.ts` (copy the
`@license`/Copyright 2025 Qwen Team/SPDX block from an existing file).
NodeNext ESM: `.js` extensions on relative imports. No `any` (eslint
`no-explicit-any: error`) — use `Record<string, unknown>` + safe reads.
Commits end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Read first (the canonical references you are replicating):**

- `packages/core/src/services/sessionService.ts` lines ~884–952
  (`forkSession`) — the EXACT copy logic to replicate.
- `packages/core/src/config/storage.ts` `getProjectDir` (~307),
  `getRuntimeBaseDir` (~126), `getGlobalQwenDir` (~144); and
  `packages/core/src/utils/paths.ts` `sanitizeCwd` (~the `replace(/[^a-zA-Z0-9]/g,'-')`).
- `packages/core/src/services/chatRecordingService.ts` `ChatRecord`
  interface + the `forkedFrom` field (~line 311).
- `packages/rc-gateway/src/routes/prompt.ts` (route shape, daemon-throw
  → 502), `src/routes/search.ts` (capabilities→cwd wiring),
  `src/server.ts` (pipeline + GatewayDeps), `src/auditLog.ts`
  (`AuditAction` union — add `session_forked`).

## Task 1 — `resolveChatsDir` exact path resolver

New `packages/rc-gateway/src/sessions/chatsPath.ts`:

- `sanitizeCwd(cwd: string): string` — `cwd.replace(/[^a-zA-Z0-9]/g,'-')`
  (lowercase first only when `process.platform === 'win32'`).
- `runtimeBaseDir(env = process.env): string` — `QWEN_RUNTIME_DIR` (if
  set, resolved to absolute) → else `QWEN_HOME` (if set, resolved) → else
  `join(homedir(), '.qwen')`. (We CANNOT see the settings-based
  `setRuntimeBaseDir`/contextual override — that's the documented gap the
  route's existence-guard catches.)
- `resolveChatsDir(cwd: string, env?): string` =
  `join(runtimeBaseDir(env), 'projects', sanitizeCwd(cwd), 'chats')`.
- `SESSION_FILE_RE = /^[0-9a-fA-F-]{32,36}$/` + `isValidSessionId(id)`.

Tests `chatsPath.test.ts`: sanitizeCwd replaces `_`/space/`.`/`/` →
`-` (the cases that diverge from cycle-19's approximation); resolveChatsDir
honors `QWEN_RUNTIME_DIR` then `QWEN_HOME` then `~/.qwen` (pass an `env`
object); isValidSessionId accepts a UUID, rejects `../x` and short ids.

Commits: `test(rc-gateway): exact chats-dir path resolver` /
`feat(rc-gateway): exact chats-dir path resolver (sanitizeCwd + runtime base)`.

## Task 2 — fork-copy transform (pure)

New `packages/rc-gateway/src/sessions/forkTranscript.ts`:

- Define a minimal local `ForkRecord = Record<string, unknown>` (we don't
  need the full ChatRecord type — operate on parsed JSON objects; read
  `uuid` as string).
- `forkRecords(records: Array<Record<string, unknown>>, sourceId: string, newId: string): Array<Record<string, unknown>>`
  — replicate `forkSession`'s map EXACTLY: `prevUuid = null`; for each
  record return `{ ...record, sessionId: newId, parentUuid: prevUuid,
forkedFrom: { sessionId: sourceId, messageUuid: record.uuid } }`, then
  `prevUuid = record.uuid`. Do NOT modify `cwd` or any other field.
- `serializeForked(records): string` = `records.map(r =>
JSON.stringify(r)).join('\n') + '\n'` (matches forkSession byte shape).

Tests `forkTranscript.test.ts`: every record's `sessionId` rewritten;
`parentUuid` chain is `[null, uuid0, uuid1, …]` in write order; each
`forkedFrom` = `{sessionId: source, messageUuid: <that record's uuid>}`;
`cwd` and message content untouched (deep-equal except the 3 fields);
serialize round-trips line-per-record + trailing newline.

Commit: `feat(rc-gateway): fork-transcript record-copy transform` (write
test+impl; prefer red/green two commits).

## Task 3 — fork store/IO helper

New `packages/rc-gateway/src/sessions/forkStore.ts` (thin fs wrapper, so
the route stays testable + the read/parse/write is in one place):

- `class SessionForkStore` ctor `(resolveChatsDir: (cwd:string)=>string)`
  or simply free functions. Provide:
  - `async readParentRecords(chatsDir, parentId): Promise<Array<Record<string,unknown>> | null>`
    — path `<chatsDir>/<parentId>.jsonl`; ENOENT → `null`; read, split on
    `\n`, drop blank lines, `JSON.parse` each (a corrupt line → skip; if
    zero valid records → treat as null = "not forkable").
  - `async writeFork(chatsDir, newId, body): Promise<void>` — `mkdir`
    chatsDir recursive; open `wx` mode 0600; write; close. Surface EEXIST
    distinctly (throw a typed error the route maps to 500).
  - `async removeFork(chatsDir, newId): Promise<void>` — best-effort
    unlink (swallow errors) for the loadSession-failed rollback.

Tests `forkStore.test.ts` (tmp dirs): readParentRecords parses a real
multi-line JSONL; missing file → null; empty/all-corrupt → null; writeFork
creates 0600 file with exact bytes; writeFork on existing path → EEXIST
error; removeFork unlinks + is a no-op when absent.

Commit: `feat(rc-gateway): session fork file IO (read parent / write fork / rollback)`.

## Task 4 — `POST /rc/session/:id/fork` route

New `packages/rc-gateway/src/routes/fork.ts`
`createForkRoute(daemon, resolveWorkspaceCwd: () => Promise<string|undefined>, deps?: { now?: ()=>Date, audit?, randomId?: ()=>string }): RequestHandler`:

1. Body guard: if `req.body?.transcript` is present and !== `'include'`,
   or `req.body?.fromEventId` present → `400 { code:'unsupported_fork_mode' }`.
2. `parentId = req.params.id`; if `!isValidSessionId(parentId)` →
   `404 parent_transcript_not_found` (invalid id can't have a file).
3. `cwd = await resolveWorkspaceCwd()`; falsy → `502 daemon_unavailable`.
   `chatsDir = resolveChatsDir(cwd)`.
4. `records = await readParentRecords(chatsDir, parentId)`; `null` →
   `404 { code:'parent_transcript_not_found' }`.
5. `newId = (deps?.randomId ?? randomUUID)()`. `body =
serializeForked(forkRecords(records, parentId, newId))`. `await
writeFork(chatsDir, newId, body)` (EEXIST → 500 fork_conflict).
6. `try { await daemon.loadSession(newId) } catch { await
removeFork(chatsDir, newId); 502 daemon_unavailable; return }`.
7. `void audit?.record({ action:'session_forked', actorTokenId:
req.rcClient?.id, target: parentId, detail: { newSessionId: newId,
copiedCount: records.length } })`.
8. `200 { sessionId: newId, parentSessionId: parentId, forkedAt:
(deps?.now ?? (()=>new Date()))().toISOString() }`.

Add `session_forked` to `AuditAction` union + `AUDIT_ACTIONS` list.

Tests `fork.route.test.ts` (use a tmp chats dir + a fake/stub daemon
whose `loadSession` resolves; point the route's resolver at the tmp dir
via an injected `resolveWorkspaceCwd` returning a cwd whose
`resolveChatsDir` lands on the tmp dir — OR inject the chatsDir directly
to avoid sanitize coupling; pick the cleaner injection): unsupported mode
→ 400; missing parent → 404; happy path → 200, asserts the fork file
exists with rewritten sessionId, `loadSession` called with newId, audit
entry has newSessionId+copiedCount and NOT record content; `loadSession`
rejects → fork file removed + 502.

Commit: `feat(rc-gateway): POST /rc/session/:id/fork (full-copy include)`.

## Task 5 — wire into server.ts + index.ts

- Add the route after the prompt route in the session pipeline:
  ```ts
  app.post(
    '/rc/session/:id/fork',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    createForkRoute(
      deps.daemon,
      async () => {
        try {
          return (await deps.daemon.capabilities()).workspaceCwd;
        } catch {
          return undefined;
        }
      },
      { audit },
    ),
  );
  ```
- Export new symbols from `index.ts`.
- server.test: a boot test that the route is mounted + WRITE-gated
  (403 without write; 404 for a missing parent with a write token).

Commit: `feat(rc-gateway): wire session fork route into gateway`.

## Task 6 — e2e (THE drift detector)

Extend `scripts/rc-gateway-e2e.mjs`. In a try/finally that cleans up both
transcript files:

1. Resolve the real daemon's chats dir for its `workspaceCwd` using the
   SAME derivation as the gateway (import/copy `resolveChatsDir`; the
   daemon is spawned with a known workspace cwd in the e2e — reuse it).
2. Make a forkable parent: simplest robust path — fabricate a minimal
   valid parent transcript on disk: one `ChatRecord` JSON line with
   `{uuid, parentUuid:null, sessionId:<parentUuid>, timestamp, type:'user',
cwd:<workspaceCwd>, version:'0.0.0', message:{role:'user',parts:[{text:'hello'}]}}`
   written to `<chatsDir>/<parentUuid>.jsonl`. (If a fabricated record
   doesn't satisfy the real daemon's `loadSession`, fall back to creating
   a session via `createOrAttachSession` and check whether its JSONL is
   non-empty; document whichever was used.)
3. `POST /rc/session/<parentUuid>/fork` with the owner token → expect 200
   `{sessionId, parentSessionId, forkedAt}`.
4. Assert `<chatsDir>/<newId>.jsonl` exists.
5. Assert the fork **appears in `GET /workspace/:cwd/sessions`** (proves
   the real daemon restored our gateway-written file by path) — call via
   the SDK or a direct daemon request as the script already does for
   other checks.
6. Error cases: `POST /rc/session/<random-uuid>/fork` (no transcript) →
   404; fork with NO/insufficient token → 401/403.
7. `finally`: unlink the parent + fork JSONL (and any created session
   artifacts). Assert `git status --short` shows no stray files when the
   script ends (the script writes only under `~/.qwen/.../chats`, outside
   the repo — so repo stays clean regardless; still clean up the chats
   files to not pollute the user's real sessions).

- Bump the e2e summary count.

**If step 5 fails** (daemon won't restore our file), that is the drift
detector firing — STOP, report it; do not paper over it. It would mean
the path derivation or restore-by-path assumption is wrong and the cycle
must be reconsidered (not shipped).

Commit: `test(rc-gateway): e2e real-daemon fork restore-by-path`.

## Final verification (repo root, all must pass)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

Confirm diff scope: `git diff --name-only <cycle-start>..HEAD` shows only
`packages/rc-gateway/` + `scripts/rc-gateway-e2e.mjs` (+ the two docs).

## IMPORTANT — report back

- Whether the e2e's step 5 (real-daemon restore-by-path) PASSED. This is
  the make-or-break signal. If it required the fallback (create-session)
  or failed, say so explicitly.
- Commit hashes, all 5 verification outputs (test + e2e counts), the diff
  scope, any deviations, any bugs.
- Do NOT push or edit memory — the orchestrator does that after review.
