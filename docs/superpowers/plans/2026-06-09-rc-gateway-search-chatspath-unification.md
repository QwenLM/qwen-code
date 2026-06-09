# Plan — rc-gateway search/chatsPath resolver unification (cycle 23)

Design: `docs/superpowers/specs/2026-06-09-rc-gateway-search-chatspath-unification-design.md`.

**Branch:** `add-remote-control-spec` — stay on it. Run all git/npm from repo
root `/home/evan/projects/qwen-code` with absolute paths. No `--no-verify`.
NodeNext ESM `.js` extensions. Commits end with
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

Mechanical refactor (delete one function, repoint three imports + a barrel +
two test files). Done directly (no implementer subagent — the load-bearing
gates are the divergence test, the opus review, and the e2e, not TDD ceremony).

## Step 1 — add the divergence regression test (red against old behavior)

`src/sessions/chatsPath.test.ts`, inside the existing `describe('resolveChatsDir')`:
add a case proving the char-class fix at the resolver level —
`resolveChatsDir('/home/u/my_proj', {})` → `join(homedir(),'.qwen','projects','-home-u-my-proj','chats')`,
with a comment: old `search` resolver gave `-home-u-my_proj` (underscore kept) →
wrong dir → silent `[]`. This is the proof the cycle exists for.

## Step 2 — delete the approximate resolver

`src/search/transcripts.ts`: remove the `resolveChatsDir` export (lines ~70–84)
and the now-unused `homedir` import. Keep `join`/`readFile`/`readdir` (still used
by `searchTranscripts`). `searchTranscripts` is unchanged.

## Step 3 — repoint the production caller

`src/server.ts:35`: change
`import { resolveChatsDir } from './search/transcripts.js';` →
`import { resolveChatsDir } from './sessions/chatsPath.js';`
The call site (`resolveChatsDir(caps.workspaceCwd)`, line ~199) is unchanged —
the exact resolver's `env` param defaults to `process.env`.

## Step 4 — barrel

`src/index.ts`: in the `./search/transcripts.js` export block drop
`resolveChatsDir` (keep `searchTranscripts`, `SearchHit`, `SearchOptions`). In
the `./sessions/chatsPath.js` block export `resolveChatsDir` under its own name
AND keep `resolveChatsDir as resolveForkChatsDir`. Update the stale comment
(no more "legacy approximate resolver re-exported above").

## Step 5 — drop the dead test

`src/search/transcripts.test.ts`: remove the `describe('resolveChatsDir', …)`
block and `resolveChatsDir` from the import (keep `searchTranscripts`).

## Step 6 — verification sweep (repo root)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

Confirm `git diff --name-only 507411bdd..HEAD` lists only
`packages/rc-gateway/src/{search/transcripts.ts,search/transcripts.test.ts,server.ts,index.ts,sessions/chatsPath.test.ts}`

- the two docs.

## Commits

- docs: `docs(rc-gateway): cycle 23 spec+plan — unify search chats-path resolver`
- impl: `fix(rc-gateway): search uses the exact chats-path resolver (drop cycle-19 approximation)`

(One impl commit is fine for a mechanical refactor; the divergence test lands in
the same commit. Then opus review → fix → push → memory.)
