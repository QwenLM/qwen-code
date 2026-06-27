/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MCPServerStatus, type McpClient } from '@qwen-code/qwen-code-core';
import { appEvents } from '../../utils/events.js';
import { useConfigInitMessage } from './useConfigInitMessage.js';

function makeClient(status: MCPServerStatus): McpClient {
  return { getStatus: () => status } as unknown as McpClient;
}

describe('useConfigInitMessage', () => {
  afterEach(() => {
    appEvents.removeAllListeners('mcp-client-update');
  });

  it('returns null once config is initialized', () => {
    const { result } = renderHook(() => useConfigInitMessage(true));
    expect(result.current).toBeNull();
  });

  it('defaults to "Initializing..." while config is still initializing', () => {
    const { result } = renderHook(() => useConfigInitMessage(false));
    expect(result.current).toBe('Initializing...');
  });

  it('reports connection progress as MCP clients connect', () => {
    const { result } = renderHook(() => useConfigInitMessage(false));

    const clients = new Map<string, McpClient>([
      ['a', makeClient(MCPServerStatus.CONNECTED)],
      ['b', makeClient(MCPServerStatus.DISCONNECTED)],
      ['c', makeClient(MCPServerStatus.DISCONNECTED)],
    ]);

    act(() => {
      appEvents.emit('mcp-client-update', clients);
    });
    expect(result.current).toBe('Connecting to MCP servers... (1/3)');

    clients.set('b', makeClient(MCPServerStatus.CONNECTED));
    act(() => {
      appEvents.emit('mcp-client-update', clients);
    });
    expect(result.current).toBe('Connecting to MCP servers... (2/3)');
  });

  it('falls back to "Initializing..." when the clients map is empty', () => {
    const { result } = renderHook(() => useConfigInitMessage(false));

    act(() => {
      appEvents.emit(
        'mcp-client-update',
        new Map<string, McpClient>([
          ['a', makeClient(MCPServerStatus.CONNECTED)],
        ]),
      );
    });
    expect(result.current).toBe('Connecting to MCP servers... (1/1)');

    act(() => {
      appEvents.emit('mcp-client-update', new Map<string, McpClient>());
    });
    expect(result.current).toBe('Initializing...');
  });

  it('flips to null as soon as config finishes initializing', () => {
    const { result, rerender } = renderHook(
      ({ initialized }: { initialized: boolean }) =>
        useConfigInitMessage(initialized),
      { initialProps: { initialized: false } },
    );

    act(() => {
      appEvents.emit(
        'mcp-client-update',
        new Map<string, McpClient>([
          ['a', makeClient(MCPServerStatus.CONNECTED)],
        ]),
      );
    });
    expect(result.current).toBe('Connecting to MCP servers... (1/1)');

    rerender({ initialized: true });
    expect(result.current).toBeNull();
  });

  it('unsubscribes from mcp-client-update on unmount', () => {
    const { unmount } = renderHook(() => useConfigInitMessage(false));
    expect(appEvents.listenerCount('mcp-client-update')).toBe(1);
    unmount();
    expect(appEvents.listenerCount('mcp-client-update')).toBe(0);
  });

  it('unsubscribes when config transitions to initialized', () => {
    const { rerender } = renderHook(
      ({ initialized }: { initialized: boolean }) =>
        useConfigInitMessage(initialized),
      { initialProps: { initialized: false } },
    );
    expect(appEvents.listenerCount('mcp-client-update')).toBe(1);

    rerender({ initialized: true });
    expect(appEvents.listenerCount('mcp-client-update')).toBe(0);
  });
});
