/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_STATUS_SCHEMA_VERSION,
  clearRuntimeStatus,
  readRuntimeStatus,
  writeRuntimeStatus,
} from './runtimeStatus.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-runtime-status-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const targetPath = () => path.join(tmpDir, 'runtime.json');

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
  // from session A to session B. The old sidecar must be removed before the
  // new one is written so external observers can't double-claim the PID.
  it('clears the old sidecar before writing the new one', async () => {
    const oldPath = path.join(tmpDir, 'session-a.runtime.json');
    const newPath = path.join(tmpDir, 'session-b.runtime.json');
    await writeRuntimeStatus(oldPath, {
      sessionId: 'session-a',
      workDir: '/w',
      pid: 4242,
      qwenVersion: '0.0.0-test',
    });
    expect(await readRuntimeStatus(oldPath)).not.toBeNull();

    await clearRuntimeStatus(oldPath);
    await writeRuntimeStatus(newPath, {
      sessionId: 'session-b',
      workDir: '/w',
      pid: 4242,
      qwenVersion: '0.0.0-test',
    });

    expect(await readRuntimeStatus(oldPath)).toBeNull();
    const after = await readRuntimeStatus(newPath);
    expect(after?.sessionId).toBe('session-b');
    expect(after?.pid).toBe(4242);
  });
});
