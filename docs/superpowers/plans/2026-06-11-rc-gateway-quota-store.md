# Plan — policy quota store + WAL (cycle 42, INERT)

See design: `../specs/2026-06-11-rc-gateway-quota-store-design.md`.

TDD, fail-safe order. Repo root, absolute paths. Every `git add` uses explicit
`packages/rc-gateway/` + `docs/` paths (foreign upstream edits present — never
commit them). All INERT this cycle: nothing in evaluator/enforcer/cli/routes
imports the new module → zero behavior change.

## Commit 1 — docs

## Commit 2 — QuotaStore (window math) + QuotaWal interface + MemoryQuotaWal + tests

`src/policy/quotas.ts`:

```ts
export interface QuotaLimit { count: number; windowSec: number }
export type QuotaState = 'room' | 'exhausted' | 'untracked';
export interface QuotaRecord { ruleId: string; ms: number }
export interface QuotaWal {           // dumb storage; never throws
  append(rec: QuotaRecord): Promise<void>;
  load(): Promise<QuotaRecord[]>;     // shape-validated, malformed lines skipped
  rewrite(recs: QuotaRecord[]): Promise<void>;  // atomic compaction
}
export class MemoryQuotaWal implements QuotaWal { … }   // for tests + the no-persist case
export class QuotaStore {
  static async create(
    wal: QuotaWal,
    limitsFor: (ruleId: string) => QuotaLimit | undefined,
    opts?: { compactionFloor?: number },               // default 64
  ): Promise<QuotaStore>;
  state(ruleId: string, nowMs: number): QuotaState;     // untracked | room | exhausted
  remaining(ruleId: string, nowMs: number): number | undefined;  // undefined = untracked
  consume(ruleId: string, nowMs: number): Promise<void>;// memory + wal.append; auto-compact
  compact(nowMs: number): Promise<void>;                // prune-all + wal.rewrite (public for tests)
}
```

- Memory: `Map<ruleId, number[]>`. Prune = `arr.filter(t => t > nowMs - windowSec*1000)`
  (no sort needed — `used` is a count, not order-sensitive). `state`: `limitsFor`
  undefined → `untracked`; else prune, `used < count ? 'room' : 'exhausted'`.
- `create`: replay `wal.load()` into memory (no prune — no `now` at construct;
  lazy prune on access). No throw.
- `consume`: push `nowMs`; `await wal.append`; `walLines++`; when
  `walLines > floor` → `compact(nowMs)`; floor starts at `compactionFloor`, reset
  to `max(compactionFloor, 2*live)` after each compaction.
- `compact`: prune every rule via `limitsFor`+`nowMs`, DROP untracked rules, flatten
  to `QuotaRecord[]`, `await wal.rewrite`, reset `walLines`/`floor`. No throw.

Tests `src/policy/quotas.test.ts` (MemoryQuotaWal): under cap→room; at cap→exhausted;
aged-out instant frees a slot (advance nowMs); unknown ruleId→untracked; `count:0`→
exhausted; restart survival (new store over the SAME MemoryQuotaWal resumes the
count — spec scenario); compaction KEEPS live records AND drops unknown-ruleId.

## Commit 3 — FileQuotaWal (durability) + tests + barrel

`src/policy/quotas.ts` add `FileQuotaWal implements QuotaWal`:

- `append`: lazy `mkdir -p` once, `appendFile(path, JSON.stringify({r,t})+'\n', {mode:0o600})`;
  catch → warn + swallow (never throw).
- `load`: `readFile`; `ENOENT` → `[]` (NO warn); other whole-file error → warn + `[]`;
  else split lines, `JSON.parse` each in try, KEEP only `typeof o.r==='string' &&
Number.isFinite(o.t)` → `{ruleId:o.r, ms:o.t}`; skip the rest.
- `rewrite`: `mkdir -p`, write temp `path+'.tmp'`, `rename` to path (atomic); catch→warn+swallow.

Tests (real temp dirs): ENOENT→[]+no-throw; a WAL with a valid line + truncated
trailing line + garbage line + wrong-shape `{"r":5}`/`{"t":1}` → only valid replayed;
round-trip restart survival through a real file; auto-compaction shrinks the file
yet a reloaded store resumes correctly; whole-file unreadable (point at a dir) →
[]+no-throw.

`index.ts` barrel: `QuotaStore`, `FileQuotaWal`, `MemoryQuotaWal`, types
`QuotaLimit`/`QuotaState`/`QuotaRecord`/`QuotaWal`.

## Verify (repo root)

typecheck/lint/build/test `@qwen-code/rc-gateway` + `node scripts/rc-gateway-e2e.mjs`
(e2e unaffected — module is inert). Then opus review on `git diff fc308de03..HEAD
-- packages/rc-gateway/` (tell it to ignore foreign out-of-boundary changes; this
is INERT infra, behavior flip is next cycle) → fix → push → update both memory
files. Memory: record that wiring (loader validate + evaluator oracle + enforcer
consume-after-vote) is the IMMEDIATE next cycle, and the TOCTOU-serialization
check it must do.
