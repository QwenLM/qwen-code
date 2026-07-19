import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  sendTyping: vi.fn(),
}));
const accountMocks = vi.hoisted(() => ({
  resolveStateDir: vi.fn(() => '/legacy/weixin'),
  loadAccount: vi.fn(),
}));
const monitorMocks = vi.hoisted(() => ({ startPollLoop: vi.fn() }));

vi.mock('./api.js', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
  return {
    ...actual,
    getConfig: apiMocks.getConfig,
    sendTyping: apiMocks.sendTyping,
  };
});

vi.mock('./accounts.js', () => ({
  DEFAULT_BASE_URL: 'https://ilinkai.weixin.qq.com',
  resolveStateDir: accountMocks.resolveStateDir,
  loadAccount: accountMocks.loadAccount,
}));

vi.mock('./monitor.js', async () => {
  const actual =
    await vi.importActual<typeof import('./monitor.js')>('./monitor.js');
  return { ...actual, startPollLoop: monitorMocks.startPollLoop };
});

import { WeixinChannel } from './WeixinAdapter.js';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  ChannelTaskLifecycleEvent,
} from '@qwen-code/channel-base';

type LifecycleBase = Omit<
  Extract<ChannelTaskLifecycleEvent, { type: 'started' }>,
  'type'
>;

class TestWeixinChannel extends WeixinChannel {
  emitLifecycle(event: ChannelTaskLifecycleEvent): void {
    this.onTaskLifecycle(event);
  }
}

const config: ChannelConfig = {
  type: 'weixin',
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
  options?: ChannelBaseOptions,
): TestWeixinChannel {
  const bridge = Object.assign(new EventEmitter(), {
    newSession: vi.fn(),
    loadSession: vi.fn(),
    prompt: vi.fn(),
    cancelSession: vi.fn(),
    availableCommands: [],
  });

  return new TestWeixinChannel(
    'weixin',
    { ...config, ...configOverrides },
    bridge as unknown as ChannelAgentBridge,
    options,
  );
}

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('WeixinChannel', () => {
  beforeEach(() => {
    apiMocks.getConfig.mockReset();
    apiMocks.sendTyping.mockReset();
    accountMocks.loadAccount.mockReset();
    monitorMocks.startPollLoop.mockReset();
    monitorMocks.startPollLoop.mockResolvedValue(undefined);
  });

  it('loads credentials only from the daemon scoped state directory', async () => {
    accountMocks.loadAccount.mockReturnValue({
      token: 'scoped-token',
      baseUrl: 'https://bot.example',
      savedAt: '2026-07-19T00:00:00.000Z',
    });
    const channel = createChannel({}, { stateDir: '/scoped/weixin' });

    await channel.connect();

    expect(accountMocks.loadAccount).toHaveBeenCalledWith('/scoped/weixin');
  });

  it('uses the singleton legacy state only when the daemon supplies proof', async () => {
    accountMocks.loadAccount.mockReturnValue({
      token: 'legacy-token',
      baseUrl: 'https://bot.example',
      savedAt: '2026-07-19T00:00:00.000Z',
    });
    const channel = createChannel(
      {},
      {
        stateDir: '/scoped/weixin',
        allowLegacyCredentialFallback: true,
      },
    );

    await channel.connect();

    expect(accountMocks.loadAccount).toHaveBeenCalledWith('/scoped/weixin', {
      allowLegacyFallback: true,
      legacyStateDir: '/legacy/weixin',
    });
  });

  it('preserves the standalone no-argument account lookup', async () => {
    accountMocks.loadAccount.mockReturnValue({
      token: 'legacy-token',
      baseUrl: 'https://bot.example',
      savedAt: '2026-07-19T00:00:00.000Z',
    });
    const channel = createChannel();

    await channel.connect();

    expect(accountMocks.loadAccount).toHaveBeenCalledWith();
  });

  it('maps lifecycle start and terminal events to typing state', () => {
    const channel = createChannel();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    (channel as unknown as { setTyping: typeof setTyping }).setTyping =
      setTyping;

    const baseEvent = {
      channelName: 'weixin',
      chatId: 'user-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      identity: { id: 'channel:weixin', displayName: 'weixin' },
      memoryScope: { namespace: 'channel:weixin', mode: 'metadata-only' },
    } satisfies LifecycleBase;

    channel.emitLifecycle({ ...baseEvent, type: 'started' });
    channel.emitLifecycle({ ...baseEvent, type: 'started' });
    channel.emitLifecycle({ ...baseEvent, type: 'cancelled', reason: 'clear' });
    channel.emitLifecycle({ ...baseEvent, type: 'completed' });

    expect(setTyping).toHaveBeenNthCalledWith(1, 'user-1', true);
    expect(setTyping).toHaveBeenNthCalledWith(2, 'user-1', false);
    expect(setTyping).toHaveBeenCalledTimes(2);
  });

  it('clears failed start typing state so a later started event can retry', async () => {
    const channel = createChannel();
    const chatId = 'user-retry';
    const activeTypingChats = (
      channel as unknown as { activeTypingChats: Set<string> }
    ).activeTypingChats;

    apiMocks.getConfig.mockResolvedValue({ typing_ticket: 'ticket-1' });
    apiMocks.sendTyping
      .mockRejectedValueOnce(new Error('send failed'))
      .mockResolvedValueOnce({});

    const baseEvent = {
      channelName: 'weixin',
      chatId,
      sessionId: 'session-2',
      messageId: 'message-2',
      identity: { id: 'channel:weixin', displayName: 'weixin' },
      memoryScope: { namespace: 'channel:weixin', mode: 'metadata-only' },
    } satisfies LifecycleBase;

    channel.emitLifecycle({ ...baseEvent, type: 'started' });

    await vi.waitFor(() => {
      expect(apiMocks.sendTyping).toHaveBeenCalledTimes(1);
      expect(activeTypingChats.has(chatId)).toBe(false);
    });

    channel.emitLifecycle({ ...baseEvent, type: 'started' });

    await vi.waitFor(() => {
      expect(apiMocks.sendTyping).toHaveBeenCalledTimes(2);
      expect(activeTypingChats.has(chatId)).toBe(true);
    });
  });

  it('stops typing again when a late lifecycle start resolves after terminal cleanup', async () => {
    const channel = createChannel();
    const start = deferredPromise<boolean>();
    const setTyping = vi
      .fn()
      .mockReturnValueOnce(start.promise)
      .mockResolvedValueOnce(true);
    (channel as unknown as { setTyping: typeof setTyping }).setTyping =
      setTyping;

    const baseEvent = {
      channelName: 'weixin',
      chatId: 'user-late-start',
      sessionId: 'session-3',
      messageId: 'message-3',
      identity: { id: 'channel:weixin', displayName: 'weixin' },
      memoryScope: { namespace: 'channel:weixin', mode: 'metadata-only' },
    } satisfies LifecycleBase;

    channel.emitLifecycle({ ...baseEvent, type: 'started' });
    channel.emitLifecycle({ ...baseEvent, type: 'completed' });

    expect(setTyping).toHaveBeenNthCalledWith(1, 'user-late-start', true);
    expect(setTyping).toHaveBeenNthCalledWith(2, 'user-late-start', false);

    start.resolve(true);

    await vi.waitFor(() => {
      expect(setTyping).toHaveBeenNthCalledWith(3, 'user-late-start', false);
      expect(setTyping).toHaveBeenCalledTimes(3);
    });
  });

  it('clears active typing state on disconnect', () => {
    const channel = createChannel();
    const setTyping = vi.fn().mockResolvedValue(true);
    (channel as unknown as { setTyping: typeof setTyping }).setTyping =
      setTyping;
    const activeTypingChats = (
      channel as unknown as { activeTypingChats: Set<string> }
    ).activeTypingChats;

    channel.emitLifecycle({
      type: 'started',
      channelName: 'weixin',
      chatId: 'user-disconnect',
      sessionId: 'session-4',
      messageId: 'message-4',
      identity: { id: 'channel:weixin', displayName: 'weixin' },
      memoryScope: { namespace: 'channel:weixin', mode: 'metadata-only' },
    });
    expect(activeTypingChats.has('user-disconnect')).toBe(true);

    channel.disconnect();

    expect(activeTypingChats.has('user-disconnect')).toBe(false);
  });
});
