import { EventEmitter } from 'node:events';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLEAR_CANCEL_TIMEOUT_MS,
  type ChannelAgentBridge,
  type Envelope,
} from '@qwen-code/channel-base';
import { DingtalkChannel } from './DingtalkAdapter.js';

// The adapter's main test file replaces ChannelBase with a stub, so the
// /clear eviction and session-died races can only be witnessed here, against
// the REAL ChannelBase machinery.

const dingtalkSdkMock = vi.hoisted(() => ({
  instances: [] as unknown[],
}));

vi.mock('dingtalk-stream-sdk-nodejs', () => ({
  DWClient: class {
    debug = true;
    connected = true;
    registered = true;
    config = { autoReconnect: true };
    socket = new (class {
      readyState = 1;
      ping = vi.fn();
      private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

      on(event: string, listener: (...args: unknown[]) => void): void {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
      }

      off(event: string, listener: (...args: unknown[]) => void): void {
        this.listeners.get(event)?.delete(listener);
      }

      emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) {
          listener(...args);
        }
      }
    })();
    callback?: (msg: DWClientDownStream) => void;
    callbacks = new Map<string, (msg: DWClientDownStream) => void>();
    disconnect = vi.fn();
    getConfig = vi.fn(() => ({ access_token: 'token' }));
    registerCallbackListener = vi.fn(
      (topic: string, callback: (msg: DWClientDownStream) => void) => {
        this.callbacks.set(topic, callback);
        if (topic === 'robot') this.callback = callback;
      },
    );
    send = vi.fn();
    connect = vi.fn(() => Promise.resolve());

    onSystem = vi.fn();
    onEvent = vi.fn();
    onCallback = vi.fn();
    onDownStream = vi.fn();

    constructor(readonly options: Record<string, unknown>) {
      dingtalkSdkMock.instances.push(this);
    }
  },
  TOPIC_ROBOT: 'robot',
  TOPIC_CARD: 'card',
  EventAck: { SUCCESS: 'success' },
}));

function createBridge(promptImpl: (sessionId: string) => Promise<string>) {
  const emitter = new EventEmitter();
  const bridge = Object.assign(emitter, {
    newSession: vi.fn().mockReturnValue('session-1'),
    loadSession: vi.fn(),
    prompt: vi.fn().mockImplementation(promptImpl),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    discardSession: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    start: vi.fn(),
    isConnected: true,
    availableCommands: [],
    setBridge: vi.fn(),
    respondToPermission: vi.fn().mockResolvedValue(true),
    registerChannelLoopToolHandler: vi.fn(),
  });
  return bridge as unknown as ChannelAgentBridge & {
    prompt: ReturnType<typeof vi.fn>;
  };
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    channelName: 'test-dingtalk',
    senderId: 'user1',
    senderName: 'User 1',
    chatId: 'cid123',
    text: 'hello',
    isGroup: false,
    isMentioned: false,
    isReplyToBot: false,
    ...overrides,
  };
}

function createChannel(bridge: ChannelAgentBridge): DingtalkChannel {
  return new DingtalkChannel(
    'test-dingtalk',
    {
      type: 'dingtalk',
      token: 'tok',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: '/tmp',
      groupPolicy: 'disabled',
      dmPolicy: 'open',
      groups: {},
      outputMode: 'process_and_result',
      blockStreaming: 'on',
      blockStreamingChunk: { minChars: 5, maxChars: 10 },
      blockStreamingCoalesce: { idleMs: 60_000 },
    } as never,
    bridge,
  );
}

function seedWebhook(channel: DingtalkChannel, chatId: string): void {
  (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
    chatId,
    'https://oapi.dingtalk.com/robot/send?access_token=token',
  );
}

const MARKER_TEXT = 'aaaa\n\n[FILE: /workspace/secret.txt] more more';

describe('DingtalkChannel output under eviction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('/clear on a wedged turn does not leak unfinished output', async () => {
    const bridge = createBridge((sessionId) => {
      (bridge as unknown as EventEmitter).emit(
        'textChunk',
        sessionId,
        MARKER_TEXT,
      );
      return new Promise<string>(() => {});
    });
    const channel = createChannel(bridge);
    seedWebhook(channel, 'cid123');

    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      return Promise.resolve(new Response('{}'));
    });

    void channel.handleInbound(envelope({ messageId: 'm1' }));
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledOnce());
    expect(bodies).toEqual([]);

    vi.useFakeTimers();
    const clearPromise = channel.handleInbound(
      envelope({ messageId: 'm2', text: '/clear' }),
    );
    await vi.advanceTimersByTimeAsync(CLEAR_CANCEL_TIMEOUT_MS);
    vi.useRealTimers();
    await clearPromise;

    const all = bodies.join('\n');
    expect(all).toContain('Session cleared');
    expect(all).not.toContain('secret');
    expect(all).not.toContain('[FILE:');
    expect(
      (channel as unknown as { blockFileProjectors: Map<string, unknown> })
        .blockFileProjectors.size,
    ).toBe(0);
  });

  it('does not leak unfinished output when the session dies', async () => {
    const bridge = createBridge((sessionId) => {
      (bridge as unknown as EventEmitter).emit(
        'textChunk',
        sessionId,
        MARKER_TEXT,
      );
      return new Promise<string>(() => {});
    });
    const channel = createChannel(bridge);
    seedWebhook(channel, 'cid123');

    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      return Promise.resolve(new Response('{}'));
    });

    void channel.handleInbound(envelope({ messageId: 'm1' }));
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledOnce());
    expect(bodies).toEqual([]);

    channel.onSessionDied('session-1');

    const all = bodies.join('\n');
    expect(all).not.toContain('secret');
    expect(all).not.toContain('[FILE:');
    expect(
      (channel as unknown as { blockFileProjectors: Map<string, unknown> })
        .blockFileProjectors.size,
    ).toBe(0);
  });
});
