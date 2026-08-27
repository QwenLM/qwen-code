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

// maxChars=10 splits this into 'aaaa\n', '[FILE:', '/workspace',
// '/secret.tx', 't] more'. Hanging the SECOND send leaves the opener
// projected into the turn's projector (reserved line held) with the path
// bytes still queued — exactly the blocks that race the settle.
const MARKER_TEXT = 'aaaa\n\n[FILE: /workspace/secret.txt] more more';

describe('DingtalkChannel block projection under eviction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('/clear on a wedged turn drops the late blocks instead of leaking the marker tail', async () => {
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
    let fetchCalls = 0;
    const pendingFetch: Array<(response: Response) => void> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      fetchCalls += 1;
      // Hang exactly the opener block's send: it is projected (reserved line
      // held) before settle, while the path bytes wait behind it in the
      // serialized send chain.
      if (fetchCalls === 2) {
        return new Promise<Response>((resolve) => pendingFetch.push(resolve));
      }
      return Promise.resolve(new Response('{}'));
    });

    void channel.handleInbound(envelope({ messageId: 'm1' }));
    // Block 1 landed; the opener block's send hangs in fetch with the path
    // blocks queued behind it.
    await vi.waitFor(() => expect(bodies).toHaveLength(2));

    vi.useFakeTimers();
    const clearPromise = channel.handleInbound(
      envelope({ messageId: 'm2', text: '/clear' }),
    );
    // Drive the bounded wind-down wait to eviction: settle runs while the
    // path blocks are still queued in the turn's send chain.
    await vi.advanceTimersByTimeAsync(CLEAR_CANCEL_TIMEOUT_MS);
    for (const resolve of pendingFetch.splice(0)) {
      resolve(new Response('{}'));
    }
    vi.useRealTimers();
    await clearPromise;
    // Let the detached send chain drain its now-unblocked sends.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const all = bodies.join('\n');
    expect(all).toContain('File delivery unavailable');
    expect(all).not.toContain('secret');
    expect(all).not.toContain('[FILE:');
    expect(
      (channel as unknown as { blockFileProjectors: Map<string, unknown> })
        .blockFileProjectors.size,
    ).toBe(0);
  });

  it('drops the late blocks when the session dies mid-send', async () => {
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
    let fetchCalls = 0;
    const pendingFetch: Array<(response: Response) => void> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      fetchCalls += 1;
      if (fetchCalls === 2) {
        return new Promise<Response>((resolve) => pendingFetch.push(resolve));
      }
      return Promise.resolve(new Response('{}'));
    });

    void channel.handleInbound(envelope({ messageId: 'm1' }));
    await vi.waitFor(() => expect(bodies).toHaveLength(2));

    channel.onSessionDied('session-1');
    for (const resolve of pendingFetch.splice(0)) {
      resolve(new Response('{}'));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const all = bodies.join('\n');
    expect(all).toContain('File delivery unavailable');
    expect(all).not.toContain('secret');
    expect(all).not.toContain('[FILE:');
  });
});
