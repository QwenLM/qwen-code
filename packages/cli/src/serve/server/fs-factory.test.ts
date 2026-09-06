/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseNewFileModePolicy,
  resolveBridgeFsFactory,
  resolveBoundWorkspacesFromIdeEnv,
} from './fs-factory.js';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
}));

const isPosix = process.platform !== 'win32';

const scratches: string[] = [];

async function mkScratch(): Promise<string> {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-fs-factory-'));
  scratches.push(scratch);
  return scratch;
}

async function mkdirs<const Names extends readonly string[]>(
  scratch: string,
  ...names: Names
): Promise<Record<Names[number], string>> {
  const out = {} as Record<Names[number], string>;
  for (const name of names) {
    const dir = path.join(scratch, name);
    await fsp.mkdir(dir, { recursive: true });
    out[name as Names[number]] = dir;
  }
  return out;
}

afterEach(async () => {
  await Promise.all(
    scratches
      .splice(0)
      .map((scratch) => fsp.rm(scratch, { recursive: true, force: true })),
  );
});

describe('resolveBoundWorkspacesFromIdeEnv', () => {
  it('keeps the selected workspace first for legacy and JSON encoded roots', async () => {
    const scratch = await mkScratch();
    const dirs = await mkdirs(scratch, 'first', 'second');
    const withDelimiter = path.join(scratch, `tool${path.delimiter}chain`);
    await fsp.mkdir(withDelimiter);

    expect(
      resolveBoundWorkspacesFromIdeEnv(
        dirs.second,
        [dirs.first, dirs.second].join(path.delimiter),
      ),
    ).toEqual([
      realpathSync.native(dirs.second),
      realpathSync.native(dirs.first),
    ]);

    expect(
      resolveBoundWorkspacesFromIdeEnv(
        dirs.second,
        JSON.stringify([dirs.second, withDelimiter]),
      ),
    ).toEqual([
      realpathSync.native(dirs.second),
      realpathSync.native(withDelimiter),
    ]);
  });

  it('falls back to the primary workspace for stale or malformed IDE env', async () => {
    const scratch = await mkScratch();
    const dirs = await mkdirs(scratch, 'primary', 'stale');
    const primary = realpathSync.native(dirs.primary);

    expect(resolveBoundWorkspacesFromIdeEnv(dirs.primary, dirs.stale)).toEqual([
      primary,
    ]);
    expect(resolveBoundWorkspacesFromIdeEnv(dirs.primary, '[not json')).toEqual(
      [primary],
    );
    expect(
      resolveBoundWorkspacesFromIdeEnv(dirs.primary, JSON.stringify([1, 2, 3])),
    ).toEqual([primary]);
    expect(
      resolveBoundWorkspacesFromIdeEnv(
        dirs.primary,
        JSON.stringify(['relative']),
      ),
    ).toEqual([primary]);
  });

  it('keeps valid sibling roots when one env workspace fails canonicalization', async () => {
    const scratch = await mkScratch();
    const dirs = await mkdirs(scratch, 'primary', 'blocked', 'sibling');
    const realpathSpy = vi
      .spyOn(realpathSync, 'native')
      .mockImplementation((p: Parameters<typeof realpathSync.native>[0]) => {
        if (String(p).endsWith(`${path.sep}blocked`)) {
          const err = new Error('blocked') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return String(p);
      });
    try {
      expect(
        resolveBoundWorkspacesFromIdeEnv(
          dirs.primary,
          JSON.stringify([dirs.primary, dirs.blocked, dirs.sibling]),
        ),
      ).toEqual([dirs.primary, dirs.sibling]);
      expect(realpathSpy).toHaveBeenCalledTimes(4);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it('drops relative delimiter entries before canonicalization', async () => {
    const scratch = await mkScratch();
    const dirs = await mkdirs(scratch, 'primary', 'secondary');

    expect(
      resolveBoundWorkspacesFromIdeEnv(
        dirs.primary,
        [dirs.primary, 'relative', dirs.secondary].join(path.delimiter),
      ),
    ).toEqual([
      realpathSync.native(dirs.primary),
      realpathSync.native(dirs.secondary),
    ]);
  });

  it('falls back to the primary string when primary canonicalization fails', async () => {
    const scratch = await mkScratch();
    const dirs = await mkdirs(scratch, 'primary');
    const realpathSpy = vi
      .spyOn(realpathSync, 'native')
      .mockImplementation((p: Parameters<typeof realpathSync.native>[0]) => {
        if (p === dirs.primary) {
          const err = new Error('blocked') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return String(p);
      });
    try {
      expect(resolveBoundWorkspacesFromIdeEnv(dirs.primary)).toEqual([
        dirs.primary,
      ]);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it('drops env parents without losing sibling roots', async () => {
    const scratch = await mkScratch();
    const parent = path.join(scratch, 'parent');
    const primary = path.join(parent, 'primary');
    const sibling = path.join(parent, 'sibling');
    await fsp.mkdir(primary, { recursive: true });
    await fsp.mkdir(sibling);

    expect(
      resolveBoundWorkspacesFromIdeEnv(
        primary,
        [parent, sibling].join(path.delimiter),
      ),
    ).toEqual([realpathSync.native(primary), realpathSync.native(sibling)]);
  });

  it('drops nested non-primary roots', async () => {
    const scratch = await mkScratch();
    const primary = path.join(scratch, 'primary');
    const parent = path.join(scratch, 'parent');
    const child = path.join(parent, 'child');
    await fsp.mkdir(primary, { recursive: true });
    await fsp.mkdir(child, { recursive: true });

    expect(
      resolveBoundWorkspacesFromIdeEnv(
        primary,
        [primary, parent, child].join(path.delimiter),
      ),
    ).toEqual([realpathSync.native(primary), realpathSync.native(parent)]);
  });
});

describe('parseNewFileModePolicy (QWEN_SERVE_NEW_FILE_MODE)', () => {
  // Earlier suites in this file legitimately warn through the same
  // helper; reset before AND after so call-count assertions here only
  // see this suite's own invocations.
  beforeEach(() => {
    mockWriteStderrLine.mockClear();
  });
  afterEach(() => {
    mockWriteStderrLine.mockClear();
  });

  it('defaults to owner when unset or empty', () => {
    expect(parseNewFileModePolicy({})).toBe('owner');
    expect(parseNewFileModePolicy({ QWEN_SERVE_NEW_FILE_MODE: '' })).toBe(
      'owner',
    );
    expect(parseNewFileModePolicy({ QWEN_SERVE_NEW_FILE_MODE: '   ' })).toBe(
      'owner',
    );
    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });

  it('accepts explicit owner spellings', () => {
    expect(parseNewFileModePolicy({ QWEN_SERVE_NEW_FILE_MODE: 'owner' })).toBe(
      'owner',
    );
    expect(parseNewFileModePolicy({ QWEN_SERVE_NEW_FILE_MODE: '0600' })).toBe(
      'owner',
    );
    expect(
      parseNewFileModePolicy({ QWEN_SERVE_NEW_FILE_MODE: ' OWNER ' }),
    ).toBe('owner');
    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });

  it('accepts system case-insensitively with surrounding whitespace', () => {
    expect(parseNewFileModePolicy({ QWEN_SERVE_NEW_FILE_MODE: 'system' })).toBe(
      'system',
    );
    expect(
      parseNewFileModePolicy({ QWEN_SERVE_NEW_FILE_MODE: ' System ' }),
    ).toBe('system');
    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });

  it('rejects unknown values with a warning and keeps the 0600 default', () => {
    expect(parseNewFileModePolicy({ QWEN_SERVE_NEW_FILE_MODE: '0644' })).toBe(
      'owner',
    );
    expect(
      parseNewFileModePolicy({ QWEN_SERVE_NEW_FILE_MODE: 'everyone' }),
    ).toBe('owner');
    expect(mockWriteStderrLine).toHaveBeenCalledTimes(2);
    expect(mockWriteStderrLine.mock.calls[0]?.[0]).toContain(
      'QWEN_SERVE_NEW_FILE_MODE',
    );
    expect(mockWriteStderrLine.mock.calls[0]?.[0]).toContain('0600 default');
  });
});

describe('resolveBridgeFsFactory env-var wiring (QWEN_SERVE_NEW_FILE_MODE)', () => {
  // Guards the seam between the documented env var and the daemon: every
  // production call site omits `newFileMode`, so `resolveBridgeFsFactory`
  // must derive the policy from `process.env` itself. A regression that
  // hard-codes the default here would silently disable the knob while every
  // injected-`newFileMode` unit test stayed green.
  it('derives the policy from process.env when newFileMode is not injected', async () => {
    if (!isPosix) return;
    const scratch = await mkScratch();
    const prevEnv = process.env['QWEN_SERVE_NEW_FILE_MODE'];
    const prevUmask = process.umask(0o002);
    process.env['QWEN_SERVE_NEW_FILE_MODE'] = 'system';
    try {
      const factory = resolveBridgeFsFactory({
        boundWorkspaces: [scratch],
        trusted: true,
      });
      const fs = factory.forRequest({ route: 'TEST /op' });
      const resolved = await fs.resolve('env-wired.txt', 'write');
      const out = await fs.writeTextOverwrite(resolved, 'hello\n');
      expect(out.created).toBe(true);
      const st = await fsp.lstat(resolved as string);
      // system policy: 0o666 & ~umask(0o002) = 0o664, not the 0o600 default.
      expect(st.mode & 0o7777).toBe(0o664);
    } finally {
      if (prevEnv === undefined) {
        delete process.env['QWEN_SERVE_NEW_FILE_MODE'];
      } else {
        process.env['QWEN_SERVE_NEW_FILE_MODE'] = prevEnv;
      }
      process.umask(prevUmask);
    }
  });

  it('keeps the fail-closed 0600 default when the env var is unset', async () => {
    // Mirror half of the seam guard above: with the variable unset the SAME
    // production seam must resolve to the fail-closed `owner` policy. A
    // regression that makes the unset default resolve to `system` flips
    // every agent-created new file to umask-derived modes (0o664 under
    // umask 0o002) with no warning — and only this test catches it.
    if (!isPosix) return;
    const scratch = await mkScratch();
    const prevEnv = process.env['QWEN_SERVE_NEW_FILE_MODE'];
    const prevUmask = process.umask(0o002);
    delete process.env['QWEN_SERVE_NEW_FILE_MODE'];
    try {
      const factory = resolveBridgeFsFactory({
        boundWorkspaces: [scratch],
        trusted: true,
      });
      const fs = factory.forRequest({ route: 'TEST /op' });
      const resolved = await fs.resolve('default-policy.txt', 'write');
      const out = await fs.writeTextOverwrite(resolved, 'default\n');
      expect(out.created).toBe(true);
      const st = await fsp.lstat(resolved as string);
      expect(st.mode & 0o7777).toBe(0o600);
    } finally {
      if (prevEnv === undefined) {
        delete process.env['QWEN_SERVE_NEW_FILE_MODE'];
      } else {
        process.env['QWEN_SERVE_NEW_FILE_MODE'] = prevEnv;
      }
      process.umask(prevUmask);
    }
  });
});
