# Design — rc-gateway search/chatsPath resolver unification (cycle 23)

**Proposal:** debt-paydown follow-up to `add-cross-session-search` (cycle 19),
recorded in [[qwen-rc-gateway-architecture]] as a latent bug.
**Date:** 2026-06-09.
**Branch:** `add-remote-control-spec`.

## The bug

Cycle 19's `src/search/transcripts.ts` derives the on-disk chats dir with an
**approximation**:

```ts
join(homedir(), '.qwen', 'projects', cwd.replace(/[/.]/g, '-'), 'chats');
```

This diverges from how the daemon (core `Storage#getProjectDir`) actually
encodes the project segment, in two ways:

1. **Char class.** Core's `sanitizeCwd` is `replace(/[^a-zA-Z0-9]/g, '-')` —
   it dashes EVERY non-alphanumeric char. The search approximation only dashes
   `/` and `.`, so a cwd containing `_`, a space, `+`, etc. produces a
   **different** directory name than the one the daemon writes to. Example:
   `/home/u/my_proj` → daemon writes `-home-u-my-proj/`, search looks in
   `-home-u-my_proj/` → `readdir` ENOENT → search **silently returns `[]`**
   (no error, just zero results) for any workspace whose path has such a char.
2. **Runtime base.** The approximation hardcodes `~/.qwen`, ignoring the
   `QWEN_RUNTIME_DIR` / `QWEN_HOME` precedence — so a daemon launched with a
   custom runtime dir is invisible to search.

Cycle 21 already built the **exact** resolver in `src/sessions/chatsPath.ts`
(`resolveChatsDir(cwd, env?)` = `runtimeBaseDir(env)/projects/sanitizeCwd(cwd)/chats`),
and proved it byte-correct against the REAL daemon (the fork e2e writes a
transcript to that path and the daemon restores it — restore-by-path is the
same dir the daemon writes into). It is the single source of truth.

## Deviation note

No deviation from any OpenSpec design here — this is purely internal: collapse
two resolvers into the one that's empirically proven against the real daemon.
The daemon stays unmodified; all edits are inside `packages/rc-gateway/`.

## Decisions

### D1 — Delete the approximate resolver; search uses the exact one

Remove `resolveChatsDir` from `src/search/transcripts.ts` entirely (and its now
-unused `homedir` import). `searchTranscripts(chatsDir, …)` keeps taking a
pre-resolved dir — it never resolved a path itself; only its caller did. The
sole production caller (`server.ts` `/rc/search`) imports `resolveChatsDir`
from `./sessions/chatsPath.js` instead. Behavior for the common case (cwd of
only `/`, `.`, alphanumerics) is **identical**; it changes only for the
`_`/space/etc. cwds that were silently broken — strictly an improvement.

### D2 — Barrel: single canonical name, keep the e2e alias

`index.ts` currently re-exports the approximate resolver as `resolveChatsDir`
(from `search/transcripts.js`) and the exact one aliased as
`resolveForkChatsDir` (from `sessions/chatsPath.js`). After this cycle: drop the
`search/transcripts.js` `resolveChatsDir` re-export; export the **exact**
`resolveChatsDir` from `sessions/chatsPath.js` under BOTH its own name AND the
`resolveForkChatsDir` alias. Keeping the alias leaves `scripts/rc-gateway-e2e.mjs`
(the only consumer of `resolveForkChatsDir`, confirmed by repo-wide grep)
untouched — the e2e is our drift detector; don't perturb it in a refactor.

### D3 — The divergence regression test is the whole proof

The common-path cases (`/`,`.`-only) are identical between the two resolvers,
so every existing test passes against EITHER. The cycle's justification only
shows up for a `_`/space cwd. `chatsPath.test.ts` already has a `sanitizeCwd`
char-class test; add a `resolveChatsDir`-level case that contrasts explicitly
with what the old approximation produced, so the fix is demonstrated end-to-end
at the resolver the search route actually calls.

## Files

- `src/search/transcripts.ts` — delete `resolveChatsDir` + `homedir` import.
- `src/server.ts` — import `resolveChatsDir` from `./sessions/chatsPath.js`
  (still `searchTranscripts`? no — server imports only the resolver from
  transcripts today; repoint that one import).
- `src/index.ts` — barrel: drop the transcripts `resolveChatsDir`, export the
  exact one + keep the `resolveForkChatsDir` alias.
- `src/search/transcripts.test.ts` — remove the (now-deleted) `resolveChatsDir`
  describe block + its import.
- `src/sessions/chatsPath.test.ts` — add the `resolveChatsDir` divergence case.

## Verification

- New/kept tests: `chatsPath.test.ts` divergence case
  (`resolveChatsDir('/home/u/my_proj', {})` → `…/projects/-home-u-my-proj/chats`,
  with a comment that the old resolver gave `-home-u-my_proj`).
  `transcripts.test.ts` no longer references `resolveChatsDir`.
- `npm run typecheck|lint|build|test --workspace @qwen-code/rc-gateway`.
- `node scripts/rc-gateway-e2e.mjs` — must still pass 39/39 unchanged (the e2e
  uses no custom runtime-dir env and a normal repo path, so its derivation is
  identical under both resolvers; this confirms no regression).
- `git diff --name-only <start>..HEAD` shows only `packages/rc-gateway/` + docs.

## Deferred

- SQLite FTS5/BM25, boolean/phrase syntax, web Cmd-K — the remaining
  `add-cross-session-search` partials, unchanged by this cycle.
