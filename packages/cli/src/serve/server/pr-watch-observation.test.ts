/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FetchGitHubPullRequestViewResult,
  GitHubPullRequestView,
} from '@qwen-code/qwen-code-core/utils/github-prs.js';
import { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import {
  scanWorkspaceBindings,
  type SessionPrBindingSummary,
} from '../routes/session-pr-bindings.js';
import {
  createWorkspaceGenerationGuard,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  detectPrTransitions,
  normalizeWatchHost,
  observeWorkspacePrBindings,
  prWatchIdentityFromUrl,
  runPrWatchObservationTick,
  PR_WATCH_VIEW_CAP,
  type PrWatchObservation,
  type PrWatchObservationDeps,
} from './pr-watch-observation.js';
import {
  PR_WATCH_CI_FIRED_CAP,
  PR_WATCH_PENDING_CAP,
  prWatchFilePath,
  prWatchOwnerPath,
  readPrWatchStateSync,
  prWatchFileKey,
  writePrWatchStateSync,
  type PrWatchIdentity,
  type PrWatchState,
} from './pr-watch-store.js';

vi.mock('../routes/session-pr-bindings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../routes/session-pr-bindings.js')>();
  return { ...actual, scanWorkspaceBindings: vi.fn(async () => false) };
});

const identity: PrWatchIdentity = {
  host: 'github.com',
  repo: 'owner/repo',
  number: 42,
};

function obs(overrides: Partial<PrWatchObservation> = {}): PrWatchObservation {
  return {
    state: 'open',
    headSha: 'a'.repeat(40),
    checks: 'passing',
    ...overrides,
  };
}

const T0 = '2026-11-08T00:00:00.000Z';
const T1 = '2026-11-08T00:05:00.000Z';
const T2 = '2026-11-08T00:10:00.000Z';
const T3 = '2026-11-08T00:15:00.000Z';

function types(transitions: Array<{ type: string }>): string[] {
  return transitions.map((t) => t.type);
}

describe('detectPrTransitions', () => {
  it('initialises a first observation silently even when failing and conflicting', () => {
    const { state, transitions } = detectPrTransitions(
      identity,
      undefined,
      obs({ checks: 'failing', mergeable: 'conflicting', title: 'First' }),
      T0,
    );
    expect(transitions).toEqual([]);
    expect(state.headSha).toBe('a'.repeat(40));
    expect(state.checks).toBe('failing');
    expect(state.mergeable).toBe('conflicting');
    expect(state.title).toBe('First');
    expect(state.observedAt).toBe(T0);
    expect(state.pending).toBeUndefined();
    expect(state.ciFired).toBeUndefined();
  });

  it('fills a slim-only file silently on its first full view', () => {
    const slim: PrWatchState = {
      pr: identity,
      state: 'open',
      observedAt: T0,
    };
    const { state, transitions } = detectPrTransitions(
      identity,
      slim,
      obs({ checks: 'failing', mergeable: 'conflicting' }),
      T1,
    );
    expect(transitions).toEqual([]);
    expect(state.headSha).toBe('a'.repeat(40));
    expect(state.checks).toBe('failing');
    expect(state.mergeable).toBe('conflicting');
  });

  it('fires head_change when the head differs', () => {
    const first = detectPrTransitions(identity, undefined, obs(), T0);
    const next = detectPrTransitions(
      identity,
      first.state,
      obs({ headSha: 'b'.repeat(40) }),
      T1,
    );
    expect(types(next.transitions)).toEqual(['head_change']);
    expect(next.transitions[0].key).toContain('head_change');
    expect(next.transitions[0].summary).toContain('b'.repeat(40));
  });

  it('does not fire head_change when the head is unchanged', () => {
    const first = detectPrTransitions(identity, undefined, obs(), T0);
    const next = detectPrTransitions(identity, first.state, obs(), T1);
    expect(next.transitions).toEqual([]);
  });

  it('records every type when no subscription is given', () => {
    const first = detectPrTransitions(identity, undefined, obs(), T0);
    const next = detectPrTransitions(
      identity,
      first.state,
      obs({ headSha: 'b'.repeat(40), checks: 'failing' }),
      T1,
    );
    expect(types(next.transitions)).toEqual(['head_change', 'ci_failure']);
  });

  it('drops an unsubscribed type from both the transitions and pending', () => {
    const first = detectPrTransitions(identity, undefined, obs(), T0);
    const next = detectPrTransitions(
      identity,
      first.state,
      obs({ headSha: 'b'.repeat(40), checks: 'failing' }),
      T1,
      new Set(['ci_failure']),
    );
    expect(types(next.transitions)).toEqual(['ci_failure']);
    expect((next.state.pending ?? []).map((entry) => entry.type)).toEqual([
      'ci_failure',
    ]);
  });

  it('keeps only the subscribed type when several fire at once', () => {
    const first = detectPrTransitions(identity, undefined, obs(), T0);
    const next = detectPrTransitions(
      identity,
      first.state,
      obs({
        headSha: 'b'.repeat(40),
        checks: 'failing',
        mergeable: 'conflicting',
        state: 'closed',
      }),
      T1,
      new Set(['state_change']),
    );
    expect(types(next.transitions)).toEqual(['state_change']);
  });

  it('still records ciFired for an unsubscribed ci_failure', () => {
    // Subscribing later must not fire retroactively for a head that was
    // already failing: the bookkeeping is deliberately not filtered, the
    // same rule that makes a first observation initialise silently.
    const headA = 'a'.repeat(40);
    const s0 = detectPrTransitions(identity, undefined, obs(), T0);
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ headSha: headA, checks: 'failing' }),
      T1,
      new Set(['head_change']),
    );
    expect(s1.transitions).toEqual([]);
    expect(s1.state.ciFired).toEqual([headA]);

    const s2 = detectPrTransitions(
      identity,
      s1.state,
      obs({ headSha: headA, checks: 'failing' }),
      T2,
      new Set(['head_change', 'ci_failure']),
    );
    expect(s2.transitions).toEqual([]);
  });

  it('fires ci_failure once per head across a force-push revisit', () => {
    const headA = 'a'.repeat(40);
    const headB = 'b'.repeat(40);
    // Baseline A as passing so its first failure fires and enters ciFired.
    const s0 = detectPrTransitions(
      identity,
      undefined,
      obs({ headSha: headA }),
      T0,
    );
    expect(s0.transitions).toEqual([]);
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ headSha: headA, checks: 'failing' }),
      T1,
    );
    expect(types(s1.transitions)).toEqual(['ci_failure']);
    const s2 = detectPrTransitions(
      identity,
      s1.state,
      obs({ headSha: headB, checks: 'failing' }),
      T2,
    );
    expect(types(s2.transitions)).toEqual(['head_change', 'ci_failure']);
    const s3 = detectPrTransitions(
      identity,
      s2.state,
      obs({ headSha: headA, checks: 'failing' }),
      T3,
    );
    // Back to A: head_change fires, ci_failure does not (A is in ciFired).
    // ci_failure fired twice total (A at s1, B at s2), not three times.
    expect(types(s3.transitions)).toEqual(['head_change']);
    expect(s3.state.ciFired).toEqual([headA, headB]);
  });

  it('fires ci_failure for a new head whose first observation is failing', () => {
    const s0 = detectPrTransitions(identity, undefined, obs(), T0);
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ headSha: 'b'.repeat(40), checks: 'failing' }),
      T1,
    );
    expect(types(s1.transitions)).toEqual(['head_change', 'ci_failure']);
  });

  it('does not fire ci_failure again while the same head keeps failing', () => {
    const headA = 'a'.repeat(40);
    const s0 = detectPrTransitions(
      identity,
      undefined,
      obs({ headSha: headA }),
      T0,
    );
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ headSha: headA, checks: 'failing' }),
      T1,
    );
    expect(types(s1.transitions)).toEqual(['ci_failure']);
    const s2 = detectPrTransitions(
      identity,
      s1.state,
      obs({ headSha: headA, checks: 'failing' }),
      T2,
    );
    expect(s2.transitions).toEqual([]);
  });

  it('fires nothing when a PR is already failing at its first two observations', () => {
    const headA = 'a'.repeat(40);
    const s0 = detectPrTransitions(
      identity,
      undefined,
      obs({ headSha: headA, checks: 'failing' }),
      T0,
    );
    expect(s0.transitions).toEqual([]);
    // The next sweep still failing on the same head is not a new edge, even
    // though the silent first observation never put the head in ciFired.
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ headSha: headA, checks: 'failing' }),
      T1,
    );
    expect(s1.transitions).toEqual([]);
    expect(s1.state.ciFired).toBeUndefined();
  });

  it('does not re-fire ci_failure after recovery while the head stays in history', () => {
    const headA = 'a'.repeat(40);
    const s0 = detectPrTransitions(
      identity,
      undefined,
      obs({ headSha: headA }),
      T0,
    );
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ headSha: headA, checks: 'failing' }),
      T1,
    );
    const s2 = detectPrTransitions(
      identity,
      s1.state,
      obs({ headSha: headA, checks: 'passing' }),
      T2,
    );
    expect(s2.transitions).toEqual([]);
    const s3 = detectPrTransitions(
      identity,
      s2.state,
      obs({ headSha: headA, checks: 'failing' }),
      T3,
    );
    // Still once per head: A is in ciFired, so no second ci_failure.
    expect(s3.transitions).toEqual([]);
  });

  it('names up to five failing checks in the ci_failure summary', () => {
    const s0 = detectPrTransitions(identity, undefined, obs(), T0);
    const names = [
      'w1 / j1',
      'w2 / j2',
      'w3 / j3',
      'w4 / j4',
      'w5 / j5',
      'w6 / j6',
    ];
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ checks: 'failing', failingChecks: names }),
      T1,
    );
    const failure = s1.transitions.find((t) => t.type === 'ci_failure');
    expect(failure?.summary).toBe(
      'CI failing: w1 / j1, w2 / j2, w3 / j3, w4 / j4, w5 / j5',
    );
  });

  it('edge-triggers merge_conflict (conflicting → mergeable → conflicting fires twice)', () => {
    const s0 = detectPrTransitions(identity, undefined, obs(), T0);
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ mergeable: 'conflicting' }),
      T1,
    );
    expect(types(s1.transitions)).toEqual(['merge_conflict']);
    const s2 = detectPrTransitions(
      identity,
      s1.state,
      obs({ mergeable: 'mergeable' }),
      T2,
    );
    expect(s2.transitions).toEqual([]);
    const s3 = detectPrTransitions(
      identity,
      s2.state,
      obs({ mergeable: 'conflicting' }),
      T3,
    );
    expect(types(s3.transitions)).toEqual(['merge_conflict']);
  });

  it('does not re-fire merge_conflict while the PR stays conflicting', () => {
    const s0 = detectPrTransitions(
      identity,
      undefined,
      obs({ mergeable: 'mergeable' }),
      T0,
    );
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ mergeable: 'conflicting' }),
      T1,
    );
    expect(types(s1.transitions)).toEqual(['merge_conflict']);
    // Edge-triggered, not level-triggered: a second consecutive conflicting
    // observation must not append another merge_conflict (or a PR that stays
    // conflicting would prompt every tick until the pending cap evicts).
    const s2 = detectPrTransitions(
      identity,
      s1.state,
      obs({ mergeable: 'conflicting' }),
      T2,
    );
    expect(s2.transitions).toEqual([]);
  });

  it('fires a first conflicting after UNKNOWN views', () => {
    const s0 = detectPrTransitions(identity, undefined, obs(), T0);
    // mergeable UNKNOWN (absent) — stored stays undefined.
    const s1 = detectPrTransitions(identity, s0.state, obs(), T1);
    expect(s1.state.mergeable).toBeUndefined();
    const s2 = detectPrTransitions(
      identity,
      s1.state,
      obs({ mergeable: 'conflicting' }),
      T2,
    );
    expect(types(s2.transitions)).toEqual(['merge_conflict']);
  });

  it('preserves the stored mergeable on UNKNOWN and emits nothing', () => {
    const s0 = detectPrTransitions(identity, undefined, obs(), T0);
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ mergeable: 'conflicting' }),
      T1,
    );
    const s2 = detectPrTransitions(identity, s1.state, obs(), T2);
    expect(s2.transitions).toEqual([]);
    expect(s2.state.mergeable).toBe('conflicting');
  });

  it('fires state_change leaving open and again after a reopen', () => {
    const s0 = detectPrTransitions(identity, undefined, obs(), T0);
    const s1 = detectPrTransitions(
      identity,
      s0.state,
      obs({ state: 'closed' }),
      T1,
    );
    expect(types(s1.transitions)).toEqual(['state_change']);
    expect(s1.transitions[0].summary).toBe('PR closed');
    const s2 = detectPrTransitions(
      identity,
      s1.state,
      obs({ state: 'open' }),
      T2,
    );
    // Reopen returns to open: no state_change (it only fires leaving open).
    expect(s2.transitions).toEqual([]);
    const s3 = detectPrTransitions(
      identity,
      s2.state,
      obs({ state: 'merged' }),
      T3,
    );
    expect(types(s3.transitions)).toEqual(['state_change']);
    expect(s3.transitions[0].summary).toBe('PR merged');
  });

  it('hashes an over-length key deterministically', () => {
    const longIdentity: PrWatchIdentity = {
      host: 'github.com',
      repo: `${'o'.repeat(120)}/${'r'.repeat(120)}`,
      number: 42,
    };
    const s0 = detectPrTransitions(longIdentity, undefined, obs(), T0);
    const s1 = detectPrTransitions(
      longIdentity,
      s0.state,
      obs({ headSha: 'b'.repeat(40) }),
      T1,
    );
    const key = s1.transitions[0].key;
    expect(key).toMatch(/^pr-state:h:[0-9a-f]{40}$/);
    // Deterministic: same inputs reproduce the same key.
    const again = detectPrTransitions(
      longIdentity,
      s0.state,
      obs({ headSha: 'b'.repeat(40) }),
      T1,
    );
    expect(again.transitions[0].key).toBe(key);
  });

  it('reserves room for the role-group suffix at the key cap boundary', () => {
    // raw key length is 131 + repo.length for a head_change between two
    // 40-char heads at PR #42: repo 61 -> raw 192 (192 + ':untyped' = 200,
    // kept literal); repo 62 -> raw 193 (193 + 8 = 201 > 200, must hash).
    const headChangeKey = (repo: string): string => {
      const id: PrWatchIdentity = { host: 'github.com', repo, number: 42 };
      const s0 = detectPrTransitions(id, undefined, obs(), T0);
      const s1 = detectPrTransitions(
        id,
        s0.state,
        obs({ headSha: 'b'.repeat(40) }),
        T1,
      );
      return s1.transitions[0].key;
    };
    const atCap = headChangeKey(`${'o'.repeat(30)}/${'r'.repeat(30)}`);
    expect(atCap.startsWith('pr-state:')).toBe(true);
    expect(atCap.length + ':untyped'.length).toBeLessThanOrEqual(200);
    const overCap = headChangeKey(`${'o'.repeat(30)}/${'r'.repeat(31)}`);
    expect(overCap).toMatch(/^pr-state:h:[0-9a-f]{40}$/);
    expect(overCap.length + ':untyped'.length).toBeLessThanOrEqual(200);
  });

  it('keeps the newest ciFired heads at the cap', () => {
    let state = detectPrTransitions(identity, undefined, obs(), T0).state;
    for (let i = 0; i < PR_WATCH_CI_FIRED_CAP + 3; i += 1) {
      const head = `${i}`.padStart(40, '0');
      state = detectPrTransitions(
        identity,
        state,
        obs({ headSha: head, checks: 'failing' }),
        new Date(Date.parse(T0) + (i + 1) * 60_000).toISOString(),
      ).state;
    }
    expect(state.ciFired).toHaveLength(PR_WATCH_CI_FIRED_CAP);
    expect(state.ciFired?.[state.ciFired.length - 1]).toBe(
      `${PR_WATCH_CI_FIRED_CAP + 2}`.padStart(40, '0'),
    );
  });

  it('caps pending at the limit, dropping the oldest', () => {
    let state = detectPrTransitions(identity, undefined, obs(), T0).state;
    const total = PR_WATCH_PENDING_CAP + 4;
    const at = (i: number) =>
      new Date(Date.parse(T0) + i * 60_000).toISOString();
    // Each head change appends a pending transition; nothing drains here.
    for (let i = 0; i < total; i += 1) {
      state = detectPrTransitions(
        identity,
        state,
        obs({ headSha: `${i}`.padStart(40, '0') }),
        at(i + 1),
      ).state;
    }
    expect(state.pending).toHaveLength(PR_WATCH_PENDING_CAP);
    // Pin the direction, not just the length: the newest entries survive.
    // The oldest surviving transition is iteration (total - cap), stamped
    // total - cap + 1; the newest is the final iteration, stamped total. A
    // slice(0, cap) that keeps the oldest would pass the length assertion
    // but fail both endpoints.
    expect(state.pending?.[0]?.detectedAt).toBe(
      at(total - PR_WATCH_PENDING_CAP + 1),
    );
    expect(state.pending?.[PR_WATCH_PENDING_CAP - 1]?.detectedAt).toBe(
      at(total),
    );
  });

  it('preserves lastBoundAt and delivered across observations', () => {
    const previous: PrWatchState = {
      pr: identity,
      lastBoundAt: T0,
      observedAt: T0,
      state: 'open',
      headSha: 'a'.repeat(40),
      checks: 'passing',
      delivered: ['pr-state:owner/repo#42:head_change:x:y'],
    };
    const { state } = detectPrTransitions(
      identity,
      previous,
      obs({ headSha: 'b'.repeat(40) }),
      T1,
    );
    expect(state.lastBoundAt).toBe(T0);
    expect(state.delivered).toEqual(previous.delivered);
  });
});

function prUrl(
  number: number,
  repo = 'owner/repo',
  host = 'github.com',
): string {
  return `https://${host}/${repo}/pull/${number}`;
}

function binding(
  number: number,
  state?: 'open' | 'merged' | 'closed',
  repo = 'owner/repo',
  host = 'github.com',
): SessionPrBindingSummary {
  return {
    sessionId: 's1',
    workspaceCwd: '/ws',
    prs: [
      {
        number,
        url: prUrl(number, repo, host),
        ...(state !== undefined ? { state } : {}),
      },
    ],
  };
}

function okResult(
  url: string,
  overrides: Partial<GitHubPullRequestView> = {},
): FetchGitHubPullRequestViewResult {
  return {
    kind: 'ok',
    view: {
      url,
      title: 'Title',
      headSha: 'a'.repeat(40),
      state: 'open',
      checks: 'passing',
      failingChecks: [],
      ...overrides,
    },
  };
}

describe('observeWorkspacePrBindings', () => {
  let dir: string;
  let locks: PathMutexRegistry;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pr-watch-obs-'));
    locks = new PathMutexRegistry();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeDeps(
    view: (url: string) => Promise<FetchGitHubPullRequestViewResult>,
    overrides: Partial<PrWatchObservationDeps> = {},
  ): PrWatchObservationDeps {
    return {
      watchDir: dir,
      locks,
      allowedHosts: new Set(['github.com']),
      viewPullRequest: view,
      now: () => Date.parse(T1),
      ...overrides,
    };
  }

  it('normalises hosts and derives the watch identity from a binding URL', () => {
    expect(normalizeWatchHost('WWW.GitHub.com')).toBe('github.com');
    expect(prWatchIdentityFromUrl(prUrl(42))).toEqual(identity);
    expect(
      prWatchIdentityFromUrl('https://www.github.com/owner/repo/pull/42/files'),
    ).toEqual(identity);
    expect(prWatchIdentityFromUrl('not a url')).toBeUndefined();
  });

  it('writes a first observation silently and a later head change to pending', async () => {
    const view = vi.fn(async (url: string) => okResult(url));
    const first = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view),
    );
    expect(first).toEqual({ consumed: 1, observed: 1, failed: 0 });
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    const stored = readPrWatchStateSync(dir, id);
    expect(stored.kind).toBe('state');
    if (stored.kind === 'state') {
      expect(stored.state.headSha).toBe('a'.repeat(40));
      expect(stored.state.pending).toBeUndefined();
    }
    view.mockImplementation(async (url: string) =>
      okResult(url, { headSha: 'b'.repeat(40) }),
    );
    const second = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { now: () => Date.parse(T2) }),
    );
    expect(second.observed).toBe(1);
    const after = readPrWatchStateSync(dir, id);
    expect(after.kind).toBe('state');
    if (after.kind === 'state') {
      expect(after.state.pending?.map((p) => p.type)).toEqual(['head_change']);
    }
  });

  it('writes no transition the subscription excludes', async () => {
    // The sweep-level witness for the view call site. The detector's filter
    // has its own direct cases, but only this one proves the sweep passes its
    // subscription down: dropping `deps.events` at the call site leaves every
    // other case in this file green.
    const view = vi.fn(async (url: string) => okResult(url));
    await observeWorkspacePrBindings([binding(42)], makeDeps(view));
    view.mockImplementation(async (url: string) =>
      okResult(url, { headSha: 'b'.repeat(40), checks: 'failing' }),
    );
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, {
        now: () => Date.parse(T2),
        events: new Set(['ci_failure']),
      }),
    );
    expect(result.observed).toBe(1);
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    const after = readPrWatchStateSync(dir, id);
    expect(after.kind).toBe('state');
    if (after.kind === 'state') {
      expect(after.state.pending?.map((p) => p.type)).toEqual(['ci_failure']);
    }
  });

  it('plumbs the view mergeable into the watch file and conflict detection', async () => {
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    const view = vi.fn(async (url: string) =>
      okResult(url, { mergeable: 'mergeable' }),
    );
    // Baseline observation initialises silently.
    await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { now: () => Date.parse(T0) }),
    );
    // A conflicting view must reach the detector: the watch file carries
    // mergeable and a merge_conflict pending entry (pins observationFromView).
    view.mockImplementation(async (url: string) =>
      okResult(url, { mergeable: 'conflicting' }),
    );
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { now: () => Date.parse(T1) }),
    );
    expect(result.observed).toBe(1);
    const stored = readPrWatchStateSync(dir, id);
    expect(stored.kind).toBe('state');
    if (stored.kind === 'state') {
      expect(stored.state.mergeable).toBe('conflicting');
      expect(stored.state.pending?.map((p) => p.type)).toEqual([
        'merge_conflict',
      ]);
    }
  });

  it('skips a binding on a non-allowed host without any view call', async () => {
    const view = vi.fn(async (url: string) => okResult(url));
    const result = await observeWorkspacePrBindings(
      [binding(42, undefined, 'owner/repo', 'gitlab.com')],
      makeDeps(view),
    );
    expect(result).toEqual({ consumed: 0, observed: 0, failed: 0 });
    expect(view).not.toHaveBeenCalled();
  });

  it('treats www.github.com as the allowed github.com', async () => {
    const view = vi.fn(async (url: string) => okResult(url));
    const result = await observeWorkspacePrBindings(
      [binding(42, undefined, 'owner/repo', 'www.github.com')],
      makeDeps(view),
    );
    expect(result.observed).toBe(1);
    expect(view).toHaveBeenCalledTimes(1);
  });

  it('discards a view that returns another number', async () => {
    const view = vi.fn(async () => okResult(prUrl(99)));
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view),
    );
    expect(result).toEqual({ consumed: 1, observed: 0, failed: 1 });
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    expect(readPrWatchStateSync(dir, id).kind).toBe('absent');
  });

  it('accepts a renamed repository and keeps the binding own watch file', async () => {
    const view = vi.fn(async () => okResult(prUrl(42, 'newowner/repo')));
    const log = vi.fn();
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { log }),
    );
    expect(result.observed).toBe(1);
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    expect(readPrWatchStateSync(dir, id).kind).toBe('state');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('renamed'));
  });

  it('rotates the capped window so two sweeps observe all 40 PRs', async () => {
    const bindings = Array.from({ length: 40 }, (_, i) => binding(i + 1));
    const view = vi.fn(async (url: string) => okResult(url));
    const seen = new Set<string>();
    const record = async (options: { sweepStart?: number }) => {
      const result = await observeWorkspacePrBindings(
        bindings,
        makeDeps(view),
        options,
      );
      for (let n = 1; n <= 40; n += 1) {
        const id = prWatchIdentityFromUrl(prUrl(n))!;
        if (readPrWatchStateSync(dir, id).kind === 'state') seen.add(prUrl(n));
      }
      return result;
    };
    const first = await record({ sweepStart: 0 });
    expect(first.consumed).toBe(PR_WATCH_VIEW_CAP);
    const second = await record({ sweepStart: first.consumed });
    expect(second.consumed).toBe(PR_WATCH_VIEW_CAP);
    expect(seen.size).toBe(40);
  });

  it('starts no view past the deadline', async () => {
    const view = vi.fn(async (url: string) => okResult(url));
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { now: () => Date.parse(T2) }),
      { deadline: Date.parse(T1) },
    );
    expect(result.consumed).toBe(0);
    expect(view).not.toHaveBeenCalled();
  });

  it('skips a PR already viewed this tick (cross-workspace dedup)', async () => {
    const view = vi.fn(async (url: string) => okResult(url));
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    const viewedThisTick = new Set([`${id.host}/${id.repo}#${id.number}`]);
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view),
      { viewedThisTick },
    );
    expect(result.consumed).toBe(0);
    expect(view).not.toHaveBeenCalled();
  });

  it('records a viewed PR in the shared per-tick set so the next workspace skips it', async () => {
    const view = vi.fn(async (url: string) => okResult(url));
    // One Set per tick, shared across workspaces — the shape the tick uses.
    const viewedThisTick = new Set<string>();
    const first = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view),
      { viewedThisTick },
    );
    expect(first).toEqual({ consumed: 1, observed: 1, failed: 0 });
    // A second workspace bound to the same PR must find it already recorded
    // by the first workspace's write and spend no second view.
    const second = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view),
      { viewedThisTick },
    );
    expect(second).toEqual({ consumed: 0, observed: 0, failed: 0 });
    expect(view).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the watch path is not a regular file', async () => {
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    const filePath = prWatchFilePath(dir, id);
    mkdirSync(filePath);
    const view = vi.fn(async (url: string) => okResult(url));
    const log = vi.fn();
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { log }),
    );
    // The pre-check skips the PR before spending a view (master §2): no
    // view, no write, and the read error is logged once.
    expect(result).toEqual({ consumed: 0, observed: 0, failed: 0 });
    expect(view).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('read error');
    expect(log.mock.calls[0][0]).toContain(filePath);
  });

  it('still fails closed when the watch path turns unreadable after the pre-check', async () => {
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    const filePath = prWatchFilePath(dir, id);
    // The pre-check sees no file; the view's side effect plants a directory
    // at the watch path, so the in-lock read errors (the TOCTOU window the
    // in-lock error branch still covers).
    const view = vi.fn(async (url: string) => {
      mkdirSync(filePath);
      return okResult(url);
    });
    const log = vi.fn();
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { log }),
    );
    expect(result).toEqual({ consumed: 1, observed: 0, failed: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('read error'));
  });

  it('logs an invalid watch file and re-initialises it silently', async () => {
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    const filePath = prWatchFilePath(dir, id);
    writeFileSync(filePath, '{');
    const view = vi.fn(async (url: string) => okResult(url));
    const log = vi.fn();
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { log }),
    );
    // Master §2: an invalid file initialises silently but logs, so a lost
    // baseline is distinguishable from a PR with no transitions. The view
    // is accepted, no transition fires, and the file becomes a valid state.
    expect(result).toEqual({ consumed: 1, observed: 1, failed: 0 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('invalid watch file');
    expect(log.mock.calls[0][0]).toContain(filePath);
    const stored = readPrWatchStateSync(dir, id);
    expect(stored.kind).toBe('state');
    if (stored.kind === 'state') {
      expect(stored.state.headSha).toBe('a'.repeat(40));
      expect(stored.state.pending).toBeUndefined();
    }
  });

  it('does not view a merged binding', async () => {
    const view = vi.fn(async (url: string) => okResult(url));
    const result = await observeWorkspacePrBindings(
      [binding(42, 'merged')],
      makeDeps(view),
    );
    expect(result.consumed).toBe(0);
    expect(view).not.toHaveBeenCalled();
  });

  it('views a closed PR outside the listing but not one the listing returned', async () => {
    const view = vi.fn(async (url: string) =>
      okResult(url, { state: 'closed' }),
    );
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    const key = `${id.host}/${id.repo}#${id.number}`;
    const notListed = await observeWorkspacePrBindings(
      [binding(42, 'closed')],
      makeDeps(view),
      { listedKeys: new Set() },
    );
    expect(notListed.consumed).toBe(1);
    const listed = await observeWorkspacePrBindings(
      [binding(43, 'closed')],
      makeDeps(view),
      { listedKeys: new Set([key.replace('#42', '#43')]) },
    );
    expect(listed.consumed).toBe(0);
  });

  it('isolates a failing view from the other PRs', async () => {
    const view = vi.fn(async (url: string) =>
      url.endsWith('/42')
        ? ({ kind: 'cli_unavailable' } as FetchGitHubPullRequestViewResult)
        : okResult(url),
    );
    const result = await observeWorkspacePrBindings(
      [binding(42), binding(43)],
      makeDeps(view),
    );
    expect(result.consumed).toBe(2);
    expect(result.observed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('discards a view that started before the stored observedAt', async () => {
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    const view = vi.fn(async (url: string) => okResult(url));
    // First observation at T2 baselines the file at observedAt=T2.
    await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { now: () => Date.parse(T2) }),
    );
    // A slower view that started at T1 (< T2) must not roll the baseline back.
    view.mockImplementation(async (url: string) =>
      okResult(url, { headSha: 'b'.repeat(40) }),
    );
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { now: () => Date.parse(T1) }),
    );
    expect(result.consumed).toBe(1);
    expect(result.observed).toBe(0);
    const stored = readPrWatchStateSync(dir, id);
    expect(stored.kind).toBe('state');
    if (stored.kind === 'state') {
      expect(stored.state.headSha).toBe('a'.repeat(40));
    }
  });

  it('does not run gh when the generation guard throws', async () => {
    const view = vi.fn(async (url: string) => okResult(url));
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, {
        assertGenerationOpen: () => {
          throw new Error('generation retired');
        },
      }),
    );
    // The guard throws before the view starts, so the rotation is not
    // advanced (consumed 0): master §1 advances by views actually started.
    expect(result.consumed).toBe(0);
    expect(result.observed).toBe(0);
    expect(result.failed).toBe(1);
    expect(view).not.toHaveBeenCalled();
  });

  it('logs when pending overflows the cap', async () => {
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    const pending = Array.from({ length: PR_WATCH_PENDING_CAP }, (_, i) => ({
      type: 'head_change' as const,
      key: `k${i}`,
      summary: 's',
      detectedAt: T0,
    }));
    writePrWatchStateSync(dir, id, {
      pr: id,
      observedAt: T0,
      state: 'open',
      headSha: 'a'.repeat(40),
      checks: 'passing',
      pending,
    });
    const view = vi.fn(async (url: string) =>
      okResult(url, { headSha: 'b'.repeat(40) }),
    );
    const log = vi.fn();
    const result = await observeWorkspacePrBindings(
      [binding(42)],
      makeDeps(view, { log, now: () => Date.parse(T1) }),
    );
    expect(result.observed).toBe(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('pending overflow'),
    );
  });

  it('does not let dedup-skipped PRs consume the view cap', async () => {
    const bindings = Array.from({ length: 40 }, (_, i) => binding(i + 1));
    const view = vi.fn(async (url: string) => okResult(url));
    // The first 30 PRs were already viewed by another workspace this tick.
    const viewedThisTick = new Set<string>();
    for (let n = 1; n <= 30; n += 1) {
      const id = prWatchIdentityFromUrl(prUrl(n))!;
      viewedThisTick.add(`${id.host}/${id.repo}#${id.number}`);
    }
    const result = await observeWorkspacePrBindings(bindings, makeDeps(view), {
      viewedThisTick,
      sweepStart: 0,
    });
    // The 10 unique PRs past the skipped prefix are still observed; the
    // skipped views do not count against the cap (master §1).
    expect(result.consumed).toBe(10);
    expect(result.observed).toBe(10);
    expect(view).toHaveBeenCalledTimes(10);
  });
});

describe('runPrWatchObservationTick', () => {
  let dir: string;
  let locks: PathMutexRegistry;
  const scanMock = vi.mocked(scanWorkspaceBindings);

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pr-watch-tick-'));
    locks = new PathMutexRegistry();
    scanMock.mockReset();
    scanMock.mockImplementation(async (_runtime, out) => {
      out.push(binding(42));
      return false;
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runtime(
    cwd: string,
    overrides: {
      trusted?: boolean;
      primary?: boolean;
      effectiveEnv?: Record<string, string>;
      generationGuard?: WorkspaceRuntime['generationGuard'];
    } = {},
  ): WorkspaceRuntime {
    return {
      workspaceCwd: cwd,
      trusted: overrides.trusted ?? true,
      primary: overrides.primary ?? false,
      env: { effectiveEnv: overrides.effectiveEnv ?? {} },
      ...(overrides.generationGuard !== undefined
        ? { generationGuard: overrides.generationGuard }
        : {}),
    } as unknown as WorkspaceRuntime;
  }

  it('claims ownership, observes the bound PR and advances the offset', async () => {
    const view = vi.fn(async (url: string) => okResult(url));
    const offsets = new Map<string, number>();
    const result = await runPrWatchObservationTick(
      [runtime('/ws')],
      {
        watchDir: dir,
        locks,
        allowedHosts: new Set(['github.com']),
        viewPullRequest: view,
        now: () => Date.parse(T1),
      },
      { intervalMs: 300_000, sweepOffsets: offsets },
    );
    expect(result).toEqual({ claimed: true, observed: 1 });
    expect(view).toHaveBeenCalledTimes(1);
    expect(offsets.get('/ws')).toBe(1);
    const id = prWatchIdentityFromUrl(prUrl(42))!;
    expect(readPrWatchStateSync(dir, id).kind).toBe('state');
  });

  it('observes nothing when an unverifiable record blocks the claim', async () => {
    writeFileSync(
      prWatchOwnerPath(dir),
      JSON.stringify({
        pid: process.pid,
        procStart: 'foreign-boot:0',
        startedAt: new Date().toISOString(),
      }),
    );
    const view = vi.fn(async (url: string) => okResult(url));
    const result = await runPrWatchObservationTick(
      [runtime('/ws')],
      {
        watchDir: dir,
        locks,
        allowedHosts: new Set(['github.com']),
        viewPullRequest: view,
      },
      { intervalMs: 300_000, sweepOffsets: new Map() },
    );
    expect(result).toEqual({ claimed: false, observed: 0 });
    expect(view).not.toHaveBeenCalled();
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('hands each workspace its own env and the private watch dir as the view cwd', async () => {
    const envA = { GH_TOKEN: 'token-a' };
    const envB = { GH_TOKEN: 'token-b' };
    scanMock.mockImplementation(async (runtime, out) => {
      out.push(binding(runtime.workspaceCwd === '/ws-a' ? 42 : 43));
      return false;
    });
    const view = vi.fn(async (url: string) => okResult(url));
    const result = await runPrWatchObservationTick(
      [
        runtime('/ws-a', { effectiveEnv: envA }),
        runtime('/ws-b', { effectiveEnv: envB }),
      ],
      {
        watchDir: dir,
        locks,
        allowedHosts: new Set(['github.com']),
        viewPullRequest: view,
        now: () => Date.parse(T1),
      },
      { intervalMs: 300_000, sweepOffsets: new Map() },
    );
    expect(result).toEqual({ claimed: true, observed: 2 });
    // The cwd is the daemon-private watch dir (never the workspace checkout,
    // where a planted gh could be resolved), and each workspace's own
    // effectiveEnv applies to its PRs (master §1).
    expect(view).toHaveBeenCalledWith(prUrl(42), dir, envA);
    expect(view).toHaveBeenCalledWith(prUrl(43), dir, envB);
  });

  it('runs the untrusted primary views with the daemon environment, not its checkout env', async () => {
    const view = vi.fn(async (url: string) => okResult(url));
    const result = await runPrWatchObservationTick(
      [
        runtime('/ws-primary', {
          primary: true,
          trusted: false,
          effectiveEnv: { GH_TOKEN: 'planted-in-untrusted-checkout' },
        }),
      ],
      {
        watchDir: dir,
        locks,
        allowedHosts: new Set(['github.com']),
        viewPullRequest: view,
        now: () => Date.parse(T1),
      },
      { intervalMs: 300_000, sweepOffsets: new Map() },
    );
    expect(result).toEqual({ claimed: true, observed: 1 });
    // undefined env → ghEnv falls back to the daemon's process.env; the
    // untrusted checkout's credential must not reach the view (master §1).
    expect(view).toHaveBeenCalledWith(prUrl(42), dir, undefined);
  });

  it('does not view a workspace whose generation guard is closed', async () => {
    const guard = createWorkspaceGenerationGuard();
    guard.close();
    const view = vi.fn(async (url: string) => okResult(url));
    const result = await runPrWatchObservationTick(
      [runtime('/ws', { generationGuard: guard })],
      {
        watchDir: dir,
        locks,
        allowedHosts: new Set(['github.com']),
        viewPullRequest: view,
        now: () => Date.parse(T1),
      },
      { intervalMs: 300_000, sweepOffsets: new Map() },
    );
    expect(result).toEqual({ claimed: true, observed: 0 });
    expect(view).not.toHaveBeenCalled();
  });

  it('drops a closed PR the listing covered and keeps one it did not', async () => {
    scanMock.mockImplementation(async (_runtime, out) => {
      out.push(binding(42, 'closed'));
      return false;
    });
    const key = prWatchFileKey(prWatchIdentityFromUrl(prUrl(42))!);
    const view = vi.fn(async (url: string) => okResult(url));
    const deps = {
      watchDir: dir,
      locks,
      allowedHosts: new Set(['github.com']),
      viewPullRequest: view,
      now: () => Date.parse(T1),
    };

    // Covered by this workspace's listing: the closed PR leaves the rotation.
    const covered = await runPrWatchObservationTick([runtime('/ws')], deps, {
      intervalMs: 300_000,
      sweepOffsets: new Map(),
      listedKeysByWorkspace: new Map([['/ws', new Set([key])]]),
    });
    expect(covered).toEqual({ claimed: true, observed: 0 });
    expect(view).not.toHaveBeenCalled();

    // The same key under a different workspace does not cover this one, so the
    // PR stays in rotation to catch a reopen.
    const uncovered = await runPrWatchObservationTick([runtime('/ws')], deps, {
      intervalMs: 300_000,
      sweepOffsets: new Map(),
      listedKeysByWorkspace: new Map([['/other', new Set([key])]]),
    });
    expect(uncovered.observed).toBe(1);
    expect(view).toHaveBeenCalledTimes(1);
  });
});
