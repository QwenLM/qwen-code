/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isNotification,
  isRequest,
  isResponse,
  parseInbound,
  QWEN_METHOD_NS,
  RPC,
} from './json-rpc.js';

describe('json-rpc helpers', () => {
  it('classifies a request', () => {
    const m = { jsonrpc: '2.0', id: 1, method: 'initialize' };
    expect(isRequest(m)).toBe(true);
    expect(isNotification(m)).toBe(false);
    expect(isResponse(m)).toBe(false);
  });

  it('classifies a notification (no id)', () => {
    const m = { jsonrpc: '2.0', method: 'session/cancel' };
    expect(isNotification(m)).toBe(true);
    expect(isRequest(m)).toBe(false);
  });

  it('classifies a response (result, no method)', () => {
    const m = { jsonrpc: '2.0', id: -1, result: { ok: true } };
    expect(isResponse(m)).toBe(true);
    expect(isRequest(m)).toBe(false);
  });

  it('classifies an error response', () => {
    const m = { jsonrpc: '2.0', id: 2, error: { code: -1, message: 'x' } };
    expect(isResponse(m)).toBe(true);
  });

  it('rejects a response with BOTH result and error (XOR); parseInbound → 400-shape', () => {
    const m = {
      jsonrpc: '2.0',
      id: 3,
      result: {},
      error: { code: -1, message: 'x' },
    };
    expect(isResponse(m)).toBe(false);
    const r = parseInbound(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error.code).toBe(RPC.INVALID_REQUEST);
  });

  it('rejects JSON-RPC batch arrays', () => {
    const r = parseInbound([{ jsonrpc: '2.0', id: 1, method: 'x' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error.code).toBe(RPC.INVALID_REQUEST);
  });

  it('rejects malformed envelopes', () => {
    expect(parseInbound({ foo: 'bar' }).ok).toBe(false);
    expect(parseInbound(null).ok).toBe(false);
  });

  it('accepts a well-formed request', () => {
    const r = parseInbound({ jsonrpc: '2.0', id: 1, method: 'session/new' });
    expect(r.ok).toBe(true);
  });

  it('exposes the qwen extension namespace', () => {
    expect(QWEN_METHOD_NS).toBe('_qwen/');
  });
});
