import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRouter } from '@qwen-code/channel-base';
import { QQChannel } from './QQChannel.js';

// The outbound media tools must bind to the chat of the turn in progress, not
// to the router target frozen at session creation: under a shared
// `sessionScope` one session serves every chat, so the target is whichever chat
// created it and a file would be delivered somewhere the caller never asked
// about. Same invariant the moderation tools already pin.
describe('outbound media tools resolve the turn chat', () => {
  type FileTool = {
    name: string;
    handler: (
      args: Record<string, unknown>,
      context: { sessionId: string },
    ) => Promise<string | { text: string; isError?: boolean }>;
  };

  let workspace: string;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'qq-file-tool-')));
    // Constructing a real QQChannel creates the shared channel state directory
    // under the global Qwen home; keep it inside this test's workspace so the
    // suite never touches the developer's ~/.qwen.
    vi.stubEnv('QWEN_HOME', join(workspace, 'qwen-home'));
    writeFileSync(join(workspace, 'chart.png'), Buffer.from('not-an-image'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
  });

  function makeChannel(
    configOverrides: Record<string, unknown>,
    routerTarget: { channelName: string; chatId: string } | undefined,
  ): { ch: QQChannel; tool: FileTool; sendMedia: ReturnType<typeof vi.fn> } {
    const registered: FileTool[] = [];
    const router = new SessionRouter(
      {} as never,
      workspace,
      (configOverrides['sessionScope'] as never) ?? 'single',
    );
    vi.spyOn(router, 'getTarget').mockReturnValue(routerTarget as never);
    vi.spyOn(router, 'getSessionCwd').mockReturnValue(workspace);
    const ch = new QQChannel(
      'test-bot',
      {
        type: 'qq',
        token: '',
        senderPolicy: 'open',
        allowedUsers: [],
        sessionScope: 'single',
        cwd: workspace,
        groupPolicy: 'disabled',
        groups: {},
        appID: 'test-app-id',
        appSecret: 'test-secret',
        groupAllPolicy: 'log',
        keywordTriggers: [],
        fileTools: true,
        ...configOverrides,
      } as never,
      {
        on: vi.fn(),
        off: vi.fn(),
        registerChannelTool: (tool: FileTool) => registered.push(tool),
      } as never,
      { router },
    );
    const tool = registered.find((entry) => entry.name === 'qq_send_file');
    if (!tool) throw new Error('qq_send_file was not registered');
    const sendMedia = vi.fn().mockResolvedValue({ ok: true });
    (ch as unknown as { sendQQMedia: unknown }).sendQQMedia = sendMedia;
    return { ch, tool, sendMedia };
  }

  async function call(
    tool: FileTool,
    sessionId: string,
  ): Promise<{ text: string; isError: boolean }> {
    const result = await tool.handler(
      { path: join(workspace, 'chart.png') },
      { sessionId },
    );
    return typeof result === 'string'
      ? { text: result, isError: false }
      : { text: result.text, isError: result.isError === true };
  }

  it('sends into the turn chat, not the frozen router target', async () => {
    const { ch, tool, sendMedia } = makeChannel(
      {},
      {
        channelName: 'test-bot',
        chatId: 'GROUP_A',
      },
    );

    (
      ch as unknown as {
        onPromptStart: (chatId: string, sessionId: string) => void;
      }
    ).onPromptStart('GROUP_B', 'session-1');

    const result = await call(tool, 'session-1');

    expect(result.isError).toBe(false);
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendMedia.mock.calls[0]![0]).toMatchObject({ chatId: 'GROUP_B' });
    // The frozen target is a different chat: this is the regression.
    expect(sendMedia.mock.calls[0]![0]).not.toMatchObject({
      chatId: 'GROUP_A',
    });
  });

  it('rebinds to each new turn chat instead of keeping the first one', async () => {
    const { ch, tool, sendMedia } = makeChannel(
      {},
      {
        channelName: 'test-bot',
        chatId: 'GROUP_A',
      },
    );
    const raw = ch as unknown as {
      onPromptStart: (chatId: string, sessionId: string) => void;
      onPromptEnd: (chatId: string, sessionId: string) => void;
    };

    raw.onPromptStart('GROUP_B', 'session-1');
    await call(tool, 'session-1');
    raw.onPromptEnd('GROUP_B', 'session-1');
    raw.onPromptStart('GROUP_C', 'session-1');
    await call(tool, 'session-1');

    expect(sendMedia.mock.calls.map((c) => c[0].chatId)).toEqual([
      'GROUP_B',
      'GROUP_C',
    ]);
  });

  it('fails closed for a single-scope session outside a turn', async () => {
    const { tool, sendMedia } = makeChannel(
      {},
      {
        channelName: 'test-bot',
        chatId: 'GROUP_A',
      },
    );

    const result = await call(tool, 'session-1');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('No QQ chat is bound');
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it('still falls back to the routed target for a per-chat scope', async () => {
    const { tool, sendMedia } = makeChannel(
      { sessionScope: 'user' },
      {
        channelName: 'test-bot',
        chatId: 'USER_A',
      },
    );

    const result = await call(tool, 'session-1');

    expect(result.isError).toBe(false);
    expect(sendMedia.mock.calls[0]![0]).toMatchObject({ chatId: 'USER_A' });
  });

  it('does not send through another channel target', async () => {
    const { tool, sendMedia } = makeChannel(
      { sessionScope: 'user' },
      {
        channelName: 'other-bot',
        chatId: 'OTHER_CHAT',
      },
    );

    const result = await call(tool, 'session-1');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('No QQ chat is bound');
    expect(sendMedia).not.toHaveBeenCalled();
  });
});
