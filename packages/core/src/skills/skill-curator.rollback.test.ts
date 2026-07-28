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
import { recordAutoSkillUsage, runAutoSkillCurator } from './skill-curator.js';

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
});
