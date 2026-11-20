/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveSseAdmissionCaps,
  sseListenerCapsForStatus,
  sseMaxConnections,
} from './daemon-status.js';
import { tagListener } from './local-control/listener-identity.js';
import {
  checkSseAdmission,
  countSseStream,
  evaluateSseAdmission,
  getSseOccupancy,
  getSurfaceCount,
  type SseStreamSurface,
} from './sse-occupancy.js';

const { writeStderrLine } = vi.hoisted(() => ({
  writeStderrLine: vi.fn(),
}));
vi.mock('../utils/stdioHelpers.js', () => ({ writeStderrLine }));

/** Synthetic request whose socket resolves to the tagged listener. */
function reqOn(kind: 'primary' | 'local-control' | 'remote-access'): Request {
  const server = {} as Server;
  tagListener(server, { kind });
  return { socket: { server } } as unknown as Request;
}

/** Minimal response double recording the refusal and emitting 'close'. */
function fakeRes() {
  const emitter = new EventEmitter();
  const json = vi.fn();
  const res = Object.assign(emitter, {
    destroyed: false,
    setHeader: vi.fn(),
    status: vi.fn(() => ({ json })),
    json,
  });
  return res as unknown as Response & {
    destroyed: boolean;
    setHeader: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    emit: (event: string) => boolean;
  };
}

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.clearAllMocks();
});

function count(
  surface: SseStreamSurface,
  kind: 'primary' | 'local-control' | 'remote-access' = 'primary',
  res?: Response,
) {
  const release = countSseStream(surface, reqOn(kind), res);
  releases.push(release);
  return release;
}

describe('sse occupancy counters', () => {
  it('counts per surface, per listener, and in total; release is idempotent', () => {
    const before = getSseOccupancy();
    const releaseRest = count('restEvents');
    count('acpWs', 'local-control');
    count('generation', 'remote-access');
    const during = getSseOccupancy();
    expect(during.total).toBe(before.total + 3);
    expect(during.bySurface.restEvents).toBe(before.bySurface.restEvents + 1);
    expect(during.bySurface.acpWs).toBe(before.bySurface.acpWs + 1);
    expect(during.bySurface.generation).toBe(before.bySurface.generation + 1);
    expect(during.byListener.primary).toBe(before.byListener.primary + 1);
    expect(during.byListener['local-control']).toBe(
      before.byListener['local-control'] + 1,
    );
    expect(during.byListener['remote-access']).toBe(
      before.byListener['remote-access'] + 1,
    );
    expect(getSurfaceCount('restEvents')).toBe(during.bySurface.restEvents);

    releaseRest();
    releaseRest(); // idempotent
    const after = getSseOccupancy();
    expect(after.total).toBe(before.total + 2);
    expect(after.bySurface.restEvents).toBe(before.bySurface.restEvents);
    expect(after.byListener.primary).toBe(before.byListener.primary);
  });

  it('releases on response close when a response is provided', () => {
    const before = getSseOccupancy();
    const res = fakeRes();
    count('acpSse', 'primary', res);
    expect(getSseOccupancy().total).toBe(before.total + 1);
    res.emit('close');
    expect(getSseOccupancy().total).toBe(before.total);
    // A late second close must not double-release.
    res.emit('close');
    expect(getSseOccupancy().total).toBe(before.total);
  });

  it('releases immediately when the response is already destroyed', () => {
    const before = getSseOccupancy();
    const res = fakeRes();
    res.destroyed = true;
    count('artifactLibrary', 'primary', res);
    expect(getSseOccupancy().total).toBe(before.total);
  });

  it('snapshot is a fresh copy, not live state', () => {
    const snapshot = getSseOccupancy();
    count('hostedEvents');
    expect(snapshot.total).toBe(getSseOccupancy().total - 1);
  });
});

describe('evaluateSseAdmission', () => {
  it('admits everything when caps are absent', () => {
    count('restEvents');
    expect(evaluateSseAdmission('primary', undefined)).toBeUndefined();
  });

  it('refuses at the aggregate cap with daemon scope', () => {
    const caps = resolveSseAdmissionCaps({
      maxConnections: 10,
      maxSseConnections: 2,
    });
    count('restEvents');
    count('acpWs', 'local-control');
    const refusal = evaluateSseAdmission('primary', caps);
    expect(refusal).toEqual({
      listener: 'primary',
      scope: 'daemon',
      active: getSseOccupancy().total,
      limit: 2,
    });
  });

  it('refuses at the listener clamp with listener scope', () => {
    // Aggregate high enough not to bind; the pairing clamp (51) binds.
    const caps = resolveSseAdmissionCaps({ maxConnections: 256 });
    expect(caps.byListener['local-control']).toBe(51);
    for (let i = 0; i < 51; i++) count('restEvents', 'local-control');
    const refusal = evaluateSseAdmission('local-control', caps);
    expect(refusal?.scope).toBe('listener');
    expect(refusal?.listener).toBe('local-control');
    expect(refusal?.limit).toBe(51);
    expect(refusal?.active).toBe(51);
    // The primary listener still admits under the same caps.
    expect(evaluateSseAdmission('primary', caps)).toBeUndefined();
  });

  it('checks the aggregate before the listener clamp', () => {
    const caps = resolveSseAdmissionCaps({
      maxConnections: 256,
      maxSseConnections: 1,
    });
    // Fill BOTH caps: the listener clamp (51) on local-control and the
    // aggregate (1). Only aggregate-first reports the daemon-wide budget;
    // a listener-first order would report 'listener' here (review R1-4).
    const listenerClamp = caps.byListener['local-control']!;
    for (let i = 0; i < listenerClamp; i++) {
      count('restEvents', 'local-control');
    }
    expect(getSseOccupancy().byListener['local-control']).toBe(listenerClamp);
    expect(evaluateSseAdmission('local-control', caps)?.scope).toBe('daemon');
  });
});

describe('checkSseAdmission refusal shape', () => {
  it('sends 503 + Retry-After with the shared code and logs a WARN', () => {
    const caps = resolveSseAdmissionCaps({
      maxConnections: 10,
      maxSseConnections: 1,
    });
    count('restEvents');
    const res = fakeRes();
    const daemonLog = { warn: vi.fn() };
    const admitted = checkSseAdmission({
      surface: 'generation',
      req: reqOn('primary'),
      res,
      caps,
      daemonLog: daemonLog as never,
      logContext: { sessionId: 'sess-1' },
    });
    expect(admitted).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error:
        `Daemon SSE connection limit reached (${getSseOccupancy().total}/1). ` +
        `Retry after the Retry-After interval.`,
      code: 'sse_connection_limit_exceeded',
      limit: 1,
      active: getSseOccupancy().total,
      scope: 'daemon',
    });
    expect(daemonLog.warn).toHaveBeenCalledWith(
      'SSE connection limit reached',
      expect.objectContaining({
        surface: 'generation',
        listener: 'primary',
        scope: 'daemon',
        limit: 1,
        sessionId: 'sess-1',
      }),
    );
    expect(writeStderrLine).not.toHaveBeenCalled();
  });

  it('adds listener details on a listener-scoped refusal', () => {
    const caps = resolveSseAdmissionCaps({ maxConnections: 256 });
    for (let i = 0; i < 51; i++) count('restEvents', 'local-control');
    const res = fakeRes();
    expect(
      checkSseAdmission({
        surface: 'restEvents',
        req: reqOn('local-control'),
        res,
        caps,
      }),
    ).toBe(false);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'sse_connection_limit_exceeded',
        scope: 'listener',
        listener: 'local-control',
        limit: 51,
        active: 51,
      }),
    );
  });

  it('falls back to the stderr line without a daemonLog', () => {
    const caps = resolveSseAdmissionCaps({
      maxConnections: 10,
      maxSseConnections: 1,
    });
    count('restEvents');
    const res = fakeRes();
    checkSseAdmission({
      surface: 'acpSse',
      req: reqOn('primary'),
      res,
      caps,
    });
    expect(writeStderrLine).toHaveBeenCalledWith(
      `qwen serve: SSE connection limit reached (active=${getSseOccupancy().total}, limit=1); ` +
        `rejecting new SSE client with 503`,
    );
  });

  it('admits below the cap without touching the response', () => {
    const caps = resolveSseAdmissionCaps({ maxConnections: 256 });
    const res = fakeRes();
    expect(
      checkSseAdmission({
        surface: 'restEvents',
        req: reqOn('primary'),
        res,
        caps,
      }),
    ).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('resolveSseAdmissionCaps', () => {
  it('derives the aggregate and pairing clamps from the listener cap', () => {
    const caps = resolveSseAdmissionCaps({});
    expect(caps.aggregate).toBe(sseMaxConnections(undefined, undefined));
    expect(caps.aggregate).toBe(204);
    expect(caps.byListener).toEqual({
      primary: 204,
      'local-control': 51,
      'remote-access': 51,
    });
  });

  it('honors an explicit override downward and clamps it upward', () => {
    expect(resolveSseAdmissionCaps({ maxSseConnections: 5 }).aggregate).toBe(5);
    expect(resolveSseAdmissionCaps({ maxSseConnections: 300 }).aggregate).toBe(
      204,
    );
    // The pairing clamp stays derived from the pairing socket budget.
    expect(
      resolveSseAdmissionCaps({ maxSseConnections: 300 }).byListener[
        'local-control'
      ],
    ).toBe(51);
  });

  it('disables every clamp on the disabled sentinels', () => {
    for (const opts of [
      { maxSseConnections: 0 },
      { maxSseConnections: Infinity },
      { maxConnections: 0 },
    ]) {
      const caps = resolveSseAdmissionCaps(opts);
      expect(caps.aggregate).toBeUndefined();
      expect(caps.byListener).toEqual({
        primary: undefined,
        'local-control': undefined,
        'remote-access': undefined,
      });
    }
  });

  it('keeps an explicit cap when the listener cap is disabled', () => {
    const caps = resolveSseAdmissionCaps({
      maxConnections: 0,
      maxSseConnections: 4,
    });
    expect(caps.aggregate).toBe(4);
    expect(caps.byListener.primary).toBe(4);
    expect(caps.byListener['local-control']).toBe(51);
  });

  it('floors fractional caps to at least one stream', () => {
    const caps = resolveSseAdmissionCaps({
      maxConnections: 2,
      maxSseConnections: 0.8,
    });
    expect(caps.aggregate).toBe(1);
  });

  it('maps to the status payload with null for unlimited', () => {
    expect(sseListenerCapsForStatus(undefined, undefined)).toEqual({
      primary: 204,
      'local-control': 51,
      'remote-access': 51,
    });
    expect(sseListenerCapsForStatus(0, undefined)).toEqual({
      primary: null,
      'local-control': null,
      'remote-access': null,
    });
  });
});
