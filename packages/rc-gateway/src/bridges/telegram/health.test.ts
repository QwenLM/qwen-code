/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildTelegramHealthReport,
  parseTelegramHealthzPort,
  startTelegramHealthServer,
} from './health.js';

const T0 = 1_000_000_000;

describe('buildTelegramHealthReport', () => {
  it('ok is true only when both daemonReachable AND telegramReachable', () => {
    expect(
      buildTelegramHealthReport(
        { daemonReachable: true, telegramReachable: true },
        { startedAtMs: T0, nowMs: T0 + 5000 },
      ).ok,
    ).toBe(true);

    expect(
      buildTelegramHealthReport(
        { daemonReachable: true, telegramReachable: false },
        { startedAtMs: T0, nowMs: T0 },
      ).ok,
    ).toBe(false);

    expect(
      buildTelegramHealthReport(
        { daemonReachable: false, telegramReachable: true },
        { startedAtMs: T0, nowMs: T0 },
      ).ok,
    ).toBe(false);

    expect(
      buildTelegramHealthReport(
        { daemonReachable: false, telegramReachable: false },
        { startedAtMs: T0, nowMs: T0 },
      ).ok,
    ).toBe(false);
  });

  it('uptimeSec is floored to whole seconds (never negative)', () => {
    const r = buildTelegramHealthReport(
      { daemonReachable: true, telegramReachable: true },
      { startedAtMs: T0, nowMs: T0 + 7500 },
    );
    expect(r.uptimeSec).toBe(7);

    const r2 = buildTelegramHealthReport(
      { daemonReachable: false, telegramReachable: false },
      { startedAtMs: T0 + 1000, nowMs: T0 }, // clock skew → clamp to 0
    );
    expect(r2.uptimeSec).toBe(0);
  });

  it('exposes daemonReachable and telegramReachable verbatim', () => {
    const r = buildTelegramHealthReport(
      { daemonReachable: true, telegramReachable: false },
      { startedAtMs: T0, nowMs: T0 },
    );
    expect(r.daemonReachable).toBe(true);
    expect(r.telegramReachable).toBe(false);
  });
});

describe('parseTelegramHealthzPort', () => {
  it('returns fallback when value is undefined', () => {
    expect(parseTelegramHealthzPort(undefined, 9100)).toBe(9100);
    expect(parseTelegramHealthzPort(undefined, undefined)).toBeUndefined();
  });

  it('disables on off/none/0/empty', () => {
    for (const v of ['off', 'none', '0', '']) {
      expect(parseTelegramHealthzPort(v, 9100)).toBeUndefined();
    }
  });

  it('parses a valid port number', () => {
    expect(parseTelegramHealthzPort('9200', 9100)).toBe(9200);
    expect(parseTelegramHealthzPort('1', 9100)).toBe(1);
    expect(parseTelegramHealthzPort('65535', 9100)).toBe(65535);
  });

  it('falls back to fallback for an invalid port string', () => {
    expect(parseTelegramHealthzPort('abc', 9100)).toBe(9100);
    expect(parseTelegramHealthzPort('0.5', 9100)).toBe(9100);
    expect(parseTelegramHealthzPort('99999', 9100)).toBe(9100);
  });
});

describe('startTelegramHealthServer', () => {
  it('serves GET /healthz with the current report', async () => {
    const srv = await startTelegramHealthServer(
      0, // port 0 → OS assigns
      () => ({
        ok: true,
        daemonReachable: true,
        telegramReachable: true,
        uptimeSec: 42,
      }),
    );
    try {
      expect(srv.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        daemonReachable: boolean;
        telegramReachable: boolean;
        uptimeSec: number;
      };
      expect(body.ok).toBe(true);
      expect(body.daemonReachable).toBe(true);
      expect(body.telegramReachable).toBe(true);
      expect(body.uptimeSec).toBe(42);
    } finally {
      await srv.close();
    }
  });

  it('returns 404 for unknown paths', async () => {
    const srv = await startTelegramHealthServer(0, () => ({
      ok: false,
      daemonReachable: false,
      telegramReachable: false,
      uptimeSec: 0,
    }));
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/other`);
      expect(res.status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it('resolves with port 0 when the port is already in use (non-fatal)', async () => {
    const srv1 = await startTelegramHealthServer(0, () => ({
      ok: true,
      daemonReachable: true,
      telegramReachable: true,
      uptimeSec: 0,
    }));
    const logs: string[] = [];
    const srv2 = await startTelegramHealthServer(
      srv1.port, // taken
      () => ({
        ok: false,
        daemonReachable: false,
        telegramReachable: false,
        uptimeSec: 0,
      }),
      { log: (m) => logs.push(m) },
    );
    try {
      expect(srv2.port).toBe(0); // bind failed gracefully
      expect(logs.some((l) => l.includes('healthz disabled'))).toBe(true);
    } finally {
      await srv1.close();
      await srv2.close();
    }
  });
});
