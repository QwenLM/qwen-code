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
  resolveBoundWorkspacesFromIdeEnv,
} from './fs-factory.js';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
}));

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
