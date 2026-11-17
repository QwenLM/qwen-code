/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getPtyInputQueueBytes,
  MAX_PTY_INPUT_QUEUE_TASKS,
  type PtyInputQueueInternals,
} from './pty-input-queue.js';

describe('getPtyInputQueueBytes', () => {
  it('reads the Bun public queued/in-flight byte counter as it drains', () => {
    let pending = 300 * 1024;
    const pty = {
      get stats() {
        return { writeQueuedBytes: pending };
      },
    };
    expect(getPtyInputQueueBytes(pty)).toBe(pending);
    pending = 0;
    expect(getPtyInputQueueBytes(pty)).toBe(0);
  });

  it.each([undefined, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid Bun queued-byte count %s',
    (writeQueuedBytes) => {
      expect(
        getPtyInputQueueBytes({ stats: { writeQueuedBytes } }),
      ).toBeUndefined();
    },
  );

  it.each([MAX_PTY_INPUT_QUEUE_TASKS, MAX_PTY_INPUT_QUEUE_TASKS * 4])(
    'treats %s queued tasks as saturated without inspecting entries',
    (length) => {
      const queue = Array.from({ length }, () => ({
        get buffer(): Buffer {
          throw new Error('A saturated queue must not be scanned');
        },
        offset: 0,
      }));
      const pty = { _writeStream: { _writeQueue: queue } };
      expect(getPtyInputQueueBytes(pty)).toBe('saturated');
      queue.length = 0;
      expect(getPtyInputQueueBytes(pty)).toBe(0);
      queue.push({ buffer: Buffer.from('é'), offset: 1 });
      expect(getPtyInputQueueBytes(pty)).toBe(1);
    },
  );

  it('sums the remaining bytes across POSIX tasks', () => {
    const queue = [
      { buffer: Buffer.from('你好😀'), offset: 4 },
      { buffer: Buffer.from('é'), offset: 0 },
      { buffer: Buffer.from('done'), offset: 4 },
    ];
    const pty = { _writeStream: { _writeQueue: queue } };
    expect(getPtyInputQueueBytes(pty)).toBe(8);
    queue[0].offset = 10;
    expect(getPtyInputQueueBytes(pty)).toBe(2);
    queue.splice(0);
    expect(getPtyInputQueueBytes(pty)).toBe(0);
  });

  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, 2])(
    'rejects invalid task offset %s',
    (offset) => {
      expect(
        getPtyInputQueueBytes({
          _writeStream: {
            _writeQueue: [{ buffer: Buffer.from('x'), offset }],
          },
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    { _writeStream: {} },
    { _writeStream: { _writeQueue: {} } },
    { _writeStream: { _writeQueue: [null] } },
    { _writeStream: { _writeQueue: [{ offset: 0 }] } },
    { _writeStream: { _writeQueue: [{ buffer: 'x', offset: 0 }] } },
    { _writeStream: { _writeQueue: [{ buffer: Buffer.from('x') }] } },
  ])('rejects malformed POSIX queue %j', (pty) => {
    expect(
      getPtyInputQueueBytes(pty as unknown as PtyInputQueueInternals),
    ).toBeUndefined();
  });

  it('rejects a malformed tail even after a head exceeds the admission limit', () => {
    expect(
      getPtyInputQueueBytes({
        _writeStream: {
          _writeQueue: [
            { buffer: Buffer.alloc(1024 * 1024), offset: 0 },
            { buffer: Buffer.from('x'), offset: -1 },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it('uses the Windows input socket instead of its output socket', () => {
    expect(
      getPtyInputQueueBytes({
        _agent: { inSocket: { writableLength: 9 } },
        _socket: { writableLength: 0 },
      }),
    ).toBe(9);
    expect(
      getPtyInputQueueBytes({ _agent: {}, _socket: { writableLength: 0 } }),
    ).toBeUndefined();
  });

  it('supports a legacy socket only when no Windows agent exists', () => {
    expect(
      getPtyInputQueueBytes({
        _agent: undefined,
        _socket: { writableLength: 7 },
      }),
    ).toBe(7);
    expect(getPtyInputQueueBytes({ _socket: { writableLength: 0 } })).toBe(0);
    expect(getPtyInputQueueBytes({})).toBeUndefined();
  });

  it.each([undefined, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid socket count %s in either backend',
    (writableLength) => {
      expect(
        getPtyInputQueueBytes({ _agent: { inSocket: { writableLength } } }),
      ).toBeUndefined();
      expect(
        getPtyInputQueueBytes({ _socket: { writableLength } }),
      ).toBeUndefined();
    },
  );
});
