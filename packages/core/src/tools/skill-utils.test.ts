/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applySkillAllowedTools,
  applySkillSideEffects,
  canApplySkillSideEffects,
  collectAvailableSkillEntries,
  clearCollectedSkillEntriesCache,
  clearLoadedSkillTracking,
} from './skill-utils.js';
import { ToolNames } from './tool-names.js';
import type { ToolRegistry } from './tool-registry.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SkillConfig } from '../skills/types.js';
import type { Config } from '../config/config.js';

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
  it("marks the grants trust-gated when told to — a project skill's rules apply only while the folder is trusted", () => {
    const addSessionAllowRule = vi.fn();
    applySkillAllowedTools(
      { addSessionAllowRule } as unknown as PermissionManager,
      ['Bash(git *)'],
      { trustGated: true },
    );
    expect(addSessionAllowRule).toHaveBeenCalledWith('Bash(git *)', {
      trustGated: true,
    });
  });

  it('adds one session allow rule per entry, verbatim and in order', () => {
    const { pm, addSessionAllowRule } = mockPermissionManager();

    applySkillAllowedTools(pm, ['Bash(git *)', 'Edit', 'mcp__server__tool']);

    expect(addSessionAllowRule).toHaveBeenCalledTimes(3);
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(1, 'Bash(git *)', {
      trustGated: false,
    });
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(2, 'Edit', {
      trustGated: false,
    });
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(
      3,
      'mcp__server__tool',
      {
        trustGated: false,
      },
    );
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
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(1, 'Bash(unbalanced', {
      trustGated: false,
    });
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(2, 'Read', {
      trustGated: false,
    });
  });
});

describe('canApplySkillSideEffects', () => {
  const trusted = { isTrustedFolder: () => true };
  const untrusted = { isTrustedFolder: () => false };

  it('gates project skills on folder trust', () => {
    expect(canApplySkillSideEffects({ level: 'project' }, trusted)).toBe(true);
    expect(canApplySkillSideEffects({ level: 'project' }, untrusted)).toBe(
      false,
    );
  });

  it.each(['user', 'extension', 'bundled'] as const)(
    'never gates %s skills, which are not repo-controlled',
    (level) => {
      expect(canApplySkillSideEffects({ level }, untrusted)).toBe(true);
    },
  );
});

describe('applySkillSideEffects', () => {
  const gatedSkill = {
    name: 'gated-skill',
    description: 'Gated',
    level: 'user',
    filePath: '/skills/gated-skill/SKILL.md',
    skillRoot: '/skills/gated-skill',
    body: 'Body.',
    allowedTools: ['Edit'],
    hooks: {
      PreToolUse: [
        {
          matcher: 'Shell',
          hooks: [{ type: 'command', command: './gate.sh' }],
        },
      ],
    },
  } as unknown as SkillConfig;

  function makeConfig(
    overrides: Partial<{
      getHookSystem: () => unknown;
      getSessionId: () => string | undefined;
    }> = {},
  ) {
    const { pm, addSessionAllowRule } = mockPermissionManager();
    const addSessionHook = vi.fn();
    const config = {
      isTrustedFolder: () => true,
      getPermissionManager: () => pm,
      getSessionId: () => 'session-1',
      getHookSystem: () => ({
        getSessionHooksManager: () => ({
          addSessionHook,
          getHooksForEvent: () => [],
        }),
      }),
      ...overrides,
    } as unknown as Config;
    return { config, addSessionAllowRule, addSessionHook };
  }

  it('applies both allowedTools and hooks', () => {
    const { config, addSessionAllowRule, addSessionHook } = makeConfig();
    applySkillSideEffects(config, gatedSkill);
    expect(addSessionAllowRule).toHaveBeenCalledWith('Edit', {
      trustGated: false,
    });
    expect(addSessionHook).toHaveBeenCalledTimes(1);
  });

  // Hooks can be disabled session-wide (`disableAllHooks`, safe mode, bare
  // mode, the ACP agent's `skipHooks`), so no hook system is built. Dropping
  // the guard would call getSessionHooksManager() on undefined and crash every
  // skill invocation in those sessions.
  it('registers nothing and does not throw when there is no hook system', () => {
    const { config, addSessionAllowRule, addSessionHook } = makeConfig({
      getHookSystem: () => undefined,
    });
    expect(() => applySkillSideEffects(config, gatedSkill)).not.toThrow();
    expect(addSessionHook).not.toHaveBeenCalled();
    // The allowedTools half still applies — only the hooks are skipped.
    expect(addSessionAllowRule).toHaveBeenCalledWith('Edit', {
      trustGated: false,
    });
  });

  it('registers nothing and does not throw when there is no session id', () => {
    const { config, addSessionHook } = makeConfig({
      getSessionId: () => undefined,
    });
    expect(() => applySkillSideEffects(config, gatedSkill)).not.toThrow();
    expect(addSessionHook).not.toHaveBeenCalled();
  });

  it('applies neither for a project skill in an untrusted folder', () => {
    const { config, addSessionAllowRule, addSessionHook } = makeConfig();
    const projectSkill = {
      ...gatedSkill,
      level: 'project',
    } as unknown as SkillConfig;
    applySkillSideEffects(
      { ...config, isTrustedFolder: () => false } as unknown as Config,
      projectSkill,
    );
    expect(addSessionAllowRule).not.toHaveBeenCalled();
    expect(addSessionHook).not.toHaveBeenCalled();
  });

  it('is a no-op without a config', () => {
    expect(() => applySkillSideEffects(null, gatedSkill)).not.toThrow();
    expect(() => applySkillSideEffects(undefined, gatedSkill)).not.toThrow();
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
      isSkillEnabled: vi.fn().mockReturnValue(true),
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

describe('clearLoadedSkillTracking', () => {
  it('clears the SkillTool tracker when one is registered', () => {
    const clearLoadedSkills = vi.fn();
    const registry = {
      getTool: vi.fn().mockReturnValue({ clearLoadedSkills }),
    } as unknown as ToolRegistry;

    clearLoadedSkillTracking(registry, 'test-boundary');

    expect(registry.getTool).toHaveBeenCalledWith(ToolNames.SKILL);
    expect(clearLoadedSkills).toHaveBeenCalledTimes(1);
  });

  it('no-ops when the registry or tracker is missing', () => {
    expect(() =>
      clearLoadedSkillTracking(undefined, 'test-boundary'),
    ).not.toThrow();

    const registry = {
      getTool: vi.fn().mockReturnValue(undefined),
    } as unknown as ToolRegistry;
    expect(() =>
      clearLoadedSkillTracking(registry, 'test-boundary'),
    ).not.toThrow();
  });
});
