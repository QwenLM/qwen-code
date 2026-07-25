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

// Pass-through spy: the real fs is used, but the mode the credential file is
// *created* with stays observable. A permission check after the fact cannot
// see it — write-then-chmod ends at 0600 too, it is just briefly readable on
// the way there.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
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

beforeEach(() => {
  vi.mocked(writeFileSync).mockClear();
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
    // fix that only passes the option would leave this at 644.
    const p = join(stateDir, 'account.json');
    writeFileSync(p, '{"token":"stale"}', 'utf-8');
    chmodSync(p, 0o644);
    expect(mode(p)).toBe('644');

    saveAccount(DATA);

    expect(mode(p)).toBe('600');
    expect(loadAccount()).toEqual(DATA);
  });

  it('narrows a stale tmp file left by a crashed run', () => {
    // Same blind spot one level down: the tmp path already exists, so it keeps
    // its own permissions unless they are set explicitly.
    const tmp = join(stateDir, 'account.json.tmp');
    writeFileSync(tmp, 'leftover', 'utf-8');
    chmodSync(tmp, 0o644);

    saveAccount(DATA);

    expect(mode(join(stateDir, 'account.json'))).toBe('600');
    expect(existsSync(tmp)).toBe(false);
  });

  it('leaves no tmp file behind on success', () => {
    saveAccount(DATA);
    expect(existsSync(join(stateDir, 'account.json.tmp'))).toBe(false);
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
