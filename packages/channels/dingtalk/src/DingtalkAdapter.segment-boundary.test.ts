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

/** Envelope with a configurable messageId so two turns do not dedup. */
function envelopeWith(messageId: string): Envelope {
  return {
    channelName: 'test-dingtalk',
    senderId: 'owner-1',
    senderName: 'Owner One',
    chatId: SESSION_WEBHOOK_CHAT_ID,
    text: 'send me the report',
    isGroup: false,
    isMentioned: false,
    isReplyToBot: false,
    messageId,
  };
}

/** Fetch stub that records every webhook POST body it answers. */
function stubWebhookFetch(
  postBodies: Array<Record<string, unknown>>,
  markdownVerdict: (markdownCall: number) => number = () => 0,
  fileVerdict: () => number = () => 0,
): void {
  let markdownCall = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
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
    const body = JSON.parse(String((init as RequestInit | undefined)?.body));
    postBodies.push(body);
    if (body.msgtype === 'markdown') {
      const errcode = markdownVerdict(markdownCall++);
      return Promise.resolve(
        new Response(JSON.stringify({ errcode }), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ errcode: fileVerdict() }), {
        status: 200,
      }),
    );
  });
}

function segmentDeliveryTextMap(
  channel: DingtalkChannelInstance,
): Map<string, Map<string, string>> {
  return (
    channel as unknown as {
      segmentDeliveryText: Map<string, Map<string, string>>;
    }
  ).segmentDeliveryText;
}

describe('round-17/18 boundary delivery fixes', () => {
  it('fails a card-less text turn whose chat has no webhook (R18-1)', async () => {
    // R18-1: `sendPreparedReply` logged the missing webhook and returned
    // false, which every caller ignored — a DM payload lacking
    // `conversationId` (chatId = sessionWebhook, no map entry) resolved the
    // turn successful with zero webhook POSTs: no response, no apology, no
    // failure event. The missing webhook now throws like the file variant.
    const dir = mkdtempSync(join(tmpdir(), 'dingtalk-r181-'));
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, {
        cwd: dir,
        interactiveCards: undefined,
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ errcode: 0 }), { status: 200 }),
      );

      await expect(
        channel.handleInbound(envelopeWith('msg-r181')),
      ).rejects.toThrow(/no webhook/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not accumulate delivery text without a presenter (R17-1)', async () => {
    // R17-1: the delivery accumulation existed only for
    // `closeSegmentWithFiles`, which never runs without a presenter — yet
    // every streamed chunk of every turn accumulated until the session
    // died, unbounded, in the default card-less deployment.
    const dir = mkdtempSync(join(tmpdir(), 'dingtalk-r171-'));
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, {
        cwd: dir,
        interactiveCards: undefined,
      });
      (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
        SESSION_WEBHOOK_CHAT_ID,
        'https://oapi.dingtalk.com/robot/send?access_token=token',
      );
      stubWebhookFetch([]);

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, 'streamed chunk');
        bridge.emit('responseBoundary', sessionId);
        return 'final answer';
      };

      await expect(
        channel.handleInbound(envelopeWith('msg-r171a')),
      ).resolves.toBe(undefined);
      expect(segmentDeliveryTextMap(channel).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims the final segment delivery text after completion (R17-1)', async () => {
    // R17-1 card arm: the FINAL segment of every successful turn was never
    // deleted — `onResponseComplete` has no delete and `onPromptEnd` does
    // not touch the map — so a long-lived session pinned every turn's raw
    // text forever.
    const dir = mkdtempSync(join(tmpdir(), 'dingtalk-r171b-'));
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: dir });
      (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
        SESSION_WEBHOOK_CHAT_ID,
        'https://oapi.dingtalk.com/robot/send?access_token=token',
      );
      stubWebhookFetch([]);
      installPresenter(channel, 'segment body');

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, 'segment body');
        return 'final answer';
      };

      await expect(
        channel.handleInbound(envelopeWith('msg-r171b')),
      ).resolves.toBe(undefined);
      expect(segmentDeliveryTextMap(channel).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the mention for the final answer after a boundary fallback (R17-2)', async () => {
    // R17-2: the boundary fallback delivered through `sendPreparedResponse`,
    // which deletes the prompt's one-shot mention target — correct for the
    // final answer, wrong mid-run: the final answer then shipped without
    // the @ the channel promises.
    const file = createTempFile();
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file.dir, atSender: true });
      (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
        SESSION_WEBHOOK_CHAT_ID,
        'https://oapi.dingtalk.com/robot/send?access_token=token',
      );
      const postBodies: Array<Record<string, unknown>> = [];
      stubWebhookFetch(postBodies);
      (
        channel as unknown as { mentionTargets: Map<string, string> }
      ).mentionTargets.set('msg-r172', 'staff-1');

      let resolveBoundaryClosed!: () => void;
      const boundaryClosed = new Promise<void>((resolve) => {
        resolveBoundaryClosed = resolve;
      });
      installPresenter(channel, `[FILE: ${file.path}]`, (_s, _t, reason) => {
        if (reason === 'response_boundary') {
          resolveBoundaryClosed();
          return Promise.resolve(false);
        }
        if (reason === 'completed') return Promise.resolve(false);
        return Promise.resolve(true);
      });

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, `[FILE: ${file.path}]`);
        bridge.emit('responseBoundary', sessionId);
        await boundaryClosed;
        return 'final answer';
      };

      await expect(
        channel.handleInbound(envelopeWith('msg-r172')),
      ).resolves.toBe(undefined);

      const markdowns = postBodies.filter(
        (b) => b.msgtype === 'markdown',
      ) as Array<{
        markdown: { text: string };
        at?: { atUserIds: string[] };
      }>;
      // Both the boundary fallback and the final answer carry the mention.
      expect(markdowns).toHaveLength(2);
      expect(markdowns[0]!.markdown.text).toContain('@staff-1');
      expect(markdowns[0]!.markdown.text).toContain('[File sent: report.txt]');
      expect(markdowns[0]!.at?.atUserIds).toEqual(['staff-1']);
      expect(markdowns[1]!.markdown.text).toContain('@staff-1');
      expect(markdowns[1]!.markdown.text).toContain('final answer');
      expect(markdowns[1]!.at?.atUserIds).toEqual(['staff-1']);
      // The final answer consumed the target; nothing outlives the turn.
      expect(
        (
          channel as unknown as {
            sessionMentionTargets: Map<string, string>;
          }
        ).sessionMentionTargets.size,
      ).toBe(0);
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });

  it('surfaces a boundary failure when the turn ends with an empty response (R17-3)', async () => {
    // R17-3 arm B: ChannelBase skips `onResponseComplete` for an empty
    // final response, and `onPromptEnd` swept the recorded failure without
    // consulting it — the file and its notice lost, the turn booked
    // completed. The sweep now drains and surfaces: best-effort apology
    // plus a loud log.
    const file = createTempFile();
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file.dir });
      (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
        SESSION_WEBHOOK_CHAT_ID,
        'https://oapi.dingtalk.com/robot/send?access_token=token',
      );
      const postBodies: Array<Record<string, unknown>> = [];
      // Quota-dead webhook: the file, the notice, and the apology alike.
      stubWebhookFetch(
        postBodies,
        () => 310000,
        () => 310000,
      );
      const writes: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      installPresenter(channel, `[FILE: ${file.path}]`);

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, `[FILE: ${file.path}]`);
        bridge.emit('responseBoundary', sessionId);
        return '';
      };

      // The turn books completed — the failure can no longer fail it — but
      // it is no longer silent.
      await expect(
        channel.handleInbound(envelopeWith('msg-r173')),
      ).resolves.toBe(undefined);

      await vi.waitFor(() => {
        const apologies = postBodies.filter((b) =>
          String(
            (b as { markdown?: { text?: string } }).markdown?.text ?? '',
          ).includes('Sorry, something went wrong processing your message.'),
        );
        expect(apologies).toHaveLength(1);
      });
      expect(writes.join('')).toContain('boundary failure after turn end');
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });

  it('does not poison the next turn with a late boundary failure (R17-3)', async () => {
    // R17-3 arm A: a close still in flight recorded its failure AFTER the
    // sweep — the entry survived and the NEXT healthy turn rethrew it,
    // booking that turn failed for this turn's delivery failure. The
    // sweep now chains onto the in-flight close and surfaces the failure
    // itself.
    const file = createTempFile();
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file.dir });
      (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
        SESSION_WEBHOOK_CHAT_ID,
        'https://oapi.dingtalk.com/robot/send?access_token=token',
      );
      const postBodies: Array<Record<string, unknown>> = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      // Gate the upload-token fetch so the boundary close is provably in
      // flight when the empty-response turn ends.
      let releaseTokenFetch!: () => void;
      const tokenGate = new Promise<void>((resolve) => {
        releaseTokenFetch = resolve;
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
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
        const body = JSON.parse(
          String((init as RequestInit | undefined)?.body),
        );
        postBodies.push(body);
        // Quota-dead webhook: file, notice, and apology all rejected.
        return Promise.resolve(
          new Response(JSON.stringify({ errcode: 310000 }), {
            status: 200,
          }),
        );
      });
      installPresenter(channel, `[FILE: ${file.path}]`);

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, `[FILE: ${file.path}]`);
        bridge.emit('responseBoundary', sessionId);
        setTimeout(releaseTokenFetch, 10);
        return '';
      };

      await expect(
        channel.handleInbound(envelopeWith('msg-r173a1')),
      ).resolves.toBe(undefined);

      // The late failure surfaces against its OWN turn's chat — as the
      // best-effort apology — not against the next turn.
      await vi.waitFor(() => {
        const apologies = postBodies.filter((b) =>
          String(
            (b as { markdown?: { text?: string } }).markdown?.text ?? '',
          ).includes('Sorry, something went wrong processing your message.'),
        );
        expect(apologies).toHaveLength(1);
      });

      // Turn 2, healthy: it must not be booked failed for turn 1's loss.
      (bridge as unknown as { prompt: unknown }).prompt = async () =>
        'final answer';
      await expect(
        channel.handleInbound(envelopeWith('msg-r173a2')),
      ).resolves.toBe(undefined);
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });

  it('does not resend after a rejected display close (R17-4)', async () => {
    // R17-4: `closeOutput`'s fallback can reject after part of the text
    // already POSTED; the adapter then re-POSTed the ENTIRE segment — the
    // recipient saw the first chunk twice. A rejected display close now
    // skips the adapter resend and records the loss instead.
    const file = createTempFile();
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file.dir });
      (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
        SESSION_WEBHOOK_CHAT_ID,
        'https://oapi.dingtalk.com/robot/send?access_token=token',
      );
      const postBodies: Array<Record<string, unknown>> = [];
      stubWebhookFetch(postBodies);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      installPresenter(channel, `[FILE: ${file.path}]`, (_s, _t, reason) =>
        reason === 'response_boundary'
          ? Promise.reject(new Error('card stream latched failed'))
          : Promise.resolve(true),
      );

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, `[FILE: ${file.path}]`);
        bridge.emit('responseBoundary', sessionId);
        return 'final answer';
      };

      // The recorded display-close failure becomes the turn's verdict.
      await expect(
        channel.handleInbound(envelopeWith('msg-r174')),
      ).rejects.toThrow(/card stream latched failed/);

      // The file went out, but the adapter never resent the segment text.
      expect(postBodies.filter((b) => b.msgtype === 'file')).toHaveLength(1);
      expect(postBodies.filter((b) => b.msgtype === 'markdown')).toHaveLength(
        0,
      );
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });

  it('fails the turn when the display close and the fallback both reject (R18-3)', async () => {
    // R18-3: with `files: []` (the upload failed in
    // `prepareOutgoingContent`, the prepared text is the corrective notice)
    // `sendReplyFiles` returns before any webhook check; a rejecting
    // display close plus a rejecting fallback left nothing recorded — the
    // turn booked completed while the recipient got nothing.
    const dir = mkdtempSync(join(tmpdir(), 'dingtalk-r183-'));
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      // Marker points at a nonexistent file: prepare bakes the
      // `[File delivery failed: …]` notice and yields `files: []`.
      const channel = createChannel(bridge, { cwd: dir });
      (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
        SESSION_WEBHOOK_CHAT_ID,
        'https://oapi.dingtalk.com/robot/send?access_token=token',
      );
      const postBodies: Array<Record<string, unknown>> = [];
      // The boundary fallback notice dies on the quota-dead webhook; the
      // final answer would succeed — pre-fix the turn resolved with the
      // loss unrecorded.
      stubWebhookFetch(postBodies, (call) => (call === 0 ? 310000 : 0));
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      // No display surface at all: the close answers false and the plain
      // fallback rides the quota-dead webhook.
      installPresenter(channel, '[FILE: /nonexistent/missing.txt]', () =>
        Promise.resolve(false),
      );

      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, '[FILE: /nonexistent/missing.txt]');
        bridge.emit('responseBoundary', sessionId);
        return 'final answer';
      };

      await expect(
        channel.handleInbound(envelopeWith('msg-r183')),
      ).rejects.toThrow(/API code 310000/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('round-19 attribution and streaming delivery failures', () => {
  it('attributes a fast-failing boundary close to its own turn (R19-24)', async () => {
    // R19-x (R19-24): the pending-failure map is keyed by session alone, so
    // turn 1's deferred turn-end drain consumed whatever occupied the map
    // when ITS close settled — turn 2's freshly recorded failure. Turn 2
    // then booked completed with its file and notice both lost, and turn 1
    // apologised for a failure that was not its own. Each turn's consumers
    // must remove only the entries recorded under that turn's token.
    const file2 = createTempFile('report2.txt');
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, { cwd: file2.dir });
      stubOutboundFetch();
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      let releaseTurn1Close: () => void = () => {};
      let boundaryCloseCalls = 0;
      installPresenter(channel, 'unused', (_s, _t, reason) => {
        if (reason !== 'response_boundary') return Promise.resolve(true);
        boundaryCloseCalls++;
        if (boundaryCloseCalls === 1) {
          // Turn 1's boundary close stays in flight past its turn's end.
          return new Promise<boolean>((resolve) => {
            releaseTurn1Close = () => resolve(true);
          });
        }
        return Promise.resolve(true);
      });

      // Turn 1: a plain segment whose close hangs; an EMPTY final response
      // ends the turn without onResponseComplete (the R17-3 shape), so the
      // turn-end sweep registers on the still-in-flight close.
      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, 'plain segment');
        bridge.emit('responseBoundary', sessionId);
        return '';
      };
      await channel.handleInbound(envelopeWith('msg-r1924-1'));

      // Turn 2 on the same session: its boundary close fails fast while
      // turn 1's close still hangs.
      (bridge as unknown as { prompt: unknown }).prompt = async (
        sessionId: string,
      ) => {
        bridge.emit('textChunk', sessionId, `[FILE: ${file2.path}]`);
        bridge.emit('responseBoundary', sessionId);
        return 'final answer';
      };
      const turn2 = channel.handleInbound(envelopeWith('msg-r1924-2'));

      // Turn 2's close records and display-closes; its onResponseComplete
      // then waits for the session's in-flight chain — turn 1's hung close.
      await vi.waitFor(() => expect(boundaryCloseCalls).toBe(2));
      releaseTurn1Close();

      // Turn 2 fails with ITS OWN failure — pre-fix turn 1's sweep drained
      // it first and turn 2 booked completed.
      await expect(turn2).rejects.toThrow(/no delivered notice: report2\.txt/);
      // Turn 1's sweep surfaced nothing: the failure was never its own.
      expect(stderrSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('boundary failure after turn end'),
      );
    } finally {
      rmSync(file2.dir, { recursive: true, force: true });
    }
  });

  it('surfaces streamed-block delivery failures the streamer swallows (R19-4)', async () => {
    // R19-x (R19-4): under blockStreaming, ChannelBase delivers each block
    // through BlockStreamer, whose serialized chain ends in a swallowed
    // catch — every DingTalkDeliveryError the block send raises is dropped
    // and the turn books completed. The adapter records the failure
    // instead; the turn-end sweep logs it and sends best-effort the apology
    // a rethrow would otherwise have earned.
    const dir = mkdtempSync(join(tmpdir(), 'dingtalk-r194-'));
    try {
      const bridge = createBridge() as EventEmitter & ChannelAgentBridge;
      const channel = createChannel(bridge, {
        cwd: dir,
        blockStreaming: 'on',
        blockStreamingChunk: { minChars: 1, maxChars: 4 },
        blockStreamingCoalesce: { idleMs: 0 },
      });
      (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
        SESSION_WEBHOOK_CHAT_ID,
        'https://oapi.dingtalk.com/robot/send?access_token=token',
      );
      const postBodies: Array<Record<string, unknown>> = [];
      // Every markdown POST rejects with a non-zero errcode (quota dead).
      stubWebhookFetch(postBodies, () => 310000);
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      installPresenter(channel, 'streamed');

      (bridge as unknown as { prompt: unknown }).prompt = async () =>
        'final answer';

      // The turn still completes — streaming failures surface at turn end.
      await channel.handleInbound(envelopeWith('msg-r194'));

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('boundary failure after turn end'),
      );
      // The apology POST follows the rejected block POSTs.
      expect(postBodies.length).toBeGreaterThanOrEqual(4);
      expect(postBodies.at(-1)).toMatchObject({
        markdown: {
          text: expect.stringContaining('Sorry, something went wrong'),
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
