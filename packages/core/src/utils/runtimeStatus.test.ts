/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  symlink,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPidNamespaceId, readProcStartToken } from './process-liveness.js';
import {
  RUNTIME_STATUS_SCHEMA_VERSION,
  clearRuntimeStatus,
  hasActiveRuntimeStatusClaimSync,
  isRuntimeStatusActive,
  readRuntimeStatusClaims,
  readRuntimeStatus,
  writeRuntimeStatus,
} from './runtimeStatus.js';

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<typeof import('node:fs/promises').readFile>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.readFile.mockImplementation(actual.readFile);
  return { ...actual, readFile: fsMocks.readFile };
});

let tmpDir: string;

beforeEach(async () => {
  fsMocks.readFile.mockClear();
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-runtime-status-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const targetPath = () => path.join(tmpDir, 'runtime.json');

describe('runtime status discovery', () => {
  it('discovers matching sidecars by payload session id', async () => {
    const statusPath = path.join(tmpDir, 'abc.extra.runtime.json');
    await writeRuntimeStatus(statusPath, {
      sessionId: 'abc',
      workDir: '/relocated',
      pid: process.pid,
    });
    await writeRuntimeStatus(path.join(tmpDir, 'other.extra.runtime.json'), {
      sessionId: 'other',
      workDir: '/other',
      pid: process.pid,
    });

    const { statuses, incomplete } = await readRuntimeStatusClaims(
      tmpDir,
      'abc',
    );

    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.workDir).toBe('/relocated');
    expect(incomplete).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'discovers sidecars by name even when the dirent is a symlink',
    async () => {
      const realPath = path.join(tmpDir, 'real.runtime.json');
      const linkPath = path.join(tmpDir, 'abc.runtime.json');
      await writeRuntimeStatus(realPath, {
        sessionId: 'abc',
        workDir: '/relocated',
        pid: process.pid,
      });
      await symlink(realPath, linkPath);

      const { statuses, incomplete } = await readRuntimeStatusClaims(
        tmpDir,
        'abc',
      );

      expect(statuses.map((status) => status.workDir)).toContain('/relocated');
      expect(incomplete).toBe(false);
      expect(hasActiveRuntimeStatusClaimSync(tmpDir)).toBe(true);
    },
  );

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

  it.skipIf(process.platform !== 'linux')(
    'treats claims from a different pid namespace as active keep-only evidence',
    () => {
      const currentNamespace = readPidNamespaceId();
      expect(currentNamespace).not.toBeNull();

      expect(
        isRuntimeStatusActive({
          schemaVersion: RUNTIME_STATUS_SCHEMA_VERSION,
          pid: 2_000_000_000,
          sessionId: 'abc',
          workDir: '/remote',
          hostname: os.hostname(),
          startedAt: Date.now() / 1000,
          qwenVersion: null,
          pidNamespaceId: currentNamespace! + 1,
          procStartToken: null,
        }),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'uses the proc start token for claims in the current pid namespace',
    () => {
      const currentNamespace = readPidNamespaceId();
      expect(currentNamespace).not.toBeNull();

      expect(
        isRuntimeStatusActive({
          schemaVersion: RUNTIME_STATUS_SCHEMA_VERSION,
          pid: process.pid,
          sessionId: 'abc',
          workDir: process.cwd(),
          hostname: os.hostname(),
          startedAt: Date.now() / 1000,
          qwenVersion: null,
          pidNamespaceId: currentNamespace,
          procStartToken: readProcStartToken(process.pid),
        }),
      ).toBe(true);
      expect(
        isRuntimeStatusActive({
          schemaVersion: RUNTIME_STATUS_SCHEMA_VERSION,
          pid: process.pid,
          sessionId: 'abc',
          workDir: process.cwd(),
          hostname: os.hostname(),
          startedAt: Date.now() / 1000,
          qwenVersion: null,
          pidNamespaceId: currentNamespace,
          procStartToken: 'not-this-process:1',
        }),
      ).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'treats a foreign boot id as active keep-only evidence',
    () => {
      const currentNamespace = readPidNamespaceId();
      expect(currentNamespace).not.toBeNull();

      expect(
        isRuntimeStatusActive({
          schemaVersion: RUNTIME_STATUS_SCHEMA_VERSION,
          pid: process.pid,
          sessionId: 'abc',
          workDir: '/remote',
          hostname: os.hostname(),
          startedAt: Date.now() / 1000,
          qwenVersion: null,
          pidNamespaceId: currentNamespace,
          procStartToken: '00000000-0000-0000-0000-000000000000:1',
        }),
      ).toBe(true);
    },
  );

  it('treats an unreadable runtime sidecar as unknown keep-only evidence', async () => {
    await writeRuntimeStatus(path.join(tmpDir, 'abc.runtime.json'), {
      sessionId: 'abc',
      workDir: '/old',
      pid: 0,
    });
    await writeFile(path.join(tmpDir, 'other.runtime.json'), '{not json');

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
    expect(
      data.pid_namespace_id === null || Number.isInteger(data.pid_namespace_id),
    ).toBe(true);
    expect(
      data.proc_start_token === null ||
        typeof data.proc_start_token === 'string',
    ).toBe(true);
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
