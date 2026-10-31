import { Activity } from '@microsoft/agents-activity';
import type {
  Request,
  WebResponse,
  TurnContext,
} from '@microsoft/agents-hosting';
import type { ChannelAgentBridge, Envelope } from '@qwen-code/channel-base';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TeamsConfig,
  TeamsHost,
  TeamsInboundEvent,
  TeamsReferenceStore,
} from './types.js';

const mocks = vi.hoisted(() => ({
  inbound: vi.fn(),
  authorize: vi.fn(),
  process: vi.fn(),
  send: vi.fn(),
  activity: vi.fn(),
  promptId: vi.fn(),
  cancel: vi.fn(),
  constructBase: vi.fn(),
}));
vi.mock('@qwen-code/channel-base', () => ({
  getGlobalQwenDir: () => '/unused',
  ChannelBase: class {
    constructor(
      protected name: string,
      _config: unknown,
      protected bridge: ChannelAgentBridge,
    ) {
      mocks.constructBase();
    }
    handleInbound(envelope: Envelope): Promise<void> {
      return mocks.inbound.call(this, envelope) as Promise<void>;
    }
    formatAttributedText(text: string, label?: string): string {
      return label ? `${label} ${text}` : text;
    }
    canStartInboundTurn(): boolean {
      return true;
    }
    registerCancelCommand(): void {}
    getResponseMessageId(): string | undefined {
      return mocks.promptId() as string | undefined;
    }
    setBridge(bridge: ChannelAgentBridge): void {
      this.bridge = bridge;
    }
    requestActivePromptCancellation(): Promise<boolean> {
      return mocks.cancel() as Promise<boolean>;
    }
  },
}));
vi.mock('@microsoft/agents-hosting', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@microsoft/agents-hosting')>();
  return {
    ...original,
    CloudAdapter: class {
      onTurnError?: unknown;
      authorizeRequest = mocks.authorize;
      process = mocks.process;
      continueConversation = mocks.send;
    },
  };
});

import {
  TeamsChannel,
  TeamsDeliveryError,
  splitTeamsText,
} from './TeamsChannel.js';
import { normalizeActivity } from './activity.js';
import { createTeamsIngress } from './index.js';

const config: TeamsConfig & Record<string, unknown> = {
  type: 'msteams',
  token: '',
  appId: 'bot-app',
  appPassword: 'test-only',
  tenantId: 'tenant-a',
  approvalMode: 'default',
  allowedUsers: [],
  sessionScope: 'chat_thread',
  cwd: '/unused',
  privatePolicy: 'open',
  groupPolicy: 'open',
  groups: {},
};
function body(id = 'message-1'): Record<string, unknown> {
  return {
    type: 'message',
    id,
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    from: { id: 'teams-user', aadObjectId: 'user-a' },
    recipient: { id: '28:bot-app' },
    conversation: {
      id: 'chat-1',
      conversationType: 'personal',
      tenantId: 'tenant-a',
    },
    channelData: { tenant: { id: 'tenant-a' } },
    text: 'hello',
  };
}
function event(id = 'message-1'): TeamsInboundEvent {
  return normalizeActivity('teams', config, Activity.fromObject(body(id)))!;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(hostOverride: Partial<TeamsHost> = {}) {
  const host: TeamsHost = {
    beforePrompt: vi.fn(async () => {}),
    onPromptSettled: vi.fn(async () => {}),
    acceptInbound: vi.fn(async () => {}),
    beforeSend: vi.fn(async () => {}),
    onSendReceipt: vi.fn(async () => {}),
    ...hostOverride,
  };
  const references: TeamsReferenceStore = {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
  };
  const channel = new TeamsChannel('teams', config, {} as ChannelAgentBridge, {
    host,
    referenceStore: references,
  });
  return { channel, host, references };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inbound.mockResolvedValue(undefined);
  mocks.promptId.mockReturnValue(undefined);
  mocks.cancel.mockResolvedValue(true);
  mocks.activity.mockResolvedValue({ id: 'platform-receipt' });
  mocks.authorize.mockImplementation(
    async (request: Request, _response: WebResponse, next: () => void) => {
      request.user = { aud: config.appId };
      next();
    },
  );
  mocks.process.mockImplementation(
    async (
      request: Request,
      response: WebResponse,
      logic: (context: Pick<TurnContext, 'activity'>) => Promise<void>,
    ) => {
      await logic({ activity: Activity.fromObject(request.body!) });
      response.status(200).end();
    },
  );
  mocks.send.mockImplementation(
    async (
      _appId: string,
      _reference: unknown,
      logic: (context: {
        sendActivity: () => Promise<{ id: string }>;
      }) => Promise<void>,
    ) => {
      await logic({ sendActivity: mocks.activity });
    },
  );
});

describe('Teams host contract', () => {
  it('requires a host when the base lacks standalone lifecycle guards', () => {
    const basePrototype = Object.getPrototypeOf(
      TeamsChannel.prototype,
    ) as object;
    const descriptor = Object.getOwnPropertyDescriptor(
      basePrototype,
      'canStartInboundTurn',
    );
    expect(descriptor).toBeDefined();
    Reflect.deleteProperty(basePrototype, 'canStartInboundTurn');
    try {
      expect(
        () => new TeamsChannel('teams', config, {} as ChannelAgentBridge),
      ).toThrow('channel-base 0.23.0 requires a host');
      expect(() => setup()).not.toThrow();
    } finally {
      Object.defineProperty(basePrototype, 'canStartInboundTurn', descriptor!);
    }
  });

  it('permits standalone mode when the base has lifecycle guards', () => {
    expect(
      () => new TeamsChannel('teams', config, {} as ChannelAgentBridge),
    ).not.toThrow();
  });

  it('awaits durable acceptance before ACK and does not execute at the HTTP boundary', async () => {
    const durable = deferred();
    const { channel, host } = setup({
      acceptInbound: vi.fn(() => durable.promise),
    });
    await channel.connect();
    let done = false;
    const response = channel
      .handleWebhook({ headers: {}, body: body() })
      .then((result) => {
        done = true;
        return result;
      });
    await vi.waitFor(() => expect(host.acceptInbound).toHaveBeenCalledOnce());
    expect(done).toBe(false);
    expect(mocks.inbound).not.toHaveBeenCalled();
    durable.resolve();
    expect((await response).status).toBe(200);
    await channel.disconnect();
  });

  it('does not acknowledge a failed durable write', async () => {
    const { channel } = setup({
      acceptInbound: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    await channel.connect();
    expect(
      (await channel.handleWebhook({ headers: {}, body: body() })).status,
    ).toBe(503);
    expect(mocks.inbound).not.toHaveBeenCalled();
  });

  it('permanently rejects authenticated cross-tenant messages without accepting them', async () => {
    const { channel, host } = setup();
    await channel.connect();
    const result = await channel.handleWebhook({
      headers: {},
      body: { ...body(), channelData: { tenant: { id: 'other-tenant' } } },
    });
    expect(result.status).toBe(400);
    expect(host.acceptInbound).not.toHaveBeenCalled();
  });

  it('never accepts a caller-supplied identity instead of SDK authentication', async () => {
    const { channel, host } = setup();
    mocks.authorize.mockImplementation(
      async (_request: Request, response: WebResponse) => {
        response.status(401).end();
      },
    );
    await channel.connect();
    const response = await channel.handleWebhook({
      headers: {},
      body: { ...body(), user: { aud: config.appId } },
    });
    expect(response.status).toBe(401);
    expect(mocks.process).not.toHaveBeenCalled();
    expect(host.acceptInbound).not.toHaveBeenCalled();
    expect(mocks.authorize.mock.calls[0][0].user).toBeUndefined();
  });

  it('keeps per-event targets and permits controls while another prompt is pending', async () => {
    const waiting = deferred();
    const { channel, host } = setup();
    await channel.connect();
    mocks.inbound.mockImplementation(async function (
      this: TeamsChannel,
      envelope: Envelope,
    ) {
      if (envelope.messageId === event('first').eventId) await waiting.promise;
      await this.sendMessage(envelope.chatId, envelope.messageId!);
    });
    const first = channel.dispatchPersisted(event('first'));
    await vi.waitFor(() => expect(mocks.inbound).toHaveBeenCalledOnce());
    await channel.dispatchPersisted(event('cancel'));
    expect(host.beforeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ eventId: event('cancel').eventId }),
      }),
    );
    waiting.resolve();
    await first;
    expect(host.beforeSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ eventId: event('first').eventId }),
      }),
    );
  });

  it('guards each chunk and preserves platform receipts', async () => {
    const { channel, host } = setup();
    await channel.connect();
    await channel.sendEventText(event(), 'x'.repeat(13 * 1024));
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(host.beforeSend).toHaveBeenCalledTimes(2);
    expect(host.onSendReceipt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        state: 'sent',
        platformMessageId: 'platform-receipt',
        chunkIndex: 0,
        chunkCount: 2,
      }),
    );
    expect(host.onSendReceipt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ state: 'sent', chunkIndex: 1 }),
    );
  });

  it('does not send when authorization changes between chunks', async () => {
    const guard = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('revoked'));
    const { channel, host } = setup({ beforeSend: guard });
    await channel.connect();
    await expect(
      channel.sendEventText(event(), 'x'.repeat(13 * 1024)),
    ).rejects.toMatchObject({ state: 'known_failed' });
    expect(mocks.activity).toHaveBeenCalledOnce();
    expect(host.onSendReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'known_failed', chunkIndex: 1 }),
    );
  });

  it('resumes a host-confirmed reply prefix with the original chunk metadata', async () => {
    let rejectSecondChunk = true;
    const { channel, host } = setup({
      beforeSend: vi.fn(async (context) => {
        if (context.chunkIndex === 1 && rejectSecondChunk) {
          throw new Error('Host temporarily unavailable');
        }
      }),
    });
    await channel.connect();
    const fullText = 'x'.repeat(25_000);
    await expect(
      channel.sendEventText(event(), fullText, 'response'),
    ).rejects.toMatchObject({ state: 'known_failed' });
    expect(mocks.activity).toHaveBeenCalledOnce();
    rejectSecondChunk = false;
    await channel.sendEventText(event(), fullText, 'response', {
      startChunkIndex: 1,
    });
    expect(mocks.activity).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(host.beforeSend)
        .mock.calls.map(([context]) => context.chunkIndex),
    ).toEqual([0, 1, 1, 2]);
    expect(
      vi
        .mocked(host.onSendReceipt)
        .mock.calls.map(([receipt]) => [receipt.chunkIndex, receipt.state]),
    ).toEqual([
      [0, 'sent'],
      [1, 'known_failed'],
      [1, 'sent'],
      [2, 'sent'],
    ]);
    for (const [context] of vi.mocked(host.beforeSend).mock.calls) {
      expect(context.fullText).toBe(fullText);
      expect(context.chunkCount).toBe(3);
      expect(context.event).toEqual(event());
    }
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1])(
    'rejects invalid startChunkIndex %s before contacting the platform',
    async (startChunkIndex) => {
      const { channel, host } = setup();
      await channel.connect();
      await expect(
        channel.sendEventText(event(), 'one chunk', 'response', {
          startChunkIndex,
        }),
      ).rejects.toMatchObject({ state: 'known_failed' });
      expect(host.beforeSend).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it('classifies send timeout or receipt persistence loss as unknown without retrying', async () => {
    const { channel, host } = setup();
    await channel.connect();
    mocks.send.mockImplementationOnce(
      async (
        _appId: string,
        _reference: unknown,
        logic: (context: {
          sendActivity: () => Promise<never>;
        }) => Promise<void>,
      ) => {
        await logic({
          sendActivity: async () => {
            throw new Error('timeout after server accepted');
          },
        });
      },
    );
    await expect(channel.sendEventText(event(), 'reply')).rejects.toMatchObject(
      { state: 'unknown' },
    );
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(host.onSendReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'unknown' }),
    );
    vi.mocked(host.onSendReceipt).mockRejectedValueOnce(
      new Error('receipt store unavailable'),
    );
    await expect(channel.sendEventText(event(), 'reply')).rejects.toMatchObject(
      { state: 'unknown' },
    );
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('rejects replay from another bot route and blocks sends after disconnect', async () => {
    const { channel } = setup();
    await channel.connect();
    await expect(channel.handleInbound(event().envelope)).rejects.toThrow(
      'authenticated',
    );
    await expect(
      channel.dispatchPersisted({ ...event(), tenantId: 'other-tenant' }),
    ).rejects.toThrow('does not match');
    await channel.disconnect();
    await expect(channel.sendEventText(event(), 'reply')).rejects.toMatchObject(
      { state: 'known_failed' },
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('awaits prompt submission state and persists its outcome before delivering', async () => {
    const submitting = deferred();
    const prompt = vi.fn(async () => 'final text');
    const host: TeamsHost = {
      acceptInbound: vi.fn(async () => {}),
      beforeSend: vi.fn(async () => {}),
      onSendReceipt: vi.fn(async () => {}),
      beforePrompt: vi.fn(() => submitting.promise),
      onPromptSettled: vi.fn(async () => {}),
    };
    const channel = new TeamsChannel(
      'teams',
      config,
      { prompt } as unknown as ChannelAgentBridge,
      {
        host,
        referenceStore: { get: async () => undefined, set: async () => {} },
      },
    );
    await channel.connect();
    mocks.promptId.mockReturnValue(event().eventId);
    mocks.inbound.mockImplementation(async function (this: {
      bridge: ChannelAgentBridge;
    }) {
      await this.bridge.prompt('session-1', 'prompt');
    });
    const execution = channel.dispatchPersisted(event());
    await vi.waitFor(() => expect(host.beforePrompt).toHaveBeenCalledOnce());
    expect(prompt).not.toHaveBeenCalled();
    submitting.resolve();
    await execution;
    expect(host.beforePrompt).toHaveBeenCalledWith(event(), 'session-1');
    expect(host.onPromptSettled).toHaveBeenCalledWith(event(), 'session-1', {
      status: 'completed',
      resultText: 'final text',
    });
  });

  it('never submits a queued prompt after stopping during its durable hook', async () => {
    const submitting = deferred();
    const prompt = vi.fn(async () => 'should not run');
    const host: TeamsHost = {
      acceptInbound: vi.fn(async () => {}),
      beforeSend: vi.fn(async () => {}),
      onSendReceipt: vi.fn(async () => {}),
      beforePrompt: vi.fn(() => submitting.promise),
      onPromptSettled: vi.fn(async () => {}),
    };
    const channel = new TeamsChannel(
      'teams',
      config,
      { prompt } as unknown as ChannelAgentBridge,
      {
        host,
        referenceStore: { get: async () => undefined, set: async () => {} },
      },
    );
    await channel.connect();
    mocks.promptId.mockReturnValue(event().eventId);
    mocks.inbound.mockImplementation(async function (this: {
      bridge: ChannelAgentBridge;
    }) {
      await this.bridge.prompt('session-1', 'prompt');
    });
    const execution = channel.dispatchPersisted(event());
    await vi.waitFor(() => expect(host.beforePrompt).toHaveBeenCalledOnce());
    await channel.disconnect();
    submitting.resolve();
    await expect(execution).rejects.toThrow('invalidated before submission');
    expect(prompt).not.toHaveBeenCalled();
    expect(host.onPromptSettled).toHaveBeenCalledWith(
      event(),
      'session-1',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  describe.each([true, false])(
    'completed prompt results (hosted=%s)',
    (hosted) => {
      it.each([
        ['empty', '', 'The task completed without a text response.'],
        ['blank', ' \n\t', 'The task completed without a text response.'],
        [
          'oversized UTF-8',
          '🙂'.repeat(16_385),
          'The task completed, but its response is too large to send in Teams.',
        ],
        ['normal', ' original result ', ' original result '],
        ['at limit', 'x'.repeat(64 * 1024), 'x'.repeat(64 * 1024)],
      ])(
        'normalizes %s without sending from settlement',
        async (_label, result, expected) => {
          const prompt = vi.fn(async () => result);
          const host: TeamsHost = {
            acceptInbound: vi.fn(async () => {}),
            beforePrompt: vi.fn(async () => {}),
            onPromptSettled: vi.fn(async () => {}),
            beforeSend: vi.fn(async () => {}),
            onSendReceipt: vi.fn(async () => {}),
          };
          const channel = new TeamsChannel(
            'teams',
            { ...config, webhookPort: 0 },
            { prompt } as unknown as ChannelAgentBridge,
            {
              host: hosted ? host : undefined,
              referenceStore: {
                get: async () => undefined,
                set: async () => {},
              },
            },
          );
          mocks.promptId.mockReturnValue(event().eventId);
          let returned: string | undefined;
          mocks.inbound.mockImplementation(async function (this: {
            bridge: ChannelAgentBridge;
          }) {
            returned = await this.bridge.prompt('session-1', 'prompt');
          });
          await channel.connect();
          try {
            await channel.dispatchPersisted(event());
            expect(returned).toBe(expected);
            expect(prompt).toHaveBeenCalledOnce();
            if (hosted) {
              expect(host.onPromptSettled).toHaveBeenCalledWith(
                event(),
                'session-1',
                {
                  status: 'completed',
                  resultText: result,
                },
              );
            } else {
              expect(host.onPromptSettled).not.toHaveBeenCalled();
            }
            expect(mocks.send).not.toHaveBeenCalled();
            expect(host.beforeSend).not.toHaveBeenCalled();
          } finally {
            await channel.disconnect();
          }
        },
      );
    },
  );

  it('checks exact event before cancelling and never cancels a replacement turn', async () => {
    const { channel } = setup();
    await channel.connect();
    mocks.promptId.mockReturnValue('replacement-event');
    expect(await channel.cancelEvent('session-1', 'previous-event')).toBe(
      false,
    );
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(await channel.cancelEvent('session-1', 'replacement-event')).toBe(
      true,
    );
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it('rechecks stop state after the SDK obtains its connector', async () => {
    const { channel } = setup();
    await channel.connect();
    const connector = deferred();
    mocks.send.mockImplementationOnce(
      async (
        _appId: string,
        _reference: unknown,
        logic: (context: {
          sendActivity: typeof mocks.activity;
        }) => Promise<void>,
      ) => {
        await connector.promise;
        await logic({ sendActivity: mocks.activity });
      },
    );
    const sending = channel.sendEventText(event(), 'reply');
    await channel.disconnect();
    connector.resolve();
    await expect(sending).rejects.toMatchObject({ state: 'known_failed' });
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('chunks UTF-8 without splitting code points and bounds total output', () => {
    const text = '🙂'.repeat(4000);
    const chunks = splitTeamsText(text);
    expect(chunks.join('')).toBe(text);
    expect(
      chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 12 * 1024),
    ).toBe(true);
    expect(() => splitTeamsText('x'.repeat(65 * 1024))).toThrow(
      TeamsDeliveryError,
    );
  });
});

describe('Teams independent ingress', () => {
  const credentials = {
    appId: config.appId,
    appPassword: config.appPassword,
    tenantId: config.tenantId,
  };

  it('requires bot credentials without channel execution configuration', () => {
    expect(() =>
      createTeamsIngress(
        'teams',
        { ...credentials, appId: '' },
        async () => {},
      ),
    ).toThrow('Teams requires appId, appPassword, and tenantId.');
    expect(mocks.constructBase).not.toHaveBeenCalled();
  });

  it('awaits acceptance without constructing a base or starting execution', async () => {
    const durable = deferred();
    const accept = vi.fn<(event: TeamsInboundEvent) => Promise<void>>(
      () => durable.promise,
    );
    const ingress = createTeamsIngress('teams', credentials, accept);
    let done = false;
    const response = ingress
      .handleWebhook({ headers: {}, body: body() })
      .then((result) => {
        done = true;
        return result;
      });
    await vi.waitFor(() => expect(accept).toHaveBeenCalledOnce());
    expect(accept.mock.calls[0]?.[0]).toEqual(event());
    expect(done).toBe(false);
    expect(mocks.constructBase).not.toHaveBeenCalled();
    expect(mocks.inbound).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    durable.resolve();
    expect((await response).status).toBe(200);
  });

  it('returns a retryable failure when acceptance rejects', async () => {
    const ingress = createTeamsIngress('teams', credentials, async () => {
      throw new Error('durable acceptance failed');
    });
    expect(await ingress.handleWebhook({ headers: {}, body: body() })).toEqual({
      status: 503,
      headers: {},
    });
  });

  it('does not trust identity supplied beside the HTTP input or in its body', async () => {
    mocks.authorize.mockImplementation(
      async (_request: Request, response: WebResponse) => {
        response.status(401).end();
      },
    );
    const accept = vi.fn(async () => {});
    const ingress = createTeamsIngress('teams', credentials, accept);
    const input = {
      headers: {},
      user: { aud: credentials.appId },
      body: { ...body(), user: { aud: credentials.appId } },
    };
    expect((await ingress.handleWebhook(input)).status).toBe(401);
    expect(mocks.authorize.mock.calls[0][0].user).toBeUndefined();
    expect(mocks.process).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    { channelData: { tenant: { id: 'other-tenant' } } },
    { recipient: { id: '28:other-bot' } },
    { serviceUrl: 'https://untrusted.example/' },
  ])('rejects invalid authenticated routing: %j', async (override) => {
    const accept = vi.fn(async () => {});
    const ingress = createTeamsIngress('teams', credentials, accept);
    expect(
      (
        await ingress.handleWebhook({
          headers: {},
          body: { ...body(), ...override },
        })
      ).status,
    ).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });

  it('ignores unmentioned groups and preserves the SDK invoke response', async () => {
    const accept = vi.fn(async () => {});
    const ingress = createTeamsIngress('teams', credentials, accept);
    expect(
      (
        await ingress.handleWebhook({
          headers: {},
          body: {
            ...body(),
            conversation: { id: 'group', conversationType: 'groupChat' },
          },
        })
      ).status,
    ).toBe(200);
    mocks.process.mockImplementationOnce(
      async (
        request: Request,
        response: WebResponse,
        logic: (context: Pick<TurnContext, 'activity'>) => Promise<void>,
      ) => {
        await logic({ activity: Activity.fromObject(request.body!) });
        response.setHeader('content-type', 'application/json');
        response.status(501).send({ error: 'invoke not supported' }).end();
      },
    );
    expect(
      await ingress.handleWebhook({
        headers: {},
        body: { ...body(), type: 'invoke' },
      }),
    ).toEqual({
      status: 501,
      headers: { 'content-type': 'application/json' },
      body: { error: 'invoke not supported' },
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it('does not serialize or deduplicate concurrent HTTP callbacks', async () => {
    const durable = deferred();
    const accept = vi
      .fn<(event: TeamsInboundEvent) => Promise<void>>()
      .mockImplementationOnce(() => durable.promise)
      .mockResolvedValue(undefined);
    const ingress = createTeamsIngress('teams', credentials, accept);
    const first = ingress.handleWebhook({ headers: {}, body: body() });
    await vi.waitFor(() => expect(accept).toHaveBeenCalledOnce());
    expect(
      (await ingress.handleWebhook({ headers: {}, body: body() })).status,
    ).toBe(200);
    expect(accept).toHaveBeenCalledTimes(2);
    expect(accept.mock.calls[0][0].eventId).toBe(
      accept.mock.calls[1][0].eventId,
    );
    durable.resolve();
    expect((await first).status).toBe(200);
  });

  it('rejects an oversized JSON body before SDK authentication', async () => {
    const accept = vi.fn(async () => {});
    const ingress = createTeamsIngress('teams', credentials, accept);
    expect(
      (
        await ingress.handleWebhook({
          headers: {},
          body: { text: 'a'.repeat(1024 * 1024) },
        })
      ).status,
    ).toBe(413);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
});
