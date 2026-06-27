import { describe, expect, it, vi } from 'vitest';

vi.mock('dingtalk-stream-sdk-nodejs', () => ({
  DWClient: class {
    disconnect = vi.fn();
    getConfig = vi.fn(() => ({ access_token: 'token' }));
    registerCallbackListener = vi.fn();
    send = vi.fn();
    connect = vi.fn();
  },
  TOPIC_ROBOT: 'robot',
  EventAck: { SUCCESS: 'success' },
}));

vi.mock('@qwen-code/channel-base', () => ({
  ChannelBase: class {
    protected config: Record<string, unknown>;
    protected name: string;

    constructor(
      name: string,
      config: Record<string, unknown>,
      _bridge: unknown,
    ) {
      this.name = name;
      this.config = config;
    }
  },
}));

const { DingtalkChannel } = await import('./DingtalkAdapter.js');

function createChannel(): DingtalkChannel {
  return new DingtalkChannel(
    'test-dingtalk',
    {
      type: 'dingtalk',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: '/tmp',
      groupPolicy: 'open',
      groups: {},
    },
    {} as never,
  );
}

function getPromptHook(
  channel: DingtalkChannel,
  hook: 'onPromptStart' | 'onPromptEnd',
): (chatId: string, sessionId: string, messageId?: string) => void {
  const fn = (channel as unknown as Record<string, unknown>)[hook] as (
    chatId: string,
    sessionId: string,
    messageId?: string,
  ) => void;
  return fn.bind(channel);
}

describe('DingtalkChannel prompt reactions', () => {
  it('skips uppercase webhook URLs when starting a prompt', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as { attachReaction: typeof attachReaction }
    ).attachReaction = attachReaction;

    getPromptHook(channel, 'onPromptStart')(
      'HTTPS://oapi.dingtalk.com/robot/send?access_token=token',
      'session-1',
      'message-1',
    );

    expect(attachReaction).not.toHaveBeenCalled();
  });

  it('still attaches reactions for conversation IDs', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as { attachReaction: typeof attachReaction }
    ).attachReaction = attachReaction;

    getPromptHook(channel, 'onPromptStart')(
      'cid-123',
      'session-1',
      'message-1',
    );

    expect(attachReaction).toHaveBeenCalledWith('message-1', 'cid-123');
  });

  it('skips uppercase webhook URLs when ending a prompt', () => {
    const channel = createChannel();
    const recallReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as { recallReaction: typeof recallReaction }
    ).recallReaction = recallReaction;

    getPromptHook(channel, 'onPromptEnd')(
      'HTTPS://oapi.dingtalk.com/robot/send?access_token=token',
      'session-1',
      'message-1',
    );

    expect(recallReaction).not.toHaveBeenCalled();
  });
});
