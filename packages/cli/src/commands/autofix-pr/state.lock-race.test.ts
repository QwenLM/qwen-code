/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The holder releases the lock between this helper's failed take and its
// read of the lock: the read is what the race reaches, so it is the one
// call made to fail.
const race = vi.hoisted(() => ({ lockPath: '', armed: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (race.armed && path === race.lockPath) {
      race.armed = false;
      actual.rmSync(race.lockPath, { force: true });
      throw Object.assign(new Error(`ENOENT: ${race.lockPath}`), {
        code: 'ENOENT',
      });
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(
      path,
      ...rest,
    );
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import(
  'node:fs'
);
const { autofixPrPaths, withWatchLock } = await import('./state.js');

describe('withWatchLock, released while it looks', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autofix-lock-race-'));
  });

  afterEach(() => {
    race.armed = false;
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes the lock its holder released after the take failed', () => {
    const paths = autofixPrPaths(dir, 7);
    mkdirSync(dirname(paths.lockPath), { recursive: true });
    // Held by a live helper: this very process, under another token.
    writeFileSync(
      paths.lockPath,
      JSON.stringify({ pid: process.pid, ns: null, at: Date.now(), id: 'x' }),
    );
    race.lockPath = paths.lockPath;
    race.armed = true;
    expect(withWatchLock(paths, 7, () => 'ran')).toBe('ran');
    expect(race.armed).toBe(false);
  });
});
