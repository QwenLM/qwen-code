import { describe, expect, it, vi } from 'vitest';
import { AcpBridge } from './AcpBridge.js';
import { CHANNEL_LOOP_MCP_SERVER_NAME } from './ChannelLoopTools.js';
import type { ChannelLoopToolHandler } from './ChannelAgentBridge.js';

type TestableAcpBridge = AcpBridge & {
  connection: { extMethod: ReturnType<typeof vi.fn> };
  channelLoopMcpServer: unknown;
  channelLoopToolHandlers: ChannelLoopToolHandler[];
  channelLoopMcpRegistered: boolean;
  handleExtMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  handleClientMcpMessage(params: Record<string, unknown>): Promise<unknown>;
  registerChannelLoopMcpServer(): Promise<void>;
  resolveChannelLoopToolHandler(sessionId: string): ChannelLoopToolHandler;
};

describe('AcpBridge', () => {
  it('registers the channel loop MCP server once across concurrent calls', async () => {
    const pending: Array<() => void> = [];
    const extMethod = vi.fn(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.connection = { extMethod };
    bridge.channelLoopMcpServer = {};

    const first = bridge.registerChannelLoopMcpServer();
    const second = bridge.registerChannelLoopMcpServer();

    expect(extMethod).toHaveBeenCalledTimes(1);
    pending.splice(0).forEach((resolve) => resolve());
    await Promise.all([first, second]);
    expect(bridge.channelLoopMcpRegistered).toBe(true);
  });

  it('does not fabricate a payload for MCP notifications', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.channelLoopMcpServer = {
      handleMessage: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      bridge.handleClientMcpMessage({
        server: CHANNEL_LOOP_MCP_SERVER_NAME,
        payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
        sessionId: 's-1',
      }),
    ).resolves.toStrictEqual({});
  });

  it('handles mid-turn queue drain requests from the ACP child', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;

    await expect(
      bridge.handleExtMethod('craft/drainMidTurnQueue', {
        sessionId: 's-1',
      }),
    ).resolves.toStrictEqual({ messages: [] });
  });

  it('rejects channel loop tool calls when no handler matches the session', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.channelLoopToolHandlers = [
      {
        canHandle: () => false,
        create: vi.fn(),
        list: vi.fn(),
        cancel: vi.fn(),
      },
    ];

    expect(() => bridge.resolveChannelLoopToolHandler('s-2')).toThrow(
      'No channel loop handler matched session s-2.',
    );
  });
});
