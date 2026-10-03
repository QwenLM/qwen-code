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
  const now = new Date('2026-07-27T00:00:00.000Z');
  const plusDays = (days: number, base = now) =>
    new Date(base.getTime() + days * DAY_MS);
  const qwenPath = (...segments: string[]) =>
    path.join(projectRoot, '.qwen', ...segments);
  const statePath = () => qwenPath('skill-curator.json');
  const readState = async () =>
    JSON.parse(await fs.readFile(statePath(), 'utf8')) as {
      skills: Record<
        string,
        {
          firstSeenAt: string;
          lastActivityAt: string;
          useCount: number;
          pinned?: boolean;
        }
      >;
    };
  const readStatus = (at = now) => getAutoSkillCuratorStatus(projectRoot, at);
  const curate = (options: { dryRun?: boolean; now?: Date } = {}) =>
    runAutoSkillCurator(projectRoot, { now, ...options });
  const restore = (directoryName: string) =>
    restoreArchivedAutoSkill(projectRoot, directoryName, now);
  const names = (entries: Array<{ directoryName: string }>) =>
    entries.map((entry) => entry.directoryName);
  const surfaced = async () => {
    const status = await readStatus();
    return names([...status.active, ...status.stale, ...status.archived]);
  };
  const expectPresent = (target: string) =>
    expect(fs.access(target)).resolves.toBeUndefined();
  const expectMissing = (target: string) =>
    expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skill-curator-'),
    );
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  const frontmatter = (
    name: string,
    description: string,
    source = 'auto-skill',
  ) => [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `source: ${source}`,
    '---',
    '',
  ];

  async function writeManifest(
    directory: string,
    lines: string[],
    modifiedAt?: Date,
  ): Promise<string> {
    const manifest = path.join(directory, 'SKILL.md');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(manifest, lines.join('\n'));
    if (modifiedAt) await fs.utimes(manifest, modifiedAt, modifiedAt);
    return manifest;
  }

  const writeSkill = (
    directoryName: string,
    source: string,
    modifiedAt: Date,
  ) =>
    writeManifest(
      qwenPath('skills', directoryName),
      [
        ...frontmatter(
          directoryName.replace(/^auto-skill-/, ''),
          directoryName,
          source,
        ),
        '# Skill',
      ],
      modifiedAt,
    );

  // Records a project-level use of the manifest under its frontmatter name.
  const recordUse = (
    filePath: string,
    at: Date,
    level: 'project' | 'user' = 'project',
  ) =>
    recordAutoSkillUsage(
      projectRoot,
      {
        name: path.basename(path.dirname(filePath)).replace(/^auto-skill-/, ''),
        level,
        filePath,
      },
      at,
    );

  // A managed auto-skill last modified and last used at `modifiedAt`, unless
  // `usedAt` says otherwise.
  async function writeUsedSkill(
    directoryName: string,
    modifiedAt: Date,
    usedAt = modifiedAt,
  ): Promise<string> {
    const manifest = await writeSkill(directoryName, 'auto-skill', modifiedAt);
    await recordUse(manifest, usedAt);
    return manifest;
  }

  it('only manages doubly-marked project auto-skills', async () => {
    const old = plusDays(-100);
    const managedManifest = await writeSkill(
      'auto-skill-managed',
      'auto-skill',
      old,
    );
    await writeSkill('hand-authored', 'auto-skill', old);
    await writeSkill('auto-skill-learned', 'learned', old);
    await recordUse(managedManifest, old);

    const status = await readStatus();

    expect(names(status.stale)).toEqual(['auto-skill-managed']);
    expect(status.active).toEqual([]);
  });

  it('does not leave a placeholder file beside the proper lock', async () => {
    await curate();

    await expect(
      fs.lstat(qwenPath('skill-curator.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('registers a lock-compromised handler and completes when the curator lock is compromised', async () => {
    const { lockSpy, getLockedFile, getOnCompromised } = mockCompromisedLock();

    try {
      await expect(curate()).resolves.toMatchObject({ dryRun: false });
      expect(getOnCompromised()).toBeTypeOf('function');
      expect(getLockedFile()).toBe(qwenPath('skill-curator.lock'));
    } finally {
      lockSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'ignores auto-skill directories whose names carry control/ANSI bytes',
    async () => {
      const old = plusDays(-100);

      // A crafted directory that satisfies the `auto-skill-` prefix and
      // basename checks and carries a VALID frontmatter name, so only the
      // directory-name charset guard can exclude it. Its name embeds an ESC
      // control sequence the non-interactive `/curator` output would otherwise
      // print verbatim (terminal control-sequence injection). A clean managed
      // skill keeps the enumeration itself exercised.
      const maliciousDir = 'auto-skill-[2J[31mevil';
      await writeManifest(
        qwenPath('skills', maliciousDir),
        [...frontmatter('evil', 'crafted'), '# Skill'],
        old,
      );
      await writeSkill('auto-skill-clean', 'auto-skill', old);

      const listed = await surfaced();

      expect(listed).toContain('auto-skill-clean');
      expect(listed).not.toContain(maliciousDir);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses an auto-skill whose manifest is a symlink',
    async () => {
      // A managed directory whose SKILL.md is a symlink (git mode 120000
      // survives a clone). Even though the link target is a valid auto-skill
      // manifest, the O_NOFOLLOW read refuses to follow it — so the skill is
      // not managed and a crafted target (e.g. /dev/zero) can never be read.
      const target = await writeSkill(
        'auto-skill-real',
        'auto-skill',
        plusDays(-100),
      );
      const linkedDir = qwenPath('skills', 'auto-skill-linked');
      await fs.mkdir(linkedDir, { recursive: true });
      await fs.symlink(target, path.join(linkedDir, 'SKILL.md'));

      const listed = await surfaced();

      expect(listed).not.toContain('auto-skill-linked');
      // The real, non-symlinked skill is still enumerated normally.
      expect(listed).toContain('auto-skill-real');
    },
  );

  it('keeps dry-run non-mutating while reporting first-sight seeding', async () => {
    await writeSkill('auto-skill-old', 'auto-skill', plusDays(-100));

    const result = await curate({ dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      checked: 1,
      seeded: ['auto-skill-old'],
      archived: [],
    });
    await expectMissing(statePath());
    await expectMissing(qwenPath('archived-skills'));
    await expectPresent(qwenPath('skills', 'auto-skill-old', 'SKILL.md'));
  });

  it('previews aged persisted candidates without changing state', async () => {
    await writeUsedSkill('auto-skill-old', plusDays(-100));
    const before = await fs.readFile(statePath(), 'utf8');

    const result = await curate({ dryRun: true });

    expect(result.archived).toEqual(['auto-skill-old']);
    expect(result.seeded).toEqual([]);
    await expect(fs.readFile(statePath(), 'utf8')).resolves.toBe(before);
    await expectMissing(qwenPath('archived-skills'));
  });

  it('seeds the first automatic observation before aging skills', async () => {
    await writeSkill('auto-skill-existing', 'auto-skill', plusDays(-200));

    await expect(maybeRunAutoSkillCurator(projectRoot, now)).resolves.toEqual({
      status: 'seeded',
      checked: 1,
    });
    await expectPresent(qwenPath('skills', 'auto-skill-existing'));
    await expect(
      maybeRunAutoSkillCurator(projectRoot, plusDays(6)),
    ).resolves.toEqual({ status: 'not_due' });

    const result = await maybeRunAutoSkillCurator(projectRoot, plusDays(91));
    expect(result.status).toBe('ran');
    if (result.status === 'ran') {
      expect(result.result.archived).toEqual(['auto-skill-existing']);
    }
  });

  it('preserves an existing usage baseline when seeding the first run', async () => {
    const usedAt = new Date('2026-04-01T00:00:00.000Z');
    // Usage recorded before the first curator run establishes the inactivity
    // baseline (firstSeenAt / lastActivityAt) at usedAt.
    await writeUsedSkill(
      'auto-skill-preseeded',
      plusDays(-200, usedAt),
      usedAt,
    );

    // The first automatic (seeding) run happens ~40 days later. It must not
    // reset the inactivity clock to `now`, or the stale transition would be
    // delayed by up to the full interval.
    await expect(
      maybeRunAutoSkillCurator(projectRoot, plusDays(40, usedAt)),
    ).resolves.toEqual({ status: 'seeded', checked: 1 });

    const record = (await readState()).skills['auto-skill-preseeded']!;
    expect(record.firstSeenAt).toBe(usedAt.toISOString());
    expect(record.lastActivityAt).toBe(usedAt.toISOString());
    expect(record.useCount).toBe(1);
  });

  it('marks inactive skills stale before archiving them', async () => {
    await writeUsedSkill('auto-skill-stale', plusDays(-40));

    const result = await curate();

    expect(result.markedStale).toEqual(['auto-skill-stale']);
    expect(result.archived).toEqual([]);
    await expectPresent(qwenPath('skills', 'auto-skill-stale'));
  });

  it('archives stale packages and restores them without overwriting', async () => {
    const manifest = await writeUsedSkill('auto-skill-old', plusDays(-100));
    const supportFile = qwenPath(
      'skills',
      'auto-skill-old',
      'references',
      'notes.md',
    );
    await fs.mkdir(path.dirname(supportFile), { recursive: true });
    await fs.writeFile(supportFile, 'keep me');

    const run = await curate();
    expect(run.archived).toEqual(['auto-skill-old']);
    await expect(recordUse(manifest, now)).resolves.toBe(false);
    await expect(
      fs.readFile(
        qwenPath('archived-skills', 'auto-skill-old', 'references', 'notes.md'),
        'utf8',
      ),
    ).resolves.toBe('keep me');

    await restore('auto-skill-old');
    await expect(fs.readFile(supportFile, 'utf8')).resolves.toBe('keep me');
    const status = await readStatus();
    expect(names(status.active)).toEqual(['auto-skill-old']);
  });

  it('refuses to restore over an existing active directory', async () => {
    await writeUsedSkill('auto-skill-old', plusDays(-100));
    const run = await curate();
    expect(run.archived).toEqual(['auto-skill-old']);

    // A new skill reclaims the archived directory name in the live library.
    const reusedManifest = await writeSkill(
      'auto-skill-old',
      'auto-skill',
      now,
    );
    await fs.writeFile(reusedManifest, 'REUSED');

    await expect(restore('auto-skill-old')).rejects.toThrow(
      'an active directory already exists',
    );

    // Neither the reused active directory nor the archived copy is disturbed.
    await expect(fs.readFile(reusedManifest, 'utf8')).resolves.toBe('REUSED');
    await expectPresent(
      qwenPath('archived-skills', 'auto-skill-old', 'SKILL.md'),
    );
  });

  it('protects recently used skills and increments durable usage', async () => {
    const usedAt = new Date('2026-07-27T00:00:00.000Z');
    const manifest = await writeSkill(
      'auto-skill-used',
      'auto-skill',
      plusDays(-200, usedAt),
    );

    await expect(recordUse(manifest, usedAt)).resolves.toBe(true);
    const run = await curate({
      now: new Date(usedAt.getTime() + AUTO_SKILL_ARCHIVE_AFTER_MS - DAY_MS),
    });

    expect(run.archived).toEqual([]);
    const state = await readState();
    expect(state.skills['auto-skill-used']!.firstSeenAt).toBe(
      usedAt.toISOString(),
    );
    const status = await readStatus(plusDays(1, usedAt));
    expect(status.active[0]).toMatchObject({
      directoryName: 'auto-skill-used',
      useCount: 1,
    });
  });

  it('treats a recent manifest edit as activity', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z');
    const manifest = await writeUsedSkill('auto-skill-edited', old);
    await fs.utimes(manifest, now, now);

    const run = await curate();

    expect(run.archived).toEqual([]);
    expect(run.reactivated).toEqual([]);
  });

  it('reactivates a stale skill once activity resumes', async () => {
    const manifest = await writeUsedSkill('auto-skill-revived', plusDays(-40));

    const staleRun = await curate();
    expect(staleRun.markedStale).toEqual(['auto-skill-revived']);
    expect(staleRun.reactivated).toEqual([]);

    await fs.utimes(manifest, now, now);
    const revivedRun = await curate();

    expect(revivedRun.reactivated).toEqual(['auto-skill-revived']);
    expect(revivedRun.archived).toEqual([]);
    expect(revivedRun.markedStale).toEqual([]);
  });

  it('fails closed on corrupt state without moving a skill', async () => {
    const manifest = await writeSkill(
      'auto-skill-old',
      'auto-skill',
      plusDays(-100),
    );
    await fs.writeFile(statePath(), '{broken');

    await expect(curate()).rejects.toThrow('Invalid auto-skill curator state');
    await expectPresent(manifest);
  });

  it('fails closed on corrupt state without restoring an archived skill', async () => {
    await writeUsedSkill('auto-skill-old', plusDays(-100));
    await curate();
    const archivedManifest = qwenPath(
      'archived-skills',
      'auto-skill-old',
      'SKILL.md',
    );
    await fs.writeFile(statePath(), '{broken');

    await expect(restore('auto-skill-old')).rejects.toThrow(
      'Invalid auto-skill curator state',
    );
    await expectPresent(archivedManifest);
    await expectMissing(qwenPath('skills', 'auto-skill-old', 'SKILL.md'));
  });

  it('skips archive collisions while continuing with other packages', async () => {
    const old = plusDays(-100);
    const liveManifest = await writeUsedSkill('auto-skill-collision', old);
    const otherManifest = await writeUsedSkill('auto-skill-other', old);
    const archivedDirectory = qwenPath(
      'archived-skills',
      'auto-skill-collision',
    );
    await fs.mkdir(archivedDirectory, { recursive: true });
    await fs.writeFile(path.join(archivedDirectory, 'sentinel'), 'preserve');

    const result = await curate();

    expect(result.skippedCollisions).toEqual(['auto-skill-collision']);
    expect(result.archived).toEqual(['auto-skill-other']);
    await expectPresent(liveManifest);
    await expectMissing(otherManifest);
    await expect(
      fs.readFile(path.join(archivedDirectory, 'sentinel'), 'utf8'),
    ).resolves.toBe('preserve');
  });

  it('reports archive collisions during a dry run', async () => {
    const liveManifest = await writeUsedSkill(
      'auto-skill-collision',
      plusDays(-100),
    );
    await fs.mkdir(qwenPath('archived-skills', 'auto-skill-collision'), {
      recursive: true,
    });

    const result = await curate({ dryRun: true });

    expect(result.skippedCollisions).toEqual(['auto-skill-collision']);
    expect(result.archived).toEqual([]);
    await expectPresent(liveManifest);
  });

  it('seeds an unseen skill on an explicit run before aging it', async () => {
    const manifest = await writeSkill(
      'auto-skill-legacy',
      'auto-skill',
      plusDays(-200),
    );

    const result = await curate();

    expect(result.seeded).toEqual(['auto-skill-legacy']);
    expect(result.archived).toEqual([]);
    await expectPresent(manifest);
  });

  it('keeps pinned skills active until they are unpinned', async () => {
    await writeUsedSkill('auto-skill-important', plusDays(-100));

    await setAutoSkillPinned(projectRoot, 'auto-skill-important', true, now);
    const pinnedRun = await curate();
    expect(pinnedRun.archived).toEqual([]);
    expect((await readStatus()).active[0]).toMatchObject({
      directoryName: 'auto-skill-important',
      pinned: true,
    });

    await setAutoSkillPinned(projectRoot, 'auto-skill-important', false, now);
    const unpinnedRun = await curate();
    expect(unpinnedRun.archived).toEqual(['auto-skill-important']);
  });

  it('loads version 1 state written before pinning was added', async () => {
    await writeUsedSkill('auto-skill-legacy', now);
    const state = await readState();
    delete state.skills['auto-skill-legacy']!.pinned;
    await fs.writeFile(statePath(), JSON.stringify(state));

    const status = await readStatus();

    expect(status.active[0]).toMatchObject({
      directoryName: 'auto-skill-legacy',
      pinned: false,
    });
  });

  it('ignores non-project usage records', async () => {
    const manifest = await writeSkill('auto-skill-user', 'auto-skill', now);

    await expect(recordUse(manifest, now, 'user')).resolves.toBe(false);
  });

  it('ignores project usage records outside the skills root', async () => {
    const manifest = await writeManifest(
      qwenPath('outside', 'auto-skill-evil'),
      frontmatter('evil', 'outside the managed skills root'),
    );

    await expect(recordUse(manifest, now)).resolves.toBe(false);
  });

  it('rejects archive directory traversal during restore', async () => {
    const traversalTarget = qwenPath('outside');
    await fs.mkdir(qwenPath('archived-skills'), { recursive: true });
    await writeManifest(traversalTarget, [
      ...frontmatter('outside', 'traversal target'),
      '# Outside',
    ]);

    await expect(
      restore('auto-skill-placeholder/../../outside'),
    ).rejects.toThrow('Archived auto-skill not found');
    expect((await fs.lstat(traversalTarget)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked state file',
    async () => {
      await writeSkill('auto-skill-old', 'auto-skill', plusDays(-100));
      const external = path.join(projectRoot, 'external-state.json');
      await fs.writeFile(external, JSON.stringify({ version: 1, skills: {} }));
      await fs.symlink(external, statePath());

      // The target is valid JSON, so this only rejects because the read path
      // refuses to follow the symlink at all.
      await expect(readStatus()).rejects.toThrow('refuses unsafe path');
    },
  );

  it('refuses a non-regular-file state file', async () => {
    await writeSkill('auto-skill-old', 'auto-skill', plusDays(-100));
    await fs.mkdir(statePath(), { recursive: true });

    await expect(curate({ dryRun: true })).rejects.toThrow(
      'refuses unsafe path',
    );
  });

  it('fails closed on an oversized state file', async () => {
    await writeSkill('auto-skill-old', 'auto-skill', plusDays(-100));
    // A regular file just over the 1 MiB read cap.
    await fs.writeFile(
      statePath(),
      `{"version":1,"skills":{},"pad":"${'x'.repeat(1024 * 1024)}"}`,
    );

    await expect(readStatus()).rejects.toThrow(
      'Invalid auto-skill curator state',
    );
  });

  it('distinguishes a present but ineligible archived skill from a missing one', async () => {
    // A manifest that lost its frontmatter is present but not eligible.
    await writeManifest(qwenPath('archived-skills', 'auto-skill-broken'), [
      '# no frontmatter',
    ]);

    await expect(restore('auto-skill-broken')).rejects.toThrow(
      'is not an eligible managed skill',
    );
    await expect(restore('auto-skill-absent')).rejects.toThrow(
      'Archived auto-skill not found',
    );
  });

  it('clamps a future manifest mtime so the skill remains curatable', async () => {
    const future = plusDays(10 * 365);
    const manifest = await writeUsedSkill('auto-skill-future', plusDays(-180));
    // Stamp the manifest far in the future (clock skew, backup restore).
    await fs.utimes(manifest, future, future);

    const result = await curate();

    expect(result.archived).toEqual(['auto-skill-future']);
  });

  it('does not double-list a directory present in both live and archived roots', async () => {
    await writeUsedSkill('auto-skill-dup', plusDays(-100));
    await curate();

    // Recreate the same directory name in the live library.
    await writeSkill('auto-skill-dup', 'auto-skill', now);

    const status = await readStatus();

    const allNames = names([
      ...status.active,
      ...status.stale,
      ...status.archived,
    ]);
    const dupCount = allNames.filter((n) => n === 'auto-skill-dup').length;
    expect(dupCount).toBe(1);
    expect(names(status.active)).toContain('auto-skill-dup');
    expect(names(status.archived)).not.toContain('auto-skill-dup');
  });

  it('isolates a per-skill rename failure and still persists state', async () => {
    const old = plusDays(-100);
    await writeUsedSkill('auto-skill-a', old);
    await writeUsedSkill('auto-skill-b', old);

    // Block rename for auto-skill-a by placing a file at its archive
    // destination, so it fails while auto-skill-b still archives.
    const archiveRoot = qwenPath('archived-skills');
    await fs.mkdir(archiveRoot, { recursive: true });
    await fs.writeFile(path.join(archiveRoot, 'auto-skill-a'), 'blocker');

    const result = await curate();

    // auto-skill-a hits a collision (lstat succeeds → skippedCollisions).
    expect(result.skippedCollisions).toContain('auto-skill-a');
    // auto-skill-b archives normally.
    expect(result.archived).toContain('auto-skill-b');
    // State was persisted (lastRunAt is set).
    const status = await readStatus();
    expect(status.lastRunAt).toBeDefined();
  });

  it.skipIf(process.platform === 'win32')(
    'reports skippedErrors when rename fails transiently',
    async () => {
      await writeUsedSkill('auto-skill-err', plusDays(-100));

      // Seed state so the curator proceeds past the seeding branch.
      await curate({ now: plusDays(-95) });

      // Ensure the archive root exists, then remove write permission from the
      // skills root so rename (which needs write on the source parent) fails
      // with EACCES while lstat on the destination still succeeds.
      const skillsRoot = qwenPath('skills');
      await fs.mkdir(qwenPath('archived-skills'), { recursive: true });
      await fs.chmod(skillsRoot, 0o555);

      try {
        const result = await curate();
        expect(result.skippedErrors).toContain('auto-skill-err');
        expect(result.archived).not.toContain('auto-skill-err');
        const status = await readStatus();
        expect(status.lastRunAt).toBeDefined();
      } finally {
        await fs.chmod(skillsRoot, 0o755);
      }
    },
  );

  it('prunes records whose directory exists in neither root', async () => {
    await writeUsedSkill('auto-skill-gone', plusDays(-100));

    // Seed state with the skill present.
    await curate({ now: plusDays(-95) });

    // Delete the skill directory by hand.
    await fs.rm(qwenPath('skills', 'auto-skill-gone'), {
      recursive: true,
      force: true,
    });

    // Run again — the record should be pruned.
    await curate();

    const state = await readState();
    expect(state.skills['auto-skill-gone']).toBeUndefined();
  });

  it('does not create a state file when no auto-skills exist', async () => {
    await fs.mkdir(qwenPath('skills'), { recursive: true });

    const result = await maybeRunAutoSkillCurator(projectRoot, now);

    expect(result.status).toBe('seeded');
    if (result.status === 'seeded') {
      expect(result.checked).toBe(0);
    }
    await expect(fs.lstat(statePath())).rejects.toThrow();
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
