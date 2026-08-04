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
  setAutoSkillPinned,
} from './skill-curator.js';
import { mockCompromisedLock } from '../test-utils/mock-compromised-lock.js';

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
    const managedManifest = await writeSkill(
      'auto-skill-managed',
      'auto-skill',
      old,
    );
    await writeSkill('hand-authored', 'auto-skill', old);
    await writeSkill('auto-skill-learned', 'learned', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'managed', level: 'project', filePath: managedManifest },
      old,
    );

    const status = await getAutoSkillCuratorStatus(projectRoot, now);

    expect(status.stale.map((entry) => entry.directoryName)).toEqual([
      'auto-skill-managed',
    ]);
    expect(status.active).toEqual([]);
  });

  it('does not leave a placeholder file beside the proper lock', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');

    await runAutoSkillCurator(projectRoot, { now });

    await expect(
      fs.lstat(path.join(projectRoot, '.qwen', 'skill-curator.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('registers a lock-compromised handler and completes when the curator lock is compromised', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const { lockSpy, getLockedFile, getOnCompromised } = mockCompromisedLock();

    try {
      await expect(
        runAutoSkillCurator(projectRoot, { now }),
      ).resolves.toMatchObject({ dryRun: false });
      expect(getOnCompromised()).toBeTypeOf('function');
      expect(getLockedFile()).toBe(
        path.join(projectRoot, '.qwen', 'skill-curator.lock'),
      );
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('ignores auto-skill directories whose names carry control/ANSI bytes', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);

    // A crafted directory that satisfies the `auto-skill-` prefix and basename
    // checks and carries a VALID frontmatter name, so only the directory-name
    // charset guard can exclude it. Its name embeds an ESC control sequence
    // that the non-interactive `/curator` output would otherwise print verbatim
    // (terminal control-sequence injection). Keep a clean managed skill so the
    // enumeration itself is exercised.
    const maliciousDir = 'auto-skill-[2J[31mevil';
    const directory = path.join(projectRoot, '.qwen', 'skills', maliciousDir);
    await fs.mkdir(directory, { recursive: true });
    const maliciousManifest = path.join(directory, 'SKILL.md');
    await fs.writeFile(
      maliciousManifest,
      [
        '---',
        'name: evil',
        'description: crafted',
        'source: auto-skill',
        '---',
        '',
        '# Skill',
      ].join('\n'),
    );
    await fs.utimes(maliciousManifest, old, old);

    await writeSkill('auto-skill-clean', 'auto-skill', old);

    const status = await getAutoSkillCuratorStatus(projectRoot, now);

    const surfaced = [
      ...status.active,
      ...status.stale,
      ...status.archived,
    ].map((entry) => entry.directoryName);
    expect(surfaced).toContain('auto-skill-clean');
    expect(surfaced).not.toContain(maliciousDir);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses an auto-skill whose manifest is a symlink',
    async () => {
      const now = new Date('2026-07-27T00:00:00.000Z');
      const old = new Date(now.getTime() - 100 * DAY_MS);

      // A managed directory whose SKILL.md is a symlink (git mode 120000
      // survives a clone). Even though the link target is a valid auto-skill
      // manifest, the O_NOFOLLOW read refuses to follow it — so the skill is
      // not managed and a crafted target (e.g. /dev/zero) can never be read.
      const target = await writeSkill('auto-skill-real', 'auto-skill', old);
      const linkedDir = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'auto-skill-linked',
      );
      await fs.mkdir(linkedDir, { recursive: true });
      await fs.symlink(target, path.join(linkedDir, 'SKILL.md'));

      const status = await getAutoSkillCuratorStatus(projectRoot, now);

      const surfaced = [
        ...status.active,
        ...status.stale,
        ...status.archived,
      ].map((entry) => entry.directoryName);
      expect(surfaced).not.toContain('auto-skill-linked');
      // The real, non-symlinked skill is still enumerated normally.
      expect(surfaced).toContain('auto-skill-real');
    },
  );

  it('keeps dry-run non-mutating while reporting first-sight seeding', async () => {
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
      seeded: ['auto-skill-old'],
      archived: [],
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

  it('previews aged persisted candidates without changing state', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifest = await writeSkill('auto-skill-old', 'auto-skill', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'old', level: 'project', filePath: manifest },
      old,
    );
    const statePath = path.join(projectRoot, '.qwen', 'skill-curator.json');
    const before = await fs.readFile(statePath, 'utf8');

    const result = await runAutoSkillCurator(projectRoot, {
      dryRun: true,
      now,
    });

    expect(result.archived).toEqual(['auto-skill-old']);
    expect(result.seeded).toEqual([]);
    await expect(fs.readFile(statePath, 'utf8')).resolves.toBe(before);
    await expect(
      fs.access(path.join(projectRoot, '.qwen', 'archived-skills')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('preserves an existing usage baseline when seeding the first run', async () => {
    const usedAt = new Date('2026-04-01T00:00:00.000Z');
    const manifest = await writeSkill(
      'auto-skill-preseeded',
      'auto-skill',
      new Date(usedAt.getTime() - 200 * DAY_MS),
    );
    // Usage recorded before the first curator run establishes the inactivity
    // baseline (firstSeenAt / lastActivityAt) at usedAt.
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'preseeded', level: 'project', filePath: manifest },
      usedAt,
    );

    // The first automatic (seeding) run happens ~40 days later. It must not
    // reset the inactivity clock to `now`, or the stale transition would be
    // delayed by up to the full interval.
    const seedAt = new Date(usedAt.getTime() + 40 * DAY_MS);
    await expect(
      maybeRunAutoSkillCurator(projectRoot, seedAt),
    ).resolves.toEqual({ status: 'seeded', checked: 1 });

    const state = JSON.parse(
      await fs.readFile(
        path.join(projectRoot, '.qwen', 'skill-curator.json'),
        'utf8',
      ),
    ) as {
      skills: Record<
        string,
        { firstSeenAt: string; lastActivityAt: string; useCount: number }
      >;
    };
    const record = state.skills['auto-skill-preseeded']!;
    expect(record.firstSeenAt).toBe(usedAt.toISOString());
    expect(record.lastActivityAt).toBe(usedAt.toISOString());
    expect(record.useCount).toBe(1);
  });

  it('marks inactive skills stale before archiving them', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 40 * DAY_MS);
    const manifest = await writeSkill('auto-skill-stale', 'auto-skill', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'stale', level: 'project', filePath: manifest },
      old,
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
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'old', level: 'project', filePath: manifest },
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

  it('refuses to restore over an existing active directory', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const manifest = await writeSkill(
      'auto-skill-old',
      'auto-skill',
      new Date(now.getTime() - 100 * DAY_MS),
    );
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'old', level: 'project', filePath: manifest },
      new Date(now.getTime() - 100 * DAY_MS),
    );
    const run = await runAutoSkillCurator(projectRoot, { now });
    expect(run.archived).toEqual(['auto-skill-old']);

    // A new skill reclaims the archived directory name in the live library.
    const reusedManifest = await writeSkill(
      'auto-skill-old',
      'auto-skill',
      now,
    );
    await fs.writeFile(reusedManifest, 'REUSED');

    await expect(
      restoreArchivedAutoSkill(projectRoot, 'auto-skill-old', now),
    ).rejects.toThrow('an active directory already exists');

    // Neither the reused active directory nor the archived copy is disturbed.
    await expect(fs.readFile(reusedManifest, 'utf8')).resolves.toBe('REUSED');
    await expect(
      fs.access(
        path.join(
          projectRoot,
          '.qwen',
          'archived-skills',
          'auto-skill-old',
          'SKILL.md',
        ),
      ),
    ).resolves.toBeUndefined();
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
    const state = JSON.parse(
      await fs.readFile(
        path.join(projectRoot, '.qwen', 'skill-curator.json'),
        'utf8',
      ),
    ) as { skills: Record<string, { firstSeenAt: string }> };
    expect(state.skills['auto-skill-used']!.firstSeenAt).toBe(
      usedAt.toISOString(),
    );
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

  it('reactivates a stale skill once activity resumes', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 40 * DAY_MS);
    const manifest = await writeSkill('auto-skill-revived', 'auto-skill', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'revived', level: 'project', filePath: manifest },
      old,
    );

    const staleRun = await runAutoSkillCurator(projectRoot, { now });
    expect(staleRun.markedStale).toEqual(['auto-skill-revived']);
    expect(staleRun.reactivated).toEqual([]);

    await fs.utimes(manifest, now, now);
    const revivedRun = await runAutoSkillCurator(projectRoot, { now });

    expect(revivedRun.reactivated).toEqual(['auto-skill-revived']);
    expect(revivedRun.archived).toEqual([]);
    expect(revivedRun.markedStale).toEqual([]);
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
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifest = await writeSkill('auto-skill-old', 'auto-skill', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'old', level: 'project', filePath: manifest },
      old,
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

  it('skips archive collisions while continuing with other packages', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const liveManifest = await writeSkill(
      'auto-skill-collision',
      'auto-skill',
      old,
    );
    const otherManifest = await writeSkill(
      'auto-skill-other',
      'auto-skill',
      old,
    );
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'collision', level: 'project', filePath: liveManifest },
      old,
    );
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'other', level: 'project', filePath: otherManifest },
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

    const result = await runAutoSkillCurator(projectRoot, { now });

    expect(result.skippedCollisions).toEqual(['auto-skill-collision']);
    expect(result.archived).toEqual(['auto-skill-other']);
    await expect(fs.access(liveManifest)).resolves.toBeUndefined();
    await expect(fs.access(otherManifest)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.readFile(path.join(archivedDirectory, 'sentinel'), 'utf8'),
    ).resolves.toBe('preserve');
  });

  it('reports archive collisions during a dry run', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const liveManifest = await writeSkill(
      'auto-skill-collision',
      'auto-skill',
      old,
    );
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'collision', level: 'project', filePath: liveManifest },
      old,
    );
    const archivedDirectory = path.join(
      projectRoot,
      '.qwen',
      'archived-skills',
      'auto-skill-collision',
    );
    await fs.mkdir(archivedDirectory, { recursive: true });

    const result = await runAutoSkillCurator(projectRoot, {
      dryRun: true,
      now,
    });

    expect(result.skippedCollisions).toEqual(['auto-skill-collision']);
    expect(result.archived).toEqual([]);
    await expect(fs.access(liveManifest)).resolves.toBeUndefined();
  });

  it('seeds an unseen skill on an explicit run before aging it', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const manifest = await writeSkill(
      'auto-skill-legacy',
      'auto-skill',
      new Date(now.getTime() - 200 * DAY_MS),
    );

    const result = await runAutoSkillCurator(projectRoot, { now });

    expect(result.seeded).toEqual(['auto-skill-legacy']);
    expect(result.archived).toEqual([]);
    await expect(fs.access(manifest)).resolves.toBeUndefined();
  });

  it('keeps pinned skills active until they are unpinned', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifest = await writeSkill(
      'auto-skill-important',
      'auto-skill',
      old,
    );
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'important', level: 'project', filePath: manifest },
      old,
    );

    await setAutoSkillPinned(projectRoot, 'auto-skill-important', true, now);
    const pinnedRun = await runAutoSkillCurator(projectRoot, { now });
    expect(pinnedRun.archived).toEqual([]);
    expect(
      (await getAutoSkillCuratorStatus(projectRoot, now)).active[0],
    ).toMatchObject({ directoryName: 'auto-skill-important', pinned: true });

    await setAutoSkillPinned(projectRoot, 'auto-skill-important', false, now);
    const unpinnedRun = await runAutoSkillCurator(projectRoot, { now });
    expect(unpinnedRun.archived).toEqual(['auto-skill-important']);
  });

  it('loads version 1 state written before pinning was added', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const manifest = await writeSkill('auto-skill-legacy', 'auto-skill', now);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'legacy', level: 'project', filePath: manifest },
      now,
    );
    const statePath = path.join(projectRoot, '.qwen', 'skill-curator.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
      skills: Record<string, { pinned?: boolean }>;
    };
    delete state.skills['auto-skill-legacy']!.pinned;
    await fs.writeFile(statePath, JSON.stringify(state));

    const status = await getAutoSkillCuratorStatus(projectRoot, now);

    expect(status.active[0]).toMatchObject({
      directoryName: 'auto-skill-legacy',
      pinned: false,
    });
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

  it('ignores project usage records outside the skills root', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const outsideDirectory = path.join(
      projectRoot,
      '.qwen',
      'outside',
      'auto-skill-evil',
    );
    const manifest = path.join(outsideDirectory, 'SKILL.md');
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(
      manifest,
      [
        '---',
        'name: evil',
        'description: outside the managed skills root',
        'source: auto-skill',
        '---',
        '',
      ].join('\n'),
    );

    await expect(
      recordAutoSkillUsage(
        projectRoot,
        { name: 'evil', level: 'project', filePath: manifest },
        now,
      ),
    ).resolves.toBe(false);
  });

  it('rejects archive directory traversal during restore', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const traversalTarget = path.join(projectRoot, '.qwen', 'outside');
    await fs.mkdir(path.join(projectRoot, '.qwen', 'archived-skills'), {
      recursive: true,
    });
    await fs.mkdir(traversalTarget, { recursive: true });
    await fs.writeFile(
      path.join(traversalTarget, 'SKILL.md'),
      [
        '---',
        'name: outside',
        'description: traversal target',
        'source: auto-skill',
        '---',
        '',
        '# Outside',
      ].join('\n'),
    );

    await expect(
      restoreArchivedAutoSkill(
        projectRoot,
        'auto-skill-placeholder/../../outside',
        now,
      ),
    ).rejects.toThrow('Archived auto-skill not found');
    expect((await fs.lstat(traversalTarget)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked state file',
    async () => {
      const now = new Date('2026-07-27T00:00:00.000Z');
      await writeSkill(
        'auto-skill-old',
        'auto-skill',
        new Date(now.getTime() - 100 * DAY_MS),
      );
      const statePath = path.join(projectRoot, '.qwen', 'skill-curator.json');
      const external = path.join(projectRoot, 'external-state.json');
      await fs.writeFile(external, JSON.stringify({ version: 1, skills: {} }));
      await fs.symlink(external, statePath);

      // The target is valid JSON, so this only rejects because the read path
      // refuses to follow the symlink at all.
      await expect(getAutoSkillCuratorStatus(projectRoot, now)).rejects.toThrow(
        'refuses unsafe path',
      );
    },
  );

  it('refuses a non-regular-file state file', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    await writeSkill(
      'auto-skill-old',
      'auto-skill',
      new Date(now.getTime() - 100 * DAY_MS),
    );
    const statePath = path.join(projectRoot, '.qwen', 'skill-curator.json');
    await fs.mkdir(statePath, { recursive: true });

    await expect(
      runAutoSkillCurator(projectRoot, { dryRun: true, now }),
    ).rejects.toThrow('refuses unsafe path');
  });

  it('fails closed on an oversized state file', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    await writeSkill(
      'auto-skill-old',
      'auto-skill',
      new Date(now.getTime() - 100 * DAY_MS),
    );
    const statePath = path.join(projectRoot, '.qwen', 'skill-curator.json');
    // A regular file just over the 1 MiB read cap.
    await fs.writeFile(
      statePath,
      `{"version":1,"skills":{},"pad":"${'x'.repeat(1024 * 1024)}"}`,
    );

    await expect(getAutoSkillCuratorStatus(projectRoot, now)).rejects.toThrow(
      'Invalid auto-skill curator state',
    );
  });

  it('distinguishes a present but ineligible archived skill from a missing one', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const archivedDir = path.join(
      projectRoot,
      '.qwen',
      'archived-skills',
      'auto-skill-broken',
    );
    await fs.mkdir(archivedDir, { recursive: true });
    // A manifest that lost its frontmatter is present but not eligible.
    await fs.writeFile(path.join(archivedDir, 'SKILL.md'), '# no frontmatter');

    await expect(
      restoreArchivedAutoSkill(projectRoot, 'auto-skill-broken', now),
    ).rejects.toThrow('is not an eligible managed skill');
    await expect(
      restoreArchivedAutoSkill(projectRoot, 'auto-skill-absent', now),
    ).rejects.toThrow('Archived auto-skill not found');
  });

  it('clamps a future manifest mtime so the skill remains curatable', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 180 * DAY_MS);
    const future = new Date(now.getTime() + 10 * 365 * DAY_MS);
    const manifest = await writeSkill('auto-skill-future', 'auto-skill', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'future', level: 'project', filePath: manifest },
      old,
    );
    // Stamp the manifest far in the future (clock skew, backup restore).
    await fs.utimes(manifest, future, future);

    const result = await runAutoSkillCurator(projectRoot, { now });

    expect(result.archived).toEqual(['auto-skill-future']);
  });

  it('does not double-list a directory present in both live and archived roots', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifest = await writeSkill('auto-skill-dup', 'auto-skill', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'dup', level: 'project', filePath: manifest },
      old,
    );
    await runAutoSkillCurator(projectRoot, { now });

    // Recreate the same directory name in the live library.
    await writeSkill('auto-skill-dup', 'auto-skill', now);

    const status = await getAutoSkillCuratorStatus(projectRoot, now);

    const allNames = [
      ...status.active,
      ...status.stale,
      ...status.archived,
    ].map((entry) => entry.directoryName);
    const dupCount = allNames.filter((n) => n === 'auto-skill-dup').length;
    expect(dupCount).toBe(1);
    expect(status.active.map((e) => e.directoryName)).toContain(
      'auto-skill-dup',
    );
    expect(status.archived.map((e) => e.directoryName)).not.toContain(
      'auto-skill-dup',
    );
  });

  it('isolates a per-skill rename failure and still persists state', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifestA = await writeSkill('auto-skill-a', 'auto-skill', old);
    const manifestB = await writeSkill('auto-skill-b', 'auto-skill', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'a', level: 'project', filePath: manifestA },
      old,
    );
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'b', level: 'project', filePath: manifestB },
      old,
    );

    // Make the archive root a file so rename into it fails for the first
    // skill, then fix it so the second succeeds.
    const archiveRoot = path.join(projectRoot, '.qwen', 'archived-skills');
    await fs.mkdir(archiveRoot, { recursive: true });
    // Block rename for auto-skill-a by placing a file at its destination.
    await fs.writeFile(path.join(archiveRoot, 'auto-skill-a'), 'blocker');

    const result = await runAutoSkillCurator(projectRoot, { now });

    // auto-skill-a hits a collision (lstat succeeds → skippedCollisions).
    expect(result.skippedCollisions).toContain('auto-skill-a');
    // auto-skill-b archives normally.
    expect(result.archived).toContain('auto-skill-b');
    // State was persisted (lastRunAt is set).
    const status = await getAutoSkillCuratorStatus(projectRoot, now);
    expect(status.lastRunAt).toBeDefined();
  });

  it('reports skippedErrors when rename fails transiently', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifest = await writeSkill('auto-skill-err', 'auto-skill', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'err', level: 'project', filePath: manifest },
      old,
    );

    // Seed state so the curator proceeds past the seeding branch.
    await runAutoSkillCurator(projectRoot, {
      now: new Date(now.getTime() - 95 * DAY_MS),
    });

    // Ensure the archive root exists, then remove write permission from the
    // skills root so rename (which needs write on the source parent) fails
    // with EACCES while lstat on the destination still succeeds.
    const skillsRoot = path.join(projectRoot, '.qwen', 'skills');
    const archiveRoot = path.join(projectRoot, '.qwen', 'archived-skills');
    await fs.mkdir(archiveRoot, { recursive: true });
    await fs.chmod(skillsRoot, 0o555);

    try {
      const result = await runAutoSkillCurator(projectRoot, { now });
      expect(result.skippedErrors).toContain('auto-skill-err');
      expect(result.archived).not.toContain('auto-skill-err');
      const status = await getAutoSkillCuratorStatus(projectRoot, now);
      expect(status.lastRunAt).toBeDefined();
    } finally {
      await fs.chmod(skillsRoot, 0o755);
    }
  });

  it('prunes records whose directory exists in neither root', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifest = await writeSkill('auto-skill-gone', 'auto-skill', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'gone', level: 'project', filePath: manifest },
      old,
    );

    // Seed state with the skill present.
    await runAutoSkillCurator(projectRoot, {
      now: new Date(now.getTime() - 95 * DAY_MS),
    });

    // Delete the skill directory by hand.
    await fs.rm(path.join(projectRoot, '.qwen', 'skills', 'auto-skill-gone'), {
      recursive: true,
      force: true,
    });

    // Run again — the record should be pruned.
    await runAutoSkillCurator(projectRoot, { now });

    const statePath = path.join(projectRoot, '.qwen', 'skill-curator.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    expect(state.skills['auto-skill-gone']).toBeUndefined();
  });

  it('does not create a state file when no auto-skills exist', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    await fs.mkdir(path.join(projectRoot, '.qwen', 'skills'), {
      recursive: true,
    });

    const result = await maybeRunAutoSkillCurator(projectRoot, now);

    expect(result.status).toBe('seeded');
    if (result.status === 'seeded') {
      expect(result.checked).toBe(0);
    }
    const statePath = path.join(projectRoot, '.qwen', 'skill-curator.json');
    await expect(fs.lstat(statePath)).rejects.toThrow();
  });

  it('sanitizes directory names in pin error messages', async () => {
    const evil = 'auto-skill-evil\u001b[31m';
    await expect(setAutoSkillPinned(projectRoot, evil, true)).rejects.toThrow(
      JSON.stringify(evil),
    );
  });

  it('sanitizes directory names in restore error messages', async () => {
    const evil = 'auto-skill-evil\u001b[31m';
    await expect(restoreArchivedAutoSkill(projectRoot, evil)).rejects.toThrow(
      JSON.stringify(evil),
    );
  });
});
