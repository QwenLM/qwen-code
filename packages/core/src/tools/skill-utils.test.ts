/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applySkillAllowedTools,
  collectAvailableSkillEntries,
  clearCollectedSkillEntriesCache,
  syncSkillEvictions,
  clearLoadedSkillTracking,
} from './skill-utils.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';

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

describe('collectAvailableSkillEntries memoize cache', () => {
  function mockSkillManager(): SkillManager {
    return {
      listSkills: vi.fn().mockResolvedValue([]),
      isSkillActive: vi.fn().mockReturnValue(false),
    } as unknown as SkillManager;
  }

  function mockConfig(): Config {
    return {
      getDisabledSkillNames: vi.fn().mockReturnValue(new Set<string>()),
      getModelInvocableCommandsProvider: vi.fn().mockReturnValue(null),
    } as unknown as Config;
  }

  afterEach(() => {
    clearCollectedSkillEntriesCache();
    vi.useRealTimers();
  });

  it('returns the same promise on cache hit within TTL', async () => {
    vi.useFakeTimers();
    const sm = mockSkillManager();
    const cfg = mockConfig();

    const r1 = collectAvailableSkillEntries(sm, cfg);
    const r2 = collectAvailableSkillEntries(sm, cfg);

    // The underlying scan should run only once.
    expect(sm.listSkills).toHaveBeenCalledTimes(1);
    // Both calls resolve to the exact same result object.
    const [v1, v2] = await Promise.all([r1, r2]);
    expect(v1).toBe(v2);
  });

  it('rescans after TTL expires', async () => {
    vi.useFakeTimers();
    const sm = mockSkillManager();
    const cfg = mockConfig();

    await collectAvailableSkillEntries(sm, cfg);
    vi.advanceTimersByTime(2001);
    await collectAvailableSkillEntries(sm, cfg);

    expect(sm.listSkills).toHaveBeenCalledTimes(2);
  });

  it('evicts cache entry on rejection so next caller retries', async () => {
    vi.useFakeTimers();
    const sm = mockSkillManager();
    const cfg = mockConfig();

    (sm.listSkills as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    const p1 = collectAvailableSkillEntries(sm, cfg);
    await expect(p1).rejects.toThrow('boom');

    // Flush microtask queue so the .catch() eviction handler runs.
    await vi.runAllTimersAsync();

    const p2 = collectAvailableSkillEntries(sm, cfg);
    await expect(p2).resolves.toBeDefined();
    expect(sm.listSkills).toHaveBeenCalledTimes(2);
  });

  it('clearCollectedSkillEntriesCache evicts the entry', async () => {
    vi.useFakeTimers();
    const sm = mockSkillManager();
    const cfg = mockConfig();

    await collectAvailableSkillEntries(sm, cfg);
    clearCollectedSkillEntriesCache(sm);
    await collectAvailableSkillEntries(sm, cfg);

    expect(sm.listSkills).toHaveBeenCalledTimes(2);
  });
});

describe('syncSkillEvictions / clearLoadedSkillTracking', () => {
  function mockRegistry(tool: unknown): {
    registry: ToolRegistry;
    getTool: ReturnType<typeof vi.fn>;
  } {
    const getTool = vi.fn().mockReturnValue(tool);
    return { registry: { getTool } as unknown as ToolRegistry, getTool };
  }

  function mockSkillTool(): {
    tool: unknown;
    unloadSkills: ReturnType<typeof vi.fn>;
    clearLoadedSkills: ReturnType<typeof vi.fn>;
    trackSkills: ReturnType<typeof vi.fn>;
  } {
    const unloadSkills = vi.fn();
    const clearLoadedSkills = vi.fn();
    const trackSkills = vi.fn();
    return {
      tool: { unloadSkills, clearLoadedSkills, trackSkills },
      unloadSkills,
      clearLoadedSkills,
      trackSkills,
    };
  }

  it('un-tracks the reported names when all evictions resolved', () => {
    const { tool, unloadSkills, clearLoadedSkills } = mockSkillTool();
    const { registry } = mockRegistry(tool);

    syncSkillEvictions(
      { evictedSkillNames: ['a', 'b'], unresolvedEvictedSkills: 0 },
      registry,
      'test',
    );

    expect(unloadSkills).toHaveBeenCalledWith(['a', 'b']);
    expect(clearLoadedSkills).not.toHaveBeenCalled();
  });

  it('blanket-clears when any eviction is unresolved', () => {
    const { tool, unloadSkills, clearLoadedSkills } = mockSkillTool();
    const { registry } = mockRegistry(tool);

    syncSkillEvictions(
      { evictedSkillNames: ['a'], unresolvedEvictedSkills: 1 },
      registry,
      'test',
    );

    expect(clearLoadedSkills).toHaveBeenCalledOnce();
    expect(unloadSkills).not.toHaveBeenCalled();
  });

  it('is a NOOP when nothing was evicted', () => {
    const { tool, unloadSkills, clearLoadedSkills } = mockSkillTool();
    const { registry, getTool } = mockRegistry(tool);

    syncSkillEvictions(
      { evictedSkillNames: [], unresolvedEvictedSkills: 0 },
      registry,
      'test',
    );

    expect(getTool).not.toHaveBeenCalled();
    expect(unloadSkills).not.toHaveBeenCalled();
    expect(clearLoadedSkills).not.toHaveBeenCalled();
  });

  it('tolerates a missing registry or skill tool', () => {
    expect(() =>
      syncSkillEvictions(
        { evictedSkillNames: ['a'], unresolvedEvictedSkills: 0 },
        undefined,
        'test',
      ),
    ).not.toThrow();
    const { registry } = mockRegistry(undefined);
    expect(() =>
      syncSkillEvictions(
        { evictedSkillNames: ['a'], unresolvedEvictedSkills: 0 },
        registry,
        'test',
      ),
    ).not.toThrow();
  });

  it('clearLoadedSkillTracking blanket-clears via the registry', () => {
    const { tool, clearLoadedSkills } = mockSkillTool();
    const { registry } = mockRegistry(tool);

    clearLoadedSkillTracking(registry, 'test');

    expect(clearLoadedSkills).toHaveBeenCalledOnce();
  });
});
