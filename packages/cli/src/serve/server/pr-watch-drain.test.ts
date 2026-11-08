/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import type { SessionPrBindingSummary } from '../routes/session-pr-bindings.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import {
  buildDrainPrompt,
  createPrWatchDrainState,
  mergeBindingRows,
  resolvePrRecipients,
  runPrWatchDrainTick,
  PR_WATCH_MAX_CONCURRENT_RESTORES,
  PR_WATCH_MAX_PARTIAL_RETAINED,
  type PrWatchDrainDeps,
  type PrWatchDrainState,
  type PrWatchRecipient,
} from './pr-watch-drain.js';
import {
  readPrWatchStateSync,
  writePrWatchStateSync,
  type PrWatchIdentity,
  type PrWatchState,
} from './pr-watch-store.js';

const identity: PrWatchIdentity = {
  host: 'github.com',
  repo: 'owner/repo',
  number: 42,
};
const T0 = '2026-11-08T00:00:00.000Z';

function prUrl(number = 42, repo = 'owner/repo'): string {
  return `https://github.com/${repo}/pull/${number}`;
}

function summary(
  sessionId: string,
  opts: {
    updatedAt?: string;
    sourceType?: string;
    number?: number;
    repo?: string;
    role?: 'review' | 'verify' | 'fix';
    workspaceCwd?: string;
  } = {},
): SessionPrBindingSummary {
  return {
    sessionId,
    workspaceCwd: opts.workspaceCwd ?? '/ws',
    ...(opts.sourceType !== undefined ? { sourceType: opts.sourceType } : {}),
    ...(opts.updatedAt !== undefined ? { updatedAt: opts.updatedAt } : {}),
    prs: [
      {
        number: opts.number ?? 42,
        url: prUrl(opts.number ?? 42, opts.repo ?? 'owner/repo'),
        ...(opts.role !== undefined ? { role: opts.role } : {}),
      },
    ],
  };
}

function pendingState(overrides: Partial<PrWatchState> = {}): PrWatchState {
  return {
    pr: identity,
    observedAt: T0,
    state: 'open',
    headSha: 'a'.repeat(40),
    checks: 'passing',
    pending: [
      {
        type: 'ci_failure',
        key: 'pr-state:owner/repo#42:ci_failure:aaa',
        summary: 'CI failing',
        detectedAt: T0,
      },
    ],
    ...overrides,
  };
}

describe('mergeBindingRows', () => {
  it('excludes channel-owned sessions', () => {
    const state = createPrWatchDrainState();
    const rows = mergeBindingRows(
      [summary('s1'), summary('chan', { sourceType: 'channel' })],
      false,
      state,
      () => {},
    );
    expect([...rows.keys()]).toEqual(['s1']);
  });

  it('retains unlisted rows on a partial scan and drops them on a complete scan', () => {
    const state = createPrWatchDrainState();
    mergeBindingRows(
      [summary('old', { updatedAt: T0 })],
      false,
      state,
      () => {},
    );
    // Partial scan lists only 'new': 'old' is retained.
    const partial = mergeBindingRows([summary('new')], true, state, () => {});
    expect([...partial.keys()].sort()).toEqual(['new', 'old']);
    // Complete scan lists only 'new': 'old' is dropped.
    const complete = mergeBindingRows([summary('new')], false, state, () => {});
    expect([...complete.keys()]).toEqual(['new']);
  });

  it('bounds partial retention, dropping the oldest', () => {
    const state = createPrWatchDrainState();
    const many = Array.from(
      { length: PR_WATCH_MAX_PARTIAL_RETAINED + 5 },
      (_, i) =>
        summary(`s${i}`, {
          updatedAt: new Date(Date.parse(T0) + i * 1000).toISOString(),
        }),
    );
    const rows = mergeBindingRows(many, true, state, () => {});
    expect(rows.size).toBe(PR_WATCH_MAX_PARTIAL_RETAINED);
    // The oldest (s0) is dropped; the newest survives.
    expect(rows.has('s0')).toBe(false);
    expect(rows.has(`s${PR_WATCH_MAX_PARTIAL_RETAINED + 4}`)).toBe(true);
  });
});

describe('resolvePrRecipients', () => {
  it('picks the most recently active binder without actions', () => {
    const rows = new Map([
      ['older', summary('older', { updatedAt: T0 })],
      ['newer', summary('newer', { updatedAt: '2026-11-08T01:00:00.000Z' })],
    ]);
    const { recipients } = resolvePrRecipients(
      rows,
      identity,
      undefined,
      'ci_failure',
    );
    // Candidates are recency-ordered; the winner is first, the rest allow
    // re-resolution when the leader is excluded.
    expect(recipients.map((r) => r.sessionId)).toEqual(['newer', 'older']);
  });

  it('matches the full identity, not just the number', () => {
    const rows = new Map([
      ['other-repo', summary('other-repo', { repo: 'someone/else' })],
    ]);
    const { recipients } = resolvePrRecipients(
      rows,
      identity,
      undefined,
      'ci_failure',
    );
    expect(recipients).toEqual([]);
  });

  it('resolves one winner per matched role group with actions', () => {
    const rows = new Map([
      ['rev', summary('rev', { role: 'review', updatedAt: T0 })],
      ['fix', summary('fix', { role: 'fix', updatedAt: T0 })],
    ]);
    const actions = new Map([
      ['review:ci_failure', 'review it'],
      ['fix:ci_failure', 'fix it'],
    ]);
    const { recipients, matchedGroups } = resolvePrRecipients(
      rows,
      identity,
      actions,
      'ci_failure',
    );
    expect(matchedGroups.sort()).toEqual(['fix', 'review']);
    expect(recipients.map((r) => r.sessionId).sort()).toEqual(['fix', 'rev']);
  });

  it('skips a role group whose chain does not resolve', () => {
    const rows = new Map([['ver', summary('ver', { role: 'verify' })]]);
    const actions = new Map([['review:ci_failure', 'review it']]);
    const { matchedGroups, recipients } = resolvePrRecipients(
      rows,
      identity,
      actions,
      'ci_failure',
    );
    expect(matchedGroups).toEqual(['review']);
    expect(recipients).toEqual([]);
  });
});

describe('buildDrainPrompt', () => {
  it('builds a generic prompt without actions and a rendered instruction with them', () => {
    const state = pendingState({ title: 'My PR' });
    const entry = state.pending![0];
    const recipient: PrWatchRecipient = {
      sessionId: 's1',
      workspaceCwd: '/ws',
      url: prUrl(),
      role: 'fix',
    };
    const generic = buildDrainPrompt(state, entry, recipient, undefined);
    expect(generic).toContain('CI failing');
    expect(generic).toContain('owner/repo');
    const actions = new Map([['fix:ci_failure', 'Please fix %repo% #%pr%']]);
    const roleAware = buildDrainPrompt(state, entry, recipient, actions);
    expect(roleAware).toContain('Please fix owner/repo #42');
  });
});

describe('runPrWatchDrainTick', () => {
  let dir: string;
  let locks: PathMutexRegistry;
  let state: PrWatchDrainState;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pr-watch-drain-'));
    locks = new PathMutexRegistry();
    state = createPrWatchDrainState();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function runtime(): WorkspaceRuntime {
    return {
      workspaceCwd: '/ws',
      trusted: true,
      primary: false,
    } as unknown as WorkspaceRuntime;
  }

  function makeDeps(
    overrides: Partial<PrWatchDrainDeps> = {},
  ): PrWatchDrainDeps {
    return {
      watchDir: dir,
      locks,
      scanBindings: async () => ({ bindings: [summary('s1')], partial: false }),
      resolveRuntime: () => runtime(),
      isSessionLive: () => true,
      wakeSession: async () => ({ kind: 'unavailable' }),
      admitPrompt: vi.fn(async () => ({ deduplicated: false })),
      readPushedHeads: async () => undefined,
      now: () => Date.parse(T0) + 60_000,
      log: () => {},
      ...overrides,
    };
  }

  it('delivers a pending transition once, records it and removes it from pending', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const deps = makeDeps();
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.claimed).toBe(true);
    expect(result.delivered).toBe(1);
    expect(deps.admitPrompt).toHaveBeenCalledTimes(1);
    const stored = readPrWatchStateSync(dir, identity);
    expect(stored.kind).toBe('state');
    if (stored.kind === 'state') {
      expect(stored.state.pending).toBeUndefined();
      expect(stored.state.delivered).toContain(
        'pr-state:owner/repo#42:ci_failure:aaa',
      );
    }
    // A second drain does not re-deliver.
    const again = await runPrWatchDrainTick([runtime()], deps, state);
    expect(again.delivered).toBe(0);
    expect(deps.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('does not re-admit a key already in delivered even if its entry is still pending', async () => {
    // Crash window (master §5): the key reached `delivered` but the entry was
    // not yet removed from `pending`. The drain must not admit it again.
    const key = 'pr-state:owner/repo#42:ci_failure:aaa';
    writePrWatchStateSync(dir, identity, pendingState({ delivered: [key] }));
    const deps = makeDeps();
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.delivered).toBe(0);
    expect(deps.admitPrompt).not.toHaveBeenCalled();
    const stored = readPrWatchStateSync(dir, identity);
    if (stored.kind === 'state') expect(stored.state.pending).toBeUndefined();
  });

  it('drains nothing when a foreign record blocks the ownership claim', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const { prWatchOwnerPath } = await import('./pr-watch-store.js');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      prWatchOwnerPath(dir),
      JSON.stringify({
        pid: process.pid,
        procStart: 'foreign-boot:0',
        startedAt: new Date().toISOString(),
      }),
    );
    const deps = makeDeps();
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.claimed).toBe(false);
    expect(deps.admitPrompt).not.toHaveBeenCalled();
  });

  it('suppresses a self-pushed head_change and re-resolves to the next binder', async () => {
    writePrWatchStateSync(
      dir,
      identity,
      pendingState({
        pending: [
          {
            type: 'head_change',
            key: 'pr-state:owner/repo#42:head_change:x',
            summary: 'head changed',
            detectedAt: T0,
          },
        ],
      }),
    );
    const admit = vi.fn(
      async (
        _runtime: WorkspaceRuntime,
        _sessionId: string,
        _promptText: string,
        _idempotencyKey: string,
      ) => ({ deduplicated: false }),
    );
    const deps = makeDeps({
      scanBindings: async () => ({
        bindings: [
          summary('pusher', { updatedAt: '2026-11-08T02:00:00.000Z' }),
          summary('other', { updatedAt: T0 }),
        ],
        partial: false,
      }),
      admitPrompt: admit,
      readPushedHeads: async (r) =>
        r.sessionId === 'pusher' ? new Set(['a'.repeat(40)]) : undefined,
    });
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.delivered).toBe(1);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0][1]).toBe('other');
  });

  it('never suppresses ci_failure by authorship', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const admit = vi.fn(
      async (
        _runtime: WorkspaceRuntime,
        _sessionId: string,
        _promptText: string,
        _idempotencyKey: string,
      ) => ({ deduplicated: false }),
    );
    const deps = makeDeps({
      admitPrompt: admit,
      readPushedHeads: async () => new Set(['a'.repeat(40)]),
    });
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.delivered).toBe(1);
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it('deletes the watch file when a complete scan finds no binder', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const deps = makeDeps({
      scanBindings: async () => ({ bindings: [], partial: false }),
    });
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.deleted).toBe(1);
    expect(readPrWatchStateSync(dir, identity).kind).toBe('absent');
    expect(deps.admitPrompt).not.toHaveBeenCalled();
  });

  it('keeps the file on a partial scan with no binder but deletes after the age horizon', async () => {
    writePrWatchStateSync(dir, identity, pendingState({ lastBoundAt: T0 }));
    const deps = makeDeps({
      scanBindings: async () => ({ bindings: [], partial: true }),
      now: () => Date.parse(T0) + 60_000,
    });
    const kept = await runPrWatchDrainTick([runtime()], deps, state);
    expect(kept.deleted).toBe(0);
    expect(readPrWatchStateSync(dir, identity).kind).toBe('state');
    const aged = makeDeps({
      scanBindings: async () => ({ bindings: [], partial: true }),
      now: () => Date.parse(T0) + 8 * 24 * 60 * 60 * 1000,
    });
    const dropped = await runPrWatchDrainTick([runtime()], aged, state);
    expect(dropped.deleted).toBe(1);
  });

  it('drops a pending entry older than the age limit', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const deps = makeDeps({
      now: () => Date.parse(T0) + 8 * 24 * 60 * 60 * 1000,
    });
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.dropped).toBe(1);
    expect(deps.admitPrompt).not.toHaveBeenCalled();
    const stored = readPrWatchStateSync(dir, identity);
    if (stored.kind === 'state') expect(stored.state.pending).toBeUndefined();
  });

  it('leaves the entry pending when wakeDormant is off and the session is dormant', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const deps = makeDeps({ isSessionLive: () => false, wakeDormant: false });
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.delivered).toBe(0);
    expect(deps.admitPrompt).not.toHaveBeenCalled();
    const stored = readPrWatchStateSync(dir, identity);
    if (stored.kind === 'state') expect(stored.state.pending).toHaveLength(1);
  });

  it('restores a dormant recipient off-tick, delivers and releases the registration', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const admit = vi.fn(
      async (
        _runtime: WorkspaceRuntime,
        _sessionId: string,
        _promptText: string,
        _idempotencyKey: string,
      ) => ({ deduplicated: false }),
    );
    const release = vi.fn(async () => {});
    const deps = makeDeps({
      isSessionLive: () => false,
      wakeSession: async () => ({ kind: 'restored', release }),
      admitPrompt: admit,
    });
    await runPrWatchDrainTick([runtime()], deps, state);
    await vi.waitFor(() => {
      expect(admit).toHaveBeenCalledTimes(1);
    });
    // restoring clears only after the whole restore (including the release)
    // settles, so it is the correct synchronization point.
    await vi.waitFor(() => {
      expect(state.restoring.size).toBe(0);
    });
    expect(release).toHaveBeenCalled();
    const stored = readPrWatchStateSync(dir, identity);
    expect(stored.kind === 'state' && stored.state.pending).toBeUndefined();
  });

  it('leaves the entry pending when a restore is temporarily unavailable', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const admit = vi.fn(
      async (
        _runtime: WorkspaceRuntime,
        _sessionId: string,
        _promptText: string,
        _idempotencyKey: string,
      ) => ({ deduplicated: false }),
    );
    const deps = makeDeps({
      isSessionLive: () => false,
      wakeSession: async () => ({ kind: 'unavailable' }),
      admitPrompt: admit,
    });
    await runPrWatchDrainTick([runtime()], deps, state);
    await vi.waitFor(() => {
      expect(state.restoring.size).toBe(0);
    });
    expect(admit).not.toHaveBeenCalled();
    const stored = readPrWatchStateSync(dir, identity);
    if (stored.kind === 'state') expect(stored.state.pending).toHaveLength(1);
  });

  it('excludes a Gone recipient and re-resolves to the next binder on the next drain', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const admit = vi.fn(
      async (
        _runtime: WorkspaceRuntime,
        _sessionId: string,
        _promptText: string,
        _idempotencyKey: string,
      ) => ({ deduplicated: false }),
    );
    const release = vi.fn(async () => {});
    const deps = makeDeps({
      scanBindings: async () => ({
        bindings: [
          summary('gone-session', { updatedAt: '2026-11-08T02:00:00.000Z' }),
          summary('other', { updatedAt: T0 }),
        ],
        partial: false,
      }),
      isSessionLive: () => false,
      wakeSession: async (sessionId) =>
        sessionId === 'gone-session'
          ? { kind: 'gone' }
          : { kind: 'restored', release },
      admitPrompt: admit,
    });
    // Drain 1: the most-recent binder is Gone; it is excluded, entry pending.
    await runPrWatchDrainTick([runtime()], deps, state);
    await vi.waitFor(() => {
      expect(state.gone.has('gone-session')).toBe(true);
    });
    expect(admit).not.toHaveBeenCalled();
    // Drain 2: the Gone binder is skipped, the next binder is delivered to.
    await runPrWatchDrainTick([runtime()], deps, state);
    await vi.waitFor(() => {
      expect(admit).toHaveBeenCalledTimes(1);
    });
    expect(admit.mock.calls[0][1]).toBe('other');
  });

  it('delivers to each matched role group under a group-suffixed key', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const admit = vi.fn(
      async (
        _runtime: WorkspaceRuntime,
        _sessionId: string,
        _promptText: string,
        _idempotencyKey: string,
      ) => ({ deduplicated: false }),
    );
    const deps = makeDeps({
      scanBindings: async () => ({
        bindings: [
          summary('rev', { role: 'review' }),
          summary('fix', { role: 'fix' }),
        ],
        partial: false,
      }),
      actions: new Map([
        ['review:ci_failure', 'review it'],
        ['fix:ci_failure', 'fix it'],
      ]),
      admitPrompt: admit,
    });
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.delivered).toBe(2);
    expect(admit).toHaveBeenCalledTimes(2);
    const keys = admit.mock.calls.map((c) => c[3]).sort();
    expect(keys).toEqual([
      'pr-state:owner/repo#42:ci_failure:aaa:fix',
      'pr-state:owner/repo#42:ci_failure:aaa:review',
    ]);
    const stored = readPrWatchStateSync(dir, identity);
    if (stored.kind === 'state') {
      expect(stored.state.pending).toBeUndefined();
      expect(stored.state.delivered).toHaveLength(2);
    }
  });

  it('drains pending entries oldest-first', async () => {
    const first = {
      type: 'head_change' as const,
      key: 'k-first',
      summary: 'first',
      detectedAt: T0,
    };
    const second = {
      type: 'ci_failure' as const,
      key: 'k-second',
      summary: 'second',
      detectedAt: T0,
    };
    writePrWatchStateSync(
      dir,
      identity,
      pendingState({ pending: [first, second] }),
    );
    const admit = vi.fn(
      async (
        _runtime: WorkspaceRuntime,
        _sessionId: string,
        _promptText: string,
        _idempotencyKey: string,
      ) => ({ deduplicated: false }),
    );
    const deps = makeDeps({ admitPrompt: admit });
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.delivered).toBe(2);
    expect(admit).toHaveBeenCalledTimes(2);
    expect(admit.mock.calls[0][3]).toBe('k-first');
    expect(admit.mock.calls[1][3]).toBe('k-second');
  });

  it('keeps the admitted mark when the recording write fails, then retries only the write', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    const store = await import('./pr-watch-store.js');
    const key = 'pr-state:owner/repo#42:ci_failure:aaa';
    const admit = vi.fn(
      async (
        _runtime: WorkspaceRuntime,
        _sessionId: string,
        _promptText: string,
        _idempotencyKey: string,
      ) => ({ deduplicated: false }),
    );
    const deps = makeDeps({ admitPrompt: admit });
    // First drain: admission lands but the recording write fails.
    const writeSpy = vi
      .spyOn(store, 'writePrWatchStateSync')
      .mockImplementationOnce(() => {
        throw new Error('disk full');
      });
    await runPrWatchDrainTick([runtime()], deps, state);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(state.inFlight.get(key)?.admitted).toBe(true);
    const stored = readPrWatchStateSync(dir, identity);
    if (stored.kind === 'state') expect(stored.state.pending).toHaveLength(1);
    writeSpy.mockRestore();
    // Second drain: the admitted mark retries only the write, never re-admits.
    const second = await runPrWatchDrainTick([runtime()], deps, state);
    expect(second.delivered).toBe(0);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(state.inFlight.has(key)).toBe(false);
    const after = readPrWatchStateSync(dir, identity);
    if (after.kind === 'state') {
      expect(after.state.pending).toBeUndefined();
      expect(after.state.delivered).toContain(key);
    }
  });

  it('starts at most PR_WATCH_MAX_CONCURRENT_RESTORES dormant restores per tick', async () => {
    const ids = [1, 2, 3, 4, 5].map((n) => ({
      host: 'github.com',
      repo: 'owner/repo',
      number: n,
    }));
    for (const id of ids) {
      writePrWatchStateSync(dir, id, {
        pr: id,
        observedAt: T0,
        state: 'open',
        headSha: 'a'.repeat(40),
        checks: 'passing',
        pending: [
          {
            type: 'ci_failure',
            key: `k-${id.number}`,
            summary: 's',
            detectedAt: T0,
          },
        ],
      });
    }
    let releaseWake: () => void = () => {};
    const wakeGate = new Promise<void>((resolve) => {
      releaseWake = resolve;
    });
    const deps = makeDeps({
      scanBindings: async () => ({
        bindings: ids.map((id) =>
          summary(`s-${id.number}`, { number: id.number }),
        ),
        partial: false,
      }),
      isSessionLive: () => false,
      wakeSession: () =>
        wakeGate.then(() => ({ kind: 'unavailable' as const })),
    });
    await runPrWatchDrainTick([runtime()], deps, state);
    expect(state.restoring.size).toBe(PR_WATCH_MAX_CONCURRENT_RESTORES);
    releaseWake();
    await vi.waitFor(() => {
      expect(state.restoring.size).toBe(0);
    });
  });

  it('skips an unreadable watch file and still drains the healthy ones', async () => {
    writePrWatchStateSync(dir, identity, pendingState());
    writeFileSync(path.join(dir, 'corrupt.json'), '{');
    const deps = makeDeps();
    const result = await runPrWatchDrainTick([runtime()], deps, state);
    expect(result.claimed).toBe(true);
    expect(result.delivered).toBe(1);
    expect(deps.admitPrompt).toHaveBeenCalledTimes(1);
  });
});
