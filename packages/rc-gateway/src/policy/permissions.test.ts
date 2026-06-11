/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  checkPolicyFilePermissions,
  formatInsecurePolicyWarning,
  NON_OWNER_WRITE_MASK,
} from './permissions.js';

const USER = '/home/u/.qwen/rc/policy.yaml';
const WS = '/ws/.qwen/policy.yaml';

/** A stat fake over a path->mode map; an absent path throws ENOENT. */
function statFake(modes: Record<string, number>) {
  return async (path: string) => {
    if (!(path in modes)) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return { mode: modes[path] };
  };
}

describe('checkPolicyFilePermissions', () => {
  it('flags a world-writable file', async () => {
    const r = await checkPolicyFilePermissions(
      [USER],
      statFake({ [USER]: 0o100666 }),
    );
    expect(r).toEqual([{ path: USER, mode: 0o666 }]);
  });

  it('flags a group-writable file (broadened mask)', async () => {
    // 0o660 = rw-rw---- : group has WRITE (0o020), so it is flagged.
    const r = await checkPolicyFilePermissions(
      [USER],
      statFake({ [USER]: 0o100660 }),
    );
    expect(r).toEqual([{ path: USER, mode: 0o660 }]);
  });

  it('does NOT flag a 0600 file', async () => {
    const r = await checkPolicyFilePermissions(
      [USER],
      statFake({ [USER]: 0o100600 }),
    );
    expect(r).toEqual([]);
  });

  it('does NOT flag a 0644 file (group/world read-only)', async () => {
    const r = await checkPolicyFilePermissions(
      [USER],
      statFake({ [USER]: 0o100644 }),
    );
    expect(r).toEqual([]);
  });

  it('skips a missing file (ENOENT) without throwing', async () => {
    const r = await checkPolicyFilePermissions([USER], statFake({}));
    expect(r).toEqual([]);
  });

  it('skips a path whose stat throws a non-ENOENT error', async () => {
    const statFn = async (): Promise<{ mode: number }> => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    const r = await checkPolicyFilePermissions([USER], statFn);
    expect(r).toEqual([]);
  });

  it('reports only the offending file among several paths', async () => {
    const r = await checkPolicyFilePermissions(
      [USER, WS],
      statFake({ [USER]: 0o100600, [WS]: 0o100662 }),
    );
    expect(r).toEqual([{ path: WS, mode: 0o662 }]);
  });

  it('masks off the file-type bits, keeping only the permission bits', async () => {
    const r = await checkPolicyFilePermissions(
      [USER],
      statFake({ [USER]: 0o100777 }),
    );
    expect(r[0].mode).toBe(0o777);
  });

  it('the mask is group+world write', () => {
    expect(NON_OWNER_WRITE_MASK).toBe(0o022);
  });
});

describe('formatInsecurePolicyWarning', () => {
  it('contains the path, the octal mode, and a chmod fix hint', () => {
    const msg = formatInsecurePolicyWarning({ path: USER, mode: 0o666 });
    expect(msg).toContain(USER);
    expect(msg).toContain('0666');
    expect(msg).toContain('chmod go-w');
  });

  it('zero-pads a short octal mode', () => {
    const msg = formatInsecurePolicyWarning({ path: USER, mode: 0o20 });
    expect(msg).toContain('0020');
  });
});
