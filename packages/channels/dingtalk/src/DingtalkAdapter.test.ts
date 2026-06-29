import { describe, expect, it, vi } from 'vitest';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';

const dingtalkSdkMock = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
  rawLog: vi.fn(),
}));

vi.mock('dingtalk-stream-sdk-nodejs', () => ({
  DWClient: class {
    debug = true;
    disconnect = vi.fn();
    getConfig = vi.fn(() => ({ access_token: 'token' }));
    registerCallbackListener = vi.fn();
    send = vi.fn();
    connect = vi.fn();

    onSystem = vi.fn();
    onEvent = vi.fn();
    onCallback = vi.fn();
    onDownStream = vi.fn((data: Buffer | string) => {
      dingtalkSdkMock.rawLog(data);
      const msg = JSON.parse(data.toString());
      if (msg.type === 'SYSTEM') this.onSystem(msg);
      if (msg.type === 'EVENT') this.onEvent(msg);
      if (msg.type === 'CALLBACK') this.onCallback(msg);
    });

    constructor() {
      dingtalkSdkMock.instances.push(this);
    }
  },
  TOPIC_ROBOT: 'robot',
  EventAck: { SUCCESS: 'success' },
}));

vi.mock('@qwen-code/channel-base', async () => {
  // Use the REAL sanitizeSenderName so the adapter's log-sanitization path is
  // exercised against the shared helper, not a stub that could mask drift. The
  // vitest config aliases @qwen-code/channel-base to its SOURCE, so this resolves
  // with no prior channel-base build (dist may be absent/stale package-locally).
  const real = await vi.importActual<typeof import('@qwen-code/channel-base')>(
    '@qwen-code/channel-base',
  );
  return {
    ChannelBase: class {
      protected config: Record<string, unknown>;
      protected name: string;
      handleInbound = vi.fn().mockResolvedValue(undefined);

      constructor(
        name: string,
        config: Record<string, unknown>,
        _bridge: unknown,
      ) {
        this.name = name;
        this.config = config;
      }
    },
    sanitizeLogText: real.sanitizeLogText,
    sanitizeSenderName: real.sanitizeSenderName,
  };
});

const { DingtalkChannel } = await import('./DingtalkAdapter.js');
type DingtalkChannelInstance = InstanceType<typeof DingtalkChannel>;

function createChannel(): DingtalkChannelInstance {
  return new DingtalkChannel(
    'test-dingtalk',
    {
      type: 'dingtalk',
      token: '',
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

function latestMockClient(): Record<string, unknown> {
  const client = dingtalkSdkMock.instances.at(-1);
  if (!client) throw new Error('No mock DingTalk client created');
  return client;
}

function getPromptHook(
  channel: DingtalkChannelInstance,
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

describe('DingtalkChannel.isUnroutableGroupMessage', () => {
  it('drops group messages with no conversationId', () => {
    expect(DingtalkChannel.isUnroutableGroupMessage(true, undefined)).toBe(
      true,
    );
    expect(DingtalkChannel.isUnroutableGroupMessage(true, '')).toBe(true);
  });

  it('keeps routable group messages and all DMs', () => {
    expect(DingtalkChannel.isUnroutableGroupMessage(true, 'cid123')).toBe(
      false,
    );
    expect(DingtalkChannel.isUnroutableGroupMessage(false, undefined)).toBe(
      false,
    );
  });
});

describe('DingtalkChannel unroutable-message logging', () => {
  it('neutralizes a newline-bearing senderNick before logging', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'm1',
        // conversationType '2' = group; no conversationId => unroutable.
        conversationType: '2',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Mallory\n[DingTalk:fake] forged log line',
      }),
      headers: { messageId: 'm1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain('sender=Mallory  DingTalk:fake  forged log line)');
    expect(logged).not.toContain('Mallory\n');
    expect(logged).not.toContain('[DingTalk:fake]');
  });
});

describe('DingtalkChannel parsed-message logging', () => {
  it('logs parsed routing and sender fields for routable group messages', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'm1',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        text: { content: '@qwen-code hello' },
      }),
      headers: { messageId: 'm1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      '[DingTalk:test-dingtalk] message msgId=m1 conversationId=cid123 isGroup=true isMentioned=true senderNick=Alice senderStaffId=staff-1 senderId=sender-1',
    );
  });
});

describe('DingtalkChannel downstream logging', () => {
  it('replaces raw SDK Buffer logging with a structured downstream summary', () => {
    const channel = createChannel();
    const client = latestMockClient() as {
      onDownStream(data: Buffer): void;
      onCallback: ReturnType<typeof vi.fn>;
    };
    const raw = Buffer.from(
      JSON.stringify({
        specVersion: '1.0',
        type: 'CALLBACK',
        headers: {
          messageId: 'message-1',
          topic: 'robot',
        },
        data: '{"msgId":"m1"}',
      }),
    );

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    dingtalkSdkMock.rawLog.mockClear();
    client.onDownStream(raw);
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(dingtalkSdkMock.rawLog).not.toHaveBeenCalled();
    expect(logged).toContain(
      `[DingTalk:test-dingtalk] downstream type=CALLBACK topic=robot messageId=message-1 bytes=${raw.length}`,
    );
    expect(client.onCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CALLBACK',
        headers: expect.objectContaining({
          messageId: 'message-1',
          topic: 'robot',
        }),
      }),
    );
    expect(channel).toBeInstanceOf(DingtalkChannel);
  });
});

describe('DingtalkChannel sender attribution', () => {
  it('falls back to senderStaffId when senderNick is absent', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'm1',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        text: { content: '@qwen-code hello' },
      }),
      headers: { messageId: 'm1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    writeSpy.mockRestore();

    const handleInbound = (
      channel as unknown as {
        handleInbound: ReturnType<typeof vi.fn>;
      }
    ).handleInbound;

    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: 'staff-1',
        senderName: 'staff-1',
      }),
    );
  });
});
