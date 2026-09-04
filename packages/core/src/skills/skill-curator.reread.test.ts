/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordAutoSkillUsage, runAutoSkillCurator } from './skill-curator.js';

// The archive guard re-reads the manifest just before moving it, so activity
// that lands between the initial scan and that re-read downgrades the skill
// instead of archiving it. Exercising that branch with a real race would be
// flaky, so only `open` is mocked (every other fs call stays real, keeping the
// temp-dir fixtures working): while `gate.active`, the second open of the
// target manifest first bumps its mtime — a concurrent edit — so the re-read
// sees fresher activity than the scan did.
const gate = vi.hoisted(() => ({
  active: false,
  opens: 0,
  target: '',
  fresh: new Date(0),
}));

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  type OpenParams = Parameters<typeof actual.open>;
  return {
    ...actual,
    open: vi.fn(
      async (
        filePath: OpenParams[0],
        flags?: OpenParams[1],
        mode?: OpenParams[2],
      ) => {
        if (gate.active && filePath === gate.target) {
          gate.opens += 1;
          if (gate.opens >= 2) {
            await actual.utimes(filePath, gate.fresh, gate.fresh);
          }
        }
        return actual.open(filePath, flags, mode);
      },
    ),
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe('auto-skill curator archive re-read guard', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skill-curator-reread-'),
    );
  });

  afterEach(async () => {
    gate.active = false;
    gate.opens = 0;
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

  it('downgrades to stale instead of archiving when the re-read is fresher', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const manifest = await writeSkill('auto-skill-reread', old);
    await recordAutoSkillUsage(
      projectRoot,
      { name: 'reread', level: 'project', filePath: manifest },
      old,
    );

    // The scan sees the 100-day-old mtime (archive-eligible); the re-read sees
    // activity 40 days ago — inside the 90-day archive window but past the
    // 30-day stale threshold, so the skill must be marked stale, not archived.
    gate.target = manifest;
    gate.fresh = new Date(now.getTime() - 40 * DAY_MS);
    gate.opens = 0;
    gate.active = true;

    const result = await runAutoSkillCurator(projectRoot, { now });

    expect(result.archived).toEqual([]);
    expect(result.markedStale).toEqual(['auto-skill-reread']);
    await expect(fs.access(manifest)).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(
          projectRoot,
          '.qwen',
          'archived-skills',
          'auto-skill-reread',
          'SKILL.md',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
