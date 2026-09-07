/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
}));

import {
  ExtensionManager,
  ExtensionStore,
  SkillManager,
} from '@qwen-code/qwen-code-core';
import {
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  getUserSettingsPath,
} from '../config/settings.js';
import { createWorkspaceSkillsStatusProvider } from './workspace-skills-status.js';

describe('createWorkspaceSkillsStatusProvider', () => {
  let qwenHome: string;
  beforeEach(async () => {
    qwenHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-catalog-home-'));
    vi.stubEnv('QWEN_HOME', qwenHome);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fsp.rm(qwenHome, { recursive: true, force: true });
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

  it('fails closed when a configured Skills directory cannot be read', async () => {
    const workspace = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skills-unreadable-'),
    );
    const notDirectory = path.join(workspace, 'not-a-directory');
    await fsp.writeFile(notDirectory, 'x');
    vi.spyOn(SkillManager.prototype, 'getSkillsBaseDirs').mockReturnValueOnce([
      notDirectory,
    ]);

    const status = await createWorkspaceSkillsStatusProvider()(workspace);

    expect(status.initialized).toBe(false);
    expect(status.skills).toEqual([]);
    expect(status.errors?.[0]?.status).toBe('error');
    await fsp.rm(workspace, { recursive: true, force: true });
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
        name: 'disabled',
        status: 'disabled',
        disabledReason: 'default',
        installedPath: '/skills/disabled/SKILL.md',
      },
      {
        name: 'enabled',
        status: 'ok',
        installedPath: '/skills/enabled/SKILL.md',
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
        name: 'disabled',
        status: 'disabled',
        disabledReason: 'hard',
        installedPath: '/skills/disabled/SKILL.md',
      },
      {
        name: 'enabled',
        status: 'ok',
        installedPath: '/skills/enabled/SKILL.md',
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

  async function writeExtension(
    name: string,
    skillNames: string[],
    skillStates: Record<string, boolean> = {},
  ) {
    const directory = path.join(qwenHome, 'extensions', name);
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(
      path.join(directory, 'qwen-extension.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        displayName: `${name} display`,
        skillStates,
        mcpServers: { sentinel: { command: 'must-not-execute' } },
      }),
    );
    for (const skill of skillNames) {
      const skillDir = path.join(directory, 'skills', skill);
      await fsp.mkdir(skillDir, { recursive: true });
      await fsp.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: ${skill} description\nargument-hint: <input>\nuser-invocable: false\n---\nInstructions`,
      );
    }
    return directory;
  }

  it('lists active and inactive extension Skills without a runtime Config', async () => {
    const active = await writeExtension('active', ['active-skill']);
    await writeExtension('inactive', ['inactive-skill']);
    await fsp.writeFile(
      path.join(qwenHome, 'extensions', 'extension-enablement.json'),
      JSON.stringify({ inactive: { overrides: ['!*'] } }),
    );
    const refreshRuntime = vi.spyOn(ExtensionManager.prototype, 'refreshTools');
    const status = await createWorkspaceSkillsStatusProvider()(qwenHome);
    expect(status.initialized).toBe(true);
    expect(status.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'active-skill',
          status: 'ok',
          level: 'extension',
          extensionName: 'active',
          extensionDisplayName: 'active display',
          installedPath: path.join(
            active,
            'skills',
            'active-skill',
            'SKILL.md',
          ),
          argumentHint: '<input>',
          userInvocable: false,
        }),
        expect.objectContaining({
          name: 'inactive-skill',
          status: 'disabled',
          disabledReason: 'inactive_extension',
          extensionName: 'inactive',
        }),
      ]),
    );
    expect(refreshRuntime).not.toHaveBeenCalled();
  });

  it('preserves project precedence and appends same-name inactive sources', async () => {
    await writeExtension('active', ['shared']);
    await writeExtension('inactive', ['shared']);
    await fsp.writeFile(
      path.join(qwenHome, 'extensions', 'extension-enablement.json'),
      JSON.stringify({ inactive: { overrides: ['!*'] } }),
    );
    const projectSkill = path.join(qwenHome, '.qwen', 'skills', 'shared');
    await fsp.mkdir(projectSkill, { recursive: true });
    await fsp.writeFile(
      path.join(projectSkill, 'SKILL.md'),
      '---\nname: shared\ndescription: Project wins\n---\nBody',
    );
    const status = await createWorkspaceSkillsStatusProvider()(qwenHome);
    expect(status.skills.filter((s) => s.name === 'shared')).toMatchObject([
      { level: 'project', status: 'ok' },
      {
        level: 'extension',
        extensionName: 'inactive',
        disabledReason: 'inactive_extension',
      },
    ]);
  });

  it('uses persisted workspace activation and Skill overrides from the store', async () => {
    await writeExtension('suite', ['blocked', 'opt-in', 'overridden'], {
      blocked: false,
      'opt-in': false,
      overridden: false,
    });
    const workspace = path.join(qwenHome, 'workspace');
    const other = path.join(qwenHome, 'other');
    await fsp.mkdir(path.join(workspace, '.qwen'), { recursive: true });
    await fsp.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        skills: { enabled: ['OPT-IN'], disabled: ['blocked'] },
      }),
    );
    const manager = new ExtensionManager({
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
    });
    await manager.refreshCache();
    const extension = manager.getLoadedExtensions()[0]!;
    const store = new ExtensionStore();
    await store.setWorkspaceActivation(extension, other, 'disabled');
    await store.setSkillWorkspaceOverrides(
      extension,
      workspace,
      { overridden: true },
      0,
    );
    const provider = createWorkspaceSkillsStatusProvider();
    const status = await provider(workspace);
    expect(
      status.skills.filter((s) => s.extensionName === 'suite'),
    ).toMatchObject([
      { name: 'blocked', disabledReason: 'hard' },
      { name: 'opt-in', status: 'ok' },
      { name: 'overridden', status: 'ok' },
    ]);
    const otherStatus = await provider(other);
    expect(
      otherStatus.skills.filter((s) => s.extensionName === 'suite'),
    ).toHaveLength(3);
    expect(
      otherStatus.skills
        .filter((s) => s.extensionName === 'suite')
        .every((s) => s.disabledReason === 'inactive_extension'),
    ).toBe(true);
  });

  it('maps manifest defaults, reloads settings, and rebuilds after invalidation', async () => {
    await writeExtension('suite', ['default-off'], { 'default-off': false });
    const workspace = path.join(qwenHome, 'workspace');
    await fsp.mkdir(path.join(workspace, '.qwen'), { recursive: true });
    const provider = createWorkspaceSkillsStatusProvider();
    const readSkill = async () =>
      (await provider(workspace)).skills.find((s) => s.name === 'default-off');
    expect(await readSkill()).toMatchObject({
      status: 'disabled',
      disabledReason: 'default',
    });
    await fsp.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({ skills: { enabled: ['default-off'] } }),
    );
    expect(await readSkill()).toMatchObject({ status: 'ok' });
    await fsp.rm(path.join(qwenHome, 'extensions', 'suite'), {
      recursive: true,
    });
    provider.invalidate?.(workspace);
    expect(await readSkill()).toBeUndefined();
  });

  it.each(['safe', 'untrusted', 'inert-untrusted', 'disabled-level'] as const)(
    'does not load extensions in %s mode',
    async (mode) => {
      await writeExtension('suite', ['hidden']);
      if (mode === 'safe') vi.stubEnv('QWEN_CODE_SAFE_MODE', '1');
      if (mode === 'disabled-level') {
        await fsp.mkdir(path.join(qwenHome, '.qwen'), { recursive: true });
        await fsp.writeFile(
          path.join(qwenHome, '.qwen', 'settings.json'),
          JSON.stringify({ skills: { disabledLevels: ['extension'] } }),
        );
      }
      const refresh = vi.spyOn(ExtensionManager.prototype, 'refreshCache');
      const status = await createWorkspaceSkillsStatusProvider({
        workspaceTrusted: mode !== 'untrusted' && mode !== 'inert-untrusted',
        includeUntrustedSkills: mode === 'inert-untrusted',
      })(qwenHome);
      expect(status.initialized).toBe(true);
      expect(status.skills.some((s) => s.level === 'extension')).toBe(false);
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it('returns an error for an unreadable extension directory', async () => {
    await fsp.writeFile(path.join(qwenHome, 'extensions'), 'not a directory');
    const status = await createWorkspaceSkillsStatusProvider()(qwenHome);
    expect(status).toMatchObject({
      initialized: false,
      skills: [],
      errors: [{ kind: 'skills', status: 'error' }],
    });
  });

  it('loads linked extensions and Agent Plugin manifests through the shared loader', async () => {
    const source = await writeExtension('linked', ['linked-skill']);
    const relocated = path.join(qwenHome, 'linked-source');
    await fsp.rename(source, relocated);
    await fsp.mkdir(source);
    await fsp.writeFile(
      path.join(source, '.qwen-extension-install.json'),
      JSON.stringify({ type: 'link', source: relocated }),
    );
    const plugin = await writeExtension('portable', ['portable-skill']);
    await fsp.rm(path.join(plugin, 'qwen-extension.json'));
    await fsp.writeFile(
      path.join(plugin, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'portable',
        version: '1.0.0',
      }),
    );
    const status = await createWorkspaceSkillsStatusProvider()(qwenHome);
    expect(status.initialized).toBe(true);
    expect(status.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'linked-skill',
          extensionName: 'linked',
          installedPath: path.join(
            relocated,
            'skills',
            'linked-skill',
            'SKILL.md',
          ),
        }),
        expect.objectContaining({
          name: 'portable-skill',
          extensionName: 'portable',
        }),
      ]),
    );
  });

  it('does not cache a failed store read as an initialized empty catalog', async () => {
    await writeExtension('suite', ['visible']);
    vi.spyOn(ExtensionManager.prototype, 'refreshCache').mockRejectedValueOnce(
      new Error('store unavailable'),
    );
    const provider = createWorkspaceSkillsStatusProvider();
    expect(await provider(qwenHome)).toMatchObject({
      initialized: false,
      errors: [{ kind: 'skills', error: 'store unavailable' }],
    });
    expect((await provider(qwenHome)).skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'visible', status: 'ok' }),
      ]),
    );
  });

  it.each([
    { language: 'zh', envLanguage: '', expected: '扩展' },
    { language: 'zh-CN', envLanguage: '', expected: '扩展' },
    { language: 'en', envLanguage: 'zh', expected: '扩展' },
    { language: 'auto', envLanguage: '', expected: '扩展' },
    { language: 'en', envLanguage: '', expected: 'Extension' },
  ])(
    'resolves extension names for $language with env $envLanguage',
    async ({ language, envLanguage, expected }) => {
      vi.stubEnv('QWEN_CODE_LANG', envLanguage);
      vi.stubEnv('LANG', 'zh_CN.UTF-8');
      for (const name of ['active', 'inactive']) {
        const directory = await writeExtension(name, [`${name}-skill`]);
        const manifestPath = path.join(directory, 'qwen-extension.json');
        const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
        await fsp.writeFile(
          manifestPath,
          JSON.stringify({
            ...manifest,
            displayName: { en: 'Extension', zh: '扩展' },
          }),
        );
      }
      await fsp.writeFile(
        path.join(qwenHome, 'extensions', 'extension-enablement.json'),
        JSON.stringify({ inactive: { overrides: ['!*'] } }),
      );
      await fsp.mkdir(path.join(qwenHome, '.qwen'), { recursive: true });
      await fsp.writeFile(
        path.join(qwenHome, '.qwen', 'settings.json'),
        JSON.stringify({ general: { language } }),
      );
      const status = await createWorkspaceSkillsStatusProvider()(qwenHome);
      expect(status.initialized).toBe(true);
      expect(
        status.skills.filter((s) => s.level === 'extension'),
      ).toMatchObject([
        { name: 'active-skill', extensionDisplayName: expected, status: 'ok' },
        {
          name: 'inactive-skill',
          extensionDisplayName: expected,
          disabledReason: 'inactive_extension',
        },
      ]);
    },
  );
});
