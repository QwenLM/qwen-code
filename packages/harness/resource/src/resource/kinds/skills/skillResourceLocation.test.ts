/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSkillResourceLocation } from './skillResourceLocation.js';
import { UserSkillProvider } from './providers/userSkillProvider.js';
import { ProjectSkillProvider } from './providers/projectSkillProvider.js';

let failedPath: string | undefined;
const fileLinks = new Set<string>();
vi.mock(
  'node:fs/promises',
  async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
      ...actual,
      lstat: (async (...args: Parameters<typeof actual.lstat>) => {
        if (String(args[0]) === failedPath) throw new Error('permission denied');

        const stats = await actual.lstat(...args);

        if (fileLinks.has(String(args[0])))
          return { ...stats, isSymbolicLink: () => true };

        return stats;
      }) as typeof actual.lstat,
    };
  }
);

describe(
  'resolveSkillResourceLocation',
  () => {
    let tmpDir: string;
    const empty = { base: '', relativePath: '', softlink: '' };

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(
        os.tmpdir(),
        'skill-location-'
      ));
    });
    afterEach(async () => {
      failedPath = undefined;
      fileLinks.clear();
      await fs.rm(
        tmpDir,
        { recursive: true, force: true }
      );
    });

    async function write(relative: string): Promise<string> {
      const file = path.join(
        tmpDir,
        relative
      );
      await fs.mkdir(
        path.dirname(file),
        { recursive: true }
      );
      await fs.writeFile(
        file,
        '# Skill'
      );
      return file;
    }

    it(
      'uses the actual user root and keeps the marketplace in plugin paths',
      async () => {
        const relative =
          'plugins/cache/my-market/my-plugin/2.0/custom/my-skill/SKILL.md';
        const file = await write(relative);
        expect(
          await resolveSkillResourceLocation(
            file,
            {
              root: tmpDir,
              base: 'user_config',
              isFile: true,
            }
          ),
        ).toEqual({ base: 'user_config', relativePath: relative, softlink: false });
      }
    );

    it(
      'normalizes Windows separators and rejects cross-drive paths',
      async () => {
        failedPath = 'C:\\custom';
        expect(
          await resolveSkillResourceLocation(
            'C:\\custom\\skills\\x\\SKILL.md',
            {
              root: 'C:\\custom',
              base: 'user_config',
              isFile: true,
            }
          ),
        ).toEqual({
          base: 'user_config',
          relativePath: 'skills/x/SKILL.md',
          softlink: '',
        });
        expect(
          await resolveSkillResourceLocation(
            'D:\\skills\\x\\SKILL.md',
            {
              root: 'C:\\custom',
              base: 'user_config',
              isFile: true,
            }
          ),
        ).toEqual(empty);
      }
    );

    it(
      'rejects escaped paths and sibling prefixes',
      async () => {
        for (const file of [
          path.join(
            tmpDir,
            '..',
            'SKILL.md'
          ),
          `${tmpDir}-sibling/SKILL.md`,
        ]) {
          expect(
            await resolveSkillResourceLocation(
              file,
              {
                root: tmpDir,
                base: 'project_config',
                isFile: true,
              }
            ),
          ).toEqual(empty);
        }
      }
    );

    it(
      'does not infer file locations from builtin, workflow or inline skill roots',
      async () => {
        for (const location of [
          'builtin',
          'workflow:run',
          path.join(
            tmpDir,
            'commands',
            '__inline__'
          ),
        ]) {
          expect(
            await resolveSkillResourceLocation(
              location,
              {
                root: tmpDir,
                base: 'plugin_root',
                isFile: true,
              }
            ),
          ).toEqual(empty);
        }

        expect(
          await resolveSkillResourceLocation(
            await write('skills/x/SKILL.md'),
            {
              root: tmpDir,
              base: 'project_config',
              isFile: false,
            }
          ),
        ).toEqual(empty);
      }
    );

    it(
      'keeps the logical entry for links to files and parent directories outside the root',
      async () => {
        const target = await write('external/x/SKILL.md');
        const root = path.join(
          tmpDir,
          'config'
        );
        await fs.mkdir(
          path.join(
            root,
            'skills',
            'file'
          ),
          { recursive: true }
        );
        const fileEntry = path.join(
          root,
          'skills',
          'file',
          'SKILL.md'
        );

        // File symlinks require privileges on Windows; the lstat observation is
        // simulated there, while directory junctions below exercise real links.
        if (process.platform === 'win32') {
          await fs.copyFile(
            target,
            fileEntry
          );
          fileLinks.add(fileEntry);
        } else {
          await fs.symlink(
            target,
            fileEntry,
            'file'
          );
        }

        await fs.symlink(
          path.dirname(target),
          path.join(
            root,
            'skills',
            'directory'
          ),
          process.platform === 'win32' ? 'junction' : 'dir',
        );

        for (const name of ['file', 'directory']) {
          expect(
            await resolveSkillResourceLocation(
              path.join(
                root,
                'skills',
                name,
                'SKILL.md'
              ),
              {
                root,
                base: 'user_config',
                isFile: true,
              },
            ),
          ).toEqual({
            base: 'user_config',
            relativePath: `skills/${name}/SKILL.md`,
            softlink: true,
          });
        }
      }
    );

    it(
      'checks the selected root entry itself for links',
      async () => {
        const target = await write('real/skills/x/SKILL.md');
        const root = path.join(
          tmpDir,
          'linked-config'
        );
        await fs.symlink(
          path.join(
            tmpDir,
            'real'
          ),
          root,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        expect(
          await resolveSkillResourceLocation(
            path.join(
              root,
              path.relative(
                path.join(
                  tmpDir,
                  'real'
                ),
                target
              )
            ),
            {
              root,
              base: 'user_config',
              isFile: true,
            },
          ),
        ).toEqual({
          base: 'user_config',
          relativePath: 'skills/x/SKILL.md',
          softlink: true,
        });
      }
    );

    it(
      'uses unknown for softlink inspection failure without losing the relative path',
      async () => {
        const file = await write('skills/x/SKILL.md');
        failedPath = path.join(
          tmpDir,
          'skills'
        );
        expect(
          await resolveSkillResourceLocation(
            file,
            {
              root: tmpDir,
              base: 'user_config',
              isFile: true,
            }
          ),
        ).toEqual({
          base: 'user_config',
          relativePath: 'skills/x/SKILL.md',
          softlink: '',
        });
      }
    );

    it(
      'captures actual config and compatibility roots in scoped providers',
      async () => {
        await write('custom-user/skills/user/SKILL.md');
        await write('custom-agents/skills/compat/SKILL.md');
        await write('custom-project/skills/project/SKILL.md');
        await write('additional/.qoder/skills/additional/SKILL.md');
        const user = await new UserSkillProvider({
          skillsDir: path.join(
            tmpDir,
            'custom-user',
            'skills'
          ),
          commandsDir: path.join(
            tmpDir,
            'custom-user',
            'commands'
          ),
          agentSkillsDir: path.join(
            tmpDir,
            'custom-agents',
            'skills'
          ),
        }).load();
        expect(user.skills.map((skill) => skill.resourceLocation)).toEqual([
          {
            base: 'user_agents',
            relativePath: 'skills/compat/SKILL.md',
            softlink: false,
          },
          {
            base: 'user_config',
            relativePath: 'skills/user/SKILL.md',
            softlink: false,
          },
        ]);
        const project = await new ProjectSkillProvider(
          ['custom-project', 'additional/.qoder'].map((root) => ({
            skillsDir: path.join(
              tmpDir,
              root,
              'skills'
            ),
            commandsDir: path.join(
              tmpDir,
              root,
              'commands'
            ),
          })),
        ).load();
        expect(project.skills.map((skill) => skill.resourceLocation)).toEqual([
          {
            base: 'project_config',
            relativePath: 'skills/project/SKILL.md',
            softlink: false,
          },
          {
            base: 'project_config',
            relativePath: 'skills/additional/SKILL.md',
            softlink: false,
          },
        ]);
      }
    );
  }
);
