/**
 * R15-1: the boundary close only ever reaches `closeSegmentWithFiles` through
 * `ChannelBase.notifyOutputSegmentEnd`, which catches every hook error and
 * logs it — the R10-1 rethrow never fails the turn in production.
 * DingtalkAdapter.test.ts mocks `@qwen-code/channel-base` (no wrapper), so
 * this file drives a full turn through the REAL ChannelBase instead: a
 * `response_boundary` whose file delivery and corrective notice both cannot
 * land must book the turn failed, not completed.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChannelAgentBridge,
  ChannelOutputSegmentContext,
  Envelope,
} from '@qwen-code/channel-base';

vi.mock('dingtalk-stream-sdk-nodejs', () => ({
  DWClient: class {
    debug = true;
    connected = true;
    registered = true;
    config = { autoReconnect: true };
    socket = { readyState: 1, ping: vi.fn() };
    callbacks = new Map<string, unknown>();
    disconnect = vi.fn();
    registerCallbackListener = vi.fn();
    send = vi.fn();
    connect = vi.fn(() => Promise.resolve());
  },
  TOPIC_ROBOT: 'robot',
  TOPIC_CARD: 'card',
  EventAck: { SUCCESS: 'success' },
}));

const { DingtalkChannel } = await import('./DingtalkAdapter.js');
type DingtalkChannelInstance = InstanceType<typeof DingtalkChannel>;

function createTempFile(
  fileName = 'report.txt',
  contents = 'report',
): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dingtalk-boundary-turn-'));
  const path = join(dir, fileName);
  writeFileSync(path, contents);
  return { dir, path };
}

function createChannel(
  bridge: ChannelAgentBridge,
  overrides: Record<string, unknown> = {},
): DingtalkChannelInstance {
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
      dmPolicy: 'open',
      groups: {},
      interactiveCards: {},
      useConnectionManager: false,
      ...overrides,
    } as never,
    bridge,
  );
}

function createBridge(): ChannelAgentBridge {
  const emitter = new EventEmitter();
  let sessionCounter = 0;
  return Object.assign(emitter, {
    newSession: () => `s-${++sessionCounter}`,
    loadSession: () => {},
    prompt: async () => 'agent response',
    cancelSession: async () => {},
    discardSession: async () => {},
    stop: () => {},
    start: () => {},
    isConnected: true,
    availableCommands: [],
    setBridge: () => {},
    respondToPermission: async () => true,
    registerChannelLoopToolHandler: () => {},
    getChannelLoopToolHandler: () => undefined,
  }) as unknown as ChannelAgentBridge;
}

/** The DM-without-conversationId shape: chatId is the sessionWebhook URL and
 * the webhook map (keyed on conversationId) has no entry for it. */
const SESSION_WEBHOOK_CHAT_ID =
  'https://oapi.dingtalk.com/robot/send?access_token=token';

function stubOutboundFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              errcode: 0,
              access_token: 'upload-token',
              expires_in: 7200,
            }),
            { status: 200 },
          ),
        );
      }
      if (url.startsWith('https://oapi.dingtalk.com/media/upload')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ errcode: 0, media_id: '@lAL-file-media-1' }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ errcode: 0 }), { status: 200 }),
      );
    },
  );
}

interface PresenterStub {
  appendOutput: (segment: ChannelOutputSegmentContext, chunk: string) => void;
  segmentContent: (segmentId: string) => string;
  closeOutput: ReturnType<typeof vi.fn>;
  acceptsLateDelivery: (runId: string) => boolean;
  terminalSettled: (runId: string) => Promise<void>;
  terminalCardRetained: (runId: string, segmentId: string) => boolean;
  registerRun: (...args: unknown[]) => void;
  startStatusCard: (runId: string) => void;
  terminalizeRun: (...args: unknown[]) => void;
}

function installPresenter(
  channel: DingtalkChannelInstance,
  segmentText: string,
): { presenter: PresenterStub; boundaryClosed: Promise<void> } {
  let resolveBoundaryClosed: () => void = () => {};
  const boundaryClosed = new Promise<void>((resolve) => {
    resolveBoundaryClosed = resolve;
  });
  const presenter: PresenterStub = {
    appendOutput: () => {},
    segmentContent: () => segmentText,
    closeOutput: vi.fn(
      (_segmentId: string, _text: string, reason: string): Promise<boolean> => {
        if (reason === 'response_boundary') resolveBoundaryClosed();
        return Promise.resolve(true);
      },
    ),
    acceptsLateDelivery: () => true,
    terminalSettled: () => Promise.resolve(),
    terminalCardRetained: () => false,
    registerRun: () => {},
    startStatusCard: () => {},
    terminalizeRun: () => {},
  };
  (
    channel as unknown as { interactionPresenter: PresenterStub }
  ).interactionPresenter = presenter;
  return { presenter, boundaryClosed };
}

function inboundEnvelope(): Envelope {
  return {
    channelName: 'test-dingtalk',
    senderId: 'owner-1',
    senderName: 'Owner One',
    chatId: SESSION_WEBHOOK_CHAT_ID,
    text: 'send me the report',
    isGroup: false,
    isMentioned: false,
    isReplyToBot: false,
    messageId: 'msg-1',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('boundary segment failure through the real ChannelBase wrapper', () => {
  it('fails the turn when the boundary file and its notice both cannot land', async () => {
    const file = createTempFile();
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file.dir });
      stubOutboundFetch();
      const { presenter, boundaryClosed } = installPresenter(
        channel,
        `[FILE: ${file.path}]`,
      );

      // Deliver one chunk so the turn has a segment, close it at the
      // boundary, and only then hand back the final response — the boundary
      // close must have settled before `onResponseComplete` runs.
      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, 'segment body');
        bridge.emit('responseBoundary', sessionId);
        await boundaryClosed;
        return 'final answer';
      };

      // The webhook map has no entry for this chat (the R5-1 shape), so the
      // file delivery and its corrective notice both have no endpoint. The
      // wrapper swallows the boundary hook's error; the turn must still fail
      // instead of booking a completed turn with a receipt for a file that
      // never arrived.
      await expect(channel.handleInbound(inboundEnvelope())).rejects.toThrow(
        /no delivered notice: report\.txt/,
      );

      // The boundary closed display-sanitized (R10-1 preserved)…
      expect(presenter.closeOutput).toHaveBeenCalledWith(
        expect.any(String),
        '',
        'response_boundary',
        expect.anything(),
      );
      // …and the final segment closed FAILED, never as a completed answer.
      expect(presenter.closeOutput).toHaveBeenCalledWith(
        expect.any(String),
        '',
        'failed',
        expect.anything(),
      );
      const completedCloses = presenter.closeOutput.mock.calls.filter(
        (call) => call[2] === 'completed',
      );
      expect(completedCloses).toHaveLength(0);
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });

  it('still completes a turn whose boundary close delivered cleanly', async () => {
    const file = createTempFile();
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file.dir });
      stubOutboundFetch();
      const { presenter, boundaryClosed } = installPresenter(channel, 'plain');

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, 'segment body');
        bridge.emit('responseBoundary', sessionId);
        await boundaryClosed;
        return 'final answer';
      };

      await expect(channel.handleInbound(inboundEnvelope())).resolves.toBe(
        undefined,
      );

      // No failure recorded: the final segment completed normally.
      expect(presenter.closeOutput).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'completed',
        expect.anything(),
      );
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });
});
