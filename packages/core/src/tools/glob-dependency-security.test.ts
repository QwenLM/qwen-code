/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { escape, Glob, globSync, Ignore } from 'glob';
import { afterEach, beforeEach, expect, it } from 'vitest';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'qwen-glob-security-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('enforces the expansion budget during globstar parent optimization', () => {
  const pattern = '**/../a/b/'.repeat(8) + 'target';

  expect(
    () => new Glob(pattern, { cwd: directory, braceExpandMax: 32 }),
  ).toThrow(RangeError);
});

it('enforces the expansion budget in ignore matchers', () => {
  const pattern = '**/../a/b/'.repeat(8) + 'target';
  expect(() => new Ignore([pattern], { braceExpandMax: 32 })).toThrow(
    RangeError,
  );
});

it('finds ordinary and escaped literal names with the installed matcher', async () => {
  const names = ['normal.ts', '#note[1].ts', '!report(1).ts'];
  await Promise.all(
    names.map((name) => writeFile(path.join(directory, name), '')),
  );

  expect(globSync('*.ts', { cwd: directory }).sort()).toEqual(
    [...names].sort(),
  );
  for (const name of names) {
    expect(globSync(escape(name), { cwd: directory })).toEqual([name]);
  }
});
