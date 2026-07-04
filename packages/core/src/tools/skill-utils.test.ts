/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest';
import {
  applySkillAllowedTools,
  collectAvailableSkillEntries,
} from './skill-utils.js';
import { invalidateCollectedSkillEntriesCache } from './skill-cache-registry.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type { Config } from '../config/config.js';
import type { SkillManager } from '../skills/skill-manager.js';

function mockPermissionManager(): {
  pm: PermissionManager;
  addSessionAllowRule: ReturnType<typeof vi.fn>;
} {
  const addSessionAllowRule = vi.fn();
  return {
    pm: { addSessionAllowRule } as unknown as PermissionManager,
    addSessionAllowRule,
  };
}

describe('applySkillAllowedTools', () => {
  it('adds one session allow rule per entry, verbatim and in order', () => {
    const { pm, addSessionAllowRule } = mockPermissionManager();

    applySkillAllowedTools(pm, ['Bash(git *)', 'Edit', 'mcp__server__tool']);

    expect(addSessionAllowRule).toHaveBeenCalledTimes(3);
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(1, 'Bash(git *)');
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(2, 'Edit');
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(3, 'mcp__server__tool');
  });

  it('no-ops when allowedTools is undefined', () => {
    const { pm, addSessionAllowRule } = mockPermissionManager();
    applySkillAllowedTools(pm, undefined);
    expect(addSessionAllowRule).not.toHaveBeenCalled();
  });

  it('no-ops when allowedTools is empty', () => {
    const { pm, addSessionAllowRule } = mockPermissionManager();
    applySkillAllowedTools(pm, []);
    expect(addSessionAllowRule).not.toHaveBeenCalled();
  });

  it('no-ops without throwing when there is no permission manager', () => {
    expect(() => applySkillAllowedTools(null, ['Bash(git *)'])).not.toThrow();
    expect(() =>
      applySkillAllowedTools(undefined, ['Bash(git *)']),
    ).not.toThrow();
  });

  it('delegates malformed-entry handling to the permission manager (does not pre-filter)', () => {
    // The permission manager is the single authority on rule validity; the
    // helper forwards every entry and lets addSessionAllowRule log/skip bad
    // ones. This keeps validation in one place.
    const { pm, addSessionAllowRule } = mockPermissionManager();
    applySkillAllowedTools(pm, ['Bash(unbalanced', 'Read']);
    expect(addSessionAllowRule).toHaveBeenCalledTimes(2);
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(1, 'Bash(unbalanced');
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(2, 'Read');
  });
});

describe('collectAvailableSkillEntries cache', () => {
  function createMockSkillManager(): SkillManager {
    return {
      listSkills: vi.fn().mockResolvedValue([]),
      isSkillActive: vi.fn().mockReturnValue(true),
    } as unknown as SkillManager;
  }

  function createMockConfig(): Config {
    return {
      get: () => undefined,
      on: () => {},
      getPreventSystemSleepEnabled: () => false,
      getDisabledSkillNames: vi.fn().mockReturnValue(new Set<string>()),
      getModelInvocableCommandsProvider: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
  }

  // Reset module-level cache before each test so tests are isolated.
  beforeEach(() => {
    invalidateCollectedSkillEntriesCache();
  });

  afterEach(() => {
    // Teardown: invalidate so other tests are unaffected.
    invalidateCollectedSkillEntriesCache();
  });

  it('cache miss on first call returns entries', async () => {
    const sm = createMockSkillManager();
    const cfg = createMockConfig();

    const result = await collectAvailableSkillEntries(sm, cfg);

    // First call should return a valid result (no error thrown).
    expect(result).toBeDefined();
    expect(result).toHaveProperty('availableSkills');
    expect(result).toHaveProperty('entries');
  });

  it('cache hit returns same object reference on subsequent call', async () => {
    // With WeakMap-based cache keyed by (skillManager, config) identity,
    // the SAME instances must be reused to demonstrate cache hit.
    const sm = createMockSkillManager();
    const cfg = createMockConfig();

    const result1 = await collectAvailableSkillEntries(sm, cfg);
    const result2 = await collectAvailableSkillEntries(sm, cfg);

    // Same instances → cache hit → identical object reference.
    expect(result1).toBe(result2);
  });

  it('cache invalidation forces recomputation', async () => {
    const sm1 = createMockSkillManager();
    const cfg1 = createMockConfig();

    const result1 = await collectAvailableSkillEntries(sm1, cfg1);

    invalidateCollectedSkillEntriesCache();

    const sm2 = createMockSkillManager();
    const cfg2 = createMockConfig();
    const result2 = await collectAvailableSkillEntries(sm2, cfg2);

    // After invalidation, a new object should be returned.
    expect(result2).not.toBe(result1);
    expect(result2).toHaveProperty('availableSkills');
    expect(result2).toHaveProperty('entries');
  });

  it('multiple invalidations in a row produce distinct objects', async () => {
    const sm1 = createMockSkillManager();
    const cfg1 = createMockConfig();
    const result1 = await collectAvailableSkillEntries(sm1, cfg1);

    invalidateCollectedSkillEntriesCache();
    const sm2 = createMockSkillManager();
    const cfg2 = createMockConfig();
    const result2 = await collectAvailableSkillEntries(sm2, cfg2);

    invalidateCollectedSkillEntriesCache();
    invalidateCollectedSkillEntriesCache();
    const sm3 = createMockSkillManager();
    const cfg3 = createMockConfig();
    const result3 = await collectAvailableSkillEntries(sm3, cfg3);

    expect(result2).not.toBe(result1);
    expect(result3).not.toBe(result2);
  });

  it('listSkills is not called on cache hit', async () => {
    // Invalidate the cache primed by beforeEach so we start fresh.
    invalidateCollectedSkillEntriesCache();
    const sm = createMockSkillManager();
    const cfg = createMockConfig();

    await collectAvailableSkillEntries(sm, cfg);
    expect(sm.listSkills).toHaveBeenCalledTimes(1);

    // Second call — cache hit, listSkills should NOT be called again.
    await collectAvailableSkillEntries(sm, cfg);
    expect(sm.listSkills).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers share a single compute (inflight promise dedup)', async () => {
    // Invalidate so we start with a cold cache.
    invalidateCollectedSkillEntriesCache();
    const sm = createMockSkillManager();
    const cfg = createMockConfig();

    // Fire 3 concurrent calls — all should share the same in-flight promise
    // so listSkills() is invoked exactly once, not three times.
    const [r1, r2, r3] = await Promise.all([
      collectAvailableSkillEntries(sm, cfg),
      collectAvailableSkillEntries(sm, cfg),
      collectAvailableSkillEntries(sm, cfg),
    ]);

    // All three resolve to the same object reference.
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    // listSkills was called exactly once despite 3 concurrent callers.
    expect(sm.listSkills).toHaveBeenCalledTimes(1);
  });

  it('cache reflects actual skill data and updates after invalidation', async () => {
    // Set up a mock skill manager that returns non-empty skill data.
    const skill1 = {
      name: 'git-skill',
      description: 'Git operations',
      level: 'project' as const,
      filePath: '/tmp/skills/git-skill',
      body: '# Git Skill',
      disableModelInvocation: false,
    };
    const skill2 = {
      name: 'docker-skill',
      description: 'Docker management',
      level: 'project' as const,
      filePath: '/tmp/skills/docker-skill',
      body: '# Docker Skill',
      disableModelInvocation: false,
    };

    // Reuse the SAME (sm, cfg) pair so invalidation targets this entry.
    const sm = createMockSkillManager();
    const cfg = createMockConfig();

    // Set up the mock directly (sm.listSkills is already a vi.fn).
    const listSkillsMock = sm.listSkills as ReturnType<typeof vi.fn>;
    listSkillsMock.mockResolvedValue([skill1, skill2]);

    const result1 = await collectAvailableSkillEntries(sm, cfg);

    // Verify listSkills was actually called
    expect(listSkillsMock).toHaveBeenCalledTimes(1);

    // Assert cached content reflects the input skills.
    expect(result1.availableSkills).toHaveLength(2);
    expect(result1.availableSkills.map((s) => s.name)).toEqual(
      expect.arrayContaining(['git-skill', 'docker-skill']),
    );
    expect(result1.entries).toHaveLength(2);
    // Entries are sorted: file-based skills first (by level), then alphabetically by name
    expect(result1.entries.map((e) => e.name)).toContain('docker-skill');
    expect(result1.entries.map((e) => e.name)).toContain('git-skill');

    // Invalidate cache and return different skills.
    invalidateCollectedSkillEntriesCache();
    const differentSkill = {
      name: 'k8s-skill',
      description: 'Kubernetes management',
      level: 'project' as const,
      filePath: '/tmp/skills/k8s-skill',
      body: '# K8s Skill',
      disableModelInvocation: false,
    };
    listSkillsMock.mockResolvedValueOnce([differentSkill]);

    // Same instances, but cache was invalidated — should recompute.
    const result2 = await collectAvailableSkillEntries(sm, cfg);

    // After invalidation, the new result should reflect the changed data.
    // With WeakMap cache, result2 is a different object from result1 because
    // the specific (sm, cfg) entry was invalidated and recomputed.
    expect(result2).not.toBe(result1);
    expect(result2.availableSkills).toHaveLength(1);
    expect(result2.availableSkills[0].name).toBe('k8s-skill');
    expect(result2.entries).toHaveLength(1);
    expect(result2.entries[0].name).toBe('k8s-skill');
  });

  it('failed compute evicts entry so next call retries', async () => {
    // The .catch() handler evicts the failed entry so the next caller retries
    // instead of replaying the same rejection. This test verifies that transient
    // listSkills() failures (e.g. disk I/O hiccup) don't permanently poison
    // the cache.
    const sm = createMockSkillManager();
    const cfg = createMockConfig();
    const listSkillsMock = sm.listSkills as ReturnType<typeof vi.fn>;

    // First call: simulate a transient disk I/O error.
    listSkillsMock.mockRejectedValueOnce(new Error('disk I/O'));
    await expect(collectAvailableSkillEntries(sm, cfg)).rejects.toThrow(
      'disk I/O',
    );

    // Second call: error is gone — should succeed with a fresh listSkills().
    listSkillsMock.mockResolvedValueOnce([]);
    const result = await collectAvailableSkillEntries(sm, cfg);

    expect(result).toBeDefined();
    expect(result).toHaveProperty('entries');
    // listSkills was called twice: once for the failed attempt, once for the retry.
    expect(listSkillsMock).toHaveBeenCalledTimes(2);
  });

  it('different configs with same skillManager get independent entries', async () => {
    // WeakMap per-instance isolation: the primary design motivation for switching
    // from a singleton to a WeakMap keyed by (skillManager, config). Two different
    // configs sharing the same skillManager should get independent cache entries
    // without explicit invalidation.
    const sm = createMockSkillManager();
    const cfg1 = createMockConfig();
    const cfg2 = createMockConfig();

    const r1 = await collectAvailableSkillEntries(sm, cfg1);
    const r2 = await collectAvailableSkillEntries(sm, cfg2);

    // Different configs → different cache keys → independent entries.
    expect(r1).not.toBe(r2);
    // Each config triggered its own listSkills() call.
    const listSkillsMock = sm.listSkills as ReturnType<typeof vi.fn>;
    expect(listSkillsMock).toHaveBeenCalledTimes(2);
  });

  it('pendingConditionalSkillNames reflects inactive path-gated skills', async () => {
    // The cache must correctly track conditional (path-gated) skills that are
    // not yet activated. The filter logic uses `paths`, `isSkillActive`, and
    // `getDisabledSkillNames` — a regression in any boolean would silently
    // produce wrong pending names in the cached result.
    const sm = createMockSkillManager();
    const cfg = createMockConfig();
    const listSkillsMock = sm.listSkills as ReturnType<typeof vi.fn>;

    const activeGated = {
      name: 'active-gated',
      description: 'Already activated path-gated skill',
      paths: ['src/**/*.ts'],
      level: 'project' as const,
      filePath: '/tmp/skills/active-gated',
      body: '# Active Gated',
      disableModelInvocation: false,
    };
    const pendingGated = {
      name: 'pending-gated',
      description: 'Not yet activated path-gated skill',
      paths: ['docs/**/*.md'],
      level: 'project' as const,
      filePath: '/tmp/skills/pending-gated',
      body: '# Pending Gated',
      disableModelInvocation: false,
    };
    const disabledGated = {
      name: 'disabled-gated',
      description: 'User-disabled path-gated skill',
      paths: ['scripts/**/*.py'],
      level: 'project' as const,
      filePath: '/tmp/skills/disabled-gated',
      body: '# Disabled Gated',
      disableModelInvocation: false,
    };

    // activeGated is already activated, pendingGated is not, disabledGated is disabled
    vi.mocked(sm.isSkillActive).mockImplementation(
      (s) => s.name === 'active-gated',
    );
    const disabledSpy = vi.mocked(cfg.getDisabledSkillNames);
    disabledSpy.mockReturnValue(new Set(['disabled-gated']));

    listSkillsMock.mockResolvedValue([
      activeGated,
      pendingGated,
      disabledGated,
    ]);

    const result = await collectAvailableSkillEntries(sm, cfg);

    expect(result.pendingConditionalSkillNames).toBeDefined();
    // Only pendingGated should be in pending — activeGated is already
    // activated, disabledGated is user-disabled.
    expect(result.pendingConditionalSkillNames).toEqual(
      new Set(['pending-gated']),
    );

    // Cache hit: same instances should return same object with same set.
    const hitResult = await collectAvailableSkillEntries(sm, cfg);
    expect(hitResult.pendingConditionalSkillNames).toBe(
      result.pendingConditionalSkillNames,
    );

    // After invalidation with different data, pending set should update.
    invalidateCollectedSkillEntriesCache();
    vi.mocked(sm.isSkillActive).mockReturnValue(false);
    listSkillsMock.mockResolvedValue([
      activeGated,
      pendingGated,
      disabledGated,
    ]);
    const resetResult = await collectAvailableSkillEntries(sm, cfg);
    expect(resetResult.pendingConditionalSkillNames).toEqual(
      new Set(['active-gated', 'pending-gated']),
    );
  });

  it('resolved value is not written to new WeakMap after mid-compute invalidation', async () => {
    // Start a compute, invalidate mid-flight, then resolve. The stale result
    // must not be written into the fresh WeakMap — otherwise the next call
    // would return stale data instead of recomputing.
    const sm = createMockSkillManager();
    const cfg = createMockConfig();
    const listSkillsMock = sm.listSkills as ReturnType<typeof vi.fn>;

    // Deferred promise so we control when listSkills resolves.
    let resolveListSkills!: (value: unknown[]) => void;
    const deferredPromise = new Promise<unknown[]>((resolve) => {
      resolveListSkills = resolve;
    });
    listSkillsMock.mockReturnValueOnce(deferredPromise);

    // Start first call — hangs on listSkills.
    const firstCall = collectAvailableSkillEntries(sm, cfg);

    // Invalidate mid-flight (replaces the WeakMap).
    invalidateCollectedSkillEntriesCache();

    // Resolve the first call. The .then() handler sees cacheByManager !== cacheSnapshot
    // and returns without writing the stale result.
    resolveListSkills([]);
    await firstCall;

    // Second call with same instances: cacheByManager is fresh, no entry for (sm, cfg),
    // so it must trigger a fresh listSkills().
    listSkillsMock.mockResolvedValueOnce([]);
    await collectAvailableSkillEntries(sm, cfg);

    expect(listSkillsMock).toHaveBeenCalledTimes(2);
  });
});
