/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest';
import {
  applySkillAllowedTools,
  collectAvailableSkillEntries,
  invalidateCollectedSkillEntriesCache,
} from './skill-utils.js';
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
    const sm1 = createMockSkillManager();
    const cfg1 = createMockConfig();
    const sm2 = createMockSkillManager();
    const cfg2 = createMockConfig();

    const result1 = await collectAvailableSkillEntries(sm1, cfg1);
    const result2 = await collectAvailableSkillEntries(sm2, cfg2);

    // Second call should return the same cached object.
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

    const sm = createMockSkillManager();
    const cfg = createMockConfig();

    // Use vi.spyOn to ensure the mock is definitely being called
    const listSkillsSpy = vi
      .spyOn(sm, 'listSkills')
      .mockResolvedValue([skill1, skill2]);

    const result1 = await collectAvailableSkillEntries(sm, cfg);

    // Verify listSkills was actually called
    expect(listSkillsSpy).toHaveBeenCalledTimes(1);

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
    listSkillsSpy.mockResolvedValueOnce([differentSkill]);

    const result2 = await collectAvailableSkillEntries(sm, cfg);

    // After invalidation, the new result should reflect the changed data.
    expect(result2).not.toBe(result1);
    expect(result2.availableSkills).toHaveLength(1);
    expect(result2.availableSkills[0].name).toBe('k8s-skill');
    expect(result2.entries).toHaveLength(1);
    expect(result2.entries[0].name).toBe('k8s-skill');
  });
});
