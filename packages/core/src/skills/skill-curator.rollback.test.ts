/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as atomicFileWrite from '../utils/atomicFileWrite.js';
import {
  recordAutoSkillUsage,
  restoreArchivedAutoSkill,
  runAutoSkillCurator,
} from './skill-curator.js';

// Wrap atomicWriteJSON so it delegates to the real implementation by default
// (seeding and normal writes still persist) but can be forced to fail once,
// after a real archive move, to exercise the rollback recovery path.
vi.mock('../utils/atomicFileWrite.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/atomicFileWrite.js')>();
  return {
    ...actual,
    atomicWriteJSON: vi.fn(actual.atomicWriteJSON),
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe('auto-skill curator rollback', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skill-curator-rollback-'),
    );
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function writeSkill(
    directoryName: string,
    modifiedAt: Date,
  ): Promise<string> {
    const directory = path.join(projectRoot, '.qwen', 'skills', directoryName);
    const manifest = path.join(directory, 'SKILL.md');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      manifest,
      [
        '---',
        `name: ${directoryName.replace(/^auto-skill-/, '')}`,
        `description: ${directoryName}`,
        'source: auto-skill',
        '---',
        '',
        '# Skill',
      ].join('\n'),
    );
    await fs.utimes(manifest, modifiedAt, modifiedAt);
    return manifest;
  }

  it('rolls back an archive move when persisting state fails', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifest = await writeSkill('auto-skill-old', old);
    // Seeding uses the real atomicWriteJSON (default passthrough).
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'old', level: 'project', filePath: manifest },
      old,
    );

    const liveManifest = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'auto-skill-old',
      'SKILL.md',
    );
    const archivedManifest = path.join(
      projectRoot,
      '.qwen',
      'archived-skills',
      'auto-skill-old',
      'SKILL.md',
    );

    // Fail the single state write that runs after the archive rename.
    vi.mocked(atomicFileWrite.atomicWriteJSON).mockRejectedValueOnce(
      new Error('simulated persistence failure'),
    );

    await expect(runAutoSkillCurator(projectRoot, { now })).rejects.toThrow(
      'simulated persistence failure',
    );

    // The rename was rolled back: the skill is back in the live library and is
    // not left stranded in the archive.
    await expect(fs.access(liveManifest)).resolves.toBeUndefined();
    await expect(fs.access(archivedManifest)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rolls back every archive move when persisting state fails', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const directoryNames = ['auto-skill-old-one', 'auto-skill-old-two'];

    for (const directoryName of directoryNames) {
      const manifest = await writeSkill(directoryName, old);
      await recordAutoSkillUsage(
        projectRoot,
        {
          name: directoryName.replace(/^auto-skill-/, ''),
          level: 'project',
          filePath: manifest,
        },
        old,
      );
    }

    vi.mocked(atomicFileWrite.atomicWriteJSON).mockRejectedValueOnce(
      new Error('simulated persistence failure'),
    );

    await expect(runAutoSkillCurator(projectRoot, { now })).rejects.toThrow(
      'simulated persistence failure',
    );

    for (const directoryName of directoryNames) {
      const liveManifest = path.join(
        projectRoot,
        '.qwen',
        'skills',
        directoryName,
        'SKILL.md',
      );
      const archivedManifest = path.join(
        projectRoot,
        '.qwen',
        'archived-skills',
        directoryName,
        'SKILL.md',
      );
      await expect(fs.access(liveManifest)).resolves.toBeUndefined();
      await expect(fs.access(archivedManifest)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('rolls back a restore move when persisting state fails', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifest = await writeSkill('auto-skill-old', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'old', level: 'project', filePath: manifest },
      old,
    );
    // Archive the skill so there is an archived copy to restore.
    await runAutoSkillCurator(projectRoot, { now });

    const liveManifest = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'auto-skill-old',
      'SKILL.md',
    );
    const archivedManifest = path.join(
      projectRoot,
      '.qwen',
      'archived-skills',
      'auto-skill-old',
      'SKILL.md',
    );
    await expect(fs.access(archivedManifest)).resolves.toBeUndefined();

    // Fail the single state write that runs after the restore rename.
    vi.mocked(atomicFileWrite.atomicWriteJSON).mockRejectedValueOnce(
      new Error('simulated persistence failure'),
    );

    await expect(
      restoreArchivedAutoSkill(projectRoot, 'auto-skill-old', now),
    ).rejects.toThrow('simulated persistence failure');

    // The rename was rolled back: the skill is back in the archive and is not
    // left stranded in the live library without a state record.
    await expect(fs.access(archivedManifest)).resolves.toBeUndefined();
    await expect(fs.access(liveManifest)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('continues rolling back after an archive rollback fails', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const restoredManifest = await writeSkill('auto-skill-old-one', old);
    const blockedManifest = await writeSkill('auto-skill-old-two', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'old-one', level: 'project', filePath: restoredManifest },
      old,
    );
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'old-two', level: 'project', filePath: blockedManifest },
      old,
    );
    const restoredLiveDirectory = path.dirname(restoredManifest);
    const blockedLiveDirectory = path.dirname(blockedManifest);
    const restoredArchivedDirectory = path.join(
      projectRoot,
      '.qwen',
      'archived-skills',
      'auto-skill-old-one',
    );
    const blockedArchivedDirectory = path.join(
      projectRoot,
      '.qwen',
      'archived-skills',
      'auto-skill-old-two',
    );
    const persistenceError = new Error('simulated persistence failure');
    vi.mocked(atomicFileWrite.atomicWriteJSON).mockImplementationOnce(
      async () => {
        await fs.mkdir(blockedLiveDirectory, { recursive: true });
        await fs.writeFile(
          path.join(blockedLiveDirectory, 'rollback-blocker'),
          'x',
        );
        throw persistenceError;
      },
    );

    await expect(
      runAutoSkillCurator(projectRoot, { now }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/^Rollback failed:/),
      cause: persistenceError,
    });
    await expect(fs.access(restoredLiveDirectory)).resolves.toBeUndefined();
    await expect(fs.access(restoredArchivedDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(blockedArchivedDirectory)).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(blockedLiveDirectory, 'rollback-blocker')),
    ).resolves.toBeUndefined();
  });

  it('escalates when a restore move cannot be rolled back', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifest = await writeSkill('auto-skill-old', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'old', level: 'project', filePath: manifest },
      old,
    );
    await runAutoSkillCurator(projectRoot, { now });
    const liveDirectory = path.dirname(manifest);
    const archivedDirectory = path.join(
      projectRoot,
      '.qwen',
      'archived-skills',
      'auto-skill-old',
    );
    const persistenceError = new Error('simulated persistence failure');
    vi.mocked(atomicFileWrite.atomicWriteJSON).mockImplementationOnce(
      async () => {
        // The restore rename has completed by the time persistence starts.
        // Recreate its source as a non-empty directory so rename-back fails.
        await fs.mkdir(archivedDirectory, { recursive: true });
        await fs.writeFile(
          path.join(archivedDirectory, 'rollback-blocker'),
          'x',
        );
        throw persistenceError;
      },
    );

    await expect(
      restoreArchivedAutoSkill(projectRoot, 'auto-skill-old', now),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/^Rollback failed:/),
      cause: persistenceError,
    });
    await expect(fs.access(liveDirectory)).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(archivedDirectory, 'rollback-blocker')),
    ).resolves.toBeUndefined();
  });
});
