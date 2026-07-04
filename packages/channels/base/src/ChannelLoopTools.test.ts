import { describe, expect, it, vi } from 'vitest';
import { ChannelLoopMcpServer } from './ChannelLoopTools.js';

describe('ChannelLoopMcpServer', () => {
  it('lists channel loop tools', async () => {
    const server = new ChannelLoopMcpServer({
      create: vi.fn(),
      list: vi.fn(),
      cancel: vi.fn(),
    });

    const response = await server.handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {},
    );

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'channel_loop_create' }),
          expect.objectContaining({ name: 'channel_loop_list' }),
          expect.objectContaining({ name: 'channel_loop_cancel' }),
        ]),
      },
    });
  });

  it('routes create calls with the current channel session id', async () => {
    const create = vi.fn().mockResolvedValue('Loop job-1: * * * * *');
    const server = new ChannelLoopMcpServer({
      create,
      list: vi.fn(),
      cancel: vi.fn(),
    });

    const response = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'channel_loop_create',
          arguments: {
            cron: '* * * * *',
            prompt: 'drink water',
          },
        },
      },
      { sessionId: 's-1' },
    );

    expect(create).toHaveBeenCalledWith('s-1', {
      cron: '* * * * *',
      prompt: 'drink water',
    });
    expect(response).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'Loop job-1: * * * * *' }],
      },
    });
  });

  it('does not respond to JSON-RPC notifications', async () => {
    const server = new ChannelLoopMcpServer({
      create: vi.fn(),
      list: vi.fn(),
      cancel: vi.fn(),
    });

    await expect(
      server.handleMessage(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it('trims cancel ids before dispatch', async () => {
    const cancel = vi.fn().mockResolvedValue('Cancelled loop job-1.');
    const server = new ChannelLoopMcpServer({
      create: vi.fn(),
      list: vi.fn(),
      cancel,
    });

    await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'channel_loop_cancel',
          arguments: { id: '  job-1  ' },
        },
      },
      { sessionId: 's-1' },
    );

    expect(cancel).toHaveBeenCalledWith('s-1', 'job-1');
  });
});
