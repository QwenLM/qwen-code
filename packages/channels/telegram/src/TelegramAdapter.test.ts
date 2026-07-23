import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './TelegramAdapter.js';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  ChannelTaskLifecycleEvent,
  Envelope,
} from '@qwen-code/channel-base';

type LifecycleBase = Omit<
  Extract<ChannelTaskLifecycleEvent, { type: 'started' }>,
  'type'
>;

type TestTelegramMessage = {
  from: { id: number; first_name: string; last_name?: string };
  chat: { id: number; type: string; title?: string };
  message_thread_id?: number;
  reply_to_message?: { from?: { id: number }; text?: string };
};

type TestTelegramEntity = { type: string; offset: number; length: number };

class TestTelegramChannel extends TelegramChannel {
  beginTyping(chatId: string): void {
    this.onPromptStart(chatId);
  }

  emitLifecycle(event: ChannelTaskLifecycleEvent): void {
    this.onTaskLifecycle(event);
  }

  buildTestEnvelope(
    msg: TestTelegramMessage,
    text: string,
    entities?: TestTelegramEntity[],
  ): Envelope {
    return (
      this as unknown as {
        buildEnvelope: (
          msg: TestTelegramMessage,
          text: string,
          entities?: TestTelegramEntity[],
        ) => Envelope;
      }
    ).buildEnvelope(msg, text, entities);
  }

  pushTestProactive(
    target: { chatId: string; threadId?: string },
    text: string,
  ) {
    return this.pushProactive(
      { channelName: 'telegram', senderId: '1', ...target },
      text,
    );
  }
}

const config: ChannelConfig = {
  type: 'telegram',
  token: 'token',
  senderPolicy: 'open',
  allowedUsers: [],
  sessionScope: 'user',
  cwd: process.cwd(),
  groupPolicy: 'disabled',
  dmPolicy: 'open',
  groups: {},
};

function createChannel(
  configOverrides: Partial<ChannelConfig> = {},
  router: unknown = {},
): TestTelegramChannel {
  return new TestTelegramChannel(
    'telegram',
    { ...config, ...configOverrides },
    {} as ChannelAgentBridge,
    {
      router: router as never,
    },
  );
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    channelName: 'telegram',
    senderId: 'user-1',
    senderName: 'User 1',
    chatId: 'chat-1',
    text: 'hello',
    isGroup: false,
    isMentioned: false,
    isReplyToBot: false,
    ...overrides,
  };
}

function installFakeBot(channel: TelegramChannel): {
  token: string;
  api: {
    getMe: ReturnType<typeof vi.fn>;
    setMyCommands: ReturnType<typeof vi.fn>;
    sendChatAction: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const bot = {
    token: 'token',
    api: {
      getMe: vi.fn().mockResolvedValue({ id: 123, username: 'qwen_bot' }),
      setMyCommands: vi.fn().mockResolvedValue(true),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
  (channel as unknown as { bot: typeof bot }).bot = bot;
  return bot;
}

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('supports proactive loop messages', () => {
    const channel = createChannel();

    expect(channel.supportsProactiveSend()).toBe(true);
  });

  it('clears active typing intervals on disconnect', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const channel = createChannel();
    const bot = installFakeBot(channel);

    channel.beginTyping('chat-1');
    channel.beginTyping('chat-2');
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);

    channel.disconnect();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(bot.stop).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4000);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);
  });

  it('maps lifecycle start and terminal events to typing', () => {
    const channel = createChannel();
    const bot = installFakeBot(channel);

    const baseEvent = {
      channelName: 'telegram',
      chatId: 'chat-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      identity: { id: 'channel:telegram', displayName: 'telegram' },
      memoryScope: { namespace: 'channel:telegram', mode: 'metadata-only' },
    } satisfies LifecycleBase;

    channel.emitLifecycle({ ...baseEvent, type: 'started' });
    channel.emitLifecycle({ ...baseEvent, type: 'started' });
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4000);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);

    channel.emitLifecycle({ ...baseEvent, type: 'completed' });
    channel.emitLifecycle({
      ...baseEvent,
      type: 'failed',
      error: 'boom',
      phase: 'agent',
    });

    vi.advanceTimersByTime(4000);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);
  });

  it('keeps typing active until every session in the chat reaches terminal state', () => {
    const channel = createChannel();
    const bot = installFakeBot(channel);

    const baseEvent = {
      channelName: 'telegram',
      chatId: 'chat-1',
      messageId: 'message-1',
      identity: { id: 'channel:telegram', displayName: 'telegram' },
      memoryScope: { namespace: 'channel:telegram', mode: 'metadata-only' },
    } satisfies Omit<LifecycleBase, 'sessionId'>;

    channel.emitLifecycle({
      ...baseEvent,
      sessionId: 'session-1',
      type: 'started',
    });
    channel.emitLifecycle({
      ...baseEvent,
      sessionId: 'session-2',
      type: 'started',
    });
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4000);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);

    channel.emitLifecycle({
      ...baseEvent,
      sessionId: 'session-1',
      type: 'completed',
    });

    vi.advanceTimersByTime(4000);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(3);

    channel.emitLifecycle({
      ...baseEvent,
      sessionId: 'session-2',
      type: 'cancelled',
      reason: 'cancel_command',
    });

    vi.advanceTimersByTime(4000);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(3);
  });

  it('clears typing when a session dies without a terminal event', () => {
    const handleSessionDied = vi.fn();
    const channel = createChannel({}, { handleSessionDied });
    const bot = installFakeBot(channel);

    channel.emitLifecycle({
      channelName: 'telegram',
      chatId: 'chat-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      identity: { id: 'channel:telegram', displayName: 'telegram' },
      memoryScope: { namespace: 'channel:telegram', mode: 'metadata-only' },
      type: 'started',
    });
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);

    channel.onSessionDied('session-1');

    expect(handleSessionDied).toHaveBeenCalledWith('session-1');

    vi.advanceTimersByTime(4000);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);
  });

  it('treats typing status API failures as best-effort', () => {
    const channel = createChannel();
    const bot = installFakeBot(channel);
    bot.api.sendChatAction.mockImplementation(() => {
      throw new Error('telegram unavailable');
    });

    expect(() => channel.beginTyping('chat-1')).not.toThrow();
    expect(() =>
      channel.emitLifecycle({
        channelName: 'telegram',
        chatId: 'chat-2',
        sessionId: 'session-2',
        messageId: 'message-2',
        identity: { id: 'channel:telegram', displayName: 'telegram' },
        memoryScope: { namespace: 'channel:telegram', mode: 'metadata-only' },
        type: 'started',
      }),
    ).not.toThrow();

    vi.advanceTimersByTime(4000);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(4);
  });

  it('registers the Telegram command menu before polling starts', async () => {
    const channel = createChannel();
    const bot = installFakeBot(channel);
    const processOnceSpy = vi.spyOn(process, 'once').mockReturnValue(process);

    await channel.connect();

    expect(bot.api.setMyCommands).toHaveBeenCalledWith([
      { command: 'start', description: 'Show quick-start help' },
      { command: 'help', description: 'Show available commands' },
      { command: 'new', description: 'Start a fresh conversation' },
      { command: 'cancel', description: 'Cancel the running request' },
      { command: 'status', description: 'Show session info' },
    ]);
    expect(bot.start).toHaveBeenCalledWith({ drop_pending_updates: true });
    expect(bot.api.setMyCommands.mock.invocationCallOrder[0]).toBeLessThan(
      bot.start.mock.invocationCallOrder[0],
    );
    expect(processOnceSpy).toHaveBeenCalled();
  });

  it('continues startup when Telegram command menu registration fails', async () => {
    const channel = createChannel();
    const bot = installFakeBot(channel);
    bot.api.setMyCommands.mockRejectedValue(new Error('bot api down'));
    vi.spyOn(process, 'once').mockReturnValue(process);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await channel.connect();

    expect(bot.start).toHaveBeenCalledWith({ drop_pending_updates: true });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to register bot commands'),
    );
  });

  it('handles /start locally', async () => {
    const channel = createChannel();
    const bot = installFakeBot(channel);

    await channel.handleInbound(envelope({ text: '/start' }));

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Qwen Code Telegram bot'),
      { parse_mode: 'HTML' },
    );
  });

  it('only treats addressed Telegram bot commands as mentions in groups', () => {
    const channel = createChannel();
    installFakeBot(channel);
    (channel as unknown as { botUsername: string }).botUsername = 'qwen_bot';

    const directCommand = channel.buildTestEnvelope(
      {
        from: { id: 1, first_name: 'User' },
        chat: { id: 2, type: 'group' },
      },
      '/cancel',
      [{ type: 'bot_command', offset: 0, length: 7 }],
    );
    const addressedCommand = channel.buildTestEnvelope(
      {
        from: { id: 1, first_name: 'User' },
        chat: { id: 2, type: 'group' },
      },
      '/cancel@qwen_bot',
      [{ type: 'bot_command', offset: 0, length: 16 }],
    );
    const otherBotCommand = channel.buildTestEnvelope(
      {
        from: { id: 1, first_name: 'User' },
        chat: { id: 2, type: 'group' },
      },
      '/cancel@other_bot',
      [{ type: 'bot_command', offset: 0, length: 17 }],
    );

    expect(directCommand.isMentioned).toBe(false);
    expect(addressedCommand.isMentioned).toBe(true);
    expect(otherBotCommand.isMentioned).toBe(false);
  });

  it('preserves Telegram forum topic ids in envelopes', () => {
    const channel = createChannel();

    const topicMessage = channel.buildTestEnvelope(
      {
        from: { id: 1, first_name: 'User' },
        chat: { id: 2, type: 'supergroup' },
        message_thread_id: 42,
      },
      'topic message',
    );

    expect(topicMessage.threadId).toBe('42');
  });

  it('preserves group and supergroup display names in envelopes', () => {
    const channel = createChannel();

    const groupMessage = channel.buildTestEnvelope(
      {
        from: { id: 1, first_name: 'User' },
        chat: { id: 2, type: 'group', title: 'Project Group' },
      },
      'group message',
    );
    const supergroupMessage = channel.buildTestEnvelope(
      {
        from: { id: 1, first_name: 'User' },
        chat: { id: 3, type: 'supergroup', title: 'Project Supergroup' },
      },
      'supergroup message',
    );
    const privateMessage = channel.buildTestEnvelope(
      {
        from: { id: 1, first_name: 'User' },
        chat: { id: 1, type: 'private', title: 'Ignored Title' },
      },
      'direct message',
    );

    expect(groupMessage.chatName).toBe('Project Group');
    expect(supergroupMessage.chatName).toBe('Project Supergroup');
    expect(privateMessage.chatName).toBeUndefined();
  });

  it('sends proactive messages back to the Telegram forum topic', async () => {
    const channel = createChannel();
    const bot = installFakeBot(channel);

    await channel.pushTestProactive(
      { chatId: '2', threadId: '42' },
      'topic response',
    );

    expect(bot.api.sendMessage).toHaveBeenCalledWith('2', expect.any(String), {
      parse_mode: 'HTML',
      message_thread_id: 42,
    });
  });

  it('does not let bare bot commands pass mention-gated groups', async () => {
    const router = { getSession: vi.fn().mockReturnValue(undefined) };
    const channel = createChannel(
      {
        groupPolicy: 'open',
        groups: { '*': { requireMention: true } },
      },
      router,
    );
    const bot = installFakeBot(channel);
    (channel as unknown as { botUsername: string }).botUsername = 'qwen_bot';
    const groupMessage = {
      from: { id: 1, first_name: 'User' },
      chat: { id: 2, type: 'group' },
    };

    await channel.handleInbound(
      channel.buildTestEnvelope(groupMessage, '/cancel', [
        { type: 'bot_command', offset: 0, length: 7 },
      ]),
    );

    expect(router.getSession).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();

    await channel.handleInbound(
      channel.buildTestEnvelope(groupMessage, '/cancel@qwen_bot', [
        { type: 'bot_command', offset: 0, length: 16 },
      ]),
    );

    expect(router.getSession).toHaveBeenCalledWith(
      'telegram',
      '1',
      '2',
      undefined,
    );
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '2',
      'No request is currently running.',
      { parse_mode: 'HTML' },
    );
  });
});
