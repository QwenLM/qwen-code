import { describe, expect, it, vi } from 'vitest';
import { AcpBridge } from './AcpBridge.js';

type TestableAcpBridge = AcpBridge & {
  connection: { extMethod: ReturnType<typeof vi.fn> };
  channelLoopMcpServer: unknown;
  channelLoopMcpRegistered: boolean;
  registerChannelLoopMcpServer(): Promise<void>;
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
});
