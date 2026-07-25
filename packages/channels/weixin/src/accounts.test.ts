/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAccount,
  saveAccount,
  clearAccount,
  DEFAULT_BASE_URL,
  type AccountData,
} from './accounts.js';

// Pass-through spies: the real fs is used, but the mode the credential file is
// *created* with stays observable, and the rename can be made to fail on
// demand. A permission check after the fact cannot see the mode — write-then-
// chmod ends at 0600 too, it is just briefly readable on the way there.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const DATA: AccountData = {
  token: 'super-secret-token',
  baseUrl: DEFAULT_BASE_URL,
  userId: 'user-1',
  savedAt: '2026-01-01T00:00:00.000Z',
};

let stateDir: string;
const previous = process.env['WEIXIN_STATE_DIR'];

/** Permission bits of a path, as an octal string like "600". */
function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

/** Temp files left in the state dir. The name is unique per save, so this
 *  cannot be a fixed path. */
function tmpFiles(): string[] {
  return readdirSync(stateDir).filter((f) => f.endsWith('.tmp'));
}

beforeEach(() => {
  vi.mocked(writeFileSync).mockClear();
  vi.mocked(renameSync).mockClear();
  stateDir = mkdtempSync(join(tmpdir(), 'weixin-accounts-'));
  process.env['WEIXIN_STATE_DIR'] = stateDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env['WEIXIN_STATE_DIR'];
  else process.env['WEIXIN_STATE_DIR'] = previous;
  rmSync(stateDir, { recursive: true, force: true });
});

describe('saveAccount', () => {
  it('round-trips the account data', () => {
    saveAccount(DATA);
    expect(loadAccount()).toEqual(DATA);
  });

  it('never creates the credential file at umask-default permissions', () => {
    saveAccount(DATA);

    // Every write that carries the token must request 0600 up front. Under the
    // usual 022 umask an unmoded write lands at 0644 — group- and
    // world-readable until a follow-up chmod closes it.
    const tokenWrites = vi
      .mocked(writeFileSync)
      .mock.calls.filter(([, contents]) =>
        String(contents).includes(DATA.token),
      );
    expect(tokenWrites.length).toBeGreaterThan(0);
    for (const [, , options] of tokenWrites) {
      expect(options).toMatchObject({ mode: 0o600 });
    }
  });

  it('leaves the credential file private to the owner', () => {
    saveAccount(DATA);
    expect(mode(join(stateDir, 'account.json'))).toBe('600');
  });

  it('narrows a world-readable file left by an older version', () => {
    // `mode` on writeFileSync is ignored for a file that already exists, so a
    // fix that only passes the option would leave this at 644. The rename is
    // what repairs it: it carries the temp file's 0600 onto the destination.
    const p = join(stateDir, 'account.json');
    writeFileSync(p, '{"token":"stale"}', 'utf-8');
    chmodSync(p, 0o644);
    expect(mode(p)).toBe('644');

    saveAccount(DATA);

    expect(mode(p)).toBe('600');
    expect(loadAccount()).toEqual(DATA);
  });

  it('never writes through a planted account.json.tmp', () => {
    // A fixed `${p}.tmp` was guessable: on a shared host anyone able to write
    // to the directory could pre-create it — as a symlink, this redirects the
    // token. The unique name means a planted file is simply never opened.
    const planted = join(stateDir, 'account.json.tmp');
    writeFileSync(planted, 'planted', 'utf-8');

    saveAccount(DATA);

    expect(readFileSync(planted, 'utf-8')).toBe('planted');
    expect(mode(join(stateDir, 'account.json'))).toBe('600');
    expect(loadAccount()).toEqual(DATA);
  });

  it('uses a different temp path on every save', () => {
    const paths = new Set<string>();
    for (let i = 0; i < 5; i++) {
      saveAccount(DATA);
      paths.add(String(vi.mocked(renameSync).mock.calls.at(-1)?.[0]));
    }
    expect(paths.size).toBe(5);
  });

  it('leaves no tmp file behind on success', () => {
    saveAccount(DATA);
    expect(tmpFiles()).toEqual([]);
  });

  it('removes the tmp file and re-throws when the rename fails', () => {
    // The rename is the step that can fail with the temp file already on disk,
    // so it is the one that exercises the cleanup path.
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('EXDEV: cross-device link not permitted');
    });

    expect(() => saveAccount(DATA)).toThrow('EXDEV');
    expect(tmpFiles()).toEqual([]);
  });

  it('re-throws a write failure without leaving a credential file', () => {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    expect(() => saveAccount(DATA)).toThrow('ENOSPC');
    expect(tmpFiles()).toEqual([]);
    expect(existsSync(join(stateDir, 'account.json'))).toBe(false);
  });

  it('replaces the previous account rather than appending', () => {
    saveAccount(DATA);
    const next: AccountData = { ...DATA, token: 'rotated', userId: 'user-2' };
    saveAccount(next);

    expect(loadAccount()).toEqual(next);
    expect(() =>
      JSON.parse(readFileSync(join(stateDir, 'account.json'), 'utf-8')),
    ).not.toThrow();
  });
});

describe('loadAccount', () => {
  it('returns null when no account is stored', () => {
    expect(loadAccount()).toBeNull();
  });

  it('returns null for a corrupt file rather than throwing', () => {
    writeFileSync(join(stateDir, 'account.json'), 'not json', 'utf-8');
    expect(loadAccount()).toBeNull();
  });
});

describe('clearAccount', () => {
  it('removes a stored account', () => {
    saveAccount(DATA);
    clearAccount();
    expect(loadAccount()).toBeNull();
    expect(existsSync(join(stateDir, 'account.json'))).toBe(false);
  });

  it('is a no-op when nothing is stored', () => {
    expect(() => clearAccount()).not.toThrow();
  });
});
