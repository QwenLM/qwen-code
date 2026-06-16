/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  denormalizeAcpNotification,
  filterEventsBySession,
  _resetSyntheticIdCounter,
  type JsonRpcNotification,
} from '../../src/daemon/AcpEventDenormalizer.js';
import type { DaemonEvent } from '../../src/daemon/types.js';

beforeEach(() => {
  _resetSyntheticIdCounter();
});

// ---------------------------------------------------------------------------
// denormalizeAcpNotification
// ---------------------------------------------------------------------------

describe('denormalizeAcpNotification', () => {
  it('converts session/update with type and data', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        type: 'session_update',
        data: { sessionId: 's1', content: 'hello' },
      },
    };
    const event = denormalizeAcpNotification(notification);
    expect(event).toBeDefined();
    expect(event!.type).toBe('session_update');
    expect(event!.data).toEqual({ sessionId: 's1', content: 'hello' });
    expect(event!.id).toBe(1);
    expect(event!.v).toBe(1);
  });

  it('converts session/update using params as data when data is missing', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        type: 'session_update',
        sessionId: 's2',
      },
    };
    const event = denormalizeAcpNotification(notification);
    expect(event).toBeDefined();
    expect(event!.type).toBe('session_update');
    // data falls back to the full params object.
    expect(event!.data).toEqual({
      type: 'session_update',
      sessionId: 's2',
    });
  });

  it('converts session/update with nested update.sessionUpdate (current daemon format)', () => {
    // This is the shape the daemon actually sends:
    //   { method: "session/update", params: { sessionId, update: { sessionUpdate: "<type>", ...data } } }
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'assistant.text.delta',
          content: { text: 'Hello' },
          _meta: { serverTimestamp: 12345 },
        },
      },
    };
    const event = denormalizeAcpNotification(notification);
    expect(event).toBeDefined();
    expect(event!.type).toBe('assistant.text.delta');
    // data is the update object with sessionId merged in.
    expect(event!.data).toEqual({
      sessionUpdate: 'assistant.text.delta',
      content: { text: 'Hello' },
      _meta: { serverTimestamp: 12345 },
      sessionId: 's1',
    });
    // _meta is extracted from the update object.
    expect(event!._meta).toEqual({ serverTimestamp: 12345 });
  });

  it('returns undefined for session/update without a type field', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1' },
    };
    expect(denormalizeAcpNotification(notification)).toBeUndefined();
  });

  it('returns undefined for session/update with empty type', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { type: '' },
    };
    expect(denormalizeAcpNotification(notification)).toBeUndefined();
  });

  it('converts _qwen/notify', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: '_qwen/notify',
      params: {
        type: 'workspace_initialized',
        data: { cwd: '/tmp' },
      },
    };
    const event = denormalizeAcpNotification(notification);
    expect(event).toBeDefined();
    expect(event!.type).toBe('workspace_initialized');
    expect(event!.data).toEqual({ cwd: '/tmp' });
  });

  it('converts workspace-scoped snake_case methods', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'memory_changed',
      params: { file: 'CLAUDE.md' },
    };
    const event = denormalizeAcpNotification(notification);
    expect(event).toBeDefined();
    expect(event!.type).toBe('memory_changed');
    expect(event!.data).toEqual({ file: 'CLAUDE.md' });
  });

  it('converts namespace/event methods, using the event part as type', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'workspace/agent_changed',
      params: { agentId: 'a1' },
    };
    const event = denormalizeAcpNotification(notification);
    expect(event).toBeDefined();
    expect(event!.type).toBe('agent_changed');
  });

  it('returns undefined for unrecognized methods without _ or /', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'ping',
      params: {},
    };
    expect(denormalizeAcpNotification(notification)).toBeUndefined();
  });

  it('produces monotonically increasing synthetic ids', () => {
    const n1: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { type: 'a', data: {} },
    };
    const n2: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { type: 'b', data: {} },
    };
    const e1 = denormalizeAcpNotification(n1);
    const e2 = denormalizeAcpNotification(n2);
    expect(e1!.id).toBe(1);
    expect(e2!.id).toBe(2);
  });

  it('preserves _meta when present as a plain object', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        type: 'test',
        data: {},
        _meta: { custom: 'value' },
      },
    };
    const event = denormalizeAcpNotification(notification);
    expect(event!._meta).toEqual({ custom: 'value' });
  });

  it('preserves originatorClientId when present', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        type: 'test',
        data: {},
        originatorClientId: 'client-42',
      },
    };
    const event = denormalizeAcpNotification(notification);
    expect(event!.originatorClientId).toBe('client-42');
  });

  it('handles missing params gracefully', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'memory_changed',
    };
    const event = denormalizeAcpNotification(notification);
    expect(event).toBeDefined();
    expect(event!.type).toBe('memory_changed');
    expect(event!.data).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// filterEventsBySession
// ---------------------------------------------------------------------------

describe('filterEventsBySession', () => {
  const events: DaemonEvent[] = [
    { id: 1, v: 1, type: 'a', data: { sessionId: 'sess-1' } },
    { id: 2, v: 1, type: 'b', data: { sessionId: 'sess-2' } },
    { id: 3, v: 1, type: 'c', data: {} }, // workspace-scoped
    { id: 4, v: 1, type: 'd', data: { sessionId: 'sess-1' } },
    { id: 5, v: 1, type: 'e', data: 'string-data' }, // non-record data
  ];

  it('yields events matching the specified session', () => {
    const filtered = [...filterEventsBySession(events, 'sess-1')];
    expect(filtered.map((e) => e.type)).toEqual(['a', 'c', 'd', 'e']);
  });

  it('filters out events from other sessions', () => {
    const filtered = [...filterEventsBySession(events, 'sess-1')];
    expect(filtered.find((e) => e.type === 'b')).toBeUndefined();
  });

  it('passes through workspace-scoped events (no sessionId)', () => {
    const filtered = [...filterEventsBySession(events, 'sess-2')];
    expect(filtered.map((e) => e.type)).toEqual(['b', 'c', 'e']);
  });

  it('passes through events with non-record data', () => {
    const filtered = [...filterEventsBySession(events, 'sess-1')];
    expect(filtered.find((e) => e.type === 'e')).toBeDefined();
  });

  it('handles empty input', () => {
    const filtered = [...filterEventsBySession([], 'sess-1')];
    expect(filtered).toEqual([]);
  });
});
