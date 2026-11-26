/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import type { EventEmitter } from 'node:events';
import {
  CoreEvent,
  coreEvents,
  type McpClient,
  MCPServerStatus,
} from '@qwen-code/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { renderHookWithProviders } from '../../test-utils/render.js';
import { useResumeStatus } from './useResumeStatus.js';
import { createMockSettings } from '../../test-utils/settings.js';

describe('useResumeStatus', () => {
  let listener: ((clients?: Map<string, McpClient>) => void) | undefined;
  let onSpy: MockInstance<EventEmitter['on']>;
  let offSpy: MockInstance<EventEmitter['off']>;

  beforeEach(() => {
    listener = undefined;
    onSpy = vi
      .spyOn(coreEvents as EventEmitter, 'on')
      .mockImplementation((event, eventListener) => {
        if (event === CoreEvent.McpClientUpdate) {
          listener = eventListener as (
            clients?: Map<string, McpClient>,
          ) => void;
        }
        return coreEvents;
      });
    offSpy = vi
      .spyOn(coreEvents as EventEmitter, 'off')
      .mockImplementation(() => coreEvents);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribes only while resume status is active', async () => {
    const { result, rerender, unmount } = await renderHookWithProviders(
      ({ active }: { active: boolean }) => useResumeStatus(active),
      { initialProps: { active: false } },
    );

    expect(result.current).toBe('Resuming session...');
    expect(onSpy).not.toHaveBeenCalledWith(
      CoreEvent.McpClientUpdate,
      expect.any(Function),
    );

    rerender({ active: true });
    expect(onSpy).toHaveBeenCalledWith(
      CoreEvent.McpClientUpdate,
      expect.any(Function),
    );

    rerender({ active: false });
    expect(offSpy).toHaveBeenCalledWith(
      CoreEvent.McpClientUpdate,
      expect.any(Function),
    );
    expect(result.current).toBe('Resuming session...');
    unmount();
  });

  it('reports MCP progress and limits the waiting-server list', async () => {
    const { result, unmount } = await renderHookWithProviders(
      () => useResumeStatus(true),
    );
    const connected = {
      getStatus: () => MCPServerStatus.CONNECTED,
    } as McpClient;
    const connecting = {
      getStatus: () => MCPServerStatus.CONNECTING,
    } as McpClient;

    act(() => {
      listener?.(
        new Map([
          ['connected', connected],
          ['alpha', connecting],
          ['beta', connecting],
          ['gamma', connecting],
          ['delta', connecting],
        ]),
      );
    });

    expect(result.current).toBe(
      'Resuming session... (Connecting to MCP servers... (1/5) - Waiting for: alpha, beta, gamma, +1 more)',
    );

    act(() => {
      listener?.(new Map([['connected', connected]]));
    });
    expect(result.current).toBe(
      'Resuming session... (Connecting to MCP servers... (1/1))',
    );
    unmount();
  });

  it('localizes resume and MCP progress while preserving server names and counters', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { result, unmount } = await renderHookWithProviders(
      () => useResumeStatus(true),
      { settings },
    );
    const connected = {
      getStatus: () => MCPServerStatus.CONNECTED,
    } as McpClient;
    const connecting = {
      getStatus: () => MCPServerStatus.CONNECTING,
    } as McpClient;

    act(() => {
      listener?.(
        new Map([
          ['connected', connected],
          ['alpha', connecting],
          ['beta', connecting],
          ['gamma', connecting],
          ['delta', connecting],
        ]),
      );
    });

    expect(result.current).toBe(
      '正在恢复会话...（正在连接 MCP 服务器...（1/5）；等待：alpha, beta, gamma，另有 1 个）',
    );
    unmount();
  });

  it('updates progress when the manager mutates and re-emits the same client map', async () => {
    const { result, unmount } = await renderHookWithProviders(
      () => useResumeStatus(true),
    );
    let status = MCPServerStatus.CONNECTING;
    const client = {
      getStatus: () => status,
    } as McpClient;
    const clients = new Map([['shared-client', client]]);

    act(() => listener?.(clients));
    expect(result.current).toBe(
      'Resuming session... (Connecting to MCP servers... (0/1) - Waiting for: shared-client)',
    );

    status = MCPServerStatus.CONNECTED;
    act(() => listener?.(clients));
    expect(result.current).toBe(
      'Resuming session... (Connecting to MCP servers... (1/1))',
    );
    unmount();
  });
});
