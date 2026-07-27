/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_SKILL_ARCHIVE_AFTER_MS,
  getAutoSkillCuratorStatus,
  maybeRunAutoSkillCurator,
  recordAutoSkillUsage,
  restoreArchivedAutoSkill,
  runAutoSkillCurator,
} from './skill-curator.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('auto-skill curator', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skill-curator-'),
    );
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function writeSkill(
    directoryName: string,
    source: string,
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
        `source: ${source}`,
        '---',
        '',
        '# Skill',
      ].join('\n'),
    );
    await fs.utimes(manifest, modifiedAt, modifiedAt);
    return manifest;
  }

  it('only manages doubly-marked project auto-skills', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    await writeSkill('auto-skill-managed', 'auto-skill', old);
    await writeSkill('hand-authored', 'auto-skill', old);
    await writeSkill('auto-skill-learned', 'learned', old);

    const status = await getAutoSkillCuratorStatus(projectRoot, now);

    expect(status.stale.map((entry) => entry.directoryName)).toEqual([
      'auto-skill-managed',
    ]);
    expect(status.active).toEqual([]);
  });

  it('keeps dry-run non-mutating while reporting archive candidates', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    await writeSkill(
      'auto-skill-old',
      'auto-skill',
      new Date(now.getTime() - 100 * DAY_MS),
    );

    const result = await runAutoSkillCurator(projectRoot, {
      dryRun: true,
      now,
    });

    expect(result).toMatchObject({
      dryRun: true,
      checked: 1,
      archived: ['auto-skill-old'],
    });
    await expect(
      fs.access(path.join(projectRoot, '.qwen', 'skill-curator.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.access(path.join(projectRoot, '.qwen', 'archived-skills')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.access(
        path.join(projectRoot, '.qwen', 'skills', 'auto-skill-old', 'SKILL.md'),
      ),
    ).resolves.toBeUndefined();
  });

  it('seeds the first automatic observation before aging skills', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    await writeSkill(
      'auto-skill-existing',
      'auto-skill',
      new Date(now.getTime() - 200 * DAY_MS),
    );

    await expect(maybeRunAutoSkillCurator(projectRoot, now)).resolves.toEqual({
      status: 'seeded',
      checked: 1,
    });
    await expect(
      fs.access(
        path.join(projectRoot, '.qwen', 'skills', 'auto-skill-existing'),
      ),
    ).resolves.toBeUndefined();
    await expect(
      maybeRunAutoSkillCurator(
        projectRoot,
        new Date(now.getTime() + 6 * DAY_MS),
      ),
    ).resolves.toEqual({ status: 'not_due' });

    const later = new Date(now.getTime() + 91 * DAY_MS);
    const result = await maybeRunAutoSkillCurator(projectRoot, later);
    expect(result.status).toBe('ran');
    if (result.status === 'ran') {
      expect(result.result.archived).toEqual(['auto-skill-existing']);
    }
  });

  it('marks inactive skills stale before archiving them', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    await writeSkill(
      'auto-skill-stale',
      'auto-skill',
      new Date(now.getTime() - 40 * DAY_MS),
    );

    const result = await runAutoSkillCurator(projectRoot, { now });

    expect(result.markedStale).toEqual(['auto-skill-stale']);
    expect(result.archived).toEqual([]);
    await expect(
      fs.access(path.join(projectRoot, '.qwen', 'skills', 'auto-skill-stale')),
    ).resolves.toBeUndefined();
  });

  it('archives stale packages and restores them without overwriting', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const manifest = await writeSkill(
      'auto-skill-old',
      'auto-skill',
      new Date(now.getTime() - 100 * DAY_MS),
    );
    const supportFile = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'auto-skill-old',
      'references',
      'notes.md',
    );
    await fs.mkdir(path.dirname(supportFile), { recursive: true });
    await fs.writeFile(supportFile, 'keep me');

    const run = await runAutoSkillCurator(projectRoot, { now });
    expect(run.archived).toEqual(['auto-skill-old']);
    await expect(
      recordAutoSkillUsage(
        projectRoot,
        { name: 'old', level: 'project', filePath: manifest },
        now,
      ),
    ).resolves.toBe(false);
    await expect(
      fs.readFile(
        path.join(
          projectRoot,
          '.qwen',
          'archived-skills',
          'auto-skill-old',
          'references',
          'notes.md',
        ),
        'utf8',
      ),
    ).resolves.toBe('keep me');

    await restoreArchivedAutoSkill(projectRoot, 'auto-skill-old', now);
    await expect(fs.readFile(supportFile, 'utf8')).resolves.toBe('keep me');
    const status = await getAutoSkillCuratorStatus(projectRoot, now);
    expect(status.active.map((entry) => entry.directoryName)).toEqual([
      'auto-skill-old',
    ]);
  });

  it('protects recently used skills and increments durable usage', async () => {
    const usedAt = new Date('2026-07-27T00:00:00.000Z');
    const manifest = await writeSkill(
      'auto-skill-used',
      'auto-skill',
      new Date(usedAt.getTime() - 200 * DAY_MS),
    );

    await expect(
      recordAutoSkillUsage(
        projectRoot,
        { name: 'used', level: 'project', filePath: manifest },
        usedAt,
      ),
    ).resolves.toBe(true);
    const run = await runAutoSkillCurator(projectRoot, {
      now: new Date(usedAt.getTime() + AUTO_SKILL_ARCHIVE_AFTER_MS - DAY_MS),
    });

    expect(run.archived).toEqual([]);
    const status = await getAutoSkillCuratorStatus(
      projectRoot,
      new Date(usedAt.getTime() + DAY_MS),
    );
    expect(status.active[0]).toMatchObject({
      directoryName: 'auto-skill-used',
      useCount: 1,
    });
  });

  it('treats a recent manifest edit as activity', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-07-27T00:00:00.000Z');
    const manifest = await writeSkill('auto-skill-edited', 'auto-skill', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'edited', level: 'project', filePath: manifest },
      old,
    );
    await fs.utimes(manifest, now, now);

    const run = await runAutoSkillCurator(projectRoot, { now });

    expect(run.archived).toEqual([]);
    expect(run.reactivated).toEqual([]);
  });

  it('fails closed on corrupt state without moving a skill', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const manifest = await writeSkill(
      'auto-skill-old',
      'auto-skill',
      new Date(now.getTime() - 100 * DAY_MS),
    );
    await fs.writeFile(
      path.join(projectRoot, '.qwen', 'skill-curator.json'),
      '{broken',
    );

    await expect(runAutoSkillCurator(projectRoot, { now })).rejects.toThrow(
      'Invalid auto-skill curator state',
    );
    await expect(fs.access(manifest)).resolves.toBeUndefined();
  });

  it('fails closed on corrupt state without restoring an archived skill', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    await writeSkill(
      'auto-skill-old',
      'auto-skill',
      new Date(now.getTime() - 100 * DAY_MS),
    );
    await runAutoSkillCurator(projectRoot, { now });
    const archivedManifest = path.join(
      projectRoot,
      '.qwen',
      'archived-skills',
      'auto-skill-old',
      'SKILL.md',
    );
    await fs.writeFile(
      path.join(projectRoot, '.qwen', 'skill-curator.json'),
      '{broken',
    );

    await expect(
      restoreArchivedAutoSkill(projectRoot, 'auto-skill-old', now),
    ).rejects.toThrow('Invalid auto-skill curator state');
    await expect(fs.access(archivedManifest)).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(projectRoot, '.qwen', 'skills', 'auto-skill-old', 'SKILL.md'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses archive collisions without overwriting either package', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const liveManifest = await writeSkill(
      'auto-skill-collision',
      'auto-skill',
      old,
    );
    const archivedDirectory = path.join(
      projectRoot,
      '.qwen',
      'archived-skills',
      'auto-skill-collision',
    );
    await fs.mkdir(archivedDirectory, { recursive: true });
    await fs.writeFile(path.join(archivedDirectory, 'sentinel'), 'preserve');

    await expect(runAutoSkillCurator(projectRoot, { now })).rejects.toThrow(
      'archive destination already exists',
    );
    await expect(fs.access(liveManifest)).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(archivedDirectory, 'sentinel'), 'utf8'),
    ).resolves.toBe('preserve');
  });

  it('ignores non-project usage records', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const manifest = await writeSkill('auto-skill-user', 'auto-skill', now);

    await expect(
      recordAutoSkillUsage(
        projectRoot,
        { name: 'user', level: 'user', filePath: manifest },
        now,
      ),
    ).resolves.toBe(false);
  });

  it('rejects archive directory traversal during restore', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    await fs.mkdir(path.join(projectRoot, '.qwen', 'archived-skills'), {
      recursive: true,
    });

    await expect(
      restoreArchivedAutoSkill(
        projectRoot,
        'auto-skill-placeholder/../../outside',
        now,
      ),
    ).rejects.toThrow('Archived auto-skill not found');
  });
});
