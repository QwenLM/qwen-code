/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./discoverSkillDirs.js', () => ({
  discoverSkillDirsForPaths: vi.fn().mockResolvedValue([]),
}));

vi.mock('@qwen-code/resource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/resource')>()),
  loadSkillsFromDir: vi.fn().mockResolvedValue([
    {
      name: 'dynamic-skill',
      description: 'dynamic skill',
      location: '/app/packages/.agents/skills/dynamic-skill/SKILL.md',
      body: 'body',
    },
  ]),
}));

import { discoverSkillDirsForPaths } from './discoverSkillDirs.js';
import { discoverAndRegisterDynamicSkills } from './dynamicSkillDiscovery.js';
import { loadSkillsFromDir } from '@qwen-code/resource';
import type { SkillManager } from './skillManager.js';

describe('discoverAndRegisterDynamicSkills', () => {
  let skillManager: Pick<
    SkillManager,
    'hasDynamicSkillDir' | 'addDynamicSkills'
  >;

  beforeEach(() => {
    vi.clearAllMocks();
    skillManager = {
      hasDynamicSkillDir: vi.fn().mockReturnValue(false),
      addDynamicSkills: vi.fn(),
    };
  });

  // 迟到的 Skill 内容不得注册，且取消后仍可重新发现该目录。
  it('does not register late skills or retain cancelled directory checks', async () => {
    const directory = '/app/src/.qwen/skills';
    let finish!: () => void;
    let started!: () => void;
    const loading = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(discoverSkillDirsForPaths).mockImplementationOnce(
      async (_paths, _cwd, options) => {
        options?.checkedDirs?.add(directory);
        return [directory];
      },
    );
    vi.mocked(loadSkillsFromDir).mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return [
        {
          name: 'late',
          description: 'late',
          skillRoot: directory,
          location: directory + '/SKILL.md',
          body: 'late',
        },
      ];
    });
    const parent = new AbortController();
    const reason = new Error('Read cancelled');
    const pending = discoverAndRegisterDynamicSkills({
      accessedPaths: ['/app/src/file.ts'],
      cwd: '/app',
      skillManager,
      signal: parent.signal,
    });
    const outcome = pending.then(() => undefined, (error: unknown) => error);
    await loading;
    parent.abort(reason);
    finish();
    expect(await outcome).toBe(reason);
    expect(skillManager.addDynamicSkills).not.toHaveBeenCalled();
    await discoverAndRegisterDynamicSkills({
      accessedPaths: ['/app/src/file.ts'],
      cwd: '/app',
      skillManager,
    });
    const lastOptions = vi
      .mocked(discoverSkillDirsForPaths)
      .mock.calls.at(-1)?.[2];
    expect(lastOptions?.checkedDirs?.has(directory)).toBe(false);
  });

  it('passes the compatibility switch to skill directory discovery', async () => {
    await discoverAndRegisterDynamicSkills({
      accessedPaths: ['/app/src/file.ts'],
      cwd: '/app',
      loadFromAgentsDirectory: true,
      skillManager,
    });

    expect(discoverSkillDirsForPaths).toHaveBeenCalledWith(
      ['/app/src/file.ts'],
      '/app',
      expect.objectContaining({ loadFromAgentsDirectory: true }),
    );
  });

  it('loads new directories and registers depth and source metadata', async () => {
    vi.mocked(discoverSkillDirsForPaths).mockResolvedValueOnce([
      '/app/packages/frontend/.agents/skills',
      '/app/packages/frontend/.qwen/skills',
    ]);

    const changed = await discoverAndRegisterDynamicSkills({
      accessedPaths: ['/app/packages/frontend/src/file.ts'],
      cwd: '/app',
      loadFromAgentsDirectory: true,
      skillManager,
    });

    expect(changed).toBe(true);
    expect(loadSkillsFromDir).toHaveBeenCalledTimes(2);
    expect(skillManager.addDynamicSkills).toHaveBeenCalledWith(
      '/app/packages/frontend/.agents/skills',
      expect.any(Array),
      { ancestorDepth: 2, source: 'legacy-agents' },
    );
    expect(skillManager.addDynamicSkills).toHaveBeenCalledWith(
      '/app/packages/frontend/.qwen/skills',
      expect.any(Array),
      { ancestorDepth: 2, source: 'configured' },
    );
  });

  it('does not reload a directory already registered as dynamic', async () => {
    vi.mocked(discoverSkillDirsForPaths).mockResolvedValueOnce([
      '/app/packages/frontend/.qwen/skills',
    ]);
    vi.mocked(skillManager.hasDynamicSkillDir).mockReturnValue(true);

    const changed = await discoverAndRegisterDynamicSkills({
      accessedPaths: ['/app/packages/frontend/src/file.ts'],
      cwd: '/app',
      skillManager,
    });

    expect(changed).toBe(false);
    expect(loadSkillsFromDir).not.toHaveBeenCalled();
    expect(skillManager.addDynamicSkills).not.toHaveBeenCalled();
  });

  it('does not register a directory that loads no skills', async () => {
    vi.mocked(discoverSkillDirsForPaths).mockResolvedValueOnce([
      '/app/packages/frontend/.qwen/skills',
    ]);
    vi.mocked(loadSkillsFromDir).mockResolvedValueOnce([]);

    const changed = await discoverAndRegisterDynamicSkills({
      accessedPaths: ['/app/packages/frontend/src/file.ts'],
      cwd: '/app',
      skillManager,
    });

    expect(changed).toBe(false);
    expect(skillManager.addDynamicSkills).not.toHaveBeenCalled();
  });
});
