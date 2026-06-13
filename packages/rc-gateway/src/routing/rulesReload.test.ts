/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLayeredRoutingMatcherStrict, RoutingError } from './rules.js';

describe('loadLayeredRoutingMatcherStrict (hot-reload loader)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-routing-reload-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('neither file present → no matcher, 0 rules', async () => {
    const res = await loadLayeredRoutingMatcherStrict(
      join(dir, 'routing.yaml'),
      undefined,
    );
    expect(res).toEqual({ matcher: undefined, ruleCount: 0 });
  });

  it('valid user file → compiled matcher with the rule count', async () => {
    const userPath = join(dir, 'routing.yaml');
    await writeFile(
      userPath,
      'rules:\n  - id: r1\n    match: { kind: task.completed }\n    route: { drop: true }\n',
      'utf8',
    );
    const res = await loadLayeredRoutingMatcherStrict(userPath, undefined);
    expect(res.ruleCount).toBe(1);
    expect(res.matcher?.firstDrop({ kind: 'task.completed' })).toBe('r1');
  });

  it('THROWS on a malformed user file (so a reload retains the prior ruleset)', async () => {
    const userPath = join(dir, 'routing.yaml');
    await writeFile(userPath, 'rules: not-a-sequence\n', 'utf8');
    await expect(
      loadLayeredRoutingMatcherStrict(userPath, undefined),
    ).rejects.toBeInstanceOf(RoutingError);
  });

  it('THROWS on a malformed WORKSPACE layer (never silently widens)', async () => {
    const userPath = join(dir, 'routing.yaml');
    await writeFile(userPath, 'rules: []\n', 'utf8');
    const wsCwd = join(dir, 'ws');
    await mkdir(join(wsCwd, '.qwen'), { recursive: true });
    await writeFile(
      join(wsCwd, '.qwen', 'routing.yaml'),
      '- not a map\n',
      'utf8',
    );
    await expect(
      loadLayeredRoutingMatcherStrict(userPath, wsCwd),
    ).rejects.toBeInstanceOf(RoutingError);
  });

  it('a MISSING file (ENOENT) is not an error — workspace layer alone applies', async () => {
    // user routing.yaml absent (intended removal); workspace provides the rule.
    const wsCwd = join(dir, 'ws');
    await mkdir(join(wsCwd, '.qwen'), { recursive: true });
    await writeFile(
      join(wsCwd, '.qwen', 'routing.yaml'),
      'rules:\n  - id: w1\n    match: { kind: task.completed }\n    route: { drop: true }\n',
      'utf8',
    );
    const res = await loadLayeredRoutingMatcherStrict(
      join(dir, 'routing.yaml'),
      wsCwd,
    );
    expect(res.ruleCount).toBe(1);
    expect(res.matcher?.firstDrop({ kind: 'task.completed' })).toBe('w1');
  });
});
