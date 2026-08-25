/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_STATUS_SCHEMA_VERSION,
  claimRuntimeStatus,
  clearRuntimeStatus,
  isRuntimeStatusActive,
  readRuntimeStatusClaims,
  readRuntimeStatus,
  releaseRuntimeStatus,
  writeRuntimeStatus,
} from './runtimeStatus.js';

const fsMocks = vi.hoisted(() => ({
  link: vi.fn<typeof import('node:fs/promises').link>(),
  readFile: vi.fn<typeof import('node:fs/promises').readFile>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.link.mockImplementation(actual.link);
  fsMocks.readFile.mockImplementation(actual.readFile);
  return { ...actual, link: fsMocks.link, readFile: fsMocks.readFile };
});

let tmpDir: string;

beforeEach(async () => {
  fsMocks.link.mockClear();
  fsMocks.readFile.mockClear();
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-runtime-status-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const targetPath = () => path.join(tmpDir, 'runtime.json');

describe('claimRuntimeStatus', () => {
  it('uses an independent claim when a sibling wins the canonical path race', async () => {
    const actualFs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    fsMocks.link.mockImplementationOnce(async (source, target) => {
      await writeRuntimeStatus(target.toString(), {
        sessionId: 'abc',
        workDir: '/sibling',
      });
      return actualFs.link(source, target);
    });

    const claimedPath = await claimRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/ours',
    });

    expect(claimedPath).not.toBe(targetPath());
    expect(claimedPath).toMatch(/\.claim-[a-f0-9]+\.runtime\.json$/);
    expect((await readRuntimeStatus(targetPath()))?.workDir).toBe('/sibling');
    expect((await readRuntimeStatus(claimedPath))?.workDir).toBe('/ours');
  });

  it('replaces a non-live canonical claim', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/stale',
      pid: 0,
    });

    const claimedPath = await claimRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/ours',
    });

    expect(claimedPath).toBe(targetPath());
    expect((await readRuntimeStatus(targetPath()))?.pid).toBe(process.pid);
    expect((await readRuntimeStatus(targetPath()))?.workDir).toBe('/ours');
    expect(
      (await readdir(tmpDir)).filter((file) => file.includes('displaced')),
    ).toEqual([]);
  });

  it('keeps a foreign-host canonical claim and creates a sibling', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/foreign',
      pid: 2_000_000_000,
    });
    const foreign = JSON.parse(await readFile(targetPath(), 'utf8'));
    foreign.hostname = 'another-machine.example';
    await writeFile(targetPath(), JSON.stringify(foreign));

    const claimedPath = await claimRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/ours',
    });

    expect(claimedPath).not.toBe(targetPath());
    expect((await readRuntimeStatus(targetPath()))?.workDir).toBe('/foreign');
    expect((await readRuntimeStatus(claimedPath))?.workDir).toBe('/ours');
  });

  it('does not destroy an unreadable canonical claim', async () => {
    await writeFile(targetPath(), '{not json');

    const claimedPath = await claimRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/ours',
    });

    expect(claimedPath).not.toBe(targetPath());
    expect(await readFile(targetPath(), 'utf8')).toBe('{not json');
    expect((await readRuntimeStatus(claimedPath))?.workDir).toBe('/ours');
  });
});

describe('runtime status claim discovery', () => {
  it('discovers sibling claims by payload session id', async () => {
    const claimPath = path.join(tmpDir, 'abc.claim-token.runtime.json');
    await writeRuntimeStatus(claimPath, {
      sessionId: 'abc',
      workDir: '/relocated',
      pid: process.pid,
    });
    await writeRuntimeStatus(
      path.join(tmpDir, 'other.claim-token.runtime.json'),
      { sessionId: 'other', workDir: '/other', pid: process.pid },
    );

    const { statuses, incomplete } = await readRuntimeStatusClaims(
      tmpDir,
      'abc',
    );

    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.workDir).toBe('/relocated');
    expect(incomplete).toBe(false);
  });

  it('treats foreign-host claims as active keep-only evidence', async () => {
    const claimPath = path.join(tmpDir, 'abc.runtime.json');
    await writeRuntimeStatus(claimPath, {
      sessionId: 'abc',
      workDir: '/remote',
      pid: 2_000_000_000,
    });
    const foreign = JSON.parse(await readFile(claimPath, 'utf8'));
    foreign.hostname = 'another-machine.example';
    await writeFile(claimPath, JSON.stringify(foreign));

    const { statuses } = await readRuntimeStatusClaims(tmpDir, 'abc');
    expect(statuses.some(isRuntimeStatusActive)).toBe(true);

    expect(isRuntimeStatusActive({ ...statuses[0]!, pid: 0 })).toBe(false);
  });

  it('treats an unreadable sibling as unknown keep-only evidence', async () => {
    await writeRuntimeStatus(path.join(tmpDir, 'abc.runtime.json'), {
      sessionId: 'abc',
      workDir: '/old',
      pid: 0,
    });
    await writeFile(
      path.join(tmpDir, 'abc.claim-token.runtime.json'),
      '{not json',
    );

    const { incomplete } = await readRuntimeStatusClaims(tmpDir, 'abc');
    expect(incomplete).toBe(true);
  });
});

describe('writeRuntimeStatus', () => {
  it('writes the expected fields', async () => {
    const written = await writeRuntimeStatus(targetPath(), {
      sessionId: '11111111-2222-3333-4444-555555555555',
      workDir: '/work/dir',
      pid: 4242,
      qwenVersion: '0.15.3',
    });
    expect(written).toBe(targetPath());

    const data = JSON.parse(await readFile(targetPath(), 'utf-8'));
    expect(data.pid).toBe(4242);
    expect(data.session_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(data.work_dir).toBe('/work/dir');
    expect(data.schema_version).toBe(RUNTIME_STATUS_SCHEMA_VERSION);
    expect(typeof data.hostname).toBe('string');
    expect(data.hostname.length).toBeGreaterThan(0);
    expect(typeof data.started_at).toBe('number');
    expect(data.qwen_version).toBe('0.15.3');
  });

  it('defaults pid to process.pid and qwen_version to null', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/w',
    });
    const data = JSON.parse(await readFile(targetPath(), 'utf-8'));
    expect(data.pid).toBe(process.pid);
    expect(data.qwen_version).toBeNull();
  });

  it('leaves no .tmp leftovers on success', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/w',
      pid: 1,
    });
    const entries = await readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('creates the parent directory on demand', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'runtime.json');
    await writeRuntimeStatus(nested, { sessionId: 'abc', workDir: '/w' });
    const data = JSON.parse(await readFile(nested, 'utf-8'));
    expect(data.session_id).toBe('abc');
  });

  it('atomically overwrites the previous PID on resume', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/w',
      pid: 1000,
    });
    const first = await readRuntimeStatus(targetPath());
    expect(first?.pid).toBe(1000);

    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/w',
      pid: 2000,
    });
    const second = await readRuntimeStatus(targetPath());
    expect(second?.pid).toBe(2000);
  });

  it('preserves non-ASCII characters in path components and session ids', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: '中文-uuid-aaa',
      workDir: 'D:/项目/我的-app',
      pid: 7777,
    });
    const status = await readRuntimeStatus(targetPath());
    expect(status?.sessionId).toBe('中文-uuid-aaa');
    expect(status?.workDir).toBe('D:/项目/我的-app');
    const rawBytes = await readFile(targetPath());
    expect(rawBytes.includes(Buffer.from('中文', 'utf-8'))).toBe(true);
  });
});

describe('readRuntimeStatus', () => {
  it('propagates the caller abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('runtime status read cancelled');
    controller.abort(reason);

    await expect(
      readRuntimeStatus(targetPath(), { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it('passes the caller signal to the file read', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      workDir: '/some/where',
      pid: 99,
    });
    const controller = new AbortController();

    await readRuntimeStatus(targetPath(), { signal: controller.signal });

    expect(fsMocks.readFile).toHaveBeenLastCalledWith(targetPath(), {
      encoding: 'utf-8',
      signal: controller.signal,
    });
  });

  it('round-trips a written record', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      workDir: '/some/where',
      pid: 99,
      qwenVersion: '0.15.3',
    });
    const status = await readRuntimeStatus(targetPath());
    expect(status).not.toBeNull();
    expect(status!.pid).toBe(99);
    expect(status!.sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(status!.workDir).toBe('/some/where');
    expect(status!.schemaVersion).toBe(RUNTIME_STATUS_SCHEMA_VERSION);
    expect(status!.qwenVersion).toBe('0.15.3');
  });

  it('returns null when the file is missing', async () => {
    expect(await readRuntimeStatus(targetPath())).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    await writeFile(targetPath(), 'not-json', 'utf-8');
    expect(await readRuntimeStatus(targetPath())).toBeNull();
  });

  it('returns null on an unknown schema version', async () => {
    await writeFile(
      targetPath(),
      JSON.stringify({
        schema_version: RUNTIME_STATUS_SCHEMA_VERSION + 99,
        pid: 1,
        session_id: 'x',
        work_dir: '/w',
        hostname: 'h',
        started_at: 0,
        qwen_version: null,
      }),
      'utf-8',
    );
    expect(await readRuntimeStatus(targetPath())).toBeNull();
  });

  it('returns null when session_id has the wrong type', async () => {
    await writeFile(
      targetPath(),
      JSON.stringify({
        schema_version: RUNTIME_STATUS_SCHEMA_VERSION,
        pid: 1,
        session_id: null,
        work_dir: '/w',
        hostname: 'h',
        started_at: 0,
        qwen_version: null,
      }),
      'utf-8',
    );
    expect(await readRuntimeStatus(targetPath())).toBeNull();
  });

  it('returns null when pid is a string', async () => {
    await writeFile(
      targetPath(),
      JSON.stringify({
        schema_version: RUNTIME_STATUS_SCHEMA_VERSION,
        pid: '1234',
        session_id: 'abc',
        work_dir: '/w',
        hostname: 'h',
        started_at: 0,
        qwen_version: null,
      }),
      'utf-8',
    );
    expect(await readRuntimeStatus(targetPath())).toBeNull();
  });

  it('returns null when work_dir is an array', async () => {
    await writeFile(
      targetPath(),
      JSON.stringify({
        schema_version: RUNTIME_STATUS_SCHEMA_VERSION,
        pid: 1,
        session_id: 'abc',
        work_dir: ['/', 'w'],
        hostname: 'h',
        started_at: 0,
        qwen_version: null,
      }),
      'utf-8',
    );
    expect(await readRuntimeStatus(targetPath())).toBeNull();
  });

  it('returns null on an array root payload', async () => {
    await writeFile(targetPath(), JSON.stringify([1, 2, 3]), 'utf-8');
    expect(await readRuntimeStatus(targetPath())).toBeNull();
  });

  it('returns null on invalid UTF-8 bytes', async () => {
    // Truncated multi-byte sequence
    await writeFile(targetPath(), Buffer.from([0xff, 0xfe, 0x20, 0x67]));
    expect(await readRuntimeStatus(targetPath())).toBeNull();
  });
});

describe('clearRuntimeStatus', () => {
  it('removes an existing file', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/w',
      pid: 1,
    });
    await clearRuntimeStatus(targetPath());
    expect(await readRuntimeStatus(targetPath())).toBeNull();
  });

  it('is idempotent on a missing file', async () => {
    await clearRuntimeStatus(targetPath());
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/w',
      pid: 1,
    });
    await clearRuntimeStatus(targetPath());
    await clearRuntimeStatus(targetPath());
  });

  it('does not throw on a non-existent directory', async () => {
    await clearRuntimeStatus(path.join(tmpDir, 'does-not-exist', 'r.json'));
  });
});

describe('same-PID session swap', () => {
  // Models the /clear, /reset, /new and /resume flow: same PID transitions
  // from session A to session B. The old sidecar must stop claiming a live
  // pid before the new one is written so external observers can't
  // double-claim the PID — demoted to the non-live sentinel, keeping its
  // membership evidence (R15-4).
  it('demotes the old sidecar before writing the new one', async () => {
    const oldPath = path.join(tmpDir, 'session-a.runtime.json');
    const newPath = path.join(tmpDir, 'session-b.runtime.json');
    await writeRuntimeStatus(oldPath, {
      sessionId: 'session-a',
      workDir: '/w',
      pid: process.pid,
      qwenVersion: '0.0.0-test',
    });
    expect(await readRuntimeStatus(oldPath)).not.toBeNull();

    await releaseRuntimeStatus(oldPath);
    await writeRuntimeStatus(newPath, {
      sessionId: 'session-b',
      workDir: '/w',
      pid: 4242,
      qwenVersion: '0.0.0-test',
    });

    const old = await readRuntimeStatus(oldPath);
    expect(old?.pid).toBe(0);
    expect(old?.sessionId).toBe('session-a');
    const after = await readRuntimeStatus(newPath);
    expect(after?.sessionId).toBe('session-b');
    expect(after?.pid).toBe(4242);
  });
});

describe('releaseRuntimeStatus', () => {
  it('demotes our own claim to the non-live sentinel, keeping membership evidence (R15-4)', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/relocated',
      pid: process.pid,
      qwenVersion: '9.9.9',
    });

    await releaseRuntimeStatus(targetPath());

    const after = await readRuntimeStatus(targetPath());
    // pid 0 fails every isPidAlive gate (session seen as closed) while
    // sessionBelongsToCurrentProject keeps reading sessionId/workDir.
    expect(after?.pid).toBe(0);
    expect(after?.sessionId).toBe('abc');
    expect(after?.workDir).toBe('/relocated');
    expect(after?.qwenVersion).toBe('9.9.9');
    expect(await readdir(tmpDir)).not.toContain('r.json.releasing');
  });

  it('puts a foreign claim back untouched (R15-1)', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/w',
      pid: 4242,
    });

    await releaseRuntimeStatus(targetPath());

    const after = await readRuntimeStatus(targetPath());
    expect(after?.pid).toBe(4242);
    expect(await readdir(tmpDir)).not.toContain('r.json.releasing');
  });

  it('does not release another hostname with the same pid', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/foreign',
      pid: process.pid,
    });
    const foreign = JSON.parse(await readFile(targetPath(), 'utf8'));
    foreign.hostname = 'another-machine.example';
    await writeFile(targetPath(), JSON.stringify(foreign));

    await releaseRuntimeStatus(targetPath());

    const after = await readRuntimeStatus(targetPath());
    expect(after?.pid).toBe(process.pid);
    expect(after?.hostname).toBe('another-machine.example');
  });

  it('does not overwrite a sibling claim that lands at the demotion commit', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/ours',
      pid: process.pid,
    });
    const actualFs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    fsMocks.link.mockImplementationOnce(async (source, target) => {
      await writeRuntimeStatus(target.toString(), {
        sessionId: 'abc',
        workDir: '/sibling',
        pid: process.pid,
      });
      return actualFs.link(source, target);
    });

    await releaseRuntimeStatus(targetPath());

    const after = await readRuntimeStatus(targetPath());
    expect(after?.pid).toBe(process.pid);
    expect(after?.workDir).toBe('/sibling');
    expect(
      (await readdir(tmpDir)).some((file) => file.includes('releasing')),
    ).toBe(false);
  });

  it('preserves a displaced foreign claim when a sibling wins put-back', async () => {
    await writeRuntimeStatus(targetPath(), {
      sessionId: 'abc',
      workDir: '/foreign',
      pid: 4242,
    });
    const actualFs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    fsMocks.link.mockImplementationOnce(async (source, target) => {
      await writeRuntimeStatus(target.toString(), {
        sessionId: 'abc',
        workDir: '/sibling',
        pid: process.pid,
      });
      return actualFs.link(source, target);
    });

    await releaseRuntimeStatus(targetPath());

    expect((await readRuntimeStatus(targetPath()))?.workDir).toBe('/sibling');
    const displacedPath = (await readdir(tmpDir))
      .map((file) => path.join(tmpDir, file))
      .find((file) => file.includes('claim-'));
    expect(displacedPath).toBeDefined();
    expect((await readRuntimeStatus(displacedPath!))?.workDir).toBe('/foreign');
    expect(
      (await readdir(tmpDir)).some((file) => file.includes('releasing')),
    ).toBe(false);
  });

  it('restores an unreadable record instead of destroying it', async () => {
    await writeFile(targetPath(), '{not json');

    await releaseRuntimeStatus(targetPath());

    expect(await readFile(targetPath(), 'utf8')).toBe('{not json');
    expect(await readdir(tmpDir)).not.toContain('r.json.releasing');
  });

  it('is a no-op on a missing file', async () => {
    await releaseRuntimeStatus(targetPath());
    expect(await readdir(tmpDir)).toEqual([]);
  });
});
