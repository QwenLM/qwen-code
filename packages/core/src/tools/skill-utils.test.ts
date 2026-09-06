/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const debugLoggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  isEnabled: () => true,
}));
vi.mock('../utils/debugLogger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/debugLogger.js')>()),
  createDebugLogger: () => debugLoggerSpies,
}));
import {
  applySkillAllowedTools,
  applySkillHooks,
  applySkillSideEffects,
  canApplySkillSideEffects,
  collectAvailableSkillEntries,
  clearCollectedSkillEntriesCache,
  clearLoadedSkillTracking,
} from './skill-utils.js';
import { HookEventName, HookType } from '../hooks/types.js';
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

describe('applySkillHooks', () => {
  function mockHookSystem(): {
    config: Config;
    addSessionHook: ReturnType<typeof vi.fn>;
    getHooksForEvent: ReturnType<typeof vi.fn>;
  } {
    const byEvent = new Map<
      string,
      Array<{ matcher: string; skillRoot?: string; config: unknown }>
    >();
    const addSessionHook = vi.fn(
      (
        _sessionId: string,
        event: string,
        matcher: string,
        hook: unknown,
        options?: { skillRoot?: string },
      ) => {
        const list = byEvent.get(event) ?? [];
        list.push({ matcher, skillRoot: options?.skillRoot, config: hook });
        byEvent.set(event, list);
      },
    );
    const getHooksForEvent = vi.fn(
      (_sessionId: string, event: string) => byEvent.get(event) ?? [],
    );
    const sessionHooksManager = { addSessionHook, getHooksForEvent };
    const config = {
      getHookSystem: () => ({
        getSessionHooksManager: () => sessionHooksManager,
      }),
      getSessionId: () => 'session-1',
    } as unknown as Config;
    return { config, addSessionHook, getHooksForEvent };
  }

  function gatedSkill(): SkillConfig {
    return {
      name: 'gated-skill',
      description: 'Runs shell work behind a gate',
      level: 'project',
      filePath: '/repo/.qwen/skills/gated-skill/SKILL.md',
      skillRoot: '/repo/.qwen/skills/gated-skill',
      body: 'Do the gated work.',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Shell',
            hooks: [
              {
                type: HookType.Command,
                command: '$QWEN_SKILL_ROOT/scripts/gate.sh',
              },
            ],
          },
        ],
      },
    };
  }

  it('registers frontmatter hooks as session hooks and injects QWEN_SKILL_ROOT into the command env', () => {
    const { config, addSessionHook } = mockHookSystem();
    const skill = gatedSkill();

    const registered = applySkillHooks(config, skill);

    expect(registered).toBe(1);
    expect(addSessionHook).toHaveBeenCalledWith(
      'session-1',
      HookEventName.PreToolUse,
      'Shell',
      expect.objectContaining({
        type: HookType.Command,
        command: '$QWEN_SKILL_ROOT/scripts/gate.sh',
        env: { QWEN_SKILL_ROOT: '/repo/.qwen/skills/gated-skill' },
      }),
      { skillRoot: '/repo/.qwen/skills/gated-skill', trustGated: true },
    );
  });

  it('dedups across repeated applications so re-invocations never double-fire', () => {
    const { config, addSessionHook } = mockHookSystem();
    const skill = gatedSkill();

    expect(applySkillHooks(config, skill)).toBe(1);
    expect(applySkillHooks(config, skill)).toBe(0);
    expect(addSessionHook).toHaveBeenCalledTimes(1);
  });

  it('returns 0 for a configless caller or a hookless skill', () => {
    const { config } = mockHookSystem();
    expect(applySkillHooks(null, gatedSkill())).toBe(0);
    expect(applySkillHooks(undefined, gatedSkill())).toBe(0);
    expect(applySkillHooks(config, { ...gatedSkill(), hooks: undefined })).toBe(
      0,
    );
  });

  it('no-ops when the hook system or session id is unavailable', () => {
    const noHookSystem = {
      getHookSystem: () => undefined,
      getSessionId: () => 'session-1',
    } as unknown as Config;
    const noSessionId = {
      getHookSystem: () => ({}),
      getSessionId: () => '',
    } as unknown as Config;

    expect(applySkillHooks(noHookSystem, gatedSkill())).toBe(0);
    expect(applySkillHooks(noSessionId, gatedSkill())).toBe(0);
  });

  function promptHookSkill(): SkillConfig {
    return {
      ...gatedSkill(),
      hooks: {
        PreToolUse: gatedSkill().hooks!.PreToolUse,
        UserPromptSubmit: [
          {
            hooks: [{ type: HookType.Command, command: 'submit-guard.sh' }],
          },
        ],
        UserPromptExpansion: [
          {
            matcher: 'gated-skill',
            hooks: [{ type: HookType.Command, command: 'expand-guard.sh' }],
          },
        ],
      },
    };
  }

  it('registers prompt-lifecycle events by default (model Skill-tool path)', () => {
    const { config, addSessionHook } = mockHookSystem();

    expect(applySkillHooks(config, promptHookSkill())).toBe(3);
    expect(addSessionHook).toHaveBeenCalledWith(
      'session-1',
      HookEventName.UserPromptSubmit,
      expect.any(String),
      expect.anything(),
      expect.anything(),
    );
    expect(addSessionHook).toHaveBeenCalledWith(
      'session-1',
      HookEventName.UserPromptExpansion,
      expect.any(String),
      expect.anything(),
      expect.anything(),
    );
  });

  it('excludePromptLifecycleEvents skips UserPromptSubmit/UserPromptExpansion but keeps tool gates', () => {
    // The slash-command startup option (PR #11153 R1-1): registering
    // prompt-lifecycle hooks from inside a /<skill-name> action lets the
    // skill's own hook fire on — and block — the submission carrying its
    // body. Only the tool-lifecycle gate may register there.
    const { config, addSessionHook } = mockHookSystem();

    expect(
      applySkillHooks(config, promptHookSkill(), {
        excludePromptLifecycleEvents: true,
      }),
    ).toBe(1);
    expect(addSessionHook).toHaveBeenCalledTimes(1);
    expect(addSessionHook).toHaveBeenCalledWith(
      'session-1',
      HookEventName.PreToolUse,
      'Shell',
      expect.anything(),
      expect.anything(),
    );
  });

  it('excludePromptLifecycleEvents is a plain pass-through for skills without prompt hooks', () => {
    const { config, addSessionHook } = mockHookSystem();

    expect(
      applySkillHooks(config, gatedSkill(), {
        excludePromptLifecycleEvents: true,
      }),
    ).toBe(1);
    expect(addSessionHook).toHaveBeenCalledTimes(1);
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
  beforeEach(() => {
    // Module-scoped spies: without clearing, each case sees the previous
    // case's log calls and both the positive and negative assertions below
    // stop meaning anything.
    debugLoggerSpies.warn.mockClear();
    debugLoggerSpies.debug.mockClear();
  });

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
    // Pinned at `warn`: a promised gate is being dropped, and at `debug` the
    // only trace of that would sit below the level anyone reads.
    expect(debugLoggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping hook registration for skill'),
    );
    expect(debugLoggerSpies.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('Skipping hook registration for skill'),
    );
  });

  // Pins `applySkillHooks`'s `if (!skill.hooks) return;`. That early return is
  // what lets the no-hook-system branch below it be a `warn`: it fires only
  // for a skill that actually declares a gate. Without it, every hookless
  // skill invoked in a hooks-disabled session emits a warning, which is the
  // steady-state noise the level was chosen to avoid.
  it('stays silent for a skill that declares no hooks, even with no hook system', () => {
    const { config, addSessionAllowRule } = makeConfig({
      getHookSystem: () => undefined,
    });
    const hookless = { ...gatedSkill, hooks: undefined } as SkillConfig;

    applySkillSideEffects(config, hookless);

    expect(debugLoggerSpies.warn).not.toHaveBeenCalled();
    // The allowedTools half is unaffected by the hooks early return.
    expect(addSessionAllowRule).toHaveBeenCalledWith('Edit', {
      trustGated: false,
    });
  });

  it('stays silent for a skill whose hooks block parses to nothing', () => {
    const { config, addSessionAllowRule } = makeConfig({
      getHookSystem: () => undefined,
    });
    // `parseSkillContent` assigns `{}` for an explicit `hooks: {}` and for a
    // block whose event names are all unknown, and `{}` is truthy — so this
    // is the shape a `!skill.hooks` guard alone lets through.
    const emptyHooks = { ...gatedSkill, hooks: {} } as SkillConfig;

    applySkillSideEffects(config, emptyHooks);

    expect(debugLoggerSpies.warn).not.toHaveBeenCalled();
    expect(addSessionAllowRule).toHaveBeenCalledWith('Edit', {
      trustGated: false,
    });
  });

  it('registers nothing and does not throw when there is no session id', () => {
    const { config, addSessionAllowRule, addSessionHook } = makeConfig({
      getSessionId: () => undefined,
    });
    expect(() => applySkillSideEffects(config, gatedSkill)).not.toThrow();
    expect(addSessionHook).not.toHaveBeenCalled();
    // Same asymmetry as the no-hook-system case: only the hooks half is
    // skipped. Without this, hoisting the session-id guard above
    // `applySkillAllowedTools` would ship untested.
    expect(addSessionAllowRule).toHaveBeenCalledWith('Edit', {
      trustGated: false,
    });
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

  it('warns for a project skill in an untrusted folder that declares only hooks', () => {
    const { config, addSessionAllowRule, addSessionHook } = makeConfig();
    // The sibling test above uses a skill carrying both halves, so it passes
    // on the `allowedTools` operand alone. This one pins the `|| skill.hooks`
    // half: a skill whose only side effect is a gate must still say so.
    const hooksOnly = {
      ...gatedSkill,
      level: 'project',
      allowedTools: undefined,
    } as unknown as SkillConfig;

    applySkillSideEffects(
      { ...config, isTrustedFolder: () => false } as unknown as Config,
      hooksOnly,
    );

    expect(addSessionAllowRule).not.toHaveBeenCalled();
    expect(addSessionHook).not.toHaveBeenCalled();
    expect(debugLoggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('untrusted folder'),
    );
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
