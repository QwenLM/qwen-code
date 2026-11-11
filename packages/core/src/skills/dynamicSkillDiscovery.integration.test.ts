/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONFIG_DIR } from '../utils/paths.js';
import { discoverAndRegisterDynamicSkills } from './dynamicSkillDiscovery.js';
import { SkillManager } from './skillManager.js';
import type { Config } from '../config/config.js';
import { discoverJitContext } from '../tools/jit-context.js';

describe('discoverAndRegisterDynamicSkills (real filesystem)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jit-skill-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('exposes a subdirectory skill once a file in that package is touched', async () => {
    const packageDir = path.join(workspaceRoot, 'packages', 'frontend');
    const skillRoot = path.join(packageDir, CONFIG_DIR, 'skills', 'jit-demo');
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\ndescription: demo skill discovered just in time\n---\ndemo body\n',
    );

    const skillManager = new SkillManager();
    skillManager.setDisableBuiltinSkills(true);
    expect(skillManager.getDisplayableSkills()).toEqual([]);

    const changed = await discoverAndRegisterDynamicSkills({
      accessedPaths: [path.join(packageDir, 'src', 'file.ts')],
      cwd: workspaceRoot,
      skillManager,
    });

    expect(changed).toBe(true);
    // SkillCommandLoader builds the slash-command catalog from this list, so
    // membership here is what makes `/jit-demo` reachable after JIT discovery.
    expect(
      skillManager.getDisplayableSkills().map((skill) => skill.name),
    ).toContain('jit-demo');
  });

  it('loads shared project skills for concurrent worktrees and a rebuilt session', async () => {
    const originalCwd = path.join(workspaceRoot, 'original');
    const skillDir = path.join(originalCwd, 'pkg', CONFIG_DIR, 'skills', 'shared');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\ndescription: shared project skill\n---\noriginal body\n',
    );

    const loadSession = async (checkout: string) => {
      const worktreeCwd = path.join(workspaceRoot, checkout);
      const skillManager = new SkillManager();
      skillManager.setDisableBuiltinSkills(true);
      const config = {
        getMemoryContextManager: () => undefined,
        getTargetDir: () => worktreeCwd,
        getWorktreeSettings: () => ({
          originalCwd,
          path: worktreeCwd,
          worktreeCwd,
        }),
        isTrustedFolder: () => true,
        isAgentSourceAllowed: () => true,
        shouldLoadSkillsFromAgentsDirectory: () => false,
        getSkillManager: () => skillManager,
        notifySkillsChanged: vi.fn(),
      } as unknown as Config;
      await discoverJitContext(config, path.join(worktreeCwd, 'pkg', 'file.ts'));
      return skillManager
        .getModelVisibleSkills()
        .map(({ name, body }) => ({ name, body }));
    };

    const concurrent = await Promise.all([loadSession('a'), loadSession('b')]);
    const rebuilt = await loadSession('a');
    for (const skills of [...concurrent, rebuilt]) {
      expect(skills).toEqual([{ name: 'shared', body: 'original body' }]);
    }
  });

  it.each(['', 'apps/desktop'])(
    'loads JIT skills from the original project while executing in worktree subdirectory "%s"',
    async (projectSubdirectory) => {
      const originalCwd = path.join(
        workspaceRoot,
        'original',
        projectSubdirectory,
      );
      const worktreePath = path.join(workspaceRoot, 'checkout');
      const worktreeCwd = path.join(worktreePath, projectSubdirectory);
      for (const [cwd, body] of [
        [originalCwd, 'original skill'],
        [worktreeCwd, 'worktree skill'],
      ]) {
        const skillDir = path.join(
          cwd,
          'packages',
          'frontend',
          CONFIG_DIR,
          'skills',
          'jit-demo',
        );
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, 'SKILL.md'),
          `---\ndescription: scoped skill\npaths:\n  - "packages/frontend/**"\n---\n${body}\n`,
        );
      }
      const skillManager = new SkillManager();
      skillManager.setDisableBuiltinSkills(true);
      const config = {
        getMemoryContextManager: () => undefined,
        getTargetDir: () => worktreeCwd,
        getWorktreeSettings: () => ({
          originalCwd,
          path: worktreePath,
          worktreeCwd,
        }),
        isTrustedFolder: () => true,
        isAgentSourceAllowed: () => true,
        shouldLoadSkillsFromAgentsDirectory: () => false,
        getSkillManager: () => skillManager,
        notifySkillsChanged: vi.fn(),
      } as unknown as Config;

      await discoverJitContext(
        config,
        path.join(worktreeCwd, 'packages', 'frontend', 'file.ts'),
      );

      // 验证模型实际可见的内容与条件激活，避免仅断言发现器收到的路径。
      expect(skillManager.getModelVisibleSkills()).toEqual([
        expect.objectContaining({
          name: 'jit-demo',
          body: 'original skill',
          location: path.join(
            originalCwd,
            'packages',
            'frontend',
            CONFIG_DIR,
            'skills',
            'jit-demo',
            'SKILL.md',
          ),
        }),
      ]);
      expect(config.getTargetDir()).toBe(worktreeCwd);
    },
  );
});
