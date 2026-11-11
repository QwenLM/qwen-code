/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { act } from 'react';
import { Text } from 'ink';
import { render } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useMcpStatus } from './useMcpStatus.js';
import { useMcpAuthHeaderNotice } from './useMcpAuthHeaderNotice.js';
import { McpAuthHeaderNotice } from '../components/McpAuthHeaderNotice.js';
import {
  MCPDiscoveryState,
  type Config,
  CoreEvent,
  coreEvents,
} from '@qwen-code/core';

describe('useMcpStatus', () => {
  let mockConfig: Config;
  let mockMcpClientManager: {
    getDiscoveryState: Mock<() => MCPDiscoveryState>;
    getMcpServerCount: Mock<() => number>;
    getNeedsAuthServerCount: Mock<() => number>;
  };

  beforeEach(() => {
    mockMcpClientManager = {
      getDiscoveryState: vi.fn().mockReturnValue(MCPDiscoveryState.NOT_STARTED),
      getMcpServerCount: vi.fn().mockReturnValue(0),
      getNeedsAuthServerCount: vi.fn().mockReturnValue(0),
    };

    mockConfig = {
      getMcpClientManager: vi.fn().mockReturnValue(mockMcpClientManager),
      waitForMcpInit: vi.fn().mockResolvedValue(undefined),
    } as unknown as Config;
  });

  const renderMcpStatusHook = async (config: Config) => {
    let hookResult: ReturnType<typeof useMcpStatus>;
    function TestComponent({ config }: { config: Config }) {
      hookResult = useMcpStatus(config);
      return null;
    }
    await render(<TestComponent config={config} />);
    return {
      result: {
        get current() {
          return hookResult;
        },
      },
    };
  };

  it('should initialize with correct values (no servers)', async () => {
    const { result } = await renderMcpStatusHook(mockConfig);

    expect(result.current.discoveryState).toBe(MCPDiscoveryState.NOT_STARTED);
    expect(result.current.mcpServerCount).toBe(0);
    expect(result.current.needsAuthServerCount).toBe(0);
    expect(result.current.isMcpReady).toBe(true);
  });

  it('should initialize with correct values (with servers, not started)', async () => {
    mockMcpClientManager.getMcpServerCount.mockReturnValue(1);
    const { result } = await renderMcpStatusHook(mockConfig);

    expect(result.current.isMcpReady).toBe(false);
  });

  it('should not be ready while in progress', async () => {
    mockMcpClientManager.getDiscoveryState.mockReturnValue(
      MCPDiscoveryState.IN_PROGRESS,
    );
    mockMcpClientManager.getMcpServerCount.mockReturnValue(1);
    const { result } = await renderMcpStatusHook(mockConfig);

    expect(result.current.isMcpReady).toBe(false);
  });

  it('should update state when McpClientUpdate is emitted', async () => {
    mockMcpClientManager.getMcpServerCount.mockReturnValue(1);
    mockMcpClientManager.getNeedsAuthServerCount.mockReturnValue(2);
    mockMcpClientManager.getDiscoveryState.mockReturnValue(
      MCPDiscoveryState.IN_PROGRESS,
    );
    const { result } = await renderMcpStatusHook(mockConfig);

    expect(result.current.isMcpReady).toBe(false);
    expect(result.current.needsAuthServerCount).toBe(2);

    mockMcpClientManager.getDiscoveryState.mockReturnValue(
      MCPDiscoveryState.COMPLETED,
    );
    mockMcpClientManager.getNeedsAuthServerCount.mockReturnValue(1);

    act(() => {
      coreEvents.emit(CoreEvent.McpClientUpdate, {
        sessionId: 'test-session',
        clients: new Map(),
      });
    });

    expect(result.current.discoveryState).toBe(MCPDiscoveryState.COMPLETED);
    expect(result.current.needsAuthServerCount).toBe(1);
    expect(result.current.isMcpReady).toBe(true);
  });

  it('updates the current notice frame from 2 to 1 to 0 after MCP events', async () => {
    mockMcpClientManager.getNeedsAuthServerCount.mockReturnValue(2);

    function TestComponent() {
      const { needsAuthServerCount } = useMcpStatus(mockConfig);
      const notice = useMcpAuthHeaderNotice(
        mockConfig,
        true,
        needsAuthServerCount,
      );
      return (
        <>
          <McpAuthHeaderNotice message={notice} />
          <Text>frame-anchor</Text>
        </>
      );
    }

    const { lastFrame, unmount } = await render(<TestComponent />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(lastFrame()).toContain(
      '2 MCP servers need authentication · run /mcp',
    );

    mockMcpClientManager.getNeedsAuthServerCount.mockReturnValue(1);
    await act(async () => {
      coreEvents.emit(CoreEvent.McpClientUpdate, {
        sessionId: 'test-session',
        clients: new Map(),
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(lastFrame()).toContain(
        '1 MCP server needs authentication · run /mcp',
      ),
    );

    mockMcpClientManager.getNeedsAuthServerCount.mockReturnValue(0);
    await act(async () => {
      coreEvents.emit(CoreEvent.McpClientUpdate, {
        sessionId: 'test-session',
        clients: new Map(),
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('frame-anchor');
      expect(lastFrame()).not.toContain('needs authentication');
    });
    unmount();
  });
});
