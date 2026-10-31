import { describe, expect, it, vi } from 'vitest';
import {
  ChannelLoopMcpServer,
  selectChannelToolsForSession,
} from './ChannelLoopTools.js';

describe('ChannelLoopMcpServer', () => {
  it('lists channel loop tools for a session', async () => {
    const server = new ChannelLoopMcpServer({
      create: vi.fn(),
      list: vi.fn(),
      cancel: vi.fn(),
    });

    const response = await server.handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { sessionId: 's-1' },
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

  it('exposes no tools without a resolved session', async () => {
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
      result: { tools: [] },
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

  it.each(['false', 0])(
    'treats serialized false recurring value %s as one-shot',
    async (recurring) => {
      const create = vi.fn().mockResolvedValue('Loop job-1: * * * * *');
      const server = new ChannelLoopMcpServer({
        create,
        list: vi.fn(),
        cancel: vi.fn(),
      });

      await server.handleMessage(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'channel_loop_create',
            arguments: {
              cron: '* * * * *',
              prompt: 'drink water',
              recurring,
            },
          },
        },
        { sessionId: 's-1' },
      );

      expect(create).toHaveBeenCalledWith('s-1', {
        cron: '* * * * *',
        prompt: 'drink water',
        recurring: false,
      });
    },
  );

  it.each(['true', 1])(
    'treats serialized true recurring value %s as recurring',
    async (recurring) => {
      const create = vi.fn().mockResolvedValue('Loop job-1: * * * * *');
      const server = new ChannelLoopMcpServer({
        create,
        list: vi.fn(),
        cancel: vi.fn(),
      });

      await server.handleMessage(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'channel_loop_create',
            arguments: {
              cron: '* * * * *',
              prompt: 'drink water',
              recurring,
            },
          },
        },
        { sessionId: 's-1' },
      );

      expect(create).toHaveBeenCalledWith('s-1', {
        cron: '* * * * *',
        prompt: 'drink water',
        recurring: true,
      });
    },
  );

  it('routes list calls with the current channel session id', async () => {
    const list = vi.fn().mockResolvedValue('No loops.');
    const server = new ChannelLoopMcpServer({
      create: vi.fn(),
      list,
      cancel: vi.fn(),
    });

    const response = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'channel_loop_list' },
      },
      { sessionId: 's-1' },
    );

    expect(list).toHaveBeenCalledWith('s-1');
    expect(response).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'No loops.' }],
      },
    });
  });

  it('marks handler failure text as an MCP tool error', async () => {
    const server = new ChannelLoopMcpServer({
      create: vi.fn().mockResolvedValue({
        text: 'Channel loops are not configured.',
        isError: true,
      }),
      list: vi.fn(),
      cancel: vi.fn(),
    });

    const response = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'channel_loop_create',
          arguments: { cron: '* * * * *', prompt: 'drink water' },
        },
      },
      { sessionId: 's-1' },
    );

    expect(response).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'Channel loops are not configured.' }],
        isError: true,
      },
    });
  });

  it('returns an isError tool result when sessionId is missing', async () => {
    const create = vi.fn();
    const server = new ChannelLoopMcpServer({
      create,
      list: vi.fn(),
      cancel: vi.fn(),
    });

    const response = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'channel_loop_list' },
      },
      {},
    );

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 5,
      result: {
        content: [{ type: 'text', text: 'Missing channel session id.' }],
        isError: true,
      },
    });
    expect(response).not.toHaveProperty('error');
    expect(create).not.toHaveBeenCalled();
  });

  it('names the failed binding when the frame carried an unbound session id', async () => {
    const create = vi.fn();
    const server = new ChannelLoopMcpServer({
      create,
      list: vi.fn(),
      cancel: vi.fn(),
    });

    const response = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'channel_loop_list' },
      },
      { carriedSessionId: 's-skip' },
    );

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [
          {
            type: 'text',
            text: 'No channel tool binding is active for this session.',
          },
        ],
        isError: true,
      },
    });
    expect(response).not.toHaveProperty('error');
    expect(create).not.toHaveBeenCalled();
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

  it('responds to JSON-RPC ping requests', async () => {
    const server = new ChannelLoopMcpServer({
      create: vi.fn(),
      list: vi.fn(),
      cancel: vi.fn(),
    });

    const response = await server.handleMessage(
      { jsonrpc: '2.0', id: 7, method: 'ping' },
      {},
    );

    expect(response).toStrictEqual({ jsonrpc: '2.0', id: 7, result: {} });
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

describe('ChannelLoopMcpServer adapter tools', () => {
  const handler = { create: vi.fn(), list: vi.fn(), cancel: vi.fn() };
  const tool = (name: string, run: (...args: never[]) => unknown) => ({
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    handler: run as never,
  });

  it('merges adapter tools into tools/list', async () => {
    const server = new ChannelLoopMcpServer(handler, {
      extraTools: () => [
        tool('qq_recall_message', vi.fn()),
        tool('adapter_tool', vi.fn()),
      ],
    });

    const response = await server.handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { sessionId: 's-1' },
    );

    expect(response).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'channel_loop_create' }),
          expect.objectContaining({
            name: 'qq_recall_message',
            description: 'qq_recall_message description',
            inputSchema: { type: 'object', properties: {} },
          }),
          expect.objectContaining({ name: 'adapter_tool' }),
        ]),
      },
    });
  });

  it('dispatches adapter tools with the channel session id', async () => {
    const run = vi.fn().mockResolvedValue('Message recalled.');
    const server = new ChannelLoopMcpServer(handler, {
      extraTools: () => [tool('qq_recall_message', run)],
    });

    const response = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'qq_recall_message',
          arguments: { message_id: 'M1' },
        },
      },
      { sessionId: 's-7' },
    );

    expect(run).toHaveBeenCalledWith(
      { message_id: 'M1' },
      { sessionId: 's-7' },
    );
    expect(response).toMatchObject({
      result: { content: [{ type: 'text', text: 'Message recalled.' }] },
    });
  });

  it('marks adapter tool failures as isError', async () => {
    const server = new ChannelLoopMcpServer(handler, {
      extraTools: () => [
        tool(
          'adapter_tool',
          vi.fn().mockResolvedValue({ text: 'allowlist-only', isError: true }),
        ),
      ],
    });

    const response = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'adapter_tool', arguments: {} },
      },
      { sessionId: 's-1' },
    );

    expect(response).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'allowlist-only' }],
        isError: true,
      },
    });
  });

  it('hides loop tools while keeping adapter tools available', async () => {
    const server = new ChannelLoopMcpServer(handler, {
      extraTools: () => [tool('qq_recall_message', vi.fn())],
      loopToolsEnabled: () => false,
    });

    const response = await server.handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      { sessionId: 's-1' },
    );

    const tools = (response as { result: { tools: Array<{ name: string }> } })
      .result.tools;
    expect(tools.map((entry) => entry.name)).toEqual(['qq_recall_message']);
  });

  it('tells loops-enabled intent apart per session', async () => {
    const server = new ChannelLoopMcpServer(handler, {
      extraTools: () => [tool('qq_recall_message', vi.fn())],
      loopToolsEnabled: (sessionId) => sessionId !== 'no-loops',
    });

    const list = async (sessionId: string) => {
      const response = await server.handleMessage(
        { jsonrpc: '2.0', id: 5, method: 'tools/list' },
        { sessionId },
      );
      return (
        response as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((entry) => entry.name);
    };

    expect(await list('s-1')).toContain('channel_loop_create');
    expect(await list('no-loops')).not.toContain('channel_loop_create');
    expect(await list('no-loops')).toContain('qq_recall_message');
  });

  it('reports unknown tool names as JSON-RPC errors', async () => {
    const server = new ChannelLoopMcpServer(handler, {
      extraTools: () => [],
    });

    const response = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'nope', arguments: {} },
      },
      { sessionId: 's-1' },
    );

    expect(response).toMatchObject({
      error: { message: 'Unknown channel loop tool: nope' },
    });
  });
});

describe('selectChannelToolsForSession', () => {
  const tool = (name: string, owner: string | undefined) => ({
    name,
    description: owner ? `${name} owned by ${owner}` : `${name} global`,
    inputSchema: { type: 'object', properties: {} },
    ...(owner === undefined ? {} : { owner }),
    handler: async () => name,
  });

  it('offers owned tools only to their channel', () => {
    const tools = [
      tool('a', 'bot-a'),
      tool('b', 'bot-b'),
      tool('c', undefined),
    ];
    expect(
      selectChannelToolsForSession(tools, 'bot-a').map((entry) => entry.name),
    ).toEqual(['a', 'c']);
    expect(
      selectChannelToolsForSession(tools, 'bot-b').map((entry) => entry.name),
    ).toEqual(['b', 'c']);
  });

  it('hides owned tools from a session with no owner', () => {
    const tools = [tool('a', 'bot-a'), tool('c', undefined)];
    expect(
      selectChannelToolsForSession(tools, undefined).map((entry) => entry.name),
    ).toEqual(['c']);
  });

  it('lets the owning channel shadow an ownerless tool of the same name', () => {
    const ownerless = tool('shared', undefined);
    const owned = tool('shared', 'bot-a');
    const forOwner = selectChannelToolsForSession([ownerless, owned], 'bot-a');
    expect(forOwner).toHaveLength(1);
    expect(forOwner[0]?.description).toBe('shared owned by bot-a');

    const forOther = selectChannelToolsForSession([ownerless, owned], 'bot-b');
    expect(forOther).toHaveLength(1);
    expect(forOther[0]?.description).toBe('shared global');
  });
});
