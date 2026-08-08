/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deriveSessionName,
  getSessionRecordPath,
  getSessionRegistryDir,
  listLiveSessions,
  patchSessionRecord,
  registerSession,
  unregisterSession,
  SESSION_REGISTRY_SCHEMA_VERSION,
} from './session-registry.js';

vi.mock('../config/storage.js', () => {
  let mockDir = '/tmp/session-registry-test';
  return {
    Storage: {
      getGlobalQwenDir: () => mockDir,
    },
    __setMockGlobalDir: (d: string) => {
      mockDir = d;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __setMockGlobalDir } = (await import('../config/storage.js')) as any;

let tmpDir: string;

/** A PID that is essentially certain not to be running. */
const DEAD_PID = 0x7ffffffe;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-registry-'));
  __setMockGlobalDir(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeRaw(fileName: string, body: unknown): Promise<string> {
  const dir = getSessionRegistryDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(
    filePath,
    typeof body === 'string' ? body : JSON.stringify(body),
  );
  return filePath;
}

describe('deriveSessionName', () => {
  it('combines the cwd basename with a session-derived suffix', () => {
    const name = deriveSessionName('/home/u/projects/qwen-code', 'abc-123');
    expect(name).toMatch(/^qwen-code-[0-9a-f]{2}$/);
  });

  it('separates two sessions in the same directory', () => {
    const a = deriveSessionName('/w/app', 'session-a');
    const b = deriveSessionName('/w/app', 'session-b');
    expect(a).not.toBe(b);
  });

  it('is stable for the same inputs', () => {
    expect(deriveSessionName('/w/app', 's1')).toBe(
      deriveSessionName('/w/app', 's1'),
    );
  });

  it('strips characters that would not survive a shell or a table', () => {
    const name = deriveSessionName('/w/my project (v2)', 's1');
    expect(name).toMatch(/^[\w.-]+$/);
  });

  it('falls back to a placeholder when the basename is empty', () => {
    expect(deriveSessionName('/', 's1')).toMatch(/^session-[0-9a-f]{2}$/);
  });
});

describe('registerSession', () => {
  it('writes a record for this process and lists it back', async () => {
    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
        qwenVersion: '1.2.3',
      }),
    ).toBe(true);

    const live = await listLiveSessions({ includeSelf: true });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      pid: process.pid,
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
      qwenVersion: '1.2.3',
    });
    expect(live[0].name).toMatch(/^app-[0-9a-f]{2}$/);
  });

  it('creates the registry directory as 0700', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
    });
    const stat = await fs.stat(getSessionRegistryDir());
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('tightens a pre-existing loose registry directory', async () => {
    await fs.mkdir(getSessionRegistryDir(), { recursive: true, mode: 0o755 });
    await fs.chmod(getSessionRegistryDir(), 0o755);

    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
    });

    const stat = await fs.stat(getSessionRegistryDir());
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('writes the record as 0600', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
    });
    const stat = await fs.stat(getSessionRecordPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('reports failure instead of throwing when the home dir is unwritable', async () => {
    __setMockGlobalDir(path.join(tmpDir, 'nope', '\0invalid'));
    expect(
      await registerSession({
        sessionId: 's1',
        cwd: '/w/app',
        kind: 'interactive',
      }),
    ).toBe(false);
  });
});

describe('patchSessionRecord', () => {
  it('updates a field without dropping the others', async () => {
    await registerSession({
      sessionId: 'old',
      cwd: '/w/app',
      kind: 'interactive',
      qwenVersion: '1.2.3',
    });

    await patchSessionRecord({ sessionId: 'new', name: 'renamed' });

    const [record] = await listLiveSessions({ includeSelf: true });
    expect(record).toMatchObject({
      sessionId: 'new',
      name: 'renamed',
      cwd: '/w/app',
      qwenVersion: '1.2.3',
    });
  });

  it('does not create a record for a session that never registered', async () => {
    await patchSessionRecord({ sessionId: 'new' });
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
  });
});

describe('unregisterSession', () => {
  it('removes the record', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
    });
    await unregisterSession();
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
  });

  it('is a no-op when nothing was registered', async () => {
    await expect(unregisterSession()).resolves.toBeUndefined();
  });
});

describe('listLiveSessions', () => {
  it('excludes the calling session by default', async () => {
    await registerSession({
      sessionId: 's1',
      cwd: '/w/app',
      kind: 'interactive',
    });
    expect(await listLiveSessions()).toEqual([]);
  });

  it('returns an empty list when the registry does not exist', async () => {
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
  });

  it('sweeps a record whose process is gone', async () => {
    const filePath = await writeRaw(`${DEAD_PID}.json`, {
      schemaVersion: 1,
      pid: DEAD_PID,
      procStart: null,
      sessionId: 's-dead',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: Date.now(),
      qwenVersion: null,
      peerProtocol: 1,
    });

    expect(await listLiveSessions()).toEqual([]);
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it('leaves a dead record in place when sweeping is disabled', async () => {
    const filePath = await writeRaw(`${DEAD_PID}.json`, {
      schemaVersion: 1,
      pid: DEAD_PID,
      sessionId: 's-dead',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: Date.now(),
    });

    expect(await listLiveSessions({ sweepStale: false })).toEqual([]);
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });

  it('treats a recycled PID as stale', async () => {
    // Our own PID is alive, but the recorded start token belongs to a
    // different process — so the record describes a session that is gone.
    if (process.platform !== 'linux') return;
    await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid,
      procStart: '1',
      sessionId: 's-recycled',
      cwd: '/w/app',
      name: 'app-aa',
      kind: 'interactive',
      startedAt: Date.now(),
    });

    // selfPid is set elsewhere so this record goes through the liveness
    // path rather than the trust-our-own-record shortcut.
    expect(await listLiveSessions({ selfPid: DEAD_PID })).toEqual([]);
  });

  it('ignores files that are not <pid>.json', async () => {
    await writeRaw('2026-planning-notes.json', { hello: 'world' });
    await writeRaw('notes.txt', 'nope');
    await writeRaw('007.json', {
      schemaVersion: 1,
      pid: 7,
      sessionId: 's',
      cwd: '/w',
      name: 'n',
      kind: 'interactive',
      startedAt: 1,
    });

    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    // Critically, none of them were deleted.
    const remaining = await fs.readdir(getSessionRegistryDir());
    expect(remaining.sort()).toEqual([
      '007.json',
      '2026-planning-notes.json',
      'notes.txt',
    ]);
  });

  it('skips a record whose pid disagrees with its filename', async () => {
    await writeRaw(`${process.pid}.json`, {
      schemaVersion: 1,
      pid: process.pid + 1,
      sessionId: 's',
      cwd: '/w',
      name: 'n',
      kind: 'interactive',
      startedAt: 1,
    });
    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    await expect(
      fs.stat(path.join(getSessionRegistryDir(), `${process.pid}.json`)),
    ).resolves.toBeDefined();
  });

  it('skips malformed and future-schema records without deleting them', async () => {
    await writeRaw('11.json', 'not json at all');
    await writeRaw('12.json', {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION + 1,
      pid: 12,
      sessionId: 's',
      cwd: '/w',
      name: 'n',
      kind: 'interactive',
      startedAt: 1,
    });
    await writeRaw('13.json', {
      schemaVersion: 1,
      pid: 13,
      sessionId: 's',
      cwd: '/w',
      name: 'n',
      kind: 'not-a-kind',
      startedAt: 1,
    });

    expect(await listLiveSessions({ includeSelf: true })).toEqual([]);
    expect((await fs.readdir(getSessionRegistryDir())).sort()).toEqual([
      '11.json',
      '12.json',
      '13.json',
    ]);
  });

  it('sorts newest first', async () => {
    await registerSession({
      sessionId: 's-self',
      cwd: '/w/app',
      kind: 'interactive',
    });
    await patchSessionRecord({ startedAt: 1000 });
    await writeRaw(`${process.ppid}.json`, {
      schemaVersion: 1,
      pid: process.ppid,
      sessionId: 's-parent',
      cwd: '/w/other',
      name: 'other-bb',
      kind: 'interactive',
      startedAt: 2000,
    });

    const live = await listLiveSessions({ includeSelf: true });
    expect(live.map((r) => r.sessionId)).toEqual(['s-parent', 's-self']);
  });
});
