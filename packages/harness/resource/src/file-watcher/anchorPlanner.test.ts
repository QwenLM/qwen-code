/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveWatchTarget,
  signalRegistrationAnchors,
} from './anchorPlanner.js';

const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anchor-planner-test-'));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('anchor planner', () => {
  it('uses an existing target and its flat parent without watching the logical root recursively', async () => {
    const projectRoot = await makeTempDir();
    const watchedDir = join(projectRoot, '.qwen', 'skills');
    await mkdir(watchedDir, { recursive: true });

    const target = resolveWatchTarget(watchedDir, projectRoot);
    const anchors = signalRegistrationAnchors(target);

    expect(anchors).toEqual(
      expect.arrayContaining([
        { anchor: await realpath(watchedDir), flat: false },
        { anchor: await realpath(join(projectRoot, '.qwen')), flat: true },
      ]),
    );
    expect(anchors).not.toContainEqual({
      anchor: projectRoot,
      flat: false,
    });
  });

  it('anchors a missing target at the nearest existing parent', async () => {
    const projectRoot = await makeTempDir();
    const configRoot = join(projectRoot, '.qwen');
    await mkdir(configRoot);

    const target = resolveWatchTarget(join(configRoot, 'skills'), projectRoot);

    expect(target).toMatchObject({
      anchor: await realpath(configRoot),
      flat: true,
      fallback: true,
    });
  });

  it('adds a flat guard for a symlink ancestor', async () => {
    const projectRoot = await makeTempDir();
    const externalRoot = await makeTempDir();
    const realAgents = join(externalRoot, 'agents');
    await mkdir(join(realAgents, 'skills'), { recursive: true });
    const agentsLink = join(projectRoot, '.agents');
    await symlink(realAgents, agentsLink);
    await writeFile(join(realAgents, 'skills', 'SKILL.md'), '');

    const target = resolveWatchTarget(
      join(agentsLink, 'skills'),
      projectRoot,
    );

    expect(target.entryGuards).toContainEqual({
      entry: agentsLink,
      matchedEntry: join(await realpath(projectRoot), '.agents'),
      anchor: await realpath(projectRoot),
    });
  });
});
