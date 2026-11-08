/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPidfileProcessToken } from '../../commands/channel/pidfile.js';
import {
  buildPrWatchOwnerRecord,
  claimPrWatchOwnershipSync,
  defaultPrWatchDir,
  deletePrWatchStateSync,
  parsePrWatchState,
  PR_WATCH_CI_FIRED_CAP,
  PR_WATCH_DELIVERED_CAP,
  PR_WATCH_PENDING_CAP,
  prWatchFileKey,
  prWatchFilePath,
  prWatchOwnerPath,
  readPrWatchStateSync,
  releasePrWatchOwnershipSync,
  sweepPrWatchTempFilesSync,
  writePrWatchStateSync,
  type PrWatchIdentity,
  type PrWatchState,
} from './pr-watch-store.js';

const identity: PrWatchIdentity = {
  host: 'github.com',
  repo: 'owner/repo',
  number: 42,
};

function minimalState(overrides: Partial<PrWatchState> = {}): PrWatchState {
  return { pr: identity, ...overrides };
}

describe('pr-watch-store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pr-watch-store-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  it('derives a lowercased identity key and a 40-hex file name', () => {
    expect(
      prWatchFileKey({ host: 'GitHub.com', repo: 'Owner/Repo', number: 42 }),
    ).toBe('github.com/owner/repo#42');
    const filePath = prWatchFilePath(dir, identity);
    expect(path.basename(filePath)).toMatch(/^[0-9a-f]{40}\.json$/);
    expect(prWatchFilePath(dir, identity)).toBe(filePath);
    expect(defaultPrWatchDir()).toContain(path.join('serve', 'pr-watch'));
  });

  it('parses a minimal state and rejects identity mismatches', () => {
    expect(parsePrWatchState(minimalState(), identity)).toEqual(minimalState());
    expect(
      parsePrWatchState(minimalState(), { ...identity, number: 43 }),
    ).toBeNull();
    expect(parsePrWatchState({ pr: { ...identity, number: 0 } })).toBeNull();
  });

  it('enforces the durable caps and pending shape', () => {
    expect(
      parsePrWatchState(
        minimalState({
          ciFired: Array.from(
            { length: PR_WATCH_CI_FIRED_CAP + 1 },
            (_, i) => `h${i}`,
          ),
        }),
      ),
    ).toBeNull();
    expect(
      parsePrWatchState(
        minimalState({
          delivered: Array.from(
            { length: PR_WATCH_DELIVERED_CAP + 1 },
            (_, i) => `k${i}`,
          ),
        }),
      ),
    ).toBeNull();
    expect(
      parsePrWatchState(
        minimalState({
          pending: Array.from({ length: PR_WATCH_PENDING_CAP + 1 }, (_, i) => ({
            type: 'head_change' as const,
            key: `k${i}`,
            summary: 's',
            detectedAt: new Date().toISOString(),
          })),
        }),
      ),
    ).toBeNull();
    expect(
      parsePrWatchState(
        minimalState({
          pending: [
            {
              type: 'head_change',
              key: 'k',
              summary: 's',
              detectedAt: new Date().toISOString(),
              served: ['review', 'bogus' as never],
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('reads absent, invalid, and valid files distinctly', () => {
    expect(readPrWatchStateSync(dir, identity)).toEqual({ kind: 'absent' });
    const filePath = prWatchFilePath(dir, identity);
    writeFileSync(filePath, '{not json');
    expect(readPrWatchStateSync(dir, identity)).toEqual({
      kind: 'invalid',
      filePath,
    });
    writeFileSync(filePath, JSON.stringify(minimalState({ headSha: 'abc' })));
    const result = readPrWatchStateSync(dir, identity);
    expect(result.kind).toBe('state');
    if (result.kind === 'state') expect(result.state.headSha).toBe('abc');
  });

  it('fails closed when the watch path is not a regular file', () => {
    const filePath = prWatchFilePath(dir, identity);
    mkdirSync(filePath);
    const result = readPrWatchStateSync(dir, identity);
    expect(result.kind).toBe('error');
  });

  it('round-trips a state and refuses invalid writes without touching the old file', () => {
    const state = minimalState({
      observedAt: new Date().toISOString(),
      state: 'open',
      headSha: 'abc',
      checks: 'passing',
      pending: [
        {
          type: 'head_change',
          key: 'pr-state:github.com/owner/repo#42:head_change:abc',
          summary: 'head moved',
          detectedAt: new Date().toISOString(),
        },
      ],
    });
    writePrWatchStateSync(dir, identity, state);
    const result = readPrWatchStateSync(dir, identity);
    expect(result.kind).toBe('state');
    if (result.kind === 'state') expect(result.state).toEqual(state);
    expect(() =>
      writePrWatchStateSync(dir, identity, {
        ...state,
        pr: { ...identity, number: 43 },
      }),
    ).toThrow(/invalid PR watch state/);
    const after = readPrWatchStateSync(dir, identity);
    expect(after.kind).toBe('state');
    if (after.kind === 'state') expect(after.state).toEqual(state);
  });

  it('deletes only an existing regular watch file', () => {
    expect(deletePrWatchStateSync(dir, identity)).toBe(false);
    writePrWatchStateSync(dir, identity, minimalState());
    expect(deletePrWatchStateSync(dir, identity)).toBe(true);
    expect(readPrWatchStateSync(dir, identity)).toEqual({ kind: 'absent' });
  });

  it('sweeps only crash temp files after a claim', () => {
    const filePath = prWatchFilePath(dir, identity);
    const temp = path.join(
      dir,
      `.${path.basename(filePath)}.11111111-2222-3333-4444-555555555555.tmp`,
    );
    writeFileSync(temp, 'partial');
    writeFileSync(path.join(dir, 'keep.json'), '{}');
    expect(sweepPrWatchTempFilesSync(dir)).toBe(1);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(path.join(dir, 'keep.json'))).toBe(true);
  });

  it('claims, retains, releases, and reclaims ownership', () => {
    const first = claimPrWatchOwnershipSync(dir);
    expect(first.kind).toBe('claimed');
    if (first.kind !== 'claimed') return;
    expect(existsSync(prWatchOwnerPath(dir))).toBe(true);
    const second = claimPrWatchOwnershipSync(dir);
    expect(second.kind).toBe('retained');
    expect(releasePrWatchOwnershipSync(dir, first.record)).toBe(true);
    expect(releasePrWatchOwnershipSync(dir, first.record)).toBe(false);
    const third = claimPrWatchOwnershipSync(dir);
    expect(third.kind).toBe('claimed');
  });

  it('keeps an unverifiable owner record and names it on every attempt', () => {
    const ownerPath = prWatchOwnerPath(dir);
    const record = {
      pid: process.pid,
      procStart: 'foreign-boot:0',
      startedAt: new Date().toISOString(),
    };
    writeFileSync(ownerPath, JSON.stringify(record));
    const log = vi.fn();
    const first = claimPrWatchOwnershipSync(dir, log);
    expect(first.kind).toBe('blocked');
    expect(existsSync(ownerPath)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(ownerPath));
    claimPrWatchOwnershipSync(dir, log);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('sweeps a provably dead local owner record', () => {
    const token = readPidfileProcessToken(process.pid);
    if (!token) return; // No start token on this platform; covered by channel pidfile tests.
    const separator = token.indexOf(':');
    const stale = {
      pid: process.pid,
      procStart: `${token.slice(0, separator)}:0`,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(prWatchOwnerPath(dir), JSON.stringify(stale));
    const result = claimPrWatchOwnershipSync(dir);
    expect(result.kind).toBe('claimed');
  });

  it('sweeps a corrupt local owner record before claiming', () => {
    writeFileSync(prWatchOwnerPath(dir), '{corrupt');
    const result = claimPrWatchOwnershipSync(dir);
    expect(result.kind).toBe('claimed');
    if (result.kind === 'claimed') {
      expect(result.record.pid).toBe(process.pid);
    }
  });

  it('builds an owner record for the current process', () => {
    const record = buildPrWatchOwnerRecord();
    expect(record.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);
  });

  const itPosix = process.platform === 'win32' ? it.skip : it;

  itPosix('refuses files and directories owned by another uid', () => {
    writePrWatchStateSync(dir, identity, minimalState());
    const filePath = prWatchFilePath(dir, identity);
    const uid = lstatSync(filePath).uid;
    const processWithUid = process as unknown as { geteuid: () => number };
    const spy = vi.spyOn(processWithUid, 'geteuid').mockReturnValue(uid + 1);
    try {
      const result = readPrWatchStateSync(dir, identity);
      expect(result.kind).toBe('error');
      expect(() =>
        writePrWatchStateSync(dir, identity, minimalState()),
      ).toThrow(/owned by uid/);
      expect(() => deletePrWatchStateSync(dir, identity)).toThrow(
        /owned by uid/,
      );
      const claim = claimPrWatchOwnershipSync(dir, vi.fn());
      expect(claim.kind).toBe('blocked');
    } finally {
      spy.mockRestore();
    }
  });

  itPosix('creates the watch directory with private permissions', () => {
    const nested = path.join(dir, 'watch');
    const result = claimPrWatchOwnershipSync(nested);
    expect(result.kind).toBe('claimed');
    const mode = lstatSync(nested).mode & 0o777;
    expect(mode).toBe(0o700);
    const ownerMode = lstatSync(prWatchOwnerPath(nested)).mode & 0o777;
    expect(ownerMode).toBe(0o600);
  });

  itPosix(
    'heals an existing watch directory that is group/world accessible',
    () => {
      const nested = path.join(dir, 'watch');
      mkdirSync(nested, { mode: 0o755 });
      chmodSync(nested, 0o755);
      const result = claimPrWatchOwnershipSync(nested);
      expect(result.kind).toBe('claimed');
      expect(lstatSync(nested).mode & 0o777).toBe(0o700);
    },
  );

  itPosix('blocks instead of hanging on a FIFO owner record', () => {
    const ownerPath = prWatchOwnerPath(dir);
    execSync(`mkfifo ${JSON.stringify(ownerPath)}`);
    const result = claimPrWatchOwnershipSync(dir, vi.fn());
    expect(result.kind).toBe('blocked');
    expect(releasePrWatchOwnershipSync(dir, buildPrWatchOwnerRecord())).toBe(
      false,
    );
  });

  itPosix('blocks on a symlinked owner record', () => {
    const target = path.join(dir, 'elsewhere.json');
    writeFileSync(target, JSON.stringify(buildPrWatchOwnerRecord()));
    symlinkSync(target, prWatchOwnerPath(dir));
    const result = claimPrWatchOwnershipSync(dir, vi.fn());
    expect(result.kind).toBe('blocked');
  });

  itPosix('returns blocked when the watch directory cannot be listed', () => {
    if (process.geteuid?.() === 0) return; // root bypasses mode bits
    chmodSync(dir, 0o000);
    try {
      const result = claimPrWatchOwnershipSync(dir, vi.fn());
      expect(result.kind).toBe('blocked');
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  itPosix('blocks when a different live process holds the owner record', () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000)'],
      {
        stdio: 'ignore',
      },
    );
    try {
      const pid = child.pid;
      expect(pid).toBeTypeOf('number');
      let token: string | null = null;
      for (let i = 0; i < 50 && !token; i += 1) {
        try {
          token = readPidfileProcessToken(pid!);
        } catch {
          token = null;
        }
        if (!token) execSync('sleep 0.02');
      }
      if (!token) return;
      writeFileSync(
        prWatchOwnerPath(dir),
        JSON.stringify({
          pid,
          procStart: token,
          startedAt: new Date().toISOString(),
        }),
      );
      const result = claimPrWatchOwnershipSync(dir, vi.fn());
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.reason).toContain(`live pid ${pid}`);
      }
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('writes the normalized state, not caller-owned extra properties', () => {
    const state = {
      ...minimalState({ headSha: 'abc' }),
      pr: { ...identity, injected: 'must not persist' },
      extra: 'must not persist',
    } as PrWatchState;
    writePrWatchStateSync(dir, identity, state);
    const result = readPrWatchStateSync(dir, identity);
    expect(result.kind).toBe('state');
    if (result.kind === 'state') {
      expect(result.state).toEqual(minimalState({ headSha: 'abc' }));
      expect(result.state).not.toHaveProperty('extra');
      expect(result.state.pr).toEqual(identity);
    }
  });

  it('rejects duplicate served role groups', () => {
    expect(
      parsePrWatchState(
        minimalState({
          pending: [
            {
              type: 'head_change',
              key: 'k',
              summary: 's',
              detectedAt: new Date().toISOString(),
              served: ['review', 'review'],
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('release refuses to delete a successor owner record', () => {
    const claim = claimPrWatchOwnershipSync(dir);
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;
    const successor = {
      ...claim.record,
      startedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    writeFileSync(prWatchOwnerPath(dir), JSON.stringify(successor));
    expect(releasePrWatchOwnershipSync(dir, claim.record)).toBe(false);
    expect(existsSync(prWatchOwnerPath(dir))).toBe(true);
  });

  itPosix('write refuses a symlinked watch target', () => {
    const target = path.join(dir, 'target.json');
    writeFileSync(target, JSON.stringify(minimalState()));
    symlinkSync(target, prWatchFilePath(dir, identity));
    expect(() =>
      writePrWatchStateSync(dir, identity, minimalState({ headSha: 'new' })),
    ).toThrow(/not a regular file/);
    expect(readFileSync(target, 'utf-8')).toBe(JSON.stringify(minimalState()));
  });
});
