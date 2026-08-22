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
  closeOutput?: (
    segmentId: string,
    text: string,
    reason: string,
  ) => Promise<boolean>,
): { presenter: PresenterStub; boundaryClosed: Promise<void> } {
  let resolveBoundaryClosed: () => void = () => {};
  const boundaryClosed = new Promise<void>((resolve) => {
    resolveBoundaryClosed = resolve;
  });
  const presenter: PresenterStub = {
    appendOutput: () => {},
    segmentContent: () => segmentText,
    closeOutput:
      closeOutput !== undefined
        ? vi.fn(closeOutput)
        : vi.fn(
            (
              _segmentId: string,
              _text: string,
              reason: string,
            ): Promise<boolean> => {
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
        bridge.emit('textChunk', sessionId, `[FILE: ${file.path}]`);
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

  it('keeps the recorded failure when the boundary display close rejects (R16-1)', async () => {
    // R16-1: both record sites ran AFTER awaits that can themselves reject —
    // a webhook present but rejecting every POST makes the catch arm's
    // display close throw (its fallback rides the same dead webhook), and
    // the rejection escaped unrecorded through ChannelBase's catch-and-log:
    // the turn booked completed with the file and the notice both lost.
    const file = createTempFile();
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file.dir });
      stubOutboundFetch();
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      // No card is live, so the response_boundary close falls back to the
      // webhook — which rejects, exactly like the delivery that failed.
      installPresenter(channel, `[FILE: ${file.path}]`, (_s, _t, reason) =>
        reason === 'response_boundary'
          ? Promise.reject(new Error('fallback webhook rejected'))
          : Promise.resolve(true),
      );

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, `[FILE: ${file.path}]`);
        bridge.emit('responseBoundary', sessionId);
        return 'final answer';
      };

      // The delivery failure stays the turn's verdict even though the
      // display close rejects on top of it.
      await expect(channel.handleInbound(inboundEnvelope())).rejects.toThrow(
        /no delivered notice: report\.txt/,
      );
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });

  it('keeps the deliveryError verdict when the display close rejects (R16-1)', async () => {
    // R16-1 success arm: the file post is rejected and its corrective
    // notice dies on the same webhook — `sendReplyFiles` returns a
    // `deliveryError` — and the display close THEN rejects too (no live
    // card, fallback rides the dead webhook). The recorded deliveryError
    // must stay the turn's verdict; pre-fix the record ran after awaits
    // whose rejection could displace it.
    const file = createTempFile();
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file.dir });
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      // A webhook that rejects every POST: the file, the notice, and the
      // boundary fallback alike (quota exhaustion — the R2-9 cause).
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
            new Response(JSON.stringify({ errcode: 310000 }), {
              status: 200,
            }),
          );
        },
      );
      (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
        SESSION_WEBHOOK_CHAT_ID,
        'https://oapi.dingtalk.com/robot/send?access_token=token',
      );
      installPresenter(channel, `[FILE: ${file.path}]`, (_s, _t, reason) =>
        reason === 'response_boundary'
          ? Promise.reject(new Error('fallback webhook rejected'))
          : Promise.resolve(true),
      );

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, `[FILE: ${file.path}]`);
        bridge.emit('responseBoundary', sessionId);
        return 'final answer';
      };

      await expect(channel.handleInbound(inboundEnvelope())).rejects.toThrow(
        /no delivered notice: report\.txt/,
      );
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });

  it('drains an in-flight boundary close before booking the turn (R15-1)', async () => {
    // R15-1: ChannelBase dispatches the boundary close fire-and-forget, so
    // it can still be uploading when the final response completes. The
    // record-then-rethrow consulted `pendingBoundaryFailures` without
    // waiting for that settlement: a failure recorded after the
    // consultation was swept by `onPromptEnd` and lost. The consultation
    // drains the session's in-flight close first.
    const file = createTempFile();
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file.dir });
      // Gate the upload-token fetch so the boundary close is provably in
      // flight when the turn completes.
      let releaseTokenFetch!: () => void;
      const tokenGate = new Promise<void>((resolve) => {
        releaseTokenFetch = resolve;
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
            return tokenGate.then(
              () =>
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
      installPresenter(channel, `[FILE: ${file.path}]`);

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, `[FILE: ${file.path}]`);
        bridge.emit('responseBoundary', sessionId);
        // The turn completes while the close is still waiting on its token;
        // the gate releases shortly after, on the close's own timeline.
        setTimeout(releaseTokenFetch, 10);
        return 'final answer';
      };

      await expect(channel.handleInbound(inboundEnvelope())).rejects.toThrow(
        /no delivered notice: report\.txt/,
      );
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });

  it('delivers a marker pushed out of the display-bounded content (R16-2)', async () => {
    // R16-2: boundary delivery sourced its markers from the presenter's
    // display-bounded `segmentContent` — tail-kept at CONTENT_LIMIT. A
    // marker emitted early in a segment longer than the cap fell out of the
    // head: the file silently never shipped, no receipt, no failure notice.
    // Delivery now reads the unbounded per-segment accumulation.
    const file = createTempFile();
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file.dir });
      stubOutboundFetch();
      (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
        SESSION_WEBHOOK_CHAT_ID,
        'https://oapi.dingtalk.com/robot/send?access_token=token',
      );
      // The presenter's display copy models the cap: tail-kept, the early
      // marker gone from the head.
      const { presenter, boundaryClosed } = installPresenter(
        channel,
        'x'.repeat(20000),
      );

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit(
          'textChunk',
          sessionId,
          `[FILE: ${file.path}]${'x'.repeat(25000)}`,
        );
        bridge.emit('responseBoundary', sessionId);
        await boundaryClosed;
        return 'final answer';
      };

      await expect(channel.handleInbound(inboundEnvelope())).resolves.toBe(
        undefined,
      );

      // The file was delivered with its receipt despite the display cap.
      expect(presenter.closeOutput).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('[File sent: report.txt]'),
        'response_boundary',
        expect.anything(),
      );
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });
});
