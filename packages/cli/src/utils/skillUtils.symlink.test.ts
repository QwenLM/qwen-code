/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONFIG_DIR } from '@qwen-code/core';
import { installSkill } from './skillUtils.js';

describe.skipIf(process.platform === 'win32')(
  'installSkill archive symlinks',
  () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'skill-symlink-integration-'),
      );
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    async function writeArchive(
      linkTarget: string,
      includeTarget: boolean,
    ): Promise<string> {
      const zip = new JSZip();
      zip.file(
        'archive-skill/SKILL.md',
        '---\nname: archive-skill\ndescription: test\n---\nbody',
        { unixPermissions: 0o100644 },
      );
      if (includeTarget) {
        zip.file('archive-skill/assets/reference.md', 'reference', {
          unixPermissions: 0o100644,
        });
      }
      zip.file('archive-skill/REFERENCE.md', linkTarget, {
        unixPermissions: 0o120777,
      });
      const archivePath = path.join(tempDir, 'skill.zip');
      await fs.writeFile(
        archivePath,
        await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }),
      );
      return archivePath;
    }

    it('rewrites an internal link into the installed Skill', async () => {
      const archivePath = await writeArchive('assets/reference.md', true);

      await installSkill(
        archivePath,
        'workspace',
        undefined,
        () => {},
      );

      const installedReference = path.join(
        tempDir,
        CONFIG_DIR,
        'skills',
        'archive-skill',
        'REFERENCE.md',
      );
      expect((await fs.lstat(installedReference)).isSymbolicLink()).toBe(true);
      expect(path.isAbsolute(await fs.readlink(installedReference))).toBe(false);
      expect(await fs.readFile(installedReference, 'utf8')).toBe('reference');
    });

    it('rejects a link that lexically escapes the archive', async () => {
      const archivePath = await writeArchive('../../outside', false);

      await expect(
        installSkill(
          archivePath,
          'workspace',
          undefined,
          () => {},
        ),
      ).rejects.toThrow('symlink points outside the archive');
    });
  },
);
