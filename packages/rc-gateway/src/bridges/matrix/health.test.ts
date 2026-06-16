/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMatrixHealthReport,
  initialMatrixHealthState,
  startMatrixHealthServer,
  type MatrixHealthServer,
} from './health.js';
import { olmStoreDir } from './e2ee.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-mx-health-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('buildMatrixHealthReport', () => {
  it('returns the spec shape with live state + computed uptime', () => {
    const r = buildMatrixHealthReport(
      {
        registeredId: 'matrix',
        daemonReachable: true,
        homeserverReachable: true,
      },
      { stateDir: dir, startedAtMs: 1_000, nowMs: 8_500 },
    );
    expect(r).toEqual({
      ok: true,
      daemonReachable: true,
      homeserverReachable: true,
      olmStorePresent: false, // no olm dir yet
      registeredId: 'matrix',
      uptimeSec: 7, // floor((8500-1000)/1000)
    });
  });

  it('reflects olmStorePresent flipping as the store appears on disk', () => {
    const ctx = { stateDir: dir, startedAtMs: 0, nowMs: 0 };
    expect(
      buildMatrixHealthReport(initialMatrixHealthState(), ctx).olmStorePresent,
    ).toBe(false);
    const od = olmStoreDir(dir);
    mkdirSync(od, { recursive: true });
    writeFileSync(join(od, 'matrix-sdk-crypto.sqlite3'), 'x');
    expect(
      buildMatrixHealthReport(initialMatrixHealthState(), ctx).olmStorePresent,
    ).toBe(true);
  });
});

describe('startMatrixHealthServer (live loopback server)', () => {
  let server: MatrixHealthServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('serves GET /healthz as JSON and reflects olmStorePresent flipping live', async () => {
    const state = initialMatrixHealthState();
    state.registeredId = 'matrix';
    state.daemonReachable = true;
    server = await startMatrixHealthServer(0, () =>
      buildMatrixHealthReport(state, {
        stateDir: dir,
        startedAtMs: 0,
        nowMs: 5_000,
      }),
    );
    expect(server.port).toBeGreaterThan(0);
    const url = `http://127.0.0.1:${server.port}/healthz`;

    const r1 = await fetch(url);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toContain('application/json');
    const body1 = await r1.json();
    expect(body1).toMatchObject({
      ok: true,
      daemonReachable: true,
      registeredId: 'matrix',
      olmStorePresent: false,
    });

    // Create the olm store on disk → the SAME endpoint now reports true.
    const od = olmStoreDir(dir);
    mkdirSync(od, { recursive: true });
    writeFileSync(join(od, 'matrix-sdk-crypto.sqlite3'), 'x');
    const body2 = await (await fetch(url)).json();
    expect(body2.olmStorePresent).toBe(true);
  });

  it('returns 404 for any non-/healthz path', async () => {
    server = await startMatrixHealthServer(0, () =>
      buildMatrixHealthReport(initialMatrixHealthState(), {
        stateDir: dir,
        startedAtMs: 0,
        nowMs: 0,
      }),
    );
    const r = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(r.status).toBe(404);
  });

  it('does NOT crash when the port is already taken (returns a no-op handle)', async () => {
    const report = () =>
      buildMatrixHealthReport(initialMatrixHealthState(), {
        stateDir: dir,
        startedAtMs: 0,
        nowMs: 0,
      });
    server = await startMatrixHealthServer(0, report);
    const taken = server.port;
    // A second bind on the same port fails — but resolves to a no-op handle,
    // never throws (a healthz conflict must not take down the bridge).
    const second = await startMatrixHealthServer(taken, report);
    expect(second.port).toBe(0);
    await second.close(); // no-op, must not throw
  });
});
