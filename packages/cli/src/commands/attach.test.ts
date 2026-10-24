/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonDiscoveryEntry,
  DaemonDiscoveryRecord,
} from '../serve/daemon-discovery.js';
import { writeDaemonToken } from '../serve/daemon-discovery.js';
import {
  attachCommand,
  formatAttachError,
  resolveAttachToken,
  resolveAttachWorkspace,
  selectAttachRecord,
} from './attach.js';

function entry(port: number): DaemonDiscoveryEntry {
  return {
    path: `/tmp/daemon-${port}.json`,
    record: {
      v: 1,
      pid: 1000 + port,
      port,
      hostname: '127.0.0.1',
      url: `http://127.0.0.1:${port}`,
      workspaces: [`/tmp/project-${port}`],
      primaryWorkspace: `/tmp/project-${port}`,
      startedAt: '2026-10-21T00:00:00.000Z',
      auth: 'none',
    },
  };
}

function bearer(port = 4170): DaemonDiscoveryRecord {
  return { ...entry(port).record, auth: 'bearer' };
}

beforeEach(() => {
  vi.stubEnv('QWEN_SERVER_TOKEN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('qwen attach target selection', () => {
  it('reports when no daemon is registered', () => {
    const result = selectAttachRecord([], undefined);
    expect(result.record).toBeUndefined();
    expect(result.error).toContain('no daemon is registered');
  });

  it('selects the only registered daemon', () => {
    const target = entry(4170);
    expect(selectAttachRecord([target], undefined, () => true)).toEqual({
      record: target.record,
    });
  });

  it('requires --port when several daemons are registered', () => {
    const result = selectAttachRecord(
      [entry(4170), entry(4171)],
      undefined,
      () => true,
    );
    expect(result.record).toBeUndefined();
    expect(result.error).toContain('--port');
  });

  it('selects the daemon named by --port', () => {
    const first = entry(4170);
    const second = entry(4171);
    expect(selectAttachRecord([first, second], 4171, () => true)).toEqual({
      record: second.record,
    });
  });

  it('reports an unknown --port', () => {
    const result = selectAttachRecord([entry(4170)], 4171, () => true);
    expect(result.record).toBeUndefined();
    expect(result.error).toContain('4171');
  });

  it('skips stale records when a live daemon remains', () => {
    const stale = entry(4170);
    const live = entry(4171);
    expect(
      selectAttachRecord(
        [stale, live],
        undefined,
        (record) => record.port === live.record.port,
      ),
    ).toEqual({ record: live.record });
  });
});

describe('qwen attach token resolution', () => {
  it('does not require a token from an unauthenticated daemon', () => {
    expect(resolveAttachToken(entry(4170).record, undefined)).toEqual({});
  });

  it('uses the explicit token for a bearer daemon', () => {
    expect(resolveAttachToken(bearer(), '  secret  ', () => false)).toEqual({
      token: 'secret',
    });
  });

  it('falls back to QWEN_SERVER_TOKEN', () => {
    vi.stubEnv('QWEN_SERVER_TOKEN', '  env-secret  ');
    expect(resolveAttachToken(bearer(), undefined, () => true)).toEqual({
      token: 'env-secret',
    });
  });

  it('refuses an ambient token for an unverified listener', () => {
    vi.stubEnv('QWEN_SERVER_TOKEN', 'env-secret');
    const result = resolveAttachToken(bearer(), undefined, () => false);
    expect(result.token).toBeUndefined();
    expect(result.error).toContain('unverified');
  });

  it('reads the pid-scoped sidecar written by daemon start --save-token', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-attach-'));
    vi.stubEnv('QWEN_RUNTIME_DIR', runtimeDir);
    try {
      const record = bearer();
      writeDaemonToken(record.port, record.pid, 'sidecar-secret');
      expect(resolveAttachToken(record, undefined, () => true)).toEqual({
        token: 'sidecar-secret',
      });
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('explains how to supply a missing bearer token', () => {
    const result = resolveAttachToken(bearer(), undefined, () => true);
    expect(result.token).toBeUndefined();
    expect(result.error).toContain('--token');
    expect(result.error).toContain('QWEN_SERVER_TOKEN');
    expect(result.error).toContain('--save-token');
  });
});

describe('qwen attach workspace resolution', () => {
  it('uses an explicit workspace', () => {
    expect(resolveAttachWorkspace(entry(4170).record, '  /tmp/other  ')).toBe(
      '/tmp/other',
    );
  });

  it('defaults to the only registered workspace', () => {
    expect(resolveAttachWorkspace(entry(4170).record, undefined)).toBe(
      '/tmp/project-4170',
    );
  });

  it('resolves a relative workspace against the shell cwd', () => {
    expect(resolveAttachWorkspace(entry(4170).record, '.')).toBe(process.cwd());
  });

  it('does not guess when several workspaces are registered', () => {
    const record = {
      ...entry(4170).record,
      workspaces: ['/tmp/one', '/tmp/two'],
      primaryWorkspace: '/tmp/one',
    };
    expect(resolveAttachWorkspace(record, undefined)).toBeUndefined();
  });
});

describe('qwen attach error formatting', () => {
  it('strips terminal escapes, tabs, and newlines from server messages', () => {
    const message = '\x1b]52;c;SGV sbG8=\x07\x1b[2Jfailed\tto\nload';
    const safe = formatAttachError(message);
    expect(safe).not.toContain('\x1b');
    expect(safe).not.toContain('\t');
    expect(safe).not.toContain('\n');
    expect(safe).toContain('failed');
  });
});

describe('qwen attach command', () => {
  it('declares the attach command and required session option', () => {
    expect(attachCommand.command).toBe('attach');
    expect(typeof attachCommand.builder).toBe('function');
    expect(typeof attachCommand.handler).toBe('function');

    const builder = attachCommand.builder;
    if (typeof builder !== 'function') {
      throw new Error('attach command builder must be a function');
    }
    const mockYargs = {
      option: vi.fn().mockReturnThis(),
    };
    builder(mockYargs as never);
    const options = mockYargs.option.mock.calls.map((call) => call[0]);
    expect(options).toEqual(['port', 'session', 'workspace', 'token']);
  });
});
