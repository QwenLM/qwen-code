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
  clearLoadedSkillTracking,
  isDisabledSkillName,
  skillSettingKeys,
} from './skill-utils.js';
import { ToolNames } from './tool-names.js';
import type { ToolRegistry } from './tool-registry.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type { SkillManager } from '../skills/skill-manager.js';
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

  it('hides a collision-renamed skill for a legacy bare disablement entry', async () => {
    const sm = mockSkillManager();
    (sm.isSkillActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (sm.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        name: 'rust:pdf',
        description: 'Extension pdf skill',
        level: 'extension',
        filePath: '/ext/rust/pdf/SKILL.md',
        body: '',
        extensionName: 'rust',
      },
    ]);
    const cfg = mockConfig();
    (cfg.getDisabledSkillNames as ReturnType<typeof vi.fn>).mockReturnValue(
      new Set(['pdf']),
    );

    const collected = await collectAvailableSkillEntries(sm, cfg);

    // The dual-spelling contract: a bare entry written before the rename
    // still hides the renamed skill from every model-facing surface.
    expect(collected.availableSkills).toEqual([]);
    expect(collected.pendingConditionalSkillNames.size).toBe(0);
    expect(collected.entries).toEqual([]);
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

describe('skill setting name matching', () => {
  it('derives the bare spelling from a collision-qualified name', () => {
    expect(
      skillSettingKeys({ name: 'rust:pdf', extensionName: 'rust' }),
    ).toEqual(['rust:pdf', 'pdf']);
  });

  it('passes unqualified names through as a single key, normalized', () => {
    expect(skillSettingKeys({ name: 'pdf' })).toEqual(['pdf']);
    expect(skillSettingKeys({ name: '  PDF ', extensionName: 'rust' })).toEqual(
      ['pdf'],
    );
  });

  it('keeps the full name when a different extension owns the prefix', () => {
    expect(
      skillSettingKeys({ name: 'other:pdf', extensionName: 'rust' }),
    ).toEqual(['other:pdf']);
  });

  it('isDisabledSkillName matches the literal and legacy bare spellings', () => {
    const disabled = new Set(['pdf']);
    expect(isDisabledSkillName('pdf', disabled, () => undefined)).toBe(true);
    expect(
      isDisabledSkillName('rust:pdf', disabled, (lowered) =>
        lowered === 'rust:pdf'
          ? { name: 'rust:pdf', extensionName: 'rust' }
          : undefined,
      ),
    ).toBe(true);
    expect(
      isDisabledSkillName('rust:pdf', new Set(['rust:pdf']), () => undefined),
    ).toBe(true);
    // Another extension's qualified spelling must not match a legacy
    // entry for a different owner.
    expect(
      isDisabledSkillName('other:pdf', new Set(['rust:pdf']), (lowered) =>
        lowered === 'other:pdf'
          ? { name: 'other:pdf', extensionName: 'other' }
          : undefined,
      ),
    ).toBe(false);
  });

  // ── Truth matrix: skillSettingKeys adversarial cells ──
  // Every name source × collision state × entry spelling combination.
  describe('skillSettingKeys truth matrix', () => {
    // name source × extensionName → expected keys
    const cases: Array<{
      name: string;
      extensionName: string | undefined;
      expected: string[];
      label: string;
    }> = [
      // Qualified name, matching owner → dual spelling
      {
        name: 'rust:pdf',
        extensionName: 'rust',
        expected: ['rust:pdf', 'pdf'],
        label: 'qualified name, matching owner',
      },
      // Qualified name, different owner → single key only
      {
        name: 'other:pdf',
        extensionName: 'rust',
        expected: ['other:pdf'],
        label: 'qualified name, different owner (no prefix ownership)',
      },
      // Qualified name, owner is empty string → treated as undefined
      {
        name: ':pdf',
        extensionName: '',
        expected: [':pdf'],
        label: 'colon-only name with empty extensionName',
      },
      // Bare name, no extension → single key
      {
        name: 'pdf',
        extensionName: undefined,
        expected: ['pdf'],
        label: 'bare name, no extension',
      },
      // Bare name with whitespace → normalized
      {
        name: '  PDF  ',
        extensionName: undefined,
        expected: ['pdf'],
        label: 'bare name with whitespace',
      },
      // Qualified name with whitespace → normalized
      {
        name: '  Rust:PDF  ',
        extensionName: ' Rust ',
        expected: ['rust:pdf', 'pdf'],
        label: 'qualified name with whitespace, normalized',
      },
      // Multiple colons — only the first colon separates owner from name
      {
        name: 'a:b:c',
        extensionName: 'a',
        expected: ['a:b:c', 'b:c'],
        label: 'multiple colons in qualified name',
      },
      // Qualified name where owner doesn't match prefix → single key
      {
        name: 'x:pdf',
        extensionName: 'rust',
        expected: ['x:pdf'],
        label: 'qualified name, owner mismatch with prefix',
      },
      // Suffixed qualified name — collision result
      {
        name: 'rust:pdf1',
        extensionName: 'rust',
        expected: ['rust:pdf1', 'pdf1'],
        label: 'suffixed qualified name',
      },
      // Empty name
      {
        name: '',
        extensionName: undefined,
        expected: [''],
        label: 'empty name',
      },
    ];

    it.each(cases)(
      'returns $expected for $label (name=$name, extensionName=$extensionName)',
      ({ name, extensionName, expected }) => {
        // Normalize whitespace like the real function does
        const trimmedName = name.trim();
        const trimmedOwner = extensionName?.trim();
        const result = skillSettingKeys({
          name: trimmedName,
          extensionName: trimmedOwner,
        });
        expect(result).toEqual(expected);
      },
    );
  });

  // Truth matrix: isDisabledSkillName adversarial cells
  // Every name source × collision state × entry spelling × operation.
  describe('isDisabledSkillName truth matrix', () => {
    it.each([
      // ── Direct match ──
      {
        rawName: 'pdf',
        disabled: new Set(['pdf']),
        findSkill: () => undefined,
        expected: true,
        label: 'direct bare match',
      },
      {
        rawName: 'rust:pdf',
        disabled: new Set(['rust:pdf']),
        findSkill: () => undefined,
        expected: true,
        label: 'direct qualified match',
      },

      // ── Legacy bare match via findSkill ──
      {
        rawName: 'rust:pdf',
        disabled: new Set(['pdf']),
        findSkill: (l: string) =>
          l === 'rust:pdf'
            ? { name: 'rust:pdf', extensionName: 'rust' }
            : undefined,
        expected: true,
        label: 'qualified name matched by legacy bare disablement',
      },
      {
        rawName: 'pdf',
        disabled: new Set(['pdf']),
        findSkill: () => undefined,
        expected: true,
        label: 'bare name matched by bare disablement',
      },

      // ── Qualified disablement matches qualified name ──
      {
        rawName: 'rust:pdf',
        disabled: new Set(['rust:pdf']),
        findSkill: () => undefined,
        expected: true,
        label: 'qualified name matched by qualified disablement',
      },

      // ── Owner mismatch ──
      {
        rawName: 'other:pdf',
        disabled: new Set(['pdf']),
        findSkill: (l: string) =>
          l === 'other:pdf'
            ? { name: 'other:pdf', extensionName: 'other' }
            : undefined,
        expected: true,
        label:
          'other-extension qualified name matches bare disablement via suffix',
      },
      {
        rawName: 'other:pdf',
        disabled: new Set(['rust:pdf']),
        findSkill: (l: string) =>
          l === 'other:pdf'
            ? { name: 'other:pdf', extensionName: 'other' }
            : undefined,
        expected: false,
        label:
          'other-extension qualified name must not match qualified disablement for different owner',
      },

      // ── No match ──
      {
        rawName: 'unknown',
        disabled: new Set(['pdf']),
        findSkill: () => undefined,
        expected: false,
        label: 'unknown name not in disablements',
      },
      {
        rawName: 'rust:pdf',
        disabled: new Set(['other']),
        findSkill: (l: string) =>
          l === 'rust:pdf'
            ? { name: 'rust:pdf', extensionName: 'rust' }
            : undefined,
        expected: false,
        label: 'qualified name not matched by unrelated disablement',
      },

      // ── Suffixed name (collision result) ──
      {
        rawName: 'rust:pdf1',
        disabled: new Set(['pdf']),
        findSkill: (l: string) =>
          l === 'rust:pdf1'
            ? { name: 'rust:pdf1', extensionName: 'rust' }
            : undefined,
        expected: false,
        label:
          'suffixed qualified name must not match bare disablement for base name',
      },
      {
        rawName: 'rust:pdf1',
        disabled: new Set(['pdf1']),
        findSkill: (l: string) =>
          l === 'rust:pdf1'
            ? { name: 'rust:pdf1', extensionName: 'rust' }
            : undefined,
        expected: true,
        label: 'suffixed qualified name matched by suffixed bare disablement',
      },

      // ── findSkill returns undefined ──
      {
        rawName: 'rust:pdf',
        disabled: new Set(['pdf']),
        findSkill: () => undefined,
        expected: false,
        label:
          'qualified name with no findSkill match and no direct disablement',
      },

      // ── Empty/whitespace ──
      {
        rawName: '  pdf  ',
        disabled: new Set(['pdf']),
        findSkill: () => undefined,
        expected: true,
        label: 'whitespace-normalized bare name',
      },
    ])('matches $label', ({ rawName, disabled, findSkill, expected }) => {
      expect(isDisabledSkillName(rawName, disabled, findSkill)).toBe(expected);
    });
  });
});
