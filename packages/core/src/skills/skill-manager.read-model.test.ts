/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guard for #8079 — workspace skill status polling repeatedly
 * triggered full skill rescans (232,406 `SKILL_LOAD` lines in one daemon
 * session).
 *
 * Deliberately unmocked: the rest of `skill-manager.test.ts` mocks `fs`, which
 * can only prove that `refreshCache()` was not *called*. The invariant that
 * actually broke is that a status read must not touch the filesystem, so this
 * file drives a real temp tree and counts syscalls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillManager } from './skill-manager.js';
import type { Config } from '../config/config.js';

// Counting wrappers that delegate to the real implementations — ESM namespaces
// are not configurable, so `vi.spyOn` cannot be used on them directly.
const { readFileSpy, readdirSpy } = vi.hoisted(() => ({
  readFileSpy: vi.fn(),
  readdirSpy: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  readFileSpy.mockImplementation(actual.readFile);
  readdirSpy.mockImplementation(actual.readdir);
  return {
    ...actual,
    default: actual,
    readFile: readFileSpy,
    readdir: readdirSpy,
  };
});

const fsPromises = await import('fs/promises');

const SKILL_COUNT = 6;

function makeSkillManagerConfig(projectRoot: string): Config {
  return {
    isSafeMode: () => false,
    getBareMode: () => false,
    getProjectRoot: () => projectRoot,
    getActiveExtensions: () => [],
  } as unknown as Config;
}

describe('workspace skills read model (real filesystem)', () => {
  let projectRoot: string;
  let manager: SkillManager;

  beforeEach(async () => {
    projectRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'qwen-skill-read-model-'),
    );
    const skillsDir = path.join(projectRoot, '.qwen', 'skills');
    for (let i = 0; i < SKILL_COUNT; i++) {
      const dir = path.join(skillsDir, `skill-${i}`);
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: skill-${i}\ndescription: Skill number ${i}\n---\n\nBody ${i}\n`,
        'utf-8',
      );
    }

    manager = new SkillManager(makeSkillManagerConfig(projectRoot));
    // Cleared after the tree is built so fixture setup is not counted.
    readFileSpy.mockClear();
    readdirSpy.mockClear();
  });

  afterEach(async () => {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  });

  it('serves repeated cached reads without any filesystem work', async () => {
    await manager.refreshCache();

    // Sanity: the refresh really did the scan and parse we are about to assert
    // does not repeat. Without this the test would also pass if the fixture
    // silently produced no skills. Counts are scoped to the project level —
    // user and bundled levels resolve against the real environment.
    const readsAfterRefresh = readFileSpy.mock.calls.length;
    const dirReadsAfterRefresh = readdirSpy.mock.calls.length;
    expect(manager.getCachedSkills('project')).toHaveLength(SKILL_COUNT);
    expect(readsAfterRefresh).toBeGreaterThanOrEqual(SKILL_COUNT);
    expect(dirReadsAfterRefresh).toBeGreaterThan(0);

    // The shape of the reported bug: many status reads in a row.
    for (let i = 0; i < 50; i++) {
      expect(manager.getCachedSkills('project')).toHaveLength(SKILL_COUNT);
    }

    expect(readFileSpy.mock.calls.length).toBe(readsAfterRefresh);
    expect(readdirSpy.mock.calls.length).toBe(dirReadsAfterRefresh);
  });

  it('reports a cold cache instead of warming it', async () => {
    expect(manager.getCachedSkills()).toBeNull();
    // A cold read must stay cold — this is what lets the daemon represent
    // "not initialized yet" instead of a status request paying for discovery.
    expect(manager.getCachedSkills()).toBeNull();

    expect(readFileSpy).not.toHaveBeenCalled();
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it('still picks up on-disk changes through an explicit refresh', async () => {
    await manager.refreshCache();
    expect(manager.getCachedSkills('project')).toHaveLength(SKILL_COUNT);

    const added = path.join(projectRoot, '.qwen', 'skills', 'skill-added');
    await fsPromises.mkdir(added, { recursive: true });
    await fsPromises.writeFile(
      path.join(added, 'SKILL.md'),
      '---\nname: skill-added\ndescription: Added later\n---\n\nBody\n',
      'utf-8',
    );

    // Cached read stays on the committed snapshot...
    expect(manager.getCachedSkills('project')).toHaveLength(SKILL_COUNT);
    // ...and the explicit refresh is what publishes the new one.
    await manager.refreshCache();
    expect(manager.getCachedSkills('project')).toHaveLength(SKILL_COUNT + 1);
  });
});
