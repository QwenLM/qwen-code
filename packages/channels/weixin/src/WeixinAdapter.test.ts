import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  sendTyping: vi.fn(),
}));
const sendMocks = vi.hoisted(() => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./api.js', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
  return {
    ...actual,
    getConfig: apiMocks.getConfig,
    sendTyping: apiMocks.sendTyping,
  };
});

vi.mock('./send.js', async () => {
  const actual = await vi.importActual<typeof import('./send.js')>('./send.js');
  return {
    ...actual,
    sendText: sendMocks.sendText,
    sendImage: sendMocks.sendImage,
  };
});

import { TYPING_KEEPALIVE_MAX_MS, WeixinChannel } from './WeixinAdapter.js';
import { TypingStatus } from './types.js';
import type {
  ChannelAgentBridge,
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

  sendAttributed(chatId: string, text: string, sourceLabel: string) {
    return this.sendThreadMessage(chatId, undefined, text, sourceLabel);
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
    sendMocks.sendText.mockClear();
    sendMocks.sendImage.mockClear();
    vi.useFakeTimers();
  });

  it('applies attribution only after raw image-marker projection', async () => {
    const channel = createChannel();

    await channel.sendAttributed(
      'user-1',
      '`[IMAGE: example.png]` remains text',
      '[review_*]',
    );

    expect(sendMocks.sendImage).not.toHaveBeenCalled();
    expect(sendMocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user-1',
        text: '[review_*] [IMAGE: example.png] remains text',
      }),
    );
  });

  it('preserves underscores in attributed task names', async () => {
    const channel = createChannel();

    await channel.sendAttributed(
      'user-1',
      '**Here** is the result.',
      '[fix_bug_2]',
    );

    expect(sendMocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user-1',
        text: '[fix_bug_2] Here is the result.',
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('retries a failed initial typing request while the session is active', async () => {
    const channel = createChannel();
    const chatId = 'user-retry';
    const activeTypingSessions = (
      channel as unknown as {
        activeTypingSessions: Map<string, Map<string, number>>;
      }
    ).activeTypingSessions;

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
      expect(activeTypingSessions.get(chatId)?.has('session-2')).toBe(true);
    });

    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => {
      expect(apiMocks.sendTyping).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps typing until every session in the same chat terminates', () => {
    const channel = createChannel();
    const setTyping = vi.fn().mockResolvedValue(true);
    (channel as unknown as { setTyping: typeof setTyping }).setTyping =
      setTyping;
    const base = {
      channelName: 'weixin',
      chatId: 'shared-chat',
      messageId: 'message',
      identity: { id: 'channel:weixin', displayName: 'weixin' },
      memoryScope: { namespace: 'channel:weixin', mode: 'metadata-only' },
    } satisfies Omit<LifecycleBase, 'sessionId'>;

    channel.emitLifecycle({ ...base, sessionId: 'session-a', type: 'started' });
    channel.emitLifecycle({ ...base, sessionId: 'session-b', type: 'started' });
    channel.emitLifecycle({
      ...base,
      sessionId: 'session-a',
      type: 'completed',
    });

    expect(setTyping).toHaveBeenCalledTimes(1);
    expect(setTyping).toHaveBeenLastCalledWith('shared-chat', true);

    channel.emitLifecycle({
      ...base,
      sessionId: 'session-b',
      type: 'completed',
    });
    expect(setTyping).toHaveBeenCalledTimes(2);
    expect(setTyping).toHaveBeenLastCalledWith('shared-chat', false);
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
    const activeTypingSessions = (
      channel as unknown as {
        activeTypingSessions: Map<string, Map<string, number>>;
      }
    ).activeTypingSessions;

    channel.emitLifecycle({
      type: 'started',
      channelName: 'weixin',
      chatId: 'user-disconnect',
      sessionId: 'session-4',
      messageId: 'message-4',
      identity: { id: 'channel:weixin', displayName: 'weixin' },
      memoryScope: { namespace: 'channel:weixin', mode: 'metadata-only' },
    });
    expect(activeTypingSessions.has('user-disconnect')).toBe(true);

    channel.disconnect();

    expect(activeTypingSessions.has('user-disconnect')).toBe(false);
  });

  describe('typing keepalive', () => {
    const keepaliveEvent = (chatId: string, sessionId: string) =>
      ({
        channelName: 'weixin',
        chatId,
        sessionId,
        messageId: `message-${sessionId}`,
        identity: { id: 'channel:weixin', displayName: 'weixin' },
        memoryScope: { namespace: 'channel:weixin', mode: 'metadata-only' },
      }) satisfies LifecycleBase;

    function installSetTypingMock(
      channel: TestWeixinChannel,
      impl: ReturnType<typeof vi.fn>,
    ): void {
      (channel as unknown as { setTyping: typeof impl }).setTyping = impl;
    }

    it('refreshes TYPING while the turn is active and stops on the terminal event', async () => {
      const channel = createChannel();
      const setTyping = vi.fn().mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-keepalive', 'session-keepalive');

      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      expect(setTyping).toHaveBeenCalledTimes(1);
      expect(setTyping).toHaveBeenLastCalledWith('user-keepalive', true);

      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(8000);
      expect(setTyping).toHaveBeenCalledTimes(4);
      expect(setTyping).toHaveBeenLastCalledWith('user-keepalive', true);

      channel.emitLifecycle({ ...base, type: 'completed' });
      expect(setTyping).toHaveBeenCalledTimes(5);
      expect(setTyping).toHaveBeenLastCalledWith('user-keepalive', false);

      await vi.advanceTimersByTimeAsync(16000);
      expect(setTyping).toHaveBeenCalledTimes(5);
    });

    it('retries through keepalive when the initial TYPING fails', async () => {
      const channel = createChannel();
      const setTyping = vi.fn().mockResolvedValue(false);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-keepalive-fail', 'session-kf');

      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(20000);

      expect(setTyping).toHaveBeenCalledTimes(6);
      expect(setTyping).toHaveBeenLastCalledWith('user-keepalive-fail', true);
    });

    it('does not overlap keepalive requests for the same chat', async () => {
      const channel = createChannel();
      let resolveKeepalive!: (value: boolean) => void;
      const pendingKeepalive = new Promise<boolean>((resolve) => {
        resolveKeepalive = resolve;
      });
      const setTyping = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockReturnValue(pendingKeepalive);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-keepalive-overlap', 'session-ko');

      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      expect(setTyping).toHaveBeenCalledTimes(1);

      // First keepalive tick fires and stays in flight.
      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(2);

      // Further ticks skip while the previous keepalive is in flight.
      await vi.advanceTimersByTimeAsync(12000);
      expect(setTyping).toHaveBeenCalledTimes(2);

      resolveKeepalive(true);
      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(3);
    });

    it('clears the keepalive interval on disconnect', async () => {
      const channel = createChannel();
      const setTyping = vi.fn().mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-keepalive-disconnect', 'session-kd');

      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(2);

      channel.disconnect();

      await vi.advanceTimersByTimeAsync(16000);
      expect(setTyping).toHaveBeenCalledTimes(2);
    });

    it('does not arm the keepalive when the turn ends before TYPING confirms', async () => {
      const channel = createChannel();
      const start = deferredPromise<boolean>();
      const setTyping = vi
        .fn()
        .mockReturnValueOnce(start.promise)
        .mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-keepalive-late', 'session-kl');

      channel.emitLifecycle({ ...base, type: 'started' });
      channel.emitLifecycle({ ...base, type: 'completed' });
      start.resolve(true);
      await vi.advanceTimersByTimeAsync(0);

      // Initial TYPING, terminal CANCEL, and the late-start CANCEL guard.
      expect(setTyping).toHaveBeenCalledTimes(3);
      expect(setTyping).toHaveBeenLastCalledWith('user-keepalive-late', false);

      await vi.advanceTimersByTimeAsync(20000);
      expect(setTyping).toHaveBeenCalledTimes(3);
    });

    it('refreshes through the api path with the cached ticket and cancels on completion', async () => {
      const channel = createChannel();
      const chatId = 'user-keepalive-api';
      apiMocks.getConfig.mockResolvedValue({ typing_ticket: 'ticket-ka' });
      apiMocks.sendTyping.mockResolvedValue({});
      const base = keepaliveEvent(chatId, 'session-ka');

      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      expect(apiMocks.sendTyping).toHaveBeenCalledTimes(1);
      expect(apiMocks.sendTyping).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          ilink_user_id: chatId,
          typing_ticket: 'ticket-ka',
          status: TypingStatus.TYPING,
        }),
      );

      await vi.advanceTimersByTimeAsync(4000);
      expect(apiMocks.sendTyping).toHaveBeenCalledTimes(2);
      // The ticket is cached after the first lookup.
      expect(apiMocks.getConfig).toHaveBeenCalledTimes(1);

      channel.emitLifecycle({ ...base, type: 'completed' });
      await vi.advanceTimersByTimeAsync(0);
      expect(apiMocks.sendTyping).toHaveBeenCalledTimes(3);
      expect(apiMocks.sendTyping).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ status: TypingStatus.CANCEL }),
      );

      await vi.advanceTimersByTimeAsync(16000);
      expect(apiMocks.sendTyping).toHaveBeenCalledTimes(3);
    });

    it('re-arms the keepalive on a second turn of the same chat', async () => {
      const channel = createChannel();
      const setTyping = vi.fn().mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-rearm', 'session-rearm');

      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(4000);
      channel.emitLifecycle({ ...base, type: 'completed' });
      // Initial TYPING, one refresh, terminal CANCEL.
      expect(setTyping).toHaveBeenCalledTimes(3);

      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      expect(setTyping).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(5);
      expect(setTyping).toHaveBeenLastCalledWith('user-rearm', true);
    });

    it('keeps other chats refreshing when one chat terminates', async () => {
      const channel = createChannel();
      const setTyping = vi.fn().mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const baseA = keepaliveEvent('user-iso-a', 'session-iso-a');
      const baseB = keepaliveEvent('user-iso-b', 'session-iso-b');

      channel.emitLifecycle({ ...baseA, type: 'started' });
      channel.emitLifecycle({ ...baseB, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      expect(setTyping).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(4);

      channel.emitLifecycle({ ...baseA, type: 'completed' });
      expect(setTyping).toHaveBeenCalledTimes(5);
      expect(setTyping).toHaveBeenLastCalledWith('user-iso-a', false);

      await vi.advanceTimersByTimeAsync(8000);
      // Only chat B keeps refreshing.
      expect(setTyping).toHaveBeenCalledTimes(7);
      expect(setTyping).toHaveBeenLastCalledWith('user-iso-b', true);
    });

    it('keeps the keepalive armed when a refresh fails', async () => {
      const channel = createChannel();
      const setTyping = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-retry', 'session-retry');

      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      expect(setTyping).toHaveBeenCalledTimes(1);

      // The first refresh fails transiently; the next tick still retries.
      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(3);
      expect(setTyping).toHaveBeenLastCalledWith('user-retry', true);
    });

    it('stops refreshing a wedged turn after the backstop elapses', async () => {
      const channel = createChannel();
      const setTyping = vi.fn().mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const base = keepaliveEvent('user-wedged', 'session-wedged');

      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      expect(setTyping).toHaveBeenCalledTimes(1);

      // No terminal event ever arrives.
      await vi.advanceTimersByTimeAsync(TYPING_KEEPALIVE_MAX_MS + 4000);
      const callsAtBackstop = setTyping.mock.calls.length;
      expect(setTyping).toHaveBeenLastCalledWith('user-wedged', false);
      // The backstop firing is the only signal of a wedged turn, so it must
      // leave a log line tying the dropped indicator to the chat.
      expect(
        stderrSpy.mock.calls.some((args) =>
          String(args[0]).includes('Typing keepalive backstop'),
        ),
      ).toBe(true);
      stderrSpy.mockRestore();

      await vi.advanceTimersByTimeAsync(20000);
      expect(setTyping).toHaveBeenCalledTimes(callsAtBackstop);
    });

    it('expires an old session without cancelling a newer session in the same chat', async () => {
      const channel = createChannel();
      const setTyping = vi.fn().mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const oldSession = keepaliveEvent('user-shared', 'session-old');
      const newSession = keepaliveEvent('user-shared', 'session-new');

      channel.emitLifecycle({ ...oldSession, type: 'started' });
      await vi.advanceTimersByTimeAsync(TYPING_KEEPALIVE_MAX_MS - 4000);
      channel.emitLifecycle({ ...newSession, type: 'started' });

      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenLastCalledWith('user-shared', true);

      const activeTypingSessions = (
        channel as unknown as {
          activeTypingSessions: Map<string, Map<string, number>>;
        }
      ).activeTypingSessions;
      expect(activeTypingSessions.get('user-shared')?.has('session-old')).toBe(
        false,
      );
      expect(activeTypingSessions.get('user-shared')?.has('session-new')).toBe(
        true,
      );

      channel.emitLifecycle({ ...newSession, type: 'completed' });
      expect(setTyping).toHaveBeenLastCalledWith('user-shared', false);
    });

    it('removes only the dead session from a shared chat', () => {
      const channel = createChannel();
      const setTyping = vi.fn().mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const sessionA = keepaliveEvent('user-session-died', 'session-a');
      const sessionB = keepaliveEvent('user-session-died', 'session-b');

      channel.emitLifecycle({ ...sessionA, type: 'started' });
      channel.emitLifecycle({ ...sessionB, type: 'started' });
      channel.onSessionDied('session-a');
      expect(setTyping).toHaveBeenCalledTimes(1);

      channel.onSessionDied('session-b');
      expect(setTyping).toHaveBeenCalledTimes(2);
      expect(setTyping).toHaveBeenLastCalledWith('user-session-died', false);
    });

    it('ignores a stale failed initial TYPING from a previous turn', async () => {
      const channel = createChannel();
      const stale = deferredPromise<boolean>();
      const setTyping = vi
        .fn()
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-stale', 'session-stale');

      channel.emitLifecycle({ ...base, type: 'started' });
      channel.emitLifecycle({
        ...base,
        type: 'cancelled',
        reason: 'cancel_command',
      });
      // Turn 2 starts before turn 1's stalled request settles.
      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      // Stalled initial, terminal CANCEL, turn-2 initial.
      expect(setTyping).toHaveBeenCalledTimes(3);

      // Turn 1's request finally fails — must not delete turn 2's state.
      stale.resolve(false);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(8000);
      // Turn-2 initial plus two keepalive refreshes.
      expect(setTyping).toHaveBeenCalledTimes(5);
      expect(setTyping).toHaveBeenLastCalledWith('user-stale', true);

      channel.emitLifecycle({ ...base, type: 'completed' });
      expect(setTyping).toHaveBeenLastCalledWith('user-stale', false);
    });

    it('does not cancel a live successor turn when a stale initial TYPING resolves late', async () => {
      const channel = createChannel();
      const stale = deferredPromise<boolean>();
      const setTyping = vi
        .fn()
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-late-success', 'session-ls');

      channel.emitLifecycle({ ...base, type: 'started' });
      channel.emitLifecycle({
        ...base,
        type: 'cancelled',
        reason: 'cancel_command',
      });
      // Turn 2 starts and confirms before turn 1's stalled request settles.
      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      // Stalled initial, terminal CANCEL, turn-2 initial.
      expect(setTyping).toHaveBeenCalledTimes(3);

      // Turn 1's request finally succeeds. The stale-success compensation
      // must stay idle-gated: a successor turn is live, so an unconditional
      // CANCEL here would blank turn 2's indicator mid-turn.
      stale.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(setTyping).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(8000);
      // Turn-2 initial plus two keepalive refreshes, no spurious CANCEL.
      expect(setTyping).toHaveBeenCalledTimes(5);
      expect(setTyping).toHaveBeenLastCalledWith('user-late-success', true);

      channel.emitLifecycle({ ...base, type: 'completed' });
      expect(setTyping).toHaveBeenLastCalledWith('user-late-success', false);
    });

    it('lets a successor turn refresh even if the previous refresh is still in flight', async () => {
      const channel = createChannel();
      const stalledRefresh = deferredPromise<boolean>();
      const setTyping = vi
        .fn()
        .mockResolvedValueOnce(true) // turn-1 initial
        .mockReturnValueOnce(stalledRefresh.promise) // turn-1 refresh stalls
        .mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-inflight-boundary', 'session-ifb');

      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      expect(setTyping).toHaveBeenCalledTimes(1);

      // The refresh fires and is still in flight when the turn ends.
      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(2);
      channel.emitLifecycle({ ...base, type: 'completed' });
      expect(setTyping).toHaveBeenCalledTimes(3);

      // The successor turn re-arms the keepalive.
      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(0);
      expect(setTyping).toHaveBeenCalledTimes(4);

      // The stalled turn-1 refresh must not suppress turn-2 refreshes via
      // the in-flight dedup flag.
      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(5);
      expect(setTyping).toHaveBeenLastCalledWith(
        'user-inflight-boundary',
        true,
      );

      stalledRefresh.resolve(true);
      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(6);
    });

    it('reclaims all keepalive state on disconnect so a reused adapter starts clean', async () => {
      const channel = createChannel();
      const setTyping = vi.fn().mockResolvedValue(true);
      installSetTypingMock(channel, setTyping);
      const base = keepaliveEvent('user-reclaim', 'session-reclaim');

      channel.emitLifecycle({ ...base, type: 'started' });
      // Run close to the backstop so any leaked armedAt entry goes stale.
      await vi.advanceTimersByTimeAsync(TYPING_KEEPALIVE_MAX_MS - 4000);
      const callsBeforeDisconnect = setTyping.mock.calls.length;
      expect(callsBeforeDisconnect).toBeGreaterThan(1);

      channel.disconnect();

      const priv = channel as unknown as {
        typingKeepaliveIntervals: Map<string, unknown>;
        typingKeepaliveInFlight: Set<string>;
        typingGenerations: Map<string, number>;
        activeTypingSessions: Map<string, Map<string, number>>;
      };
      expect(priv.typingKeepaliveIntervals.size).toBe(0);
      expect(priv.typingKeepaliveInFlight.size).toBe(0);
      expect(priv.typingGenerations.size).toBe(0);
      expect(priv.activeTypingSessions.size).toBe(0);

      // A fresh turn on the reused adapter must not be reaped early by
      // stale backstop state: it should refresh, not CANCEL.
      channel.emitLifecycle({ ...base, type: 'started' });
      await vi.advanceTimersByTimeAsync(4000);
      expect(setTyping).toHaveBeenCalledTimes(callsBeforeDisconnect + 2);
      expect(setTyping).toHaveBeenLastCalledWith('user-reclaim', true);
    });
  });
});
