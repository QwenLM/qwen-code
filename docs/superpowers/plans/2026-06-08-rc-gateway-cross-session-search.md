# RC Gateway — Cross-Session Search Core (Cycle 19)

> **For agentic workers:** TDD, `- [ ]` steps. All inside `packages/rc-gateway/` (+ repo-root `scripts/rc-gateway-e2e.mjs`). ZERO edits outside it. Stay on branch `add-remote-control-spec` (do NOT branch). Run git/npm from repo root `/home/evan/projects/qwen-code`.

**Goal:** Owner-only on-demand full-text search over the workspace's JSONL session transcripts + `GET /rc/search`.

**Design:** `docs/superpowers/specs/2026-06-08-rc-gateway-cross-session-search-design.md` — full contract, record shape, AND-match semantics, snippet, path encoding. Implement as written.

**Conventions:** license headers; `.js` imports; commit per task ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: audit action

- [ ] `src/auditLog.ts`: add `'search_performed'` to the union + `AUDIT_ACTIONS`. typecheck. Commit: `feat(rc-gateway): search_performed audit action`.

### Task 2: transcript search (TDD)

**Files:** `src/search/transcripts.ts` (+ `transcripts.test.ts`); export from `src/index.ts`.

- [ ] Failing tests per design's `transcripts.test.ts` bullets (write JSONL fixture files to a `mkdtempSync` dir; cover AND-match, kind filter incl. tool→tool_result, sessionId filter, corrupt-line skip, missing-dir→[], limit clamp, recency sort, snippet ≤200 single-line, `resolveChatsDir` encoding incl. the `.`→`-` case).
- [ ] Implement `resolveChatsDir(cwd)` = `join(homedir(),'.qwen','projects', cwd.replace(/[/.]/g,'-'), 'chats')`; `searchTranscripts(chatsDir, query, opts)`:
  - `const terms = query.toLowerCase().split(/\s+/).filter(Boolean); if (!terms.length) return [];`
  - `readdir(chatsDir)` (catch ENOENT → return []); filter `.endsWith('.jsonl')`.
  - For each file, `readFile` (catch → skip), split `\n`, for each non-empty line: `JSON.parse` (catch → skip); a record `rec`; if `opts.sessionId && rec.sessionId !== opts.sessionId` skip; if `opts.kind && opts.kind!=='all' && rec.type !== kindMap[opts.kind]` skip (kindMap: user→'user', assistant→'assistant', tool→'tool_result'); derive `text = (rec.message?.parts ?? []).map(p=>p?.text).filter(s=>typeof s==='string').join(' ')`; `const hay = text.toLowerCase(); if (!terms.every(t=>hay.includes(t))) skip`; push hit `{sessionId, eventId: rec.uuid, kind: rec.type, ts: rec.timestamp, snippet: snippet(text, terms[0])}`.
  - Sort by `ts` desc (string compare on ISO is fine, or Date.parse). Clamp `Math.min(Math.max(1, limit??50), 200)`.
  - `snippet(text, term)`: collapse whitespace `text.replace(/\s+/g,' ').trim()`; find `idx = lower.indexOf(term)`; window start `Math.max(0, idx-70)`; slice ~160 chars; add leading/trailing `…` when truncated; hard-cap 200.
- [ ] Tests pass. Export `searchTranscripts`, `resolveChatsDir`, types. Commit: `feat(rc-gateway): on-demand transcript search`.

### Task 3: search route (TDD)

**Files:** `src/routes/search.ts` (+ `search.test.ts`); export `createSearchRoute` from `src/index.ts`.

- [ ] Failing test per design's `routes/search.test.ts` (mini app, injected OWNER rcClient, `resolveDir` → a fixture chats dir + a fake audit): q hit → 200 {hits} + audit search_performed{kind,resultCount} and assert the audit blob does NOT contain the query string; missing/empty q → 400 invalid_query; bad kind → 400 invalid_kind; resolveDir→undefined → 200 {hits:[]}.
- [ ] Implement `createSearchRoute(resolveDir, audit?)` per the design. Validate q (trim non-empty), kind ∈ {user,assistant,tool,all} default all, limit parse+clamp.
- [ ] Tests pass. Commit: `feat(rc-gateway): owner cross-session search route`.

### Task 4: wiring + e2e + full verification

**Files:** `src/server.ts`, `src/server.test.ts`, `scripts/rc-gateway-e2e.mjs`.

- [ ] `server.ts`: `app.get('/rc/search', requireScope(OWNER, audit), createSearchRoute(async () => { try { const caps = await deps.daemon.capabilities(); return caps.workspaceCwd ? resolveChatsDir(caps.workspaceCwd) : undefined } catch { return undefined } }, audit));` (import createSearchRoute, resolveChatsDir, OWNER).
- [ ] `server.test.ts`: owner token → `GET /rc/search?q=x` → 200 with a `hits` array (stub daemon's workspace has no transcripts → []); non-owner token → 403; missing q → 400.
- [ ] `scripts/rc-gateway-e2e.mjs`: owner token → `GET /rc/search?q=test` → 200 with a `hits` array. Bump summary.
- [ ] From repo root run ALL: `npm run typecheck && npm run lint && npm run build && npm run test` (each `--workspace @qwen-code/rc-gateway`) → green; then `node scripts/rc-gateway-e2e.mjs` → pass.
- [ ] Commit: `feat(rc-gateway): wire cross-session search route + e2e`.

## Self-review checklist

- Search is OWNER-gated; AND-of-terms case-insensitive; kind filter maps tool→tool_result; recency-sorted; limit clamped 1..200.
- Missing chats dir / no workspace / corrupt lines → graceful (empty/skip, never 500).
- Audit `search_performed` carries ONLY {kind, resultCount} — NEVER the query text (test asserts).
- No filesystem path is built from q/kind/sessionId; only resolveChatsDir(workspaceCwd) builds a path (single dir segment, trusted source).
- `search_performed` in union + AUDIT_ACTIONS; prior 245 tests green. Zero files outside packages/rc-gateway/ except the e2e script.
