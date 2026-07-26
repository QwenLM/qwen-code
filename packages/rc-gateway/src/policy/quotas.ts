/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The parsed `maxPerWindow` of a rule: at most `count` consumes within any rolling
 * `windowSec`-second window. (This cycle the field is still raw `unknown` in the
 * loader; the wiring cycle validates it into this shape.)
 */
export interface QuotaLimit {
  count: number;
  windowSec: number;
}

/**
 * The quota verdict for a rule at a given instant:
 * - `room`: under the cap → the rule may apply (and a consume should follow once
 *   the tool is actually invoked).
 * - `exhausted`: at/over the cap within the window → the rule does NOT match and
 *   evaluation falls through to lower rules (spec:121-132).
 * - `untracked`: the rule has no known limit (id-less or no quota) → the caller
 *   cannot rate-limit it (the evaluator downgrades such a rule to prompt).
 */
export type QuotaState = 'room' | 'exhausted' | 'untracked';

/** One persisted consume: rule `ruleId` was consumed at epoch-ms `ms`. */
export interface QuotaRecord {
  ruleId: string;
  ms: number;
}

/**
 * Durable storage for consume records. A dumb append log — all window/limit logic
 * lives in {@link QuotaStore}. Every method NEVER throws (errors degrade to a warn
 * + best-effort), so the store can stay total.
 */
export interface QuotaWal {
  /** Append one consume record. */
  append(rec: QuotaRecord): Promise<void>;
  /** All shape-valid records; malformed/torn lines skipped; `[]` when absent. */
  load(): Promise<QuotaRecord[]>;
  /** Atomically replace the log with exactly `recs` (compaction). */
  rewrite(recs: QuotaRecord[]): Promise<void>;
}

/** A non-persisting {@link QuotaWal} (tests, and the no-durability case). */
export class MemoryQuotaWal implements QuotaWal {
  private recs: QuotaRecord[] = [];

  async append(rec: QuotaRecord): Promise<void> {
    this.recs.push({ ...rec });
  }

  async load(): Promise<QuotaRecord[]> {
    return this.recs.map((r) => ({ ...r }));
  }

  async rewrite(recs: QuotaRecord[]): Promise<void> {
    this.recs = recs.map((r) => ({ ...r }));
  }
}

/**
 * A rolling-window per-rule rate counter persisted through a {@link QuotaWal}.
 *
 * TRUE sliding window (spec:121 "any rolling window"): each rule keeps the epoch-ms
 * of its recent consumes; `used` counts those still within `windowSec`. Tumbling
 * `(rule, windowStart)` buckets would let `2×count` calls straddle a boundary, so
 * they are NOT used.
 *
 * The clock is injected per call (`nowMs`) so a single evaluation is consistent and
 * tests are deterministic — there is no `Date.now()` inside. Pruning is lazy
 * (on access) plus an amortized WAL compaction to bound on-disk growth.
 *
 * INERT this cycle: nothing in the evaluator/enforcer imports it yet. The wiring
 * cycle threads `state` into the evaluator (room→match, exhausted→fall-through)
 * and calls `consume` from the enforcer AFTER a successful allow vote.
 */
export class QuotaStore {
  private readonly hits = new Map<string, number[]>();
  private walLines = 0;
  private floor: number;

  private constructor(
    private readonly wal: QuotaWal,
    private readonly limitsFor: (ruleId: string) => QuotaLimit | undefined,
    compactionFloor: number,
  ) {
    this.floor = compactionFloor;
  }

  /** Load+replay the WAL (lazy prune — no pruning here, done on first access). */
  static async create(
    wal: QuotaWal,
    limitsFor: (ruleId: string) => QuotaLimit | undefined,
    opts?: { compactionFloor?: number },
  ): Promise<QuotaStore> {
    const floor = Math.max(1, opts?.compactionFloor ?? 64);
    const store = new QuotaStore(wal, limitsFor, floor);
    const records = await wal.load();
    for (const { ruleId, ms } of records) {
      const arr = store.hits.get(ruleId);
      if (arr) arr.push(ms);
      else store.hits.set(ruleId, [ms]);
    }
    store.walLines = records.length;
    return store;
  }

  /** Prune `ruleId`'s instants to `(nowMs - windowSec*1000, nowMs]` in place. */
  private usedAfterPrune(
    ruleId: string,
    windowSec: number,
    nowMs: number,
  ): number {
    const arr = this.hits.get(ruleId);
    if (!arr) return 0;
    const cutoff = nowMs - windowSec * 1000;
    const live = arr.filter((t) => t > cutoff);
    if (live.length > 0) this.hits.set(ruleId, live);
    else this.hits.delete(ruleId);
    return live.length;
  }

  /** Quota verdict for `ruleId` at `nowMs`. `untracked` when no limit is known. */
  state(ruleId: string, nowMs: number): QuotaState {
    const limit = this.limitsFor(ruleId);
    if (!limit) return 'untracked';
    const used = this.usedAfterPrune(ruleId, limit.windowSec, nowMs);
    return used < limit.count ? 'room' : 'exhausted';
  }

  /** Remaining allowance for `ruleId`, or `undefined` when untracked. */
  remaining(ruleId: string, nowMs: number): number | undefined {
    const limit = this.limitsFor(ruleId);
    if (!limit) return undefined;
    const used = this.usedAfterPrune(ruleId, limit.windowSec, nowMs);
    return Math.max(0, limit.count - used);
  }

  /**
   * Record a consume of `ruleId` at `nowMs` (memory + WAL). Never throws.
   * Triggers an amortized compaction once the WAL exceeds `max(floor, 2×live)`.
   */
  async consume(ruleId: string, nowMs: number): Promise<void> {
    const arr = this.hits.get(ruleId);
    if (arr) arr.push(nowMs);
    else this.hits.set(ruleId, [nowMs]);
    // Persistence is best-effort: the in-memory counter has already advanced, so
    // even a contract-violating WAL that throws must not break the decision path.
    try {
      await this.wal.append({ ruleId, ms: nowMs });
      this.walLines += 1;
      if (this.walLines > this.floor) await this.compact(nowMs);
    } catch {
      /* swallow — counter stands in memory; the lost line just won't persist */
    }
  }

  /**
   * Atomically reserve one slot for `ruleId` at `nowMs` if room exists: pushes
   * `nowMs` into the in-memory window IMMEDIATELY (synchronously — no `await`
   * anywhere in this method) and returns true; returns false — no mutation —
   * when exhausted or untracked.
   *
   * This closes the classic check-then-act race across concurrent callers of
   * the SAME rule (e.g. two sessions' `webpush/pump.ts` event loops racing a
   * shared `ruleId`, since quota state is keyed by ruleId alone, not
   * session): `state()`/`remaining()` are read-only, so two concurrent
   * decisions can both observe `'room'` before either commits. `reserve()` is
   * the commit — callers must invoke it synchronously, right when a decision
   * is made (before any `await`, e.g. the permission vote), so a second
   * caller's own `state()`/`evaluate()` check — which can only run before
   * this call's synchronous prefix starts or after it ends, never
   * interleaved, by JS run-to-completion — is guaranteed to see the
   * reservation already committed.
   *
   * A caller that reserves MUST follow up with EXACTLY ONE of:
   * - {@link confirmReserved} — the reserved action succeeded; persist the
   *   slot durably (WAL).
   * - {@link releaseReserved} — the reserved action failed/threw; roll the
   *   reservation back so it does not count against future decisions.
   */
  reserve(ruleId: string, nowMs: number): boolean {
    const limit = this.limitsFor(ruleId);
    if (!limit) return false; // untracked — nothing to reserve
    const used = this.usedAfterPrune(ruleId, limit.windowSec, nowMs);
    if (used >= limit.count) return false;
    const arr = this.hits.get(ruleId);
    if (arr) arr.push(nowMs);
    else this.hits.set(ruleId, [nowMs]);
    return true;
  }

  /**
   * Durably persist a slot previously reserved via {@link reserve}. The
   * in-memory count was already committed by `reserve()` itself, so this is
   * WAL-append-only (never a second in-memory push). Never throws — mirrors
   * {@link consume}'s persistence contract.
   *
   * NOTE (benign, documented): if this triggers the amortized `compact()`
   * (walLines > floor) while ANOTHER rule/session has an in-flight
   * *unconfirmed* reservation, that reservation's instant is still in
   * `this.hits` and will be written to the WAL here. Should that other
   * reservation later be released (vote failed), the WAL keeps a phantom
   * record until the next compaction prunes it out by window age — a
   * bounded, fail-closed over-count (fewer future auto-allows), never an
   * under-count. Not fixed here: narrowing it needs compaction to snapshot
   * only confirmed instants, out of scope for this race fix.
   */
  async confirmReserved(ruleId: string, nowMs: number): Promise<void> {
    try {
      await this.wal.append({ ruleId, ms: nowMs });
      this.walLines += 1;
      if (this.walLines > this.floor) await this.compact(nowMs);
    } catch {
      /* swallow — counter stands in memory; the lost line just won't persist */
    }
  }

  /**
   * Roll back one slot previously reserved via {@link reserve} that was never
   * confirmed (e.g. a permission vote that failed or threw) — removes ONE
   * matching instant from memory (the most recently pushed, LIFO, in case of
   * duplicate `nowMs` values). Never persisted (confirmReserved wasn't
   * called), so there is nothing to undo in the WAL. Synchronous — never
   * throws.
   */
  releaseReserved(ruleId: string, nowMs: number): void {
    const arr = this.hits.get(ruleId);
    if (!arr) return;
    const idx = arr.lastIndexOf(nowMs);
    if (idx === -1) return;
    arr.splice(idx, 1);
    if (arr.length === 0) this.hits.delete(ruleId);
  }

  /**
   * Prune every rule to its window, DROP untracked rules (deleted/renamed), and
   * rewrite the WAL with only the survivors. Public for tests; also auto-invoked
   * by {@link consume}. Never throws.
   */
  async compact(nowMs: number): Promise<void> {
    const survivors: QuotaRecord[] = [];
    for (const ruleId of [...this.hits.keys()]) {
      const limit = this.limitsFor(ruleId);
      if (!limit) {
        this.hits.delete(ruleId);
        continue;
      }
      const used = this.usedAfterPrune(ruleId, limit.windowSec, nowMs);
      if (used === 0) continue;
      for (const ms of this.hits.get(ruleId) ?? []) {
        survivors.push({ ruleId, ms });
      }
    }
    try {
      await this.wal.rewrite(survivors);
    } catch {
      /* swallow — memory is already pruned; the on-disk WAL just stays larger */
    }
    this.walLines = survivors.length;
    this.floor = Math.max(this.floor, 2 * survivors.length);
  }
}

/**
 * A file-backed {@link QuotaWal} (append-only JSONL, one `{"r","t"}` per line).
 * Every method is total: persistence errors degrade to a warn + best-effort, never
 * a throw, so a misconfigured/unreadable WAL never blocks a policy decision.
 *
 * Fail-direction (design D4): `load` returns `[]` on a missing file (NORMAL, no
 * warn) and on a whole-file read error (FAILS OPEN — a reset counter resumes a
 * fresh window; `maxPerWindow`'s beyond-cap fallback is prompt, not deny, so this
 * is a bounded cap-reset, with a loud warn). Torn/garbage/wrong-shape individual
 * lines are skipped.
 */
export class FileQuotaWal implements QuotaWal {
  private dirEnsured = false;

  constructor(
    private readonly path: string,
    private readonly warn: (msg: string) => void = () => {},
  ) {}

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.dirEnsured = true;
  }

  async append(rec: QuotaRecord): Promise<void> {
    try {
      await this.ensureDir();
      await appendFile(
        this.path,
        JSON.stringify({ r: rec.ruleId, t: rec.ms }) + '\n',
        { mode: 0o600 },
      );
    } catch (err) {
      this.warn(`[quotas] append failed: ${(err as Error).message}`);
    }
  }

  async load(): Promise<QuotaRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      this.warn(
        `[quotas] WAL unreadable, resetting counters: ${(err as Error).message}`,
      );
      return [];
    }
    const out: QuotaRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // torn/garbage line (incl. a kill -9 partial trailing line)
      }
      if (typeof o !== 'object' || o === null) continue;
      const r = (o as Record<string, unknown>)['r'];
      const t = (o as Record<string, unknown>)['t'];
      if (
        typeof r === 'string' &&
        typeof t === 'number' &&
        Number.isFinite(t)
      ) {
        out.push({ ruleId: r, ms: t });
      }
    }
    return out;
  }

  async rewrite(recs: QuotaRecord[]): Promise<void> {
    try {
      await this.ensureDir();
      const text = recs
        .map((r) => JSON.stringify({ r: r.ruleId, t: r.ms }))
        .join('\n');
      const tmp = this.path + '.tmp';
      await writeFile(tmp, recs.length > 0 ? text + '\n' : '', { mode: 0o600 });
      await rename(tmp, this.path);
    } catch (err) {
      this.warn(`[quotas] compaction failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Build the per-rule quota limits map from a policy: `rule.id → maxPerWindow`
 * for every rule that has BOTH (id-less rules can't be tracked; rules without
 * `maxPerWindow` aren't rate-limited). First id wins on a duplicate (the loader
 * already rejects duplicate ids, so this is just defensive). PURE.
 *
 * Used by BOTH the boot path and the hot-reload path so they construct limits
 * identically (no drift). On reload the caller rebuilds the SAME map IN PLACE
 * (`clear()` + copy) so the `limitsFor` closure a {@link QuotaStore} captured at
 * boot reflects the new policy without reconstructing the store.
 */
export function quotaLimitsFromPolicy(
  policy: import('./loader.js').Policy,
): Map<string, QuotaLimit> {
  const limits = new Map<string, QuotaLimit>();
  for (const r of policy.rules) {
    if (
      r.id !== undefined &&
      r.maxPerWindow !== undefined &&
      !limits.has(r.id)
    ) {
      limits.set(r.id, r.maxPerWindow);
    }
  }
  return limits;
}
