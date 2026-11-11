/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillUsage } from './skillUsage.js';

describe('Skill usage for listing priority', () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'skill-usage-'));
    file = path.join(directory, 'skill-usage.json');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('persists frequency, debounces within a minute, and applies the native weekly decay and floor', async () => {
    const usage = new SkillUsage(file);
    const now = 1_800_000_000_000;
    expect(usage.getScore('inspect', now)).toBe(0);
    await usage.record('inspect', now);
    await usage.record('inspect', now + 59_999);
    await usage.record('inspect', now + 60_000);
    const resumed = new SkillUsage(file);
    expect(resumed.getScore('inspect', now + 60_000)).toBe(2);
    expect(resumed.getScore('inspect', now + 60_000 + 7 * 86_400_000)).toBe(1);
    expect(resumed.getScore('inspect', now + 60_000 + 70 * 86_400_000)).toBe(
      0.2,
    );
  });

  it('merges concurrent session updates without losing unrelated skills', async () => {
    await Promise.all([
      new SkillUsage(file).record('first', 1000),
      new SkillUsage(file).record('second', 1000),
    ]);
    expect(
      Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort(),
    ).toEqual(['first', 'second']);
  });

  it('ignores malformed advisory history without blocking activation', async () => {
    await writeFile(file, '{invalid');
    const usage = new SkillUsage(file);
    expect(usage.getScore('inspect')).toBe(0);
    await expect(usage.record('inspect')).resolves.toBeUndefined();
    expect(usage.getScore('inspect')).toBeCloseTo(1);
  });
});
