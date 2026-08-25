/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@agentclientprotocol/sdk';
import {
  createBoundedAcpTransportSafety,
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

  it('estimates boolean and JSON null values on their dedicated arms', () => {
    // The boolean arm and the null half of the null/undefined arm are the
    // deciding checks here: with either arm deleted the value falls through
    // to the fail-closed catch-all and the estimate flips to the refusal
    // sentinel. Both arms must stay bounded, or wire-legal JSON `true` /
    // `false` / `null` params would retire healthy daemon transports.
    expect(
      estimateTransportValueBytes({ flag: true, gone: null }, 1024),
    ).toBeLessThan(1025);
    const parsed = JSON.parse(
      '{"sessionId":"s","rawInput":null,"tags":[null]}',
    );
    expect(estimateTransportValueBytes(parsed, GENEROUS_LIMIT)).toBe(
      Buffer.byteLength(JSON.stringify(parsed)),
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
    // For ARRAYS the hazard function is the sole defense: the array frame
    // only inspects index descriptors, so an accessor-backed own `toJSON`
    // must be refused by hasStructuralToJSONHazard's get/set condition
    // itself. Dropping that condition leaves the record cases above green
    // (the record frame refuses accessor keys independently) but admits
    // these arrays.
    const arrayGetter: unknown[] = [1];
    Object.defineProperty(arrayGetter, 'toJSON', {
      enumerable: true,
      configurable: true,
      get: () => () => [2],
    });
    expect(estimateTransportValueBytes(arrayGetter, 1024)).toBe(1025);
    const arraySetter: unknown[] = [1];
    Object.defineProperty(arraySetter, 'toJSON', {
      enumerable: true,
      configurable: true,
      set: () => {},
    });
    expect(estimateTransportValueBytes(arraySetter, 1024)).toBe(1025);
  });

  it('refuses accessor-backed members and indices at the frame level', () => {
    // An accessor under a non-`toJSON` key never reaches
    // hasStructuralToJSONHazard; the record frame's descriptor check is the
    // deciding refusal.
    const getterMember: Record<string, unknown> = { keep: 'v' };
    Object.defineProperty(getterMember, 'payload', {
      enumerable: true,
      configurable: true,
      get: () => 'x',
    });
    expect(estimateTransportValueBytes(getterMember, 1024)).toBe(1025);
    const setterMember: Record<string, unknown> = { keep: 'v' };
    Object.defineProperty(setterMember, 'payload', {
      enumerable: true,
      configurable: true,
      set: () => {},
    });
    expect(estimateTransportValueBytes(setterMember, 1024)).toBe(1025);
    // Likewise for array indices: the array frame inspects each index
    // descriptor and must refuse accessors.
    const getterIndex: unknown[] = ['a'];
    Object.defineProperty(getterIndex, '0', {
      enumerable: true,
      configurable: true,
      get: () => 'x',
    });
    expect(estimateTransportValueBytes(getterIndex, 1024)).toBe(1025);
    const setterIndex: unknown[] = ['a'];
    Object.defineProperty(setterIndex, '0', {
      enumerable: true,
      configurable: true,
      set: () => {},
    });
    expect(estimateTransportValueBytes(setterIndex, 1024)).toBe(1025);
  });

  it('fails closed on nested non-plain values via the catch-all branch', () => {
    // A function, a class instance, or a Map nested inside plain containers
    // is skipped or substituted by JSON.stringify; the only check that can
    // catch such values is the estimator's final fail-closed else, because
    // every earlier check (toJSON hazard, frame-level accessors, cycles)
    // sees only the plain wrappers.
    expect(estimateTransportValueBytes({ nested: () => 1 }, 1024)).toBe(1025);
    expect(estimateTransportValueBytes({ d: new Date() }, 1024)).toBe(1025);
    expect(estimateTransportValueBytes([new Map()], 1024)).toBe(1025);
  });

  it('still refuses cyclic values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(estimateTransportValueBytes(cyclic, 1024)).toBe(1025);
  });

  it('refuses array cycles without re-walking the cycle', () => {
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expect(estimateTransportValueBytes(cyclicArray, 1024)).toBe(1025);

    // The harm of a missing array-leg cycle check is WORK, not result: the
    // byte limit still trips eventually, so the refusal assertion above
    // passes either way. Count descriptor reads through a proxy to bound
    // the walk deterministically — the pristine estimator reads index 0
    // once before `seen` refuses the re-entry, while a walker without the
    // array-leg check re-reads it on every descent until the byte limit
    // trips (~limitBytes / 2 reads).
    let indexReads = 0;
    const target: unknown[] = [];
    const proxied: unknown[] = new Proxy(target, {
      getOwnPropertyDescriptor(proxyTarget, prop) {
        if (prop === '0') indexReads++;
        return Reflect.getOwnPropertyDescriptor(proxyTarget, prop);
      },
    });
    target.push(proxied);
    expect(estimateTransportValueBytes(proxied, 1024)).toBe(1025);
    expect(indexReads).toBeLessThan(8);
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

  it('releases the admission budget after a handler completes', async () => {
    // 3000 bytes fits exactly one small frame (2048-byte envelope + params),
    // and `maxActiveHandlers: 1` fits exactly one in-flight handler; a
    // second sequential call is admitted only if the first call's budget
    // was released by BOTH `finally` decrements in the admission run — the
    // byte decrement (`activeBytes -= requiredBytes`) and the paired count
    // decrement (`activeHandlers--`). Capping only bytes would let a leaked
    // handler count survive until the channel's lifetime request count
    // reaches maxActiveHandlers, after which every inbound call fails
    // admission and guard.fail retires the transport mid-session.
    const guard = {
      ...createFakeGuard(),
      maxActiveHandlers: 1,
      maxActiveHandlerBytes: 3000,
    };
    const { client, sessionUpdate } = createFakeClient();
    const wrapped = createLogSafeAcpClient(client, guard);
    const params = {
      sessionId: 's',
      update: { sessionUpdate: 'plan', entries: [] },
    } as never;

    await wrapped.sessionUpdate(params);
    await wrapped.sessionUpdate(params);

    expect(sessionUpdate).toHaveBeenCalledTimes(2);
    expect(guard.fail).not.toHaveBeenCalled();
  });

  it('keeps the admission budget held while a handler is in flight', async () => {
    const guard = { ...createFakeGuard(), maxActiveHandlerBytes: 3000 };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessionUpdate = vi.fn(async () => {
      await held;
    });
    const client = {
      requestPermission: vi.fn(async () => ({})),
      sessionUpdate,
    } as unknown as Client;
    const wrapped = createLogSafeAcpClient(client, guard);
    const params = {
      sessionId: 's',
      update: { sessionUpdate: 'plan', entries: [] },
    } as never;

    const first = wrapped.sessionUpdate(params);
    // The second frame arrives while the first still holds the budget: it
    // must fail closed rather than share a budget that has not been freed.
    await expect(wrapped.sessionUpdate(params)).rejects.toThrow();
    expect(sessionUpdate).toHaveBeenCalledTimes(1);
    expect(guard.fail).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('reserves the prepared response on the request success path', async () => {
    const reservePreparedResponse = vi.fn();
    const guard = { ...createFakeGuard(), reservePreparedResponse };
    const requestPermission = vi.fn(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow' },
    }));
    const client = {
      requestPermission,
      sessionUpdate: vi.fn(async () => {}),
    } as unknown as Client;
    const wrapped = createLogSafeAcpClient(client, guard);

    const result = await wrapped.requestPermission({
      sessionId: 's',
      options: [],
    } as never);

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    // runRequest must charge the retained response against maxQueuedBytes;
    // dropping the success-path reservation would let large request
    // responses queue uncharged.
    expect(reservePreparedResponse).toHaveBeenCalledTimes(1);
    expect(reservePreparedResponse).toHaveBeenCalledWith(result);
  });

  it('reserves under null when a request handler resolves undefined', async () => {
    // The ACP SDK sends `{ result: result ?? null }` on the wire, so
    // runRequest must reserve under the same normalized value: a handler
    // resolving `undefined` that reserved under `undefined` would charge
    // under a key the release path never sees — releaseMessage looks the
    // sent frame's `result: null` up, misses, and the charge leaks until
    // the queue limit retires the transport.
    const reservePreparedResponse = vi.fn();
    const guard = { ...createFakeGuard(), reservePreparedResponse };
    const extMethod = vi.fn(
      async (): Promise<Record<string, unknown>> => undefined as never,
    );
    const client = {
      requestPermission: vi.fn(async () => ({})),
      sessionUpdate: vi.fn(async () => {}),
      extMethod,
    } as unknown as Client;
    const wrapped = createLogSafeAcpClient(client, guard);

    await wrapped.extMethod!('x/status', { sessionId: 's' });

    expect(extMethod).toHaveBeenCalledTimes(1);
    expect(reservePreparedResponse).toHaveBeenCalledTimes(1);
    expect(reservePreparedResponse).toHaveBeenCalledWith(null);
  });

  it('releases the undefined-resolving charge through the null wire frame', async () => {
    // Drive an undefined-resolving handler through a real reserve→release
    // pairing: each call reserves under the normalized `null` result, and
    // the observed `result: null` wire frame must release that same
    // charge. With the `?? null` normalization dropped from runRequest,
    // the release lookup misses and the third reservation trips the
    // two-message queue limit (NdJsonQueueLimitError → guard.fail).
    const failures: unknown[] = [];
    const safety = createBoundedAcpTransportSafety(
      {
        maxFrameBytes: 64 * 1024,
        maxQueuedMessages: 2,
        maxQueuedBytes: 64 * 1024,
      },
      (error) => {
        failures.push(error);
      },
    );
    const extMethod = vi.fn(
      async (): Promise<Record<string, unknown>> => undefined as never,
    );
    const client = {
      requestPermission: vi.fn(async () => ({})),
      sessionUpdate: vi.fn(async () => {}),
      extMethod,
    } as unknown as Client;
    const wrapped = createLogSafeAcpClient(client, safety.guard);

    for (let id = 1; id <= 5; id++) {
      await wrapped.extMethod!('x/status', { sessionId: 's' });
      safety.observeMessage({
        direction: 'sent',
        bytes: 32,
        message: { jsonrpc: '2.0', id, result: null },
      });
    }

    expect(extMethod).toHaveBeenCalledTimes(5);
    expect(failures).toEqual([]);
  });

  it('fails request admission closed when params exceed the handler budget', async () => {
    const guard = { ...createFakeGuard(), maxActiveHandlerBytes: 3000 };
    const requestPermission = vi.fn(async () => ({}));
    const client = {
      requestPermission,
      sessionUpdate: vi.fn(async () => {}),
    } as unknown as Client;
    const wrapped = createLogSafeAcpClient(client, guard);

    await expect(
      wrapped.requestPermission({
        sessionId: 's',
        options: [],
        note: 'x'.repeat(4096),
      } as never),
    ).rejects.toThrow();

    expect(requestPermission).not.toHaveBeenCalled();
    expect(guard.fail).toHaveBeenCalledTimes(1);
  });
});
