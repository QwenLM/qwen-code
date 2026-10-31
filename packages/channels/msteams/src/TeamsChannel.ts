import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { CloudAdapter } from '@microsoft/agents-hosting';
import { Activity } from '@microsoft/agents-activity';
import { ChannelBase, getGlobalQwenDir } from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelOutputSegmentContext,
  ChannelTaskLifecycleEvent,
  Envelope,
} from '@qwen-code/channel-base';
import { freeze, referenceKey, validateTarget } from './activity.js';
import {
  createTeamsAdapter,
  handleTeamsWebhook,
  MAX_BODY_BYTES,
} from './ingress.js';
import { FileTeamsReferenceStore } from './reference-store.js';
import type {
  TeamsChannelOptions,
  TeamsConfig,
  TeamsInboundEvent,
  TeamsHost,
  TeamsReferenceStore,
  TeamsSendContext,
  TeamsTarget,
  TeamsWebhookRequest,
  TeamsWebhookResponse,
} from './types.js';

const MAX_REPLY_BYTES = 64 * 1024;
const CHUNK_BYTES = 12 * 1024;

export class TeamsDeliveryError extends Error {
  constructor(
    readonly state: 'known_failed' | 'unknown',
    options?: ErrorOptions,
  ) {
    super(`Teams delivery ${state}.`, options);
  }
}

export function splitTeamsText(text: string): string[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_REPLY_BYTES) {
    throw new TeamsDeliveryError('known_failed');
  }
  const chunks: string[] = [];
  let current = '';
  let size = 0;
  for (const point of text) {
    const bytes = Buffer.byteLength(point, 'utf8');
    if (size + bytes > CHUNK_BYTES) {
      chunks.push(current);
      current = '';
      size = 0;
    }
    current += point;
    size += bytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

function wrapPromptBridge(
  bridge: ChannelAgentBridge,
  lookup: (sessionId: string) => TeamsInboundEvent | undefined,
  host?: TeamsHost,
): ChannelAgentBridge {
  const prompt: ChannelAgentBridge['prompt'] = async (
    sessionId,
    text,
    options,
  ) => {
    if (!host) {
      return normalizePromptResult(
        await bridge.prompt(sessionId, text, options),
      );
    }
    const event = lookup(sessionId);
    if (!event)
      throw new Error('Teams prompt has no accepted originating event.');
    await host.beforePrompt(event, sessionId);
    let result: string;
    try {
      if (lookup(sessionId) !== event) {
        throw new Error('Teams prompt was invalidated before submission.');
      }
      result = await bridge.prompt(sessionId, text, options);
    } catch (error) {
      await host.onPromptSettled(event, sessionId, { status: 'failed', error });
      throw error;
    }
    await host.onPromptSettled(event, sessionId, {
      status: 'completed',
      resultText: result,
    });
    return normalizePromptResult(result);
  };
  return new Proxy(bridge, {
    get(target, property) {
      if (property === 'prompt') return prompt;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function normalizePromptResult(text: string): string {
  if (!text.trim()) return 'The task completed without a text response.';
  if (Buffer.byteLength(text, 'utf8') > MAX_REPLY_BYTES) {
    return 'The task completed, but its response is too large to send in Teams.';
  }
  return text;
}

export class TeamsChannel extends ChannelBase {
  private readonly adapter: CloudAdapter;
  private readonly teamsConfig: TeamsConfig;
  private readonly teamsOptions: TeamsChannelOptions;
  private readonly references: TeamsReferenceStore;
  private readonly inbound = new AsyncLocalStorage<TeamsInboundEvent>();
  private readonly activeEvents = new Map<string, TeamsInboundEvent>();
  private readonly cancelledEvents = new Set<string>();
  private readonly accepting = new Map<string, Promise<void>>();
  private readonly recent = new Map<string, number>();
  private server?: Server;
  private connected = false;

  constructor(
    name: string,
    config: TeamsConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options: TeamsChannelOptions = {},
  ) {
    if (!config.appId || !config.appPassword || !config.tenantId) {
      throw new Error('Teams requires appId, appPassword, and tenantId.');
    }
    if (!config.approvalMode)
      throw new Error('Teams requires an explicit approvalMode.');
    if (config.outputMode && config.outputMode !== 'per_turn') {
      throw new Error('Teams currently supports final per-turn text only.');
    }
    if (
      !options.host &&
      typeof Reflect.get(ChannelBase.prototype, 'canStartInboundTurn') !==
        'function'
    ) {
      throw new Error(
        'Teams standalone mode requires channel-base 0.26.1; channel-base 0.23.0 requires a host.',
      );
    }
    const channel: { current?: TeamsChannel } = {};
    super(
      name,
      {
        ...config,
        dispatchMode: 'followup',
        groupHistoryLimit: 0,
        groups: Object.fromEntries(
          Object.entries(config.groups).map(([id, group]) => [
            id,
            {
              ...group,
              dispatchMode: 'followup' as const,
              groupHistoryLimit: 0,
            },
          ]),
        ),
      },
      wrapPromptBridge(
        bridge,
        (sessionId) => channel.current?.eventForSession(sessionId),
        options.host,
      ),
      options,
    );
    channel.current = this;
    this.teamsConfig = { ...config };
    this.teamsOptions = options;
    this.registerCancelCommand();
    this.references =
      options.referenceStore ??
      new FileTeamsReferenceStore(
        join(
          options.stateDir ??
            join(
              getGlobalQwenDir(),
              'channels',
              createHash('sha256').update(name).digest('hex'),
            ),
          'teams-references',
        ),
      );
    this.adapter = createTeamsAdapter(this.teamsConfig);
  }

  private eventForSession(sessionId: string): TeamsInboundEvent | undefined {
    const messageId = this.getResponseMessageId(sessionId);
    return this.connected && messageId && !this.cancelledEvents.has(messageId)
      ? this.activeEvents.get(messageId)
      : undefined;
  }

  protected override onTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
    if (event.type === 'cancelled' && event.messageId)
      this.cancelledEvents.add(event.messageId);
  }

  override setBridge(bridge: ChannelAgentBridge): void {
    super.setBridge(
      wrapPromptBridge(
        bridge,
        (sessionId) => this.eventForSession(sessionId),
        this.teamsOptions.host,
      ),
    );
  }

  /** Host authorization must precede this exact-event cancellation. */
  async cancelEvent(
    sessionId: string,
    expectedEventId: string,
  ): Promise<boolean> {
    if (
      !this.connected ||
      this.getResponseMessageId(sessionId) !== expectedEventId
    )
      return false;
    return this.requestActivePromptCancellation(sessionId, 'cancel_command');
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    if (this.teamsOptions.host) return;
    const path = this.teamsConfig.webhookPath ?? '/api/messages';
    this.server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url?.split('?')[0] !== path) {
        response.writeHead(404).end();
        return;
      }
      try {
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += buffer.length;
          if (length > MAX_BODY_BYTES) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(buffer);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          response.writeHead(400).end();
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          response.writeHead(400).end();
          return;
        }
        const result = await this.handleWebhook({
          headers: request.headers,
          body: body as Record<string, unknown>,
        });
        response.writeHead(result.status, result.headers);
        response.end(
          result.body === undefined ? undefined : JSON.stringify(result.body),
        );
      } catch {
        if (!response.headersSent) response.writeHead(503);
        response.end();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(
          this.teamsConfig.webhookPort ?? 3978,
          '127.0.0.1',
          () => {
            this.server!.off('error', reject);
            resolve();
          },
        );
      });
    } catch (error) {
      this.connected = false;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }

  protected override canStartInboundTurn(): boolean {
    return this.connected;
  }

  /** Public HTTP entrypoint. An incoming `user` object is never trusted. */
  async handleWebhook(
    input: TeamsWebhookRequest,
  ): Promise<TeamsWebhookResponse> {
    if (!this.connected) return { status: 503, headers: {} };
    return handleTeamsWebhook(
      this.adapter,
      this.name,
      this.teamsConfig,
      (event) => this.accept(event),
      input,
    );
  }

  private async accept(event: TeamsInboundEvent): Promise<void> {
    if (this.teamsOptions.host) {
      await this.teamsOptions.host.acceptInbound(event);
      return;
    }
    const pending = this.accepting.get(event.eventId);
    if (pending) return pending;
    if ((this.recent.get(event.eventId) ?? 0) > Date.now()) return;
    const acceptance = (async () => {
      await this.references.set(referenceKey(event.target), event.target);
      this.recent.set(event.eventId, Date.now() + 10 * 60_000);
      if (this.recent.size > 1000)
        this.recent.delete(this.recent.keys().next().value!);
      void this.dispatchPersisted(event).catch(() => {
        process.stderr.write(
          `[Teams] Inbound processing failed; the event will not be replayed automatically.\n`,
        );
      });
    })();
    this.accepting.set(event.eventId, acceptance);
    try {
      await acceptance;
    } finally {
      this.accepting.delete(event.eventId);
    }
  }

  /** Trusted in-process replay only. Hosts must load and authorize their own accepted records. */
  async dispatchPersisted(event: TeamsInboundEvent): Promise<void> {
    if (!this.connected) throw new Error('Teams channel is stopped.');
    const snapshot = freeze(structuredClone(event));
    validateTarget(this.teamsConfig, snapshot.target);
    if (
      snapshot.version !== 1 ||
      snapshot.tenantId !== this.teamsConfig.tenantId.toLowerCase() ||
      snapshot.envelope.channelName !== this.name ||
      snapshot.envelope.messageId !== snapshot.eventId ||
      snapshot.envelope.senderId !==
        `msteams:${snapshot.tenantId}:${snapshot.actorId}` ||
      snapshot.envelope.chatId !== snapshot.target.chatId ||
      snapshot.envelope.threadId !== snapshot.target.threadId
    )
      throw new Error('Teams persisted event does not match this channel.');
    if (this.activeEvents.has(snapshot.eventId))
      throw new Error('Teams event is already being dispatched.');
    this.activeEvents.set(snapshot.eventId, snapshot);
    try {
      await this.references.set(referenceKey(snapshot.target), snapshot.target);
      await this.inbound.run(snapshot, () =>
        super.handleInbound({ ...snapshot.envelope }),
      );
    } finally {
      this.activeEvents.delete(snapshot.eventId);
      this.cancelledEvents.delete(snapshot.eventId);
    }
  }

  /** Normalized envelopes alone lack authenticated Teams routing; use handleWebhook or trusted replay. */
  override async handleInbound(_envelope: Envelope): Promise<void> {
    throw new Error(
      'Teams requires an authenticated Activity or a trusted persisted event.',
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.sendThreadMessage(
      chatId,
      this.inbound.getStore()?.target.threadId,
      text,
    );
  }

  protected override async sendThreadMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
    sourceLabel?: string,
  ): Promise<void> {
    const event = this.inbound.getStore();
    if (
      event &&
      (event.target.chatId !== chatId || event.target.threadId !== threadId)
    ) {
      throw new TeamsDeliveryError('known_failed');
    }
    const target =
      event?.target ??
      (await this.references.get(referenceKey({ chatId, threadId })));
    if (!target) throw new TeamsDeliveryError('known_failed');
    await this.deliver(
      target,
      this.formatAttributedText(text, sourceLabel),
      'system',
      event,
    );
  }

  protected override async onResponseComplete(
    chatId: string,
    text: string,
    sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ): Promise<void> {
    const messageId =
      segment?.messageId ?? this.getResponseMessageId(sessionId);
    const event = messageId ? this.activeEvents.get(messageId) : undefined;
    if (!event || event.target.chatId !== chatId)
      throw new TeamsDeliveryError('known_failed');
    await this.sendEventText(
      event,
      segment?.sourceLabel
        ? this.formatAttributedText(text, segment.sourceLabel)
        : text,
      'response',
    );
  }

  /** System guidance and recovered final text use the original accepted event's target. */
  async sendEventText(
    event: TeamsInboundEvent,
    text: string,
    kind: 'response' | 'system' = 'system',
    options: { startChunkIndex?: number } = {},
  ): Promise<void> {
    const snapshot = freeze(structuredClone(event));
    await this.deliver(
      snapshot.target,
      text,
      kind,
      snapshot,
      options.startChunkIndex,
    );
  }

  private async deliver(
    target: TeamsTarget,
    text: string,
    kind: 'response' | 'system',
    event?: TeamsInboundEvent,
    startChunkIndex = 0,
  ): Promise<void> {
    validateTarget(this.teamsConfig, target);
    const chunks = splitTeamsText(text);
    if (
      !Number.isInteger(startChunkIndex) ||
      startChunkIndex < 0 ||
      (startChunkIndex !== 0 && startChunkIndex >= chunks.length)
    ) {
      throw new TeamsDeliveryError('known_failed');
    }
    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (chunkIndex < startChunkIndex) continue;
      const context: TeamsSendContext = freeze({
        event,
        target,
        kind,
        text: chunk,
        fullText: text,
        chunkIndex,
        chunkCount: chunks.length,
      });
      let attempted = false;
      try {
        if (!this.connected) throw new Error('Teams channel is stopped.');
        let platformMessageId: string | undefined;
        await this.adapter.continueConversation(
          this.teamsConfig.appId,
          structuredClone(target.reference),
          async (turn) => {
            await this.teamsOptions.host?.beforeSend(context);
            if (!this.connected) throw new Error('Teams channel is stopped.');
            attempted = true;
            const receipt = await turn.sendActivity(
              Activity.fromObject({
                type: 'message',
                text: chunk,
                textFormat: 'plain',
                replyToId: target.threadId,
              }),
            );
            platformMessageId = receipt?.id;
          },
        );
        if (!platformMessageId)
          throw new Error('Teams did not return a message receipt.');
        await this.teamsOptions.host?.onSendReceipt({
          ...context,
          state: 'sent',
          platformMessageId,
        });
      } catch (cause) {
        const state = attempted ? 'unknown' : 'known_failed';
        try {
          await this.teamsOptions.host?.onSendReceipt({ ...context, state });
        } catch {
          throw new TeamsDeliveryError(state, { cause });
        }
        throw new TeamsDeliveryError(state, { cause });
      }
    }
  }
}
