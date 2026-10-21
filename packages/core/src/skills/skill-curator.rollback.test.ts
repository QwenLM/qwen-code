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
const NOW = new Date('2026-07-27T00:00:00.000Z');
const OLD = new Date(NOW.getTime() - 100 * DAY_MS);
const PERSIST_FAILURE = 'simulated persistence failure';

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

  const liveDir = (directoryName: string) =>
    path.join(projectRoot, '.qwen', 'skills', directoryName);
  const archivedDir = (directoryName: string) =>
    path.join(projectRoot, '.qwen', 'archived-skills', directoryName);

  /** Writes an auto-skill last modified at OLD and records its usage then. */
  async function seedSkill(directoryName: string): Promise<string> {
    const name = directoryName.replace(/^auto-skill-/, '');
    const manifest = path.join(liveDir(directoryName), 'SKILL.md');
    await fs.mkdir(liveDir(directoryName), { recursive: true });
    await fs.writeFile(
      manifest,
      [
        '---',
        `name: ${name}`,
        `description: ${directoryName}`,
        'source: auto-skill',
        '---',
        '',
        '# Skill',
      ].join('\n'),
    );
    await fs.utimes(manifest, OLD, OLD);
    // Seeding uses the real atomicWriteJSON (default passthrough).
    await recordAutoSkillUsage(
      projectRoot,
      { name, level: 'project', filePath: manifest },
      OLD,
    );
    return manifest;
  }

  const failNextStateWrite = () =>
    vi
      .mocked(atomicFileWrite.atomicWriteJSON)
      .mockRejectedValueOnce(new Error(PERSIST_FAILURE));

  /**
   * Fails the next state write after planting `rollback-blocker` in
   * `directory`, so renaming back into it fails. Returns the thrown error.
   */
  function blockRollbackInto(directory: string): Error {
    const persistenceError = new Error(PERSIST_FAILURE);
    vi.mocked(atomicFileWrite.atomicWriteJSON).mockImplementationOnce(
      async () => {
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'rollback-blocker'), 'x');
        throw persistenceError;
      },
    );
    return persistenceError;
  }

  const expectExists = (target: string) =>
    expect(fs.access(target)).resolves.toBeUndefined();
  const expectMissing = (target: string) =>
    expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });

  it('rolls back an archive move when persisting state fails', async () => {
    await seedSkill('auto-skill-old');
    // Fail the single state write that runs after the archive rename.
    failNextStateWrite();

    await expect(
      runAutoSkillCurator(projectRoot, { now: NOW }),
    ).rejects.toThrow(PERSIST_FAILURE);

    // The rename was rolled back: the skill is back in the live library and is
    // not left stranded in the archive.
    await expectExists(path.join(liveDir('auto-skill-old'), 'SKILL.md'));
    await expectMissing(path.join(archivedDir('auto-skill-old'), 'SKILL.md'));
  });

  it('rolls back every archive move when persisting state fails', async () => {
    const directoryNames = ['auto-skill-old-one', 'auto-skill-old-two'];
    for (const directoryName of directoryNames) {
      await seedSkill(directoryName);
    }
    failNextStateWrite();

    await expect(
      runAutoSkillCurator(projectRoot, { now: NOW }),
    ).rejects.toThrow(PERSIST_FAILURE);

    for (const directoryName of directoryNames) {
      await expectExists(path.join(liveDir(directoryName), 'SKILL.md'));
      await expectMissing(path.join(archivedDir(directoryName), 'SKILL.md'));
    }
  });

  it('rolls back a restore move when persisting state fails', async () => {
    await seedSkill('auto-skill-old');
    // Archive the skill so there is an archived copy to restore.
    await runAutoSkillCurator(projectRoot, { now: NOW });
    const liveManifest = path.join(liveDir('auto-skill-old'), 'SKILL.md');
    const archivedManifest = path.join(
      archivedDir('auto-skill-old'),
      'SKILL.md',
    );
    await expectExists(archivedManifest);

    // Fail the single state write that runs after the restore rename.
    failNextStateWrite();

    await expect(
      restoreArchivedAutoSkill(projectRoot, 'auto-skill-old', NOW),
    ).rejects.toThrow(PERSIST_FAILURE);

    // The rename was rolled back: the skill is back in the archive and is not
    // left stranded in the live library without a state record.
    await expectExists(archivedManifest);
    await expectMissing(liveManifest);
  });

  it('continues rolling back after an archive rollback fails', async () => {
    const restoredManifest = await seedSkill('auto-skill-old-one');
    const blockedManifest = await seedSkill('auto-skill-old-two');
    const blockedLiveDirectory = path.dirname(blockedManifest);
    const persistenceError = blockRollbackInto(blockedLiveDirectory);

    await expect(
      runAutoSkillCurator(projectRoot, { now: NOW }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/^Rollback failed:/),
      cause: persistenceError,
    });
    await expectExists(path.dirname(restoredManifest));
    await expectMissing(archivedDir('auto-skill-old-one'));
    await expectExists(archivedDir('auto-skill-old-two'));
    await expectExists(path.join(blockedLiveDirectory, 'rollback-blocker'));
  });

  it('escalates when a restore move cannot be rolled back', async () => {
    const manifest = await seedSkill('auto-skill-old');
    await runAutoSkillCurator(projectRoot, { now: NOW });
    const archivedDirectory = archivedDir('auto-skill-old');
    // The restore rename has completed by the time persistence starts.
    // Recreate its source as a non-empty directory so rename-back fails.
    const persistenceError = blockRollbackInto(archivedDirectory);

    await expect(
      restoreArchivedAutoSkill(projectRoot, 'auto-skill-old', NOW),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/^Rollback failed:/),
      cause: persistenceError,
    });
    await expectExists(path.dirname(manifest));
    await expectExists(path.join(archivedDirectory, 'rollback-blocker'));
  });
});
