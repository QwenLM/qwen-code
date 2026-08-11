/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SkillManager,
  Storage,
  type Config,
  type SkillLevel,
} from '@qwen-code/qwen-code-core';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const downloadSkillMock = vi.hoisted(() => vi.fn());

vi.mock('./skill-source-download.js', () => ({
  downloadSkill: downloadSkillMock,
}));

import {
  deleteManagedSkill,
  installManagedSkill,
  setManagedSkillEnabled,
} from './skill-management.js';

type SkillManagerContract = NonNullable<ReturnType<Config['getSkillManager']>>;

function configWith(skillManager: object): Config {
  return {
    getSkillManager: () => skillManager as SkillManagerContract,
  } as unknown as Config;
}

function managerFor(name: string) {
  const parseSkillContent = vi.fn(
    (_content: string, filePath: string, level: SkillLevel) => ({
      name,
      description: `${name} skill`,
      level,
      filePath,
      skillRoot: path.dirname(filePath),
      body: 'Body',
    }),
  );
  const refreshCache = vi.fn().mockResolvedValue(undefined);
  return { parseSkillContent, refreshCache };
}

async function writeSkill(root: string, relativeDir: string, name: string) {
  const skillDir = path.join(root, relativeDir, name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`,
    'utf8',
  );
  return { skillDir, skillFile };
}

afterEach(() => {
  downloadSkillMock.mockReset();
  vi.restoreAllMocks();
});

describe('managed Skill mutations', () => {
  it('installs every downloaded file and replaces an existing Skill', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const manager = managerFor('pptx');
    downloadSkillMock.mockResolvedValue({
      skillContent:
        '---\nname: pptx\ndescription: Create slide decks\n---\nBody\n',
      files: [
        {
          relativePath: 'SKILL.md',
          content: Buffer.from('---\nname: pptx\n---\nBody\n'),
        },
        {
          relativePath: 'references/editing.md',
          content: Buffer.from('# Editing guide\n'),
        },
      ],
    });

    try {
      const result = await installManagedSkill(configWith(manager), {
        skill: {
          id: 'pptx-id',
          slug: 'pptx',
          name: 'PPTX',
          sourceUrl:
            'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
        },
      });
      const installedPath = path.join(tempHome, 'skills', 'pptx', 'SKILL.md');

      expect(result).toMatchObject({
        id: 'pptx-id',
        slug: 'pptx',
        installed: true,
        installedPath,
      });
      await expect(fs.readFile(installedPath, 'utf8')).resolves.toContain(
        'name: pptx',
      );
      await expect(
        fs.readFile(
          path.join(tempHome, 'skills', 'pptx', 'references', 'editing.md'),
          'utf8',
        ),
      ).resolves.toBe('# Editing guide\n');
      expect(manager.parseSkillContent).toHaveBeenCalledWith(
        expect.stringContaining('name: pptx'),
        installedPath,
        'user',
      );

      downloadSkillMock.mockResolvedValue({
        skillContent:
          '---\nname: pptx\ndescription: Updated slide decks\n---\nUpdated\n',
        files: [
          {
            relativePath: 'SKILL.md',
            content: Buffer.from(
              '---\nname: pptx\ndescription: Updated slide decks\n---\nUpdated\n',
            ),
          },
        ],
      });
      await installManagedSkill(configWith(manager), {
        skill: {
          slug: 'pptx',
          sourceUrl:
            'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
        },
      });

      await expect(fs.readFile(installedPath, 'utf8')).resolves.toContain(
        'Updated slide decks',
      );
      await expect(
        fs.stat(
          path.join(tempHome, 'skills', 'pptx', 'references', 'editing.md'),
        ),
      ).rejects.toThrow();
      expect(manager.refreshCache).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects downloaded file paths outside the staging directory', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const manager = managerFor('pptx');
    const outsidePath = path.join(tempHome, 'skills', 'evil.md');
    downloadSkillMock.mockResolvedValue({
      skillContent: '---\nname: pptx\n---\nBody\n',
      files: [
        {
          relativePath: '../evil.md',
          content: Buffer.from('unsafe'),
        },
      ],
    });

    try {
      await expect(
        installManagedSkill(configWith(manager), {
          skill: {
            slug: 'pptx',
            sourceUrl:
              'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
          },
        }),
      ).rejects.toThrow('Invalid skill file path');
      await expect(fs.stat(outsidePath)).rejects.toThrow();
      expect(manager.refreshCache).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects manifests whose parsed name does not match the slug', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const manager = managerFor('other-name');
    const config = configWith(manager);
    downloadSkillMock.mockResolvedValue({
      skillContent: '---\nname: pptx\n---\nBody\n',
      files: [
        {
          relativePath: 'SKILL.md',
          content: Buffer.from('---\nname: pptx\n---\nBody\n'),
        },
      ],
    });

    try {
      await expect(
        installManagedSkill(config, {
          skill: {
            slug: 'pptx',
            sourceUrl:
              'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
          },
        }),
      ).rejects.toThrow('does not match requested slug');
      await expect(
        fs.stat(path.join(tempHome, 'skills', 'pptx')),
      ).rejects.toThrow();

      const { skillDir, skillFile } = await writeSkill(
        tempHome,
        'skills',
        'pptx',
      );
      const originalContent = await fs.readFile(skillFile, 'utf8');
      await expect(
        deleteManagedSkill(config, { skill: { slug: 'pptx' } }),
      ).rejects.toThrow('does not match requested slug');
      await expect(
        setManagedSkillEnabled(config, {
          skill: { slug: 'pptx', enabled: false },
        }),
      ).rejects.toThrow('does not match requested slug');

      await expect(fs.stat(skillDir)).resolves.toBeDefined();
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toBe(
        originalContent,
      );
      expect(manager.refreshCache).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('refuses to delete the global Qwen directory', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const skillFile = path.join(tempHome, 'SKILL.md');
    const content = '---\nname: pptx\n---\nBody\n';
    await fs.writeFile(skillFile, content, 'utf8');
    const manager = managerFor('pptx');
    const listSkills = vi
      .fn()
      .mockResolvedValue([{ name: 'pptx', filePath: skillFile }]);

    try {
      await expect(
        deleteManagedSkill(configWith({ ...manager, listSkills }), {
          skill: { slug: 'pptx' },
        }),
      ).rejects.toThrow('Refusing to delete unexpected skill directory');
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toBe(content);
      expect(manager.refreshCache).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('refuses to delete the shared global Skills directory', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const skillsDir = path.join(tempHome, 'skills');
    const skillFile = path.join(skillsDir, 'SKILL.md');
    const unrelatedSkillFile = path.join(skillsDir, 'unrelated', 'SKILL.md');
    const content = '---\nname: pptx\n---\nBody\n';
    await fs.mkdir(path.dirname(unrelatedSkillFile), { recursive: true });
    await fs.writeFile(skillFile, content, 'utf8');
    await fs.writeFile(unrelatedSkillFile, 'unrelated', 'utf8');
    const manager = managerFor('pptx');
    const listSkills = vi
      .fn()
      .mockResolvedValue([{ name: 'pptx', filePath: skillFile }]);

    try {
      await expect(
        deleteManagedSkill(configWith({ ...manager, listSkills }), {
          skill: { slug: 'pptx' },
        }),
      ).rejects.toThrow('Refusing to delete unexpected skill directory');
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toBe(content);
      await expect(fs.readFile(unrelatedSkillFile, 'utf8')).resolves.toBe(
        'unrelated',
      );
      expect(manager.refreshCache).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('refuses to update a non-SKILL.md fallback file', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const skillDir = path.join(tempHome, 'fallback');
    const skillFile = path.join(skillDir, 'README.md');
    const content = '---\nname: pptx\n---\nBody\n';
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, content, 'utf8');
    const manager = managerFor('pptx');
    const listSkills = vi
      .fn()
      .mockResolvedValue([{ name: 'pptx', filePath: skillFile }]);

    try {
      await expect(
        setManagedSkillEnabled(configWith({ ...manager, listSkills }), {
          skill: { slug: 'pptx', enabled: false },
        }),
      ).rejects.toThrow('Refusing to write to unexpected skill file');
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toBe(content);
      expect(manager.refreshCache).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects unsupported mutation scopes before side effects', async () => {
    const config = configWith(managerFor('unused'));

    await expect(
      installManagedSkill(config, {
        skill: {
          slug: 'pptx',
          scope: 'project',
          sourceUrl:
            'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
        },
      }),
    ).rejects.toThrow('Only global skill installation is supported');
    await expect(
      deleteManagedSkill(config, {
        skill: { slug: 'pptx', scope: 'project' },
      }),
    ).rejects.toThrow('Only global skill management is supported');
    await expect(
      setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: false, scope: 'user' },
      }),
    ).rejects.toThrow('Only global or project skill management is supported');
    expect(downloadSkillMock).not.toHaveBeenCalled();
  });

  it('enables, disables, and deletes a global Skill', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const { skillDir, skillFile } = await writeSkill(
      tempHome,
      'skills',
      'pptx',
    );
    const manager = managerFor('pptx');
    const config = configWith(manager);

    try {
      await expect(
        setManagedSkillEnabled(config, {
          skill: { slug: 'pptx', enabled: false },
        }),
      ).resolves.toMatchObject({
        slug: 'pptx',
        enabled: false,
        installedPath: skillFile,
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );

      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: true },
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.not.toContain(
        'disable-model-invocation',
      );

      await expect(
        deleteManagedSkill(config, { skill: { slug: 'pptx' } }),
      ).resolves.toEqual({ slug: 'pptx', deleted: true });
      await expect(fs.stat(skillDir)).rejects.toThrow();
      expect(manager.refreshCache).toHaveBeenCalledTimes(3);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('preserves comments and nested hooks when toggling frontmatter', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const skillDir = path.join(tempHome, 'skills', 'pptx');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      skillFile,
      '---\n# keep this comment\nname: pptx\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      command: echo hi\n---\nBody\n',
      'utf8',
    );
    const config = configWith(managerFor('pptx'));

    try {
      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: false },
      });
      let content = await fs.readFile(skillFile, 'utf8');
      expect(content).toContain('# keep this comment');
      expect(content).toContain('hooks:');
      expect(content).toContain('matcher: Bash');
      expect(content).toContain('disable-model-invocation: true');

      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: true },
      });
      content = await fs.readFile(skillFile, 'utf8');
      expect(content).toContain('# keep this comment');
      expect(content).toContain('hooks:');
      expect(content).not.toContain('disable-model-invocation');
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('canonicalizes duplicate top-level enablement fields', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const skillDir = path.join(tempHome, 'skills', 'pptx');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    const config = configWith(managerFor('pptx'));
    const parser = new SkillManager({} as Config);

    try {
      await fs.writeFile(
        skillFile,
        '---\nname: pptx\ndescription: Create slide decks\ndisable-model-invocation: false\ndisable-model-invocation: true\n---\nBody\n',
        'utf8',
      );
      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: true },
      });
      let content = await fs.readFile(skillFile, 'utf8');
      expect(content.match(/^disable-model-invocation\s*:/gm) ?? []).toEqual(
        [],
      );
      expect(
        parser.parseSkillContent(content, skillFile, 'user')
          .disableModelInvocation,
      ).toBeUndefined();

      await fs.writeFile(
        skillFile,
        '---\nname: pptx\ndescription: Create slide decks\ndisable-model-invocation: true\ndisable-model-invocation: false\n---\nBody\n',
        'utf8',
      );
      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: false },
      });
      content = await fs.readFile(skillFile, 'utf8');
      expect(content.match(/^disable-model-invocation\s*:.*$/gm)).toEqual([
        'disable-model-invocation: true',
      ]);
      const parsed = parser.parseSkillContent(content, skillFile, 'user');
      expect(parsed.disableModelInvocation).toBe(true);
      expect(parsed.description).toBe('Create slide decks');
      expect(parsed.body).toBe('Body');
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('toggles quoted top-level enablement fields', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const skillDir = path.join(tempHome, 'skills', 'pptx');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    const config = configWith(managerFor('pptx'));
    const parser = new SkillManager({} as Config);

    try {
      for (const quote of ['"', "'"]) {
        await fs.writeFile(
          skillFile,
          `---\nname: pptx\ndescription: Create slide decks\n${quote}disable-model-invocation${quote}: true\n---\nBody\n`,
          'utf8',
        );
        expect(
          parser.parseSkillContent(
            await fs.readFile(skillFile, 'utf8'),
            skillFile,
            'user',
          ).disableModelInvocation,
        ).toBe(true);
        await setManagedSkillEnabled(config, {
          skill: { slug: 'pptx', enabled: true },
        });
        let content = await fs.readFile(skillFile, 'utf8');
        expect(
          parser.parseSkillContent(content, skillFile, 'user')
            .disableModelInvocation,
        ).toBeUndefined();

        await fs.writeFile(
          skillFile,
          `---\nname: pptx\ndescription: Create slide decks\n${quote}disable-model-invocation${quote}: false\n---\nBody\n`,
          'utf8',
        );
        await setManagedSkillEnabled(config, {
          skill: { slug: 'pptx', enabled: false },
        });
        content = await fs.readFile(skillFile, 'utf8');
        expect(content.match(/^disable-model-invocation\s*:.*$/gm)).toEqual([
          'disable-model-invocation: true',
        ]);
        expect(
          parser.parseSkillContent(content, skillFile, 'user')
            .disableModelInvocation,
        ).toBe(true);
      }
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('toggles enablement fields with next-line values', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const skillDir = path.join(tempHome, 'skills', 'pptx');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    const config = configWith(managerFor('pptx'));
    const parser = new SkillManager({} as Config);

    try {
      await fs.writeFile(
        skillFile,
        '---\nname: pptx\ndescription: Create slide decks\ndisable-model-invocation:\n  false\n---\nBody\n',
        'utf8',
      );
      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: false },
      });
      let content = await fs.readFile(skillFile, 'utf8');
      expect(content.match(/^disable-model-invocation\s*:.*$/gm)).toEqual([
        'disable-model-invocation: true',
      ]);
      const disabledSkill = parser.parseSkillContent(
        content,
        skillFile,
        'user',
      );
      expect(disabledSkill.disableModelInvocation).toBe(true);
      expect(disabledSkill.description).toBe('Create slide decks');
      expect(disabledSkill.body).toBe('Body');

      await fs.writeFile(
        skillFile,
        '---\nname: pptx\ndescription: Create slide decks\ndisable-model-invocation:\n  true\n---\nBody\n',
        'utf8',
      );
      expect(
        parser.parseSkillContent(
          await fs.readFile(skillFile, 'utf8'),
          skillFile,
          'user',
        ).disableModelInvocation,
      ).toBe(true);
      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: true },
      });
      content = await fs.readFile(skillFile, 'utf8');
      expect(content).not.toContain('disable-model-invocation');
      const enabledSkill = parser.parseSkillContent(content, skillFile, 'user');
      expect(enabledSkill.disableModelInvocation).toBeUndefined();
      expect(enabledSkill.description).toBe('Create slide decks');
      expect(enabledSkill.body).toBe('Body');
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves user and project Skills through the existing manager fallbacks', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    const tempProject = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-project-skill-'),
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const userSkill = await writeSkill(tempHome, '.agents/skills', 'course');
    const projectSkill = await writeSkill(
      tempProject,
      '.qwen/skills',
      'project-course',
    );
    const manager = managerFor('unused');
    manager.parseSkillContent.mockImplementation(
      (content: string, filePath: string, level: SkillLevel) => {
        const name = content.match(/^name:\s*(.+)$/m)?.[1] ?? 'unknown';
        return {
          name,
          description: `${name} skill`,
          level,
          filePath,
          skillRoot: path.dirname(filePath),
          body: 'Body',
        };
      },
    );
    const listSkills = vi.fn(({ level }: { level: 'user' | 'project' }) =>
      Promise.resolve(
        level === 'user'
          ? [{ name: 'course', filePath: userSkill.skillFile }]
          : [{ name: 'project-course', filePath: projectSkill.skillFile }],
      ),
    );
    const config = configWith({ ...manager, listSkills });

    try {
      await setManagedSkillEnabled(config, {
        skill: { slug: 'course', enabled: false },
      });
      await setManagedSkillEnabled(config, {
        skill: {
          slug: 'project-course',
          enabled: false,
          scope: 'project',
        },
      });

      await expect(fs.readFile(userSkill.skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );
      await expect(
        fs.readFile(projectSkill.skillFile, 'utf8'),
      ).resolves.toContain('disable-model-invocation: true');
      expect(listSkills).toHaveBeenCalledWith({ level: 'user' });
      expect(listSkills).toHaveBeenCalledWith({ level: 'project' });
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempProject, { recursive: true, force: true });
    }
  });

  it('resolves project Skills from the requested working directory', async () => {
    const tempProject = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-project-cwd-skill-'),
    );
    const skillDir = path.join(tempProject, '.qwen', 'skills', 'issue-fixer');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      skillFile,
      '---\nname: bugfix\ndescription: Bugfix skill\n---\nBody\n',
      'utf8',
    );
    const manager = managerFor('bugfix');
    const loadSkillsFromDir = vi.fn().mockResolvedValue([
      {
        name: 'bugfix',
        filePath: skillFile,
      },
    ]);
    const listSkills = vi.fn().mockResolvedValue([]);
    const config = configWith({ ...manager, loadSkillsFromDir, listSkills });

    try {
      await expect(
        setManagedSkillEnabled(
          config,
          {
            skill: { slug: 'bugfix', enabled: false, scope: 'project' },
          },
          tempProject,
        ),
      ).resolves.toMatchObject({
        slug: 'bugfix',
        enabled: false,
        installedPath: skillFile,
      });
      expect(loadSkillsFromDir).toHaveBeenCalledWith(
        path.join(tempProject, '.qwen', 'skills'),
        'project',
      );
      expect(listSkills).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempProject, { recursive: true, force: true });
    }
  });

  it('rejects traversal slugs before downloading or touching disk', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const sentinel = path.join(tempHome, 'settings.json');
    await fs.writeFile(sentinel, '{"keep":true}', 'utf8');
    const config = configWith(managerFor('unused'));

    try {
      for (const slug of ['..', '.']) {
        await expect(
          installManagedSkill(config, {
            skill: {
              slug,
              sourceUrl:
                'https://github.com/anthropics/skills/blob/main/SKILL.md',
            },
          }),
        ).rejects.toThrow('Invalid skill.slug');
        await expect(
          deleteManagedSkill(config, { skill: { slug } }),
        ).rejects.toThrow('Invalid skill.slug');
        await expect(
          setManagedSkillEnabled(config, {
            skill: { slug, enabled: false },
          }),
        ).rejects.toThrow('Invalid skill.slug');
      }
      expect(downloadSkillMock).not.toHaveBeenCalled();
      await expect(fs.readFile(sentinel, 'utf8')).resolves.toContain('keep');
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });
});
