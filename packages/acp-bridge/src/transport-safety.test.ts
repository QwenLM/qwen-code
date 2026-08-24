/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@agentclientprotocol/sdk';
import {
  createLogSafeAcpClient,
  estimateTransportValueBytes,
  type AcpChannelTransportGuard,
} from './transport-safety.js';

const GENEROUS_LIMIT = Number.MAX_SAFE_INTEGER;

describe('estimateTransportValueBytes', () => {
  it('estimates plain-data toJSON keys like any other member', () => {
    // After JSON.parse a `toJSON` key is plain data — never callable — and
    // JSON.stringify serializes it as an ordinary member, so it must be
    // estimated, not refused. Refusing it retired whole daemon transports
    // over wire-legal inbound messages.
    const parsed = JSON.parse(
      '{"sessionId":"s","rawInput":{"toJSON":"model-data"},"tags":[{"toJSON":"v"}]}',
    );
    expect(estimateTransportValueBytes(parsed, GENEROUS_LIMIT)).toBe(
      Buffer.byteLength(JSON.stringify(parsed)),
    );
  });

  it('estimates arrays and records carrying an own plain-data toJSON key', () => {
    const recordWithToJSON = { toJSON: 'data', payload: 'p' };
    expect(estimateTransportValueBytes(recordWithToJSON, GENEROUS_LIMIT)).toBe(
      Buffer.byteLength(JSON.stringify(recordWithToJSON)),
    );
    const arrayWithToJSON = Object.assign(['a', 'b'], { toJSON: 'data' });
    // JSON.stringify serializes arrays by index only; the estimator matches.
    expect(estimateTransportValueBytes(arrayWithToJSON, GENEROUS_LIMIT)).toBe(
      Buffer.byteLength(JSON.stringify(arrayWithToJSON)),
    );
  });

  it('still refuses callable toJSON values, which substitute stringify output', () => {
    const record = { toJSON: () => ({ substituted: true }) };
    expect(estimateTransportValueBytes(record, 1024)).toBe(1025);
    const array = Object.assign([1], { toJSON: () => [2] });
    expect(estimateTransportValueBytes(array, 1024)).toBe(1025);
  });

  it('still refuses accessor-backed toJSON values', () => {
    const getterBacked: Record<string, unknown> = {};
    Object.defineProperty(getterBacked, 'toJSON', {
      enumerable: true,
      configurable: true,
      get: () => () => ({ substituted: true }),
    });
    expect(estimateTransportValueBytes(getterBacked, 1024)).toBe(1025);
    const setterBacked: Record<string, unknown> = {};
    Object.defineProperty(setterBacked, 'toJSON', {
      enumerable: true,
      configurable: true,
      set: () => {},
    });
    expect(estimateTransportValueBytes(setterBacked, 1024)).toBe(1025);
  });

  it('still refuses cyclic values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(estimateTransportValueBytes(cyclic, 1024)).toBe(1025);
  });
});

function createFakeGuard(): AcpChannelTransportGuard & {
  fail: ReturnType<typeof vi.fn>;
} {
  return {
    maxActiveHandlers: 8,
    maxActiveHandlerBytes: 64 * 1024 * 1024,
    reserveOutboundOperation: () => () => {},
    reservePreparedResponse: () => {},
    fail: vi.fn(),
  };
}

function createFakeClient() {
  const sessionUpdate = vi.fn(async () => {});
  const client = {
    requestPermission: vi.fn(async () => ({})),
    sessionUpdate,
  } as unknown as Client;
  return { client, sessionUpdate };
}

describe('inbound handler admission', () => {
  it('admits handlers whose params carry plain-data toJSON keys', () => {
    const guard = createFakeGuard();
    const { client, sessionUpdate } = createFakeClient();
    const wrapped = createLogSafeAcpClient(client, guard);
    // The exact wire shape: JSON.parse'd ACP params where model/MCP content
    // (rawInput is z.unknown() in the ACP SDK) contains a literal "toJSON"
    // data key. The old lenient inbound estimator admitted these; the strict
    // estimator must too, because such values pose no serialization hazard.
    const params = JSON.parse(
      '{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","rawInput":{"toJSON":"model-data"}}}',
    );
    return expect(wrapped.sessionUpdate(params))
      .resolves.toBeUndefined()
      .then(() => {
        expect(sessionUpdate).toHaveBeenCalledTimes(1);
        expect(guard.fail).not.toHaveBeenCalled();
      });
  });

  it('fails closed when params carry a callable toJSON value', async () => {
    const guard = createFakeGuard();
    const { client, sessionUpdate } = createFakeClient();
    const wrapped = createLogSafeAcpClient(client, guard);
    await expect(
      wrapped.sessionUpdate({
        sessionId: 's',
        rawInput: { toJSON: () => ({ substituted: true }) },
      } as never),
    ).rejects.toThrow();
    expect(sessionUpdate).not.toHaveBeenCalled();
    expect(guard.fail).toHaveBeenCalledTimes(1);
  });

  it('keeps admission independent of the estimation refusal semantics for ordinary frames', async () => {
    const guard = createFakeGuard();
    const { client, sessionUpdate } = createFakeClient();
    const wrapped = createLogSafeAcpClient(client, guard);
    await wrapped.sessionUpdate({
      sessionId: 's',
      update: { sessionUpdate: 'plan', entries: [] },
    } as never);
    expect(sessionUpdate).toHaveBeenCalledTimes(1);
    expect(guard.fail).not.toHaveBeenCalled();
  });
});
