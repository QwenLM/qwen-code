/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  daemonDiscoveryFilePath,
  daemonDiscoveryUrl,
  daemonTokenFilePath,
  isProcessAlive,
  readDaemonDiscoveries,
  readDaemonToken,
  removeDaemonDiscovery,
  removeDaemonToken,
  removeStaleDaemonTokens,
  resolveDaemonDiscoveryDir,
  writeDaemonDiscovery,
  writeDaemonToken,
  type DaemonDiscoveryRecord,
} from './daemon-discovery.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-daemon-discovery-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<DaemonDiscoveryRecord> = {}) {
  return {
    v: 1,
    pid: process.pid,
    port: 4170,
    hostname: '127.0.0.1',
    url: 'http://127.0.0.1:4170',
    workspaces: ['/tmp/project'],
    primaryWorkspace: '/tmp/project',
    startedAt: '2026-10-19T00:00:00.000Z',
    auth: 'none',
    logPath: '/tmp/daemon.log',
    ...overrides,
  } satisfies DaemonDiscoveryRecord;
}

describe('daemon discovery records', () => {
  it('round-trips a record through the discovery directory', () => {
    const written = writeDaemonDiscovery(record(), dir);
    expect(written).toBe(daemonDiscoveryFilePath(4170, dir));

    const { entries, invalid } = readDaemonDiscoveries(dir);
    expect(invalid).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.record).toEqual(record());
  });

  it('writes the record with private permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    const written = writeDaemonDiscovery(record(), dir);
    expect(fs.statSync(written).mode & 0o777).toBe(0o600);
  });

  it('round-trips a pid-scoped token sidecar with private permissions', () => {
    const written = writeDaemonToken(4170, process.pid, 'secret', dir);
    expect(written).toBe(daemonTokenFilePath(4170, process.pid, dir));
    if (process.platform !== 'win32') {
      expect(fs.statSync(written).mode & 0o777).toBe(0o600);
    }
    expect(readDaemonToken(4170, process.pid, dir)).toBe('secret');
    expect(removeDaemonToken(4170, process.pid, dir)).toBe(true);
    expect(readDaemonToken(4170, process.pid, dir)).toBeUndefined();
  });

  it('removes token sidecars for other instances on the same port', () => {
    writeDaemonToken(4170, 111, 'old', dir);
    writeDaemonToken(4170, 222, 'current', dir);
    writeDaemonToken(4171, 333, 'other-port', dir);

    expect(removeStaleDaemonTokens(4170, 222, dir)).toEqual([
      'daemon-4170-111.token',
    ]);
    expect(fs.existsSync(daemonTokenFilePath(4170, 111, dir))).toBe(false);
    expect(fs.existsSync(daemonTokenFilePath(4170, 222, dir))).toBe(true);
    expect(fs.existsSync(daemonTokenFilePath(4171, 333, dir))).toBe(true);
  });

  it('skips malformed records without failing the whole listing', () => {
    writeDaemonDiscovery(record(), dir);
    fs.writeFileSync(path.join(dir, 'daemon-4171.json'), '{not json');
    fs.writeFileSync(
      path.join(dir, 'daemon-4172.json'),
      JSON.stringify({ ...record(), pid: 'nope' }),
    );

    const { entries, invalid } = readDaemonDiscoveries(dir);
    expect(entries.map((entry) => entry.record.port)).toEqual([4170]);
    expect(invalid.map((item) => path.basename(item.path))).toEqual([
      'daemon-4171.json',
      'daemon-4172.json',
    ]);
  });

  it('validates the restart fields while keeping them optional', () => {
    const restartable = record({
      startupWorkspaces: ['/tmp/project'],
      web: false,
      requireAuth: true,
    });
    writeDaemonDiscovery(restartable, dir);
    fs.writeFileSync(
      path.join(dir, 'daemon-4171.json'),
      JSON.stringify({ ...record(), port: 4171, startupWorkspaces: [''] }),
    );
    fs.writeFileSync(
      path.join(dir, 'daemon-4172.json'),
      JSON.stringify({ ...record(), port: 4172, web: 'yes' }),
    );
    fs.writeFileSync(
      path.join(dir, 'daemon-4173.json'),
      JSON.stringify({ ...record(), port: 4173, requireAuth: 1 }),
    );

    const { entries, invalid } = readDaemonDiscoveries(dir);
    expect(entries.map((entry) => entry.record)).toEqual([restartable]);
    expect(invalid.map((item) => path.basename(item.path))).toEqual([
      'daemon-4171.json',
      'daemon-4172.json',
      'daemon-4173.json',
    ]);
  });

  it('removes a record only for the expected process', () => {
    const written = writeDaemonDiscovery(record(), dir);
    expect(
      removeDaemonDiscovery(4170, { dir, expectedPid: process.pid + 1 }),
    ).toBe(false);
    expect(fs.existsSync(written)).toBe(true);

    expect(removeDaemonDiscovery(4170, { dir, expectedPid: process.pid })).toBe(
      true,
    );
    expect(fs.existsSync(written)).toBe(false);
  });

  it('resolves QWEN_RUNTIME_DIR before the global directory', () => {
    expect(resolveDaemonDiscoveryDir({ QWEN_RUNTIME_DIR: dir })).toBe(
      path.join(dir, 'daemon'),
    );
  });

  it('rewrites wildcard binds to loopback for probing', () => {
    expect(daemonDiscoveryUrl('http://0.0.0.0:4170')).toBe(
      'http://127.0.0.1:4170',
    );
    expect(daemonDiscoveryUrl('http://[::]:4170')).toBe(
      'http://127.0.0.1:4170',
    );
    expect(daemonDiscoveryUrl('http://127.0.0.1:4170')).toBe(
      'http://127.0.0.1:4170',
    );
  });

  it('reports liveness for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
