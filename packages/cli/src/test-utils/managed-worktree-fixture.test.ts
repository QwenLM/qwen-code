/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupManagedWorktreeFixture } from './managed-worktree-fixture.js';

// The fixture's git setup must be atomic: when it fails partway (git missing,
// EACCES, a full tmpfs), the helper removes the directories it already
// created before rethrowing, so callers — which bind repo/runtimeBase only
// from the return value — neither leak temp directories nor see a teardown
// error on top of the real failure.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    },
  };
});

// Per-test failure injection for the two fs calls whose failure modes the
// edge cases below pin. Both hooks default to the real behavior.
const fsHooks = vi.hoisted(() => ({
  failMkdtempPrefix: null as string | null,
  rmSyncThrows: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: ((prefix: string) => {
      if (
        fsHooks.failMkdtempPrefix !== null &&
        prefix.includes(fsHooks.failMkdtempPrefix)
      ) {
        throw Object.assign(new Error('mkdtemp EIO'), { code: 'EIO' });
      }
      return actual.mkdtempSync(prefix);
    }) as typeof actual.mkdtempSync,
    rmSync: ((...args: Parameters<typeof actual.rmSync>) => {
      if (fsHooks.rmSyncThrows) {
        throw Object.assign(new Error('rmSync EPERM'), { code: 'EPERM' });
      }
      return actual.rmSync(...args);
    }) as typeof actual.rmSync,
  };
});

describe('setupManagedWorktreeFixture', () => {
  const tmpVars = ['TMPDIR', 'TEMP', 'TMP'] as const;
  let isolatedTmp: string | undefined;
  let savedEnv: Partial<Record<(typeof tmpVars)[number], string>> = {};

  const isolateTmpdir = (): string => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-fail-tmp-'));
    isolatedTmp = tmp;
    for (const key of tmpVars) {
      savedEnv[key] = process.env[key];
      process.env[key] = tmp;
    }
    expect(fs.readdirSync(tmp)).toEqual([]);
    return tmp;
  };

  afterEach(() => {
    fsHooks.failMkdtempPrefix = null;
    fsHooks.rmSyncThrows = false;
    if (isolatedTmp === undefined) {
      return;
    }
    for (const key of tmpVars) {
      const saved = savedEnv[key];
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
    fs.rmSync(isolatedTmp, { recursive: true, force: true });
    isolatedTmp = undefined;
    savedEnv = {};
  });

  it('removes its own directories when git setup fails', () => {
    const tmp = isolateTmpdir();

    expect(() => setupManagedWorktreeFixture()).toThrow(/ENOENT/);

    // The failed setup must leave neither managed-* directory behind.
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('removes the first directory when the second mkdtemp fails', () => {
    const tmp = isolateTmpdir();

    fsHooks.failMkdtempPrefix = 'managed-git-runtime-';
    try {
      expect(() => setupManagedWorktreeFixture()).toThrow(/EIO/);
    } finally {
      fsHooks.failMkdtempPrefix = null;
    }

    // The repo directory created before the failure must be gone too.
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('surfaces the setup error, not a cleanup failure', () => {
    isolateTmpdir();

    fsHooks.rmSyncThrows = true;
    try {
      // execFileSync throws ENOENT (file-wide mock); rmSync throwing EPERM
      // during cleanup must not replace that original error.
      expect(() => setupManagedWorktreeFixture()).toThrow(/ENOENT/);
    } finally {
      fsHooks.rmSyncThrows = false;
    }
  });
});
