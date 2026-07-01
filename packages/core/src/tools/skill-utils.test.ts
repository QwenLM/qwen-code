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
  function createMockSkillManager() {
    return {
      listSkills: vi.fn().mockResolvedValue([]),
      isSkillActive: vi.fn().mockReturnValue(true),
    };
  }

  function createMockConfig() {
    return {
      get: () => undefined,
      on: () => {},
      getPreventSystemSleepEnabled: () => false,
      getDisabledSkillNames: vi.fn().mockReturnValue(new Set<string>()),
      getModelInvocableCommandsProvider: vi.fn().mockReturnValue(undefined),
    };
  }

  // Reset module-level cache before each test so tests are isolated.
  beforeEach(async () => {
    invalidateCollectedSkillEntriesCache();
    const sm = createMockSkillManager();
    const cfg = createMockConfig();
    // Prime the cache so beforeEach leaves a clean known state.
    await collectAvailableSkillEntries(sm, cfg);
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
});
