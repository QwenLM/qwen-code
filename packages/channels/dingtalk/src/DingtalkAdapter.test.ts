import { describe, expect, it, vi } from 'vitest';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';
import type { ChannelTaskLifecycleEvent } from '@qwen-code/channel-base';

const dingtalkSdkMock = vi.hoisted(() => ({
  instances: [] as unknown[],
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
  const client = dingtalkSdkMock.instances.at(-1) as
    | Record<string, unknown>
    | undefined;
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

function getLifecycleHook(
  channel: DingtalkChannelInstance,
): (event: ChannelTaskLifecycleEvent) => void {
  const fn = (channel as unknown as Record<string, unknown>)
    .onTaskLifecycle as (event: ChannelTaskLifecycleEvent) => void;
  return fn.bind(channel);
}

function deferredPromise<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

describe('DingtalkChannel prompt reactions', () => {
  it('maps lifecycle start and terminal events to the eye reaction', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    const recallReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as {
        attachReaction: typeof attachReaction;
        recallReaction: typeof recallReaction;
      }
    ).attachReaction = attachReaction;
    (
      channel as unknown as {
        attachReaction: typeof attachReaction;
        recallReaction: typeof recallReaction;
      }
    ).recallReaction = recallReaction;

    const event = {
      channelName: 'dingtalk',
      chatId: 'cid-123',
      sessionId: 'session-1',
      messageId: 'message-1',
      identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
      memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
    } satisfies Omit<ChannelTaskLifecycleEvent, 'type'>;

    const lifecycle = getLifecycleHook(channel);
    lifecycle({ ...event, type: 'started' });
    lifecycle({ ...event, type: 'started' });
    lifecycle({ ...event, type: 'failed', error: 'boom' });
    lifecycle({ ...event, type: 'completed' });

    expect(attachReaction).toHaveBeenCalledOnce();
    expect(attachReaction).toHaveBeenCalledWith('message-1', 'cid-123');
    expect(recallReaction).toHaveBeenCalledOnce();
    expect(recallReaction).toHaveBeenCalledWith('message-1', 'cid-123');
  });

  it('recalls again when a late lifecycle attach resolves after terminal cleanup', async () => {
    const channel = createChannel();
    const attach = deferredPromise<void>();
    const attachReaction = vi
      .fn()
      .mockReturnValueOnce(attach.promise)
      .mockResolvedValueOnce(undefined);
    const recallReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as {
        attachReaction: typeof attachReaction;
        recallReaction: typeof recallReaction;
      }
    ).attachReaction = attachReaction;
    (
      channel as unknown as {
        attachReaction: typeof attachReaction;
        recallReaction: typeof recallReaction;
      }
    ).recallReaction = recallReaction;

    const event = {
      channelName: 'dingtalk',
      chatId: 'cid-456',
      sessionId: 'session-2',
      messageId: 'message-2',
      identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
      memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
    } satisfies Omit<ChannelTaskLifecycleEvent, 'type'>;

    const lifecycle = getLifecycleHook(channel);
    lifecycle({ ...event, type: 'started' });
    lifecycle({ ...event, type: 'cancelled', reason: 'done' });

    expect(attachReaction).toHaveBeenNthCalledWith(1, 'message-2', 'cid-456');
    expect(recallReaction).toHaveBeenNthCalledWith(1, 'message-2', 'cid-456');

    attach.resolve();

    await vi.waitFor(() => {
      expect(recallReaction).toHaveBeenNthCalledWith(
        2,
        'message-2',
        'cid-456',
      );
      expect(recallReaction).toHaveBeenCalledTimes(2);
    });
  });

  it('does not attach lifecycle reactions without a conversation id', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    (channel as unknown as { attachReaction: typeof attachReaction })
      .attachReaction = attachReaction;

    getLifecycleHook(channel)({
      type: 'started',
      channelName: 'dingtalk',
      chatId: 'HTTPS://oapi.dingtalk.com/robot/send?access_token=token',
      sessionId: 'session-1',
      messageId: 'message-1',
      identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
      memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
    });

    expect(attachReaction).not.toHaveBeenCalled();
  });

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
    createChannel();
    const client = latestMockClient() as {
      debug: boolean;
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
    expect(client.debug).toBe(false);
    expect(client.onCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CALLBACK',
        headers: expect.objectContaining({
          messageId: 'message-1',
          topic: 'robot',
        }),
      }),
    );
  });

  it('sanitizes malformed downstream parse errors and skips dispatch', () => {
    createChannel();
    const client = latestMockClient() as {
      onDownStream(data: Buffer): void;
      onSystem: ReturnType<typeof vi.fn>;
      onEvent: ReturnType<typeof vi.fn>;
      onCallback: ReturnType<typeof vi.fn>;
    };
    const raw = Buffer.from('not json\n[DingTalk:fake]');

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    client.onDownStream(raw);
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      '[DingTalk:test-dingtalk] Failed to parse downstream:',
    );
    expect(logged).not.toContain('not json\n');
    expect(logged).not.toContain('\n[DingTalk:fake]');
    expect(logged).not.toContain('[DingTalk:fake]');
    expect(client.onSystem).not.toHaveBeenCalled();
    expect(client.onEvent).not.toHaveBeenCalled();
    expect(client.onCallback).not.toHaveBeenCalled();
  });

  it('ignores downstream JSON that is not an object', () => {
    createChannel();
    const client = latestMockClient() as {
      onDownStream(data: Buffer): void;
      onSystem: ReturnType<typeof vi.fn>;
      onEvent: ReturnType<typeof vi.fn>;
      onCallback: ReturnType<typeof vi.fn>;
    };

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    expect(() => client.onDownStream(Buffer.from('null'))).not.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      '[DingTalk:test-dingtalk] downstream parsed to non-object, ignoring.',
    );
    expect(client.onSystem).not.toHaveBeenCalled();
    expect(client.onEvent).not.toHaveBeenCalled();
    expect(client.onCallback).not.toHaveBeenCalled();
  });

  it('logs SDK dispatch failures without propagating them', () => {
    createChannel();
    const client = latestMockClient() as {
      onDownStream(data: Buffer): void;
      onCallback: ReturnType<typeof vi.fn>;
    };
    client.onCallback.mockImplementationOnce(() => {
      throw new Error('callback failed\n[DingTalk:fake]');
    });
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
    expect(() => client.onDownStream(raw)).not.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain('[DingTalk:test-dingtalk] onCallback failed:');
    expect(logged).not.toContain('callback failed\n');
    expect(logged).not.toContain('\n[DingTalk:fake]');
  });

  it('ignores downstream frames with non-string routing fields', () => {
    createChannel();
    const client = latestMockClient() as {
      onDownStream(data: Buffer): void;
      onSystem: ReturnType<typeof vi.fn>;
      onEvent: ReturnType<typeof vi.fn>;
      onCallback: ReturnType<typeof vi.fn>;
    };
    const raw = Buffer.from(
      JSON.stringify({
        specVersion: '1.0',
        type: { forged: 'CALLBACK' },
        headers: {
          messageId: { value: 'message-1' },
          topic: ['robot'],
        },
        data: '{"msgId":"m1"}',
      }),
    );

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    expect(() => client.onDownStream(raw)).not.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      `[DingTalk:test-dingtalk] downstream type= topic= messageId= bytes=${raw.length}`,
    );
    expect(logged).toContain(
      '[DingTalk:test-dingtalk] Ignoring downstream type unknown.',
    );
    expect(client.onSystem).not.toHaveBeenCalled();
    expect(client.onEvent).not.toHaveBeenCalled();
    expect(client.onCallback).not.toHaveBeenCalled();
  });

  it('rejects callback frames with invalid routing headers before dispatch', () => {
    createChannel();
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
          topic: ['robot'],
        },
        data: '{"msgId":"m1"}',
      }),
    );

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    expect(() => client.onDownStream(raw)).not.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      '[DingTalk:test-dingtalk] Ignoring downstream with invalid routing headers.',
    );
    expect(client.onCallback).not.toHaveBeenCalled();
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

  it('ignores non-string message metadata when logging parsed JSON', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: { value: 'm1' },
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: { value: 'Alice' },
        senderStaffId: ['staff-1'],
        senderId: 123,
        isInAtList: true,
        text: { content: '@qwen-code hello' },
      }),
      headers: { messageId: 'header-m1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    expect(() =>
      (
        channel as unknown as { onMessage(d: DWClientDownStream): void }
      ).onMessage(downstream),
    ).not.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      '[DingTalk:test-dingtalk] message msgId=header-m1 conversationId=cid123 isGroup=true isMentioned=true senderNick= senderStaffId= senderId=',
    );
  });

  it('falls back to downstream header messageId when body msgId is empty', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: '',
        conversationType: '1',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        isInAtList: false,
        text: { content: 'hello' },
      }),
      headers: { messageId: 'header-m1' },
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
        messageId: 'header-m1',
      }),
    );
  });
});
