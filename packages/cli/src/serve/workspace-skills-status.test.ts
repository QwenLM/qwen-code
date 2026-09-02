/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
}));

import { SkillManager } from '@qwen-code/qwen-code-core';
import {
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  getUserSettingsPath,
} from '../config/settings.js';
import { createWorkspaceSkillsStatusProvider } from './workspace-skills-status.js';

describe('createWorkspaceSkillsStatusProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockWriteStderrLine.mockClear();
  });

  it('enumerates bundled skills (including /review) without an ACP child', async () => {
    const provider = createWorkspaceSkillsStatusProvider();

    const status = await provider(process.cwd());

    expect(status.initialized).toBe(true);
    const review = status.skills.find((skill) => skill.name === 'review');
    expect(review).toBeDefined();
    expect(review?.kind).toBe('skill');
    expect(review?.level).toBe('bundled');
    // Skill-tool listing exposes the model-invocable flag; bundled /review is
    // invocable, and the argument hint drives the slash-command autocomplete.
    expect(review?.modelInvocable).toBe(true);
    expect(review?.argumentHint).toBeTruthy();
  });

  it('reports the queried workspace path', async () => {
    const provider = createWorkspaceSkillsStatusProvider();

    const status = await provider('/some/workspace');

    expect(status.workspaceCwd).toBe('/some/workspace');
  });

  it('does not load workspace environment while enumerating Skills', async () => {
    const workspace = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skills-env-'),
    );
    const key = 'QWEN_SKILLS_STATUS_ENV_TEST';
    await fsp.writeFile(path.join(workspace, '.env'), `${key}=leaked\n`);
    delete process.env[key];

    await createWorkspaceSkillsStatusProvider()(workspace);

    expect(process.env[key]).toBeUndefined();
  });

  it('returns a non-initialized error status (and logs) when enumeration fails', async () => {
    vi.spyOn(SkillManager.prototype, 'listSkills').mockRejectedValueOnce(
      new Error('boom'),
    );
    const provider = createWorkspaceSkillsStatusProvider();

    const status = await provider('/ws');

    expect(status.initialized).toBe(false);
    expect(status.skills).toEqual([]);
    expect(status.workspaceCwd).toBe('/ws');
    expect(status.errors).toEqual([
      { kind: 'skills', status: 'error', error: 'boom' },
    ]);
    // Non-fatal failures are logged to the daemon's stderr.
    expect(mockWriteStderrLine).toHaveBeenCalledTimes(1);
    expect(mockWriteStderrLine.mock.calls[0][0]).toContain('boom');
  });

  it('marks skills disabled in workspace settings', async () => {
    vi.spyOn(SkillManager.prototype, 'listSkills').mockResolvedValueOnce([
      {
        name: 'enabled',
        description: 'Enabled skill',
        body: 'Visible',
        filePath: '/skills/enabled/SKILL.md',
        level: 'project',
      },
      {
        name: 'disabled',
        description: 'Disabled skill',
        body: 'Hidden',
        filePath: '/skills/disabled/SKILL.md',
        level: 'project',
      },
    ]);
    const workspace = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skills-disabled-'),
    );
    await fsp.mkdir(path.join(workspace, '.qwen'), { recursive: true });
    await fsp.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        skills: {
          defaultDisabled: ['disabled', 'enabled'],
          enabled: ['ENABLED'],
        },
      }),
    );
    const provider = createWorkspaceSkillsStatusProvider();

    const status = await provider(workspace);

    expect(status.skills).toMatchObject([
      {
        name: 'enabled',
        status: 'ok',
        installedPath: '/skills/enabled/SKILL.md',
      },
      {
        name: 'disabled',
        status: 'disabled',
        disabledReason: 'default',
        installedPath: '/skills/disabled/SKILL.md',
      },
    ]);
  });

  it('marks hard-disabled skills with a hard disable reason', async () => {
    vi.spyOn(SkillManager.prototype, 'listSkills').mockResolvedValueOnce([
      {
        name: 'enabled',
        description: 'Enabled skill',
        body: 'Visible',
        filePath: '/skills/enabled/SKILL.md',
        level: 'project',
      },
      {
        name: 'disabled',
        description: 'Disabled skill',
        body: 'Hidden',
        filePath: '/skills/disabled/SKILL.md',
        level: 'project',
      },
    ]);
    const workspace = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skills-hard-disabled-'),
    );
    await fsp.mkdir(path.join(workspace, '.qwen'), { recursive: true });
    await fsp.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        skills: {
          disabled: ['disabled'],
        },
      }),
    );
    const provider = createWorkspaceSkillsStatusProvider();

    const status = await provider(workspace);

    expect(status.skills).toMatchObject([
      {
        name: 'enabled',
        status: 'ok',
        installedPath: '/skills/enabled/SKILL.md',
      },
      {
        name: 'disabled',
        status: 'disabled',
        disabledReason: 'hard',
        installedPath: '/skills/disabled/SKILL.md',
      },
    ]);
    // A workspace-scope hard disable is not locked by a higher scope.
    const hardDisabled = status.skills.find((s) => s.name === 'disabled');
    expect(hardDisabled?.lockedScope).toBeUndefined();
  });

  it('resolves disablements in safe mode (status matches execution)', async () => {
    vi.spyOn(SkillManager.prototype, 'listSkills').mockResolvedValueOnce([
      {
        name: 'available',
        description: 'Available skill',
        body: 'Visible',
        filePath: '/skills/available/SKILL.md',
        level: 'bundled',
      },
      {
        name: 'blocked',
        description: 'Blocked skill',
        body: 'Hidden',
        filePath: '/skills/blocked/SKILL.md',
        level: 'bundled',
      },
    ]);
    const workspace = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skills-safe-mode-'),
    );
    await fsp.mkdir(path.join(workspace, '.qwen'), { recursive: true });
    await fsp.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        skills: {
          disabled: ['blocked'],
        },
      }),
    );
    const saved = process.env['QWEN_CODE_SAFE_MODE'];
    process.env['QWEN_CODE_SAFE_MODE'] = '1';
    try {
      const provider = createWorkspaceSkillsStatusProvider();

      const status = await provider(workspace);

      expect(status.skills).toMatchObject([
        { name: 'available', status: 'ok' },
        { name: 'blocked', status: 'disabled', disabledReason: 'hard' },
      ]);
    } finally {
      if (saved === undefined) {
        delete process.env['QWEN_CODE_SAFE_MODE'];
      } else {
        process.env['QWEN_CODE_SAFE_MODE'] = saved;
      }
    }
  });

  it('does not read workspace-level disabled skills when untrusted', async () => {
    vi.spyOn(SkillManager.prototype, 'listSkills').mockResolvedValueOnce([
      {
        name: 'project-skill',
        description: 'Project skill',
        body: 'Visible only when trusted',
        filePath: '/skills/project-skill/SKILL.md',
        level: 'project',
      },
    ]);
    const workspace = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skills-untrusted-'),
    );
    await fsp.mkdir(path.join(workspace, '.qwen'), { recursive: true });
    await fsp.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({ skills: { disabled: ['project-skill'] } }),
    );
    const provider = createWorkspaceSkillsStatusProvider({
      workspaceTrusted: false,
    });

    const status = await provider(workspace);

    expect(status.skills[0]).toMatchObject({
      name: 'project-skill',
      status: 'ok',
    });
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  it('can inventory inert workspace Skill manifests without trusting settings', async () => {
    const workspace = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skills-untrusted-config-'),
    );
    const skillDir = path.join(workspace, '.qwen', 'skills', 'local-skill');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: local-skill\ndescription: Local Skill\n---\nInstructions',
    );
    const provider = createWorkspaceSkillsStatusProvider({
      workspaceTrusted: false,
      includeUntrustedSkills: true,
    });

    const status = await provider(workspace);

    expect(status.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'local-skill', level: 'project' }),
      ]),
    );
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  it('does not consume corruption recovery state while reading disabled skills', async () => {
    vi.spyOn(SkillManager.prototype, 'listSkills').mockResolvedValueOnce([]);
    const qwenHome = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skills-settings-'),
    );
    const previousQwenHome = process.env['QWEN_HOME'];
    const previousCorruptedPath = process.env[ENV_CORRUPTED_PATH];
    const previousWasRecovered = process.env[ENV_WAS_RECOVERED];
    try {
      process.env['QWEN_HOME'] = qwenHome;
      const userSettingsPath = getUserSettingsPath();
      await fsp.writeFile(userSettingsPath, '{}');
      process.env[ENV_CORRUPTED_PATH] = `${userSettingsPath}.corrupted`;
      process.env[ENV_WAS_RECOVERED] = '1';

      await createWorkspaceSkillsStatusProvider()('/ws');

      expect(process.env[ENV_CORRUPTED_PATH]).toBe(
        `${userSettingsPath}.corrupted`,
      );
      expect(process.env[ENV_WAS_RECOVERED]).toBe('1');
    } finally {
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
      if (previousCorruptedPath === undefined) {
        delete process.env[ENV_CORRUPTED_PATH];
      } else {
        process.env[ENV_CORRUPTED_PATH] = previousCorruptedPath;
      }
      if (previousWasRecovered === undefined) {
        delete process.env[ENV_WAS_RECOVERED];
      } else {
        process.env[ENV_WAS_RECOVERED] = previousWasRecovered;
      }
      await fsp.rm(qwenHome, { recursive: true, force: true });
    }
  });

  it('hides skills from disabled levels in workspace settings', async () => {
    // No listSkills mock: this exercises the real daemon wiring — the
    // settings.merged.skills?.disabledLevels read, VALID_SKILL_LEVELS
    // filtering, and the getDisabledSkillLevels shim method that the prior
    // daemon regression broke.
    const workspace = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skills-disabled-levels-'),
    );
    await fsp.mkdir(path.join(workspace, '.qwen'), { recursive: true });
    await fsp.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({ skills: { disabledLevels: ['bundled'] } }),
    );
    try {
      const provider = createWorkspaceSkillsStatusProvider();

      const status = await provider(workspace);

      expect(status.initialized).toBe(true);
      expect(status.skills.find((s) => s.level === 'bundled')).toBeUndefined();
      expect(status.skills.find((s) => s.name === 'review')).toBeUndefined();
    } finally {
      await fsp.rm(workspace, { recursive: true, force: true });
    }
  });

  it('ignores disabledLevels in safe mode (matches CLI child session)', async () => {
    const workspace = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skills-safe-levels-'),
    );
    await fsp.mkdir(path.join(workspace, '.qwen'), { recursive: true });
    await fsp.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({ skills: { disabledLevels: ['bundled'] } }),
    );
    const saved = process.env['QWEN_CODE_SAFE_MODE'];
    process.env['QWEN_CODE_SAFE_MODE'] = '1';
    try {
      const provider = createWorkspaceSkillsStatusProvider();

      const status = await provider(workspace);

      expect(status.initialized).toBe(true);
      expect(status.skills.find((s) => s.name === 'review')).toBeDefined();
    } finally {
      if (saved === undefined) {
        delete process.env['QWEN_CODE_SAFE_MODE'];
      } else {
        process.env['QWEN_CODE_SAFE_MODE'] = saved;
      }
      await fsp.rm(workspace, { recursive: true, force: true });
    }
  });

  it('reuses one SkillManager per workspace across calls', async () => {
    const listSpy = vi.spyOn(SkillManager.prototype, 'listSkills');
    const provider = createWorkspaceSkillsStatusProvider();

    await provider('/ws');
    await provider('/ws');

    // Memoized: the second query reuses the first SkillManager instance, so
    // listSkills is invoked on the same object rather than a freshly-scanned one.
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(listSpy.mock.instances[0]).toBe(listSpy.mock.instances[1]);
  });
});
