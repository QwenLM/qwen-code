import { constants, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve, win32, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { isIP, type LookupFunction } from 'node:net';
import { lookup } from 'node:dns/promises';
import { WSClient, decryptFile } from '@wecom/aibot-node-sdk';
import { ChannelBase, sanitizeLogText } from '@qwen-code/channel-base';
import type {
  Attachment,
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

type WeComMediaType = 'image' | 'file' | 'voice' | 'video';

interface WeComConfig {
  botId: string;
  secret: string;
  wsUrl?: string;
}

interface WeComClientOptions {
  botId: string;
  secret: string;
  wsUrl?: string;
  logger?: WeComLogger;
}

interface WeComClient {
  connect(): unknown;
  disconnect(): void;
  on(event: string, handler: (payload: unknown) => void): void;
  off?(event: string, handler: (payload: unknown) => void): void;
  sendMessage(chatId: string, message: unknown): Promise<unknown>;
  uploadMedia(
    data: Buffer,
    options: { type: WeComMediaType; filename: string },
  ): Promise<unknown>;
  sendMediaMessage(
    chatId: string,
    mediaType: WeComMediaType,
    mediaId: string,
  ): Promise<unknown>;
}

interface WeComLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const ClientCtor = WSClient as unknown as new (
  options: WeComClientOptions,
) => WeComClient;

const MESSAGE_EVENTS = [
  'message.text',
  'message.image',
  'message.mixed',
  'message.voice',
  'message.file',
  'message.video',
] as const;

const SENSITIVE_ERROR_FIELDS = new Set([
  'secret',
  'aeskey',
  'token',
  'password',
  'authorization',
]);
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MARKDOWN_CHUNK_BYTES = 3800;
const AUTHENTICATION_TIMEOUT_MS = 30_000;
const KICK_RECONNECT_MAX_ATTEMPTS = 3;
const KICK_RECONNECT_MAX_RETRY_CYCLES = 3;
const KICK_RECONNECT_BASE_DELAY_MS = 1_000;
const KICK_RECONNECT_RESET_MS = 60_000;
const KICK_RECONNECT_RETRY_MS = 5 * 60 * 1000;
const KICK_RECONNECT_LONG_RETRY_MS = 15 * 60 * 1000;
const DISCONNECT_RECONNECT_FALLBACK_MS = 30_000;
const ACTIVITY_WATCHDOG_INTERVAL_MS = 60_000;
const ACTIVITY_STALE_MS = 5 * 60_000;

export class WeComChannel extends ChannelBase {
  private readonly wecom: WeComConfig;
  private client?: WeComClient;
  private readonly seenMessages = new Map<string, number>();
  private readonly inFlightMessages = new Set<string>();
  private readonly attachmentDirsByMessage = new Map<string, string[]>();
  private readonly attachmentMessageByDir = new Map<string, string>();
  private readonly attachmentDirsBySession = new Map<string, string[]>();
  private readonly attachmentDirsWithoutMessageByRoute = new Map<
    string,
    string[]
  >();
  private readonly bufferedAttachmentMessages = new Set<string>();
  private readonly coalescedAttachmentMessages = new Map<string, string[]>();
  private dedupTimer?: ReturnType<typeof setInterval>;
  private kickReconnectReset?: ReturnType<typeof setTimeout>;
  private kickReconnectRetry?: ReturnType<typeof setTimeout>;
  private disconnectReconnectFallback?: ReturnType<typeof setTimeout>;
  private activityWatchdog?: ReturnType<typeof setInterval>;
  private lastActivityAt = 0;
  private connecting?: Promise<void>;
  private connectingClient?: WeComClient;
  private authentication?: ReturnType<typeof waitForAuthentication>;
  private disconnectGeneration = 0;
  private clientHandlers?: {
    message: (payload: unknown) => void;
    error: (payload: unknown) => void;
    disconnected: (payload: unknown) => void;
    kicked: (payload: unknown) => void;
  };
  private reconnectingAfterKick = false;
  private pendingKickReconnect = false;
  private kickReconnectAttempts = 0;
  private kickReconnectRetryCycles = 0;

  constructor(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.wecom = parseWeComConfig(name, config);
  }

  async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;

    const connecting = this.openClient();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }

  private async openClient(): Promise<void> {
    const options: WeComClientOptions = {
      botId: this.wecom.botId,
      secret: this.wecom.secret,
      logger: createWeComLogger(this.name),
    };
    if (this.wecom.wsUrl) {
      options.wsUrl = this.wecom.wsUrl;
    }

    const client = new ClientCtor(options);
    let authenticated = false;
    const connectionGeneration = this.disconnectGeneration;
    const messageHandler = (payload: unknown) => {
      this.recordActivity();
      if (!authenticated) {
        process.stderr.write(
          `[WeCom:${this.name}] dropping message before authentication.\n`,
        );
        return;
      }
      this.clearDisconnectReconnectFallback();
      this.onMessage(payload, connectionGeneration).catch((err: unknown) => {
        const logMessageId = getLogMessageId(payload);
        process.stderr.write(
          `[WeCom:${this.name}] message handling failed for ${logMessageId}: ${sanitizeLogText(
            formatSdkError(err),
            200,
          )}\n`,
        );
      });
    };
    const errorHandler = (err: unknown) => {
      this.recordActivity();
      process.stderr.write(
        `[WeCom:${this.name}] SDK error: ${sanitizeLogText(formatSdkError(err), 200)}\n`,
      );
    };
    const disconnectedHandler = (reason: unknown) => {
      this.recordActivity();
      if (this.disconnectGeneration !== connectionGeneration) return;
      process.stderr.write(
        `[WeCom:${this.name}] WebSocket ${formatDisconnectReason(reason)}; waiting for SDK reconnect.\n`,
      );
      if (authenticated) {
        this.scheduleDisconnectReconnectFallback(
          reason,
          client,
          this.disconnectGeneration,
        );
      }
    };
    const kickedHandler = (reason: unknown) => {
      this.recordActivity();
      if (this.disconnectGeneration !== connectionGeneration) return;
      this.clearDisconnectReconnectFallback();
      this.startKickReconnect(reason);
    };
    const handlers = {
      message: messageHandler,
      error: errorHandler,
      disconnected: disconnectedHandler,
      kicked: kickedHandler,
    };
    for (const event of MESSAGE_EVENTS) {
      client.on(event, messageHandler);
    }
    client.on('error', errorHandler);
    client.on('disconnected', disconnectedHandler);
    client.on('event.disconnected_event', kickedHandler);
    this.clientHandlers = handlers;
    this.connectingClient = client;

    const authentication = waitForAuthentication(client);
    this.authentication = authentication;
    try {
      authentication.promise.catch(() => {});
      const connected = client.connect();
      const connectedPromise = isPromiseLike(connected)
        ? withTimeout(
            Promise.resolve(connected).then(() => {}),
            AUTHENTICATION_TIMEOUT_MS,
            'WeCom SDK connect timed out.',
          )
        : Promise.resolve();
      await Promise.all([connectedPromise, authentication.promise]);
      authenticated = true;
      if (this.connectingClient !== client) {
        throw new Error('WeCom connection was replaced before authentication.');
      }
      this.client = client;
      this.connectingClient = undefined;
      this.authentication = undefined;
      this.recordActivity();
      this.startActivityWatchdog(connectionGeneration);
    } catch (err) {
      authentication.cancel();
      try {
        this.detachClientHandlers(client, handlers);
      } catch {
        // cleanup must not mask the original connection error
      }
      if (this.connectingClient === client) this.connectingClient = undefined;
      if (this.authentication === authentication)
        this.authentication = undefined;
      try {
        client.disconnect();
      } catch {
        // cleanup must not mask the original connection error
      }
      throw err;
    }
    if (!this.dedupTimer) {
      this.dedupTimer = setInterval(() => this.cleanupSeenMessages(), 60_000);
      this.dedupTimer.unref?.();
    }
    process.stderr.write(`[WeCom:${this.name}] Connected via smart bot.\n`);
  }

  disconnect(): void {
    this.disconnectGeneration += 1;
    this.kickReconnectAttempts = 0;
    this.kickReconnectRetryCycles = 0;
    this.pendingKickReconnect = false;
    if (this.kickReconnectReset) {
      clearTimeout(this.kickReconnectReset);
      this.kickReconnectReset = undefined;
    }
    if (this.kickReconnectRetry) {
      clearTimeout(this.kickReconnectRetry);
      this.kickReconnectRetry = undefined;
    }
    this.clearDisconnectReconnectFallback();
    this.clearActivityWatchdog();
    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
      this.dedupTimer = undefined;
    }
    this.seenMessages.clear();
    this.inFlightMessages.clear();
    this.cleanupAllAttachmentDirs();
    this.disconnectClientOnly(new Error('WeCom channel disconnected.'));
    process.stderr.write(`[WeCom:${this.name}] Disconnected.\n`);
  }

  override supportsProactiveSend(): boolean {
    return true;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const client = this.client;
    if (!client) {
      throw new Error(
        `[WeCom:${this.name}] No active SDK client, cannot send.`,
      );
    }

    const { cleanedText, media } = parseOutboundMediaMarkers(text);
    const chunks = splitMarkdownChunks(cleanedText);
    if (chunks.length === 0 && media.length === 0) {
      process.stderr.write(
        `[WeCom:${this.name}] sendMessage produced empty payload for chatId=${sanitizeLogText(
          chatId,
          100,
        )}.\n`,
      );
      return;
    }

    for (const chunk of chunks) {
      await client.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content: chunk },
      });
    }

    const mediaErrors: string[] = [];
    for (const item of media) {
      if (item.type !== 'image') {
        process.stderr.write(
          `[WeCom:${this.name}] skipping unsupported outbound media marker: ${item.type}\n`,
        );
        continue;
      }
      try {
        const file = await readOutboundMedia(item.path, this.config.cwd);
        const upload = await client.uploadMedia(file.data, {
          type: item.type,
          filename: file.fileName,
        });
        const mediaId = extractMediaId(upload);
        if (!mediaId) {
          mediaErrors.push(`upload returned no media_id for ${item.type}`);
          process.stderr.write(
            `[WeCom:${this.name}] upload returned no media_id, skipping.\n`,
          );
          continue;
        }
        await client.sendMediaMessage(chatId, item.type, mediaId);
      } catch (err) {
        const message = sanitizeLogText(formatSdkError(err), 200);
        mediaErrors.push(`${item.type}: ${message}`);
        process.stderr.write(
          `[WeCom:${this.name}] media send failed for ${item.type}: ${message}\n`,
        );
      }
    }
    if (mediaErrors.length > 0) {
      const message = `[WeCom:${this.name}] ${mediaErrors.length} media send(s) failed (markdown text may already be delivered): ${mediaErrors.join('; ')}`;
      process.stderr.write(`${message}\n`);
    }
  }

  private async onMessage(
    payload: unknown,
    connectionGeneration: number,
  ): Promise<void> {
    const body = extractBody(payload);
    if (!body) {
      process.stderr.write(
        `[WeCom:${this.name}] dropping message with unrecognized payload structure.\n`,
      );
      return;
    }
    this.logDebugPayload('WeCom', body);

    const rawMessageId = getString(body, 'msgid') || undefined;
    const messageId = rawMessageId ?? `synthetic-${randomUUID()}`;
    const logMessageId = sanitizeLogText(rawMessageId || '(no id)', 100);

    const from = getRecord(body, 'from');
    const senderId = getString(from, 'userid') || '';
    const senderName = getString(from, 'name') || senderId || 'Unknown';
    const isGroup = getString(body, 'chattype') === 'group';
    const rawChatId = getString(body, 'chatid');
    const chatId = isGroup ? rawChatId : rawChatId || senderId;
    if (!chatId || !senderId) {
      process.stderr.write(
        `[WeCom:${this.name}] dropping message ${logMessageId}: missing ${
          !senderId ? 'senderId' : 'chatId'
        }.\n`,
      );
      return;
    }
    if (rawMessageId) {
      if (this.inFlightMessages.has(rawMessageId)) {
        process.stderr.write(
          `[WeCom:${this.name}] dropping duplicate message ${logMessageId} (already in flight).\n`,
        );
        return;
      }
      if (this.seenMessages.has(rawMessageId)) {
        process.stderr.write(
          `[WeCom:${this.name}] dropping duplicate message ${logMessageId} (already seen).\n`,
        );
        return;
      }
      this.inFlightMessages.add(rawMessageId);
    }

    const text = extractText(body);
    const quote = getRecord(body, 'quote');
    const envelope: Envelope = {
      channelName: this.name,
      senderId,
      senderName,
      chatId,
      text,
      messageId: rawMessageId ?? messageId,
      isGroup,
      isMentioned: true,
      isReplyToBot:
        getString(getRecord(quote, 'from'), 'userid') === this.wecom.botId,
      referencedText: extractQuoteText(quote),
    };
    let attachments: Attachment[] = [];
    const attachmentRouteKey = this.attachmentRouteKey(
      senderId,
      chatId,
      envelope.threadId,
    );
    let processStarted = false;
    try {
      if (!(await this.preflightInbound(envelope))) {
        process.stderr.write(
          `[WeCom:${this.name}] dropping message ${logMessageId}: preflight rejected.\n`,
        );
        return;
      }
      attachments = await this.downloadAttachments(
        body,
        attachments,
        messageId,
        attachmentRouteKey,
        connectionGeneration,
      );
      if (this.disconnectGeneration !== connectionGeneration) {
        process.stderr.write(
          `[WeCom:${this.name}] dropping message ${logMessageId}: connection changed during attachment download.\n`,
        );
        return;
      }
      if (attachments.length) {
        envelope.attachments = attachments;
      }
      if (!envelope.text && attachments.length) {
        envelope.text = attachments.some((a) => a.type === 'image')
          ? '(image)'
          : `(file: ${attachments[0]?.fileName ?? 'file'})`;
      }
      if (rawMessageId) this.seenMessages.set(rawMessageId, Date.now());
      processStarted = true;
      await this.processInbound(envelope);
    } catch (err) {
      if (rawMessageId && !processStarted) {
        this.seenMessages.delete(rawMessageId);
      } else if (rawMessageId) {
        process.stderr.write(
          `[WeCom:${this.name}] message ${logMessageId} failed after processing started; dedup entry retained.\n`,
        );
      }
      throw err;
    } finally {
      if (rawMessageId) this.inFlightMessages.delete(rawMessageId);
      if (
        messageId &&
        !this.bufferedAttachmentMessages.has(messageId) &&
        this.attachmentDirsByMessage.has(messageId)
      ) {
        this.cleanupAttachmentDirsForMessage(messageId);
      }
    }
  }

  private async downloadAttachments(
    body: Record<string, unknown>,
    attachments: Attachment[] = [],
    messageId?: string,
    routeKey?: string,
    connectionGeneration = this.disconnectGeneration,
  ): Promise<Attachment[]> {
    const refs = collectInboundMediaRefs(body);
    for (const ref of refs) {
      if (this.disconnectGeneration !== connectionGeneration)
        return attachments;
      let downloaded: { buffer: Buffer; filename?: string };
      try {
        downloaded = await downloadInboundMedia(ref);
      } catch (err) {
        process.stderr.write(
          `[WeCom:${this.name}] skipping ${ref.type} attachment: ${sanitizeLogText(
            err instanceof Error ? err.message : String(err),
            160,
          )}.\n`,
        );
        continue;
      }
      if (this.disconnectGeneration !== connectionGeneration)
        return attachments;
      const data = downloaded.buffer;
      const fileName = sanitizeFileName(ref.fileName || downloaded.filename);
      if (ref.type === 'image') {
        attachments.push({
          type: 'image',
          data: data.toString('base64'),
          mimeType: detectImageMime(data),
          fileName,
        });
      } else {
        const dir = join(tmpdir(), 'channel-files', randomUUID());
        const safeName = fileName || `wecom_${ref.type}`;
        const filePath = join(dir, safeName);
        try {
          if (this.disconnectGeneration !== connectionGeneration) {
            return attachments;
          }
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          await writeFile(filePath, data, { mode: 0o600 });
          if (this.disconnectGeneration !== connectionGeneration) {
            cleanupAttachmentDirs([dir]);
            return attachments;
          }
          this.rememberAttachmentDir(dir, messageId, routeKey);
        } catch (err) {
          cleanupAttachmentDirs([dir]);
          process.stderr.write(
            `[WeCom:${this.name}] skipping ${ref.type} attachment: ${sanitizeLogText(
              err instanceof Error ? err.message : String(err),
              160,
            )}.\n`,
          );
          continue;
        }
        attachments.push({
          type: ref.type === 'voice' ? 'audio' : ref.type,
          filePath,
          mimeType: mediaTypeToMime(ref.type),
          fileName: safeName,
        });
      }
    }
    return attachments;
  }

  protected override onPromptBuffered(
    _chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    if (!messageId) {
      this.rememberUntrackedDirsForSession(sessionId);
      return;
    }
    this.bufferedAttachmentMessages.add(messageId);
    this.rememberMessageDirsForSession(messageId, sessionId);
  }

  protected override onPromptStart(
    _chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    if (messageId) {
      this.rememberMessageDirsForSession(messageId, sessionId);
    } else {
      this.rememberUntrackedDirsForSession(sessionId);
    }
  }

  protected override onPromptBufferDrained(
    _chatId: string,
    _sessionId: string,
    messageIds: string[],
  ): void {
    const lastMessageId = messageIds.at(-1);
    if (lastMessageId) {
      this.coalescedAttachmentMessages.set(lastMessageId, messageIds);
    }
  }

  protected override onPromptBufferDropped(
    _chatId: string,
    sessionId: string,
    messageIds: string[],
  ): void {
    for (const messageId of messageIds) {
      this.cleanupAttachmentDirsForMessage(messageId);
    }
    this.cleanupUntrackedAttachmentDirsForSession(sessionId);
  }

  protected override onPromptEnd(
    _chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    if (!messageId) {
      this.cleanupAttachmentDirsForSession(sessionId);
      return;
    }
    const coalescedMessageIds = this.coalescedAttachmentMessages.get(messageId);
    if (coalescedMessageIds) {
      this.coalescedAttachmentMessages.delete(messageId);
      for (const coalescedMessageId of coalescedMessageIds) {
        this.cleanupAttachmentDirsForMessage(coalescedMessageId);
      }
      this.cleanupUntrackedAttachmentDirsForSession(sessionId);
      return;
    }
    this.cleanupAttachmentDirsForMessage(messageId);
  }

  private rememberAttachmentDir(
    dir: string,
    messageId?: string,
    routeKey?: string,
  ): void {
    if (messageId) {
      const messageDirs = this.attachmentDirsByMessage.get(messageId) ?? [];
      messageDirs.push(dir);
      this.attachmentDirsByMessage.set(messageId, messageDirs);
      this.attachmentMessageByDir.set(dir, messageId);
    } else if (routeKey) {
      const dirs = this.attachmentDirsWithoutMessageByRoute.get(routeKey) ?? [];
      dirs.push(dir);
      this.attachmentDirsWithoutMessageByRoute.set(routeKey, dirs);
    }
  }

  private rememberMessageDirsForSession(
    messageId: string,
    sessionId: string,
  ): void {
    const dirs = this.attachmentDirsByMessage.get(messageId);
    if (!dirs) return;
    const sessionDirs = this.attachmentDirsBySession.get(sessionId) ?? [];
    for (const dir of dirs) {
      if (!sessionDirs.includes(dir)) sessionDirs.push(dir);
    }
    this.attachmentDirsBySession.set(sessionId, sessionDirs);
  }

  private cleanupAttachmentDirsForMessage(messageId: string): void {
    this.bufferedAttachmentMessages.delete(messageId);
    const dirs = this.attachmentDirsByMessage.get(messageId);
    if (!dirs) return;
    this.attachmentDirsByMessage.delete(messageId);
    for (const dir of dirs) {
      this.attachmentMessageByDir.delete(dir);
    }
    this.removeAttachmentDirsFromSessions(dirs);
    cleanupAttachmentDirs(dirs);
  }

  private cleanupAttachmentDirsForSession(sessionId: string): void {
    const dirs = this.attachmentDirsBySession.get(sessionId);
    if (!dirs) return;
    this.attachmentDirsBySession.delete(sessionId);
    this.removeAttachmentDirsFromMessages(dirs);
    for (const dir of dirs) {
      this.attachmentMessageByDir.delete(dir);
    }
    cleanupAttachmentDirs(dirs);
  }

  private cleanupUntrackedAttachmentDirsForSession(sessionId: string): void {
    const dirs = this.attachmentDirsBySession.get(sessionId);
    if (!dirs) return;
    const untrackedDirs = dirs.filter(
      (dir) => !this.attachmentMessageByDir.has(dir),
    );
    if (untrackedDirs.length === 0) return;
    const remainingDirs = dirs.filter((dir) =>
      this.attachmentMessageByDir.has(dir),
    );
    if (remainingDirs.length > 0) {
      this.attachmentDirsBySession.set(sessionId, remainingDirs);
    } else {
      this.attachmentDirsBySession.delete(sessionId);
    }
    cleanupAttachmentDirs(untrackedDirs);
  }

  private rememberUntrackedDirsForSession(sessionId: string): void {
    const routeKey = this.attachmentRouteKeyForSession(sessionId);
    if (!routeKey) return;
    const dirs = this.attachmentDirsWithoutMessageByRoute.get(routeKey);
    if (!dirs || dirs.length === 0) return;
    const sessionDirs = this.attachmentDirsBySession.get(sessionId) ?? [];
    for (const dir of dirs) {
      if (!sessionDirs.includes(dir)) sessionDirs.push(dir);
    }
    this.attachmentDirsBySession.set(sessionId, sessionDirs);
    this.attachmentDirsWithoutMessageByRoute.delete(routeKey);
  }

  private removeAttachmentDirsFromSessions(dirs: string[]): void {
    const removed = new Set(dirs);
    for (const [sessionId, sessionDirs] of this.attachmentDirsBySession) {
      const remaining = sessionDirs.filter((dir) => !removed.has(dir));
      if (remaining.length) {
        this.attachmentDirsBySession.set(sessionId, remaining);
      } else {
        this.attachmentDirsBySession.delete(sessionId);
      }
    }
  }

  private removeAttachmentDirsFromMessages(dirs: string[]): void {
    const removed = new Set(dirs);
    for (const [messageId, messageDirs] of this.attachmentDirsByMessage) {
      const remaining = messageDirs.filter((dir) => !removed.has(dir));
      if (remaining.length) {
        this.attachmentDirsByMessage.set(messageId, remaining);
      } else {
        this.attachmentDirsByMessage.delete(messageId);
        this.bufferedAttachmentMessages.delete(messageId);
      }
    }
    for (const dir of dirs) {
      this.attachmentMessageByDir.delete(dir);
    }
  }

  private cleanupAllAttachmentDirs(): void {
    const dirs = Array.from(
      new Set([
        ...Array.from(this.attachmentDirsBySession.values()).flat(),
        ...Array.from(this.attachmentDirsByMessage.values()).flat(),
        ...Array.from(this.attachmentDirsWithoutMessageByRoute.values()).flat(),
      ]),
    );
    this.attachmentDirsBySession.clear();
    this.attachmentDirsByMessage.clear();
    this.attachmentMessageByDir.clear();
    this.attachmentDirsWithoutMessageByRoute.clear();
    this.bufferedAttachmentMessages.clear();
    this.coalescedAttachmentMessages.clear();
    cleanupAttachmentDirs(dirs);
  }

  private attachmentRouteKeyForSession(sessionId: string): string | undefined {
    const target = this.router.getTarget(sessionId);
    if (!target || target.channelName !== this.name) return undefined;
    return this.attachmentRouteKey(
      target.senderId,
      target.chatId,
      target.threadId,
    );
  }

  private attachmentRouteKey(
    senderId: string,
    chatId: string,
    threadId?: string,
  ): string {
    switch (this.config.sessionScope) {
      case 'thread':
        return `${this.name}:${threadId || chatId}`;
      case 'single':
        return `${this.name}:__single__`;
      case 'user':
      default:
        return `${this.name}:${senderId}:${chatId}`;
    }
  }

  private detachClientHandlers(
    client: WeComClient,
    handlers = this.clientHandlers,
  ): void {
    if (!handlers) return;
    for (const event of MESSAGE_EVENTS) {
      client.off?.(event, handlers.message);
    }
    client.off?.('error', handlers.error);
    client.off?.('disconnected', handlers.disconnected);
    client.off?.('event.disconnected_event', handlers.kicked);
    if (this.clientHandlers === handlers) this.clientHandlers = undefined;
  }

  private disconnectClientOnly(err: Error): void {
    const client = this.client ?? this.connectingClient;
    this.authentication?.cancel(err);
    this.authentication = undefined;
    this.client = undefined;
    this.connectingClient = undefined;
    this.clearActivityWatchdog();
    if (client) this.detachClientHandlers(client);
    try {
      client?.disconnect();
    } catch (e) {
      process.stderr.write(
        `[WeCom:${this.name}] client.disconnect() threw: ${sanitizeLogText(
          formatSdkError(e),
          200,
        )}\n`,
      );
    }
  }

  private clearDisconnectReconnectFallback(): void {
    if (!this.disconnectReconnectFallback) return;
    clearTimeout(this.disconnectReconnectFallback);
    this.disconnectReconnectFallback = undefined;
  }

  private recordActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private clearActivityWatchdog(): void {
    if (!this.activityWatchdog) return;
    clearInterval(this.activityWatchdog);
    this.activityWatchdog = undefined;
  }

  private startActivityWatchdog(disconnectGeneration: number): void {
    this.clearActivityWatchdog();
    this.activityWatchdog = setInterval(() => {
      if (this.disconnectGeneration !== disconnectGeneration) return;
      if (!this.client || this.reconnectingAfterKick) return;
      if (Date.now() - this.lastActivityAt < ACTIVITY_STALE_MS) return;

      process.stderr.write(
        `[WeCom:${this.name}] no SDK activity for ${ACTIVITY_STALE_MS / 60_000} minutes; reconnecting adapter.\n`,
      );
      this.kickReconnectAttempts = 0;
      this.kickReconnectRetryCycles = 0;
      this.startKickReconnect(
        new Error('WeCom SDK activity watchdog timed out.'),
        'activity watchdog',
      );
    }, ACTIVITY_WATCHDOG_INTERVAL_MS);
    this.activityWatchdog.unref?.();
  }

  private scheduleDisconnectReconnectFallback(
    reason: unknown,
    client: WeComClient,
    disconnectGeneration: number,
  ): void {
    this.clearDisconnectReconnectFallback();
    const formattedReason = formatDisconnectReason(reason);
    this.disconnectReconnectFallback = setTimeout(() => {
      this.disconnectReconnectFallback = undefined;
      if (this.disconnectGeneration !== disconnectGeneration) return;
      if (this.client !== client) return;
      process.stderr.write(
        `[WeCom:${this.name}] SDK reconnect did not recover after WebSocket ${formattedReason}; reconnecting adapter.\n`,
      );
      this.kickReconnectAttempts = 0;
      this.kickReconnectRetryCycles = 0;
      this.startKickReconnect(reason, 'SDK disconnect');
    }, DISCONNECT_RECONNECT_FALLBACK_MS);
    this.disconnectReconnectFallback.unref?.();
  }

  private async reconnectAfterKick(
    reason: unknown,
    reconnectReason = 'server kick',
  ): Promise<void> {
    if (this.reconnectingAfterKick) {
      this.pendingKickReconnect = true;
      return;
    }
    if (this.kickReconnectRetry) {
      clearTimeout(this.kickReconnectRetry);
      this.kickReconnectRetry = undefined;
      this.kickReconnectAttempts = 0;
    }
    if (this.kickReconnectReset) {
      clearTimeout(this.kickReconnectReset);
      this.kickReconnectReset = undefined;
    }
    this.reconnectingAfterKick = true;
    const previousConnecting = this.connecting;
    const disconnectGeneration = this.disconnectGeneration;
    process.stderr.write(
      `[WeCom:${this.name}] WebSocket ${formatDisconnectReason(reason)}; reconnecting after ${reconnectReason}.\n`,
    );
    try {
      this.disconnectClientOnly(
        new Error(
          `WeCom connection was kicked: ${formatDisconnectReason(reason)}`,
        ),
      );
      if (previousConnecting) {
        await previousConnecting.catch(() => {});
      }
      while (this.kickReconnectAttempts < KICK_RECONNECT_MAX_ATTEMPTS) {
        const attempt = ++this.kickReconnectAttempts;
        await delay(
          KICK_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
        );
        if (this.disconnectGeneration !== disconnectGeneration) {
          process.stderr.write(
            `[WeCom:${this.name}] reconnect after ${reconnectReason} abandoned: connection generation changed.\n`,
          );
          return;
        }
        try {
          await this.connect();
          if (this.disconnectGeneration !== disconnectGeneration) {
            process.stderr.write(
              `[WeCom:${this.name}] reconnect after ${reconnectReason} abandoned: connection generation changed.\n`,
            );
            return;
          }
          this.kickReconnectAttempts = 0;
          this.kickReconnectRetryCycles = 0;
          this.scheduleKickReconnectReset();
          process.stderr.write(
            `[WeCom:${this.name}] reconnected after ${reconnectReason}.\n`,
          );
          return;
        } catch (err) {
          process.stderr.write(
            `[WeCom:${this.name}] reconnect after ${reconnectReason} attempt ${attempt} failed: ${sanitizeLogText(
              formatSdkError(err),
              200,
            )}\n`,
          );
        }
      }
      this.kickReconnectRetryCycles += 1;
      if (this.kickReconnectRetryCycles >= KICK_RECONNECT_MAX_RETRY_CYCLES) {
        process.stderr.write(
          `[WeCom:${this.name}] reconnect after ${reconnectReason} exhausted ${this.kickReconnectRetryCycles} retry cycles; next attempt in ${KICK_RECONNECT_LONG_RETRY_MS / 60_000} minutes.\n`,
        );
        this.scheduleKickReconnectRetry(
          reason,
          disconnectGeneration,
          KICK_RECONNECT_LONG_RETRY_MS,
          reconnectReason,
          true,
        );
        return;
      }
      process.stderr.write(
        `[WeCom:${this.name}] reconnect after ${reconnectReason} gave up after ${KICK_RECONNECT_MAX_ATTEMPTS} attempts; retrying later.\n`,
      );
      this.scheduleKickReconnectRetry(
        reason,
        disconnectGeneration,
        KICK_RECONNECT_RETRY_MS,
        reconnectReason,
      );
    } finally {
      this.reconnectingAfterKick = false;
      const shouldRetryPendingKick =
        this.pendingKickReconnect &&
        this.disconnectGeneration === disconnectGeneration;
      this.pendingKickReconnect = false;
      if (shouldRetryPendingKick && !this.client) {
        this.kickReconnectAttempts = 0;
        this.startKickReconnect(reason, reconnectReason);
      }
    }
  }

  private scheduleKickReconnectReset(): void {
    if (this.kickReconnectRetry) {
      clearTimeout(this.kickReconnectRetry);
      this.kickReconnectRetry = undefined;
    }
    if (this.kickReconnectReset) clearTimeout(this.kickReconnectReset);
    this.kickReconnectReset = setTimeout(() => {
      this.kickReconnectAttempts = 0;
      this.kickReconnectRetryCycles = 0;
      this.kickReconnectReset = undefined;
    }, KICK_RECONNECT_RESET_MS);
    this.kickReconnectReset.unref?.();
  }

  private scheduleKickReconnectRetry(
    reason: unknown,
    disconnectGeneration: number,
    delayMs = KICK_RECONNECT_RETRY_MS,
    reconnectReason = 'server kick',
    resetRetryCycles = false,
  ): void {
    this.kickReconnectRetry = setTimeout(() => {
      this.kickReconnectRetry = undefined;
      if (this.disconnectGeneration !== disconnectGeneration) {
        process.stderr.write(
          `[WeCom:${this.name}] scheduled kick-reconnect cancelled; connection generation changed.\n`,
        );
        return;
      }
      this.kickReconnectAttempts = 0;
      if (resetRetryCycles) this.kickReconnectRetryCycles = 0;
      this.startKickReconnect(reason, reconnectReason);
    }, delayMs);
    this.kickReconnectRetry.unref?.();
  }

  private startKickReconnect(
    reason: unknown,
    reconnectReason = 'server kick',
  ): void {
    void this.reconnectAfterKick(reason, reconnectReason).catch(
      (err: unknown) => {
        process.stderr.write(
          `[WeCom:${this.name}] kick-reconnect failed: ${sanitizeLogText(
            formatSdkError(err),
            200,
          )}\n`,
        );
        if (this.kickReconnectRetry === undefined) {
          this.scheduleKickReconnectRetry(
            reason,
            this.disconnectGeneration,
            KICK_RECONNECT_LONG_RETRY_MS,
            reconnectReason,
            true,
          );
        }
      },
    );
  }

  private cleanupSeenMessages(): void {
    const now = Date.now();
    for (const [id, ts] of this.seenMessages) {
      if (now - ts > DEDUP_TTL_MS) {
        this.seenMessages.delete(id);
      }
    }
  }
}

function waitForAuthentication(client: WeComClient): {
  promise: Promise<void>;
  cancel(err?: Error): void;
} {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let finish: (err?: Error) => void = () => {};
  const onAuth = () => finish();
  const onError = (err: unknown) =>
    finish(
      new Error(
        `WeCom authentication failed: ${sanitizeLogText(String(err), 200)}`,
      ),
    );
  const onKicked = (reason: unknown) =>
    finish(
      new Error(
        `WeCom authentication interrupted by server kick: ${formatDisconnectReason(
          reason,
        )}`,
      ),
    );

  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      client.off?.('authenticated', onAuth);
      client.off?.('error', onError);
      client.off?.('event.disconnected_event', onKicked);
      if (err) {
        rejectPromise(err);
      } else {
        resolvePromise();
      }
    };

    timeout = setTimeout(() => {
      finish(new Error('WeCom authentication timed out.'));
    }, AUTHENTICATION_TIMEOUT_MS);
    timeout.unref?.();

    client.on('authenticated', onAuth);
    client.on('error', onError);
    client.on('event.disconnected_event', onKicked);
  });
  return {
    promise,
    cancel: (err?: Error) => finish(err),
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    timeout = setTimeout(() => {
      rejectPromise(new Error(message));
    }, timeoutMs);
    timeout.unref?.();
    promise.then(
      (value) => {
        if (timeout) clearTimeout(timeout);
        resolvePromise(value);
      },
      (err: unknown) => {
        if (timeout) clearTimeout(timeout);
        rejectPromise(err);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

function cleanupAttachmentDirs(dirs: string[]): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(
        `[WeCom] failed to remove attachment dir ${sanitizeLogText(
          dir,
          200,
        )}: ${sanitizeLogText(formatSdkError(err), 200)}.\n`,
      );
    }
  }
}

function formatDisconnectReason(reason: unknown): string {
  const text =
    typeof reason === 'string' && reason ? reason : formatSdkError(reason);
  return sanitizeLogText(text, 120);
}

function formatSdkError(err: unknown): string {
  if (err instanceof Error) return err.message;
  const record = asRecord(err);
  if (record) {
    const errcode = record['errcode'];
    const errmsg = record['errmsg'];
    if (typeof errcode === 'number' || typeof errmsg === 'string') {
      return redactSensitiveErrorText(
        `errcode=${String(errcode)} errmsg=${String(errmsg)}`,
      );
    }
    const code = record['code'];
    const reason = record['reason'];
    const wasClean = record['wasClean'];
    if (
      typeof code === 'number' ||
      typeof reason === 'string' ||
      typeof wasClean === 'boolean'
    ) {
      return [
        typeof code === 'number' ? `code=${code}` : undefined,
        typeof reason === 'string'
          ? `reason=${redactSensitiveErrorText(reason)}`
          : undefined,
        typeof wasClean === 'boolean' ? `wasClean=${wasClean}` : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' ');
    }
    try {
      return JSON.stringify(record, (key, value) =>
        SENSITIVE_ERROR_FIELDS.has(key.toLowerCase()) ? '[REDACTED]' : value,
      );
    } catch {
      // Fall through to String below.
    }
  }
  return String(err);
}

function redactSensitiveErrorText(text: string): string {
  return text.replace(
    /(["']?(?:secret|aeskey|token|password|authorization)["']?\s*[:=]\s*)(["']?)[^"',\s}]+(\2)/giu,
    '$1$2[REDACTED]$3',
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function parseWeComConfig(
  name: string,
  config: ChannelConfig & Record<string, unknown>,
): WeComConfig {
  const botId = readRequiredString(config, 'botId');
  const secret = readRequiredString(config, 'secret');
  if (!botId || !secret) {
    throw new Error(`Channel "${name}" requires botId and secret for WeCom.`);
  }
  const wsUrl = readOptionalString(config, 'wsUrl');
  if (wsUrl && !isSecureWebSocketUrl(wsUrl)) {
    throw new Error(`Channel "${name}" requires wsUrl to use wss://.`);
  }
  return wsUrl ? { botId, secret, wsUrl } : { botId, secret };
}

function readRequiredString(
  config: Record<string, unknown>,
  key: string,
): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isSecureWebSocketUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'wss:';
  } catch {
    return false;
  }
}

function createWeComLogger(name: string): WeComLogger {
  const write = (level: 'warn' | 'error', message: string): void => {
    process.stderr.write(
      `[WeCom:${name}] SDK ${level}: ${sanitizeLogText(message, 200)}\n`,
    );
  };
  return {
    debug: () => {},
    info: () => {},
    warn: (message: string) => write('warn', message),
    error: (message: string) => write('error', message),
  };
}

function extractBody(payload: unknown): Record<string, unknown> | undefined {
  const raw = asRecord(payload);
  if (!raw) return undefined;
  return getRecord(raw, 'body') ?? raw;
}

function getLogMessageId(payload: unknown): string {
  const body = extractBody(payload);
  if (!body) return '(unknown id)';
  return sanitizeLogText(getString(body, 'msgid') || '(no id)', 100);
}

function extractText(body: Record<string, unknown>): string {
  const msgType = getString(body, 'msgtype');
  if (msgType === 'mixed') {
    const mixed = getRecord(body, 'mixed');
    const items = getArray(mixed, 'msg_item');
    return items
      .map((item) => {
        const record = asRecord(item);
        if (!record) return '';
        const itemType = getString(record, 'msgtype');
        if (itemType === 'text') {
          return getString(getRecord(record, 'text'), 'content');
        }
        if (itemType === 'voice') {
          return getString(getRecord(record, 'voice'), 'content');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  const text = getString(getRecord(body, 'text'), 'content');
  const voiceText = getString(getRecord(body, 'voice'), 'content');
  if (text) return text;
  if (voiceText) return voiceText;
  if (msgType === 'image') return '(image)';
  if (msgType === 'voice') return '(voice)';
  if (msgType === 'video') return '(video)';
  if (msgType === 'file') {
    const name = sanitizeFileName(
      getString(getRecord(body, 'file'), 'filename'),
    );
    return `(file: ${name || 'file'})`;
  }
  return '';
}

function extractQuoteText(
  quote: Record<string, unknown> | undefined,
): string | undefined {
  if (!quote) return undefined;
  return extractText(quote) || undefined;
}

interface InboundMediaRef {
  type: WeComMediaType;
  url: string;
  aesKey?: string;
  fileName?: string;
}

function collectInboundMediaRefs(
  body: Record<string, unknown>,
  depth = 0,
  seenUrls = new Set<string>(),
): InboundMediaRef[] {
  if (depth > 3) return [];

  const refs: InboundMediaRef[] = [];
  const add = (type: WeComMediaType, source: Record<string, unknown>): void => {
    const url = getString(source, 'url');
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    refs.push({
      type,
      url,
      aesKey: getString(source, 'aeskey') || undefined,
      fileName:
        getString(source, 'filename') ||
        getString(source, 'file_name') ||
        undefined,
    });
  };

  const mixed = getRecord(body, 'mixed');
  for (const item of getArray(mixed, 'msg_item')) {
    const record = asRecord(item);
    if (!record) continue;
    const itemType = getString(record, 'msgtype');
    if (isWeComMediaType(itemType)) {
      add(itemType, getRecord(record, itemType) ?? {});
    }
  }

  add('image', getRecord(body, 'image') ?? {});
  add('file', getRecord(body, 'file') ?? {});
  add('video', getRecord(body, 'video') ?? {});
  add('voice', getRecord(body, 'voice') ?? {});

  const quote = getRecord(body, 'quote');
  if (quote) refs.push(...collectInboundMediaRefs(quote, depth + 1, seenUrls));

  return refs;
}

interface OutboundMediaMarker {
  type: WeComMediaType;
  path: string;
}

function parseOutboundMediaMarkers(text: string): {
  cleanedText: string;
  media: OutboundMediaMarker[];
} {
  const codeRanges = findCodeRanges(text);
  const markerRe = /\[(IMAGE):\s*([^\]]+)\]/gi;
  const media: OutboundMediaMarker[] = [];
  const rangesToRemove: Array<[number, number]> = [];

  for (const match of text.matchAll(markerRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (codeRanges.some(([from, to]) => start >= from && start < to)) continue;
    const path = match[2]?.trim();
    const rawType = match[1]?.toLowerCase();
    if (!path || !isWeComMediaType(rawType)) continue;
    media.push({ type: rawType, path });
    rangesToRemove.push([start, end]);
  }

  let cleanedText = text;
  for (const [start, end] of rangesToRemove.toReversed()) {
    cleanedText = `${cleanedText.slice(0, start)}${cleanedText.slice(end)}`;
  }
  return {
    cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n').trim(),
    media,
  };
}

function findCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fenceStart: number | undefined;
  let fenceToken: FenceToken | undefined;
  for (const match of text.matchAll(/```|~~~/g)) {
    const start = match.index ?? 0;
    const token = match[0] as FenceToken;
    if (fenceStart === undefined) {
      fenceStart = start;
      fenceToken = token;
    } else if (token === fenceToken) {
      ranges.push([fenceStart, start + 3]);
      fenceStart = undefined;
      fenceToken = undefined;
    }
  }
  if (fenceStart !== undefined) {
    ranges.push([fenceStart, text.length]);
  }

  for (const match of text.matchAll(/(`+)[^`\n]*\1/g)) {
    const start = match.index ?? 0;
    if (ranges.some(([from, to]) => start >= from && start < to)) continue;
    ranges.push([start, start + match[0].length]);
  }

  const lineRe = /^(?: {4,}|\t).*$/gm;
  for (const match of text.matchAll(lineRe)) {
    const start = match.index ?? 0;
    if (ranges.some(([from, to]) => start >= from && start < to)) continue;
    ranges.push([start, start + match[0].length]);
  }

  return ranges;
}

type FenceToken = '```' | '~~~';

function isWeComMediaType(value: string | undefined): value is WeComMediaType {
  return (
    value === 'image' ||
    value === 'file' ||
    value === 'voice' ||
    value === 'video'
  );
}

function splitMarkdownChunks(text: string): string[] {
  if (!text) return [];

  const chunks: string[] = [];
  let current = '';
  let codeFence: FenceToken | undefined;
  const fits = (value: string, nextCodeFence = codeFence): boolean =>
    Buffer.byteLength(
      nextCodeFence ? `${value}\n${nextCodeFence}` : value,
      'utf8',
    ) <= MARKDOWN_CHUNK_BYTES;
  const flush = (closeCode = true): void => {
    if (!current) return;
    chunks.push(closeCode && codeFence ? `${current}\n${codeFence}` : current);
    current = closeCode && codeFence ? codeFence : '';
  };

  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    const candidateCodeFence = toggleCodeFenceState(line, codeFence);
    if (fits(candidate, candidateCodeFence)) {
      current = candidate;
      codeFence = candidateCodeFence;
      continue;
    }

    flush();
    const retried = current ? `${current}\n${line}` : line;
    const retriedCodeFence = toggleCodeFenceState(line, codeFence);
    if (fits(retried, retriedCodeFence)) {
      current = retried;
      codeFence = retriedCodeFence;
      continue;
    }

    let needsLineBreak = Boolean(current);
    for (let index = 0; index < line.length; ) {
      const codePoint = line.codePointAt(index);
      const token = line.startsWith('```', index)
        ? '```'
        : line.startsWith('~~~', index)
          ? '~~~'
          : codePoint === undefined
            ? ''
            : String.fromCodePoint(codePoint);
      if (!token) break;
      const nextCodeFence =
        token === codeFence
          ? undefined
          : !codeFence && isFenceToken(token)
            ? token
            : codeFence;
      const addition = needsLineBreak && current ? `\n${token}` : token;
      const candidate = `${current}${addition}`;
      if (!fits(candidate, nextCodeFence)) {
        flush();
        current = current ? `${current}\n${token}` : token;
      } else {
        current = candidate;
      }
      codeFence = nextCodeFence;
      needsLineBreak = false;
      index += token.length;
    }
  }

  flush();
  return chunks;
}

function toggleCodeFenceState(
  line: string,
  codeFence: FenceToken | undefined,
): FenceToken | undefined {
  let nextCodeFence = codeFence;
  for (const match of line.matchAll(/```|~~~/g)) {
    const token = match[0] as FenceToken;
    if (nextCodeFence === token) {
      nextCodeFence = undefined;
    } else if (!nextCodeFence) {
      nextCodeFence = token;
    }
  }
  return nextCodeFence;
}

function isFenceToken(token: string): token is FenceToken {
  return token === '```' || token === '~~~';
}

async function readOutboundMedia(
  rawPath: string,
  cwd: string,
): Promise<{
  data: Buffer;
  fileName: string;
}> {
  const resolved = resolve(cwd, rawPath);
  const real = realpathSync(resolved);
  const allowedDirs = [
    ensureDirectoryRealpath(join(tmpdir(), 'channel-files')),
  ];
  if (!allowedDirs.some((dir) => isInsideDir(real, dir))) {
    throw new Error('Media path outside allowed outbound directory');
  }

  const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      throw new Error(`Not a regular file: ${basename(rawPath)}`);
    if (stat.size > MAX_MEDIA_BYTES) {
      throw new Error(`Media file too large: ${stat.size} bytes`);
    }
    return { data: await file.readFile(), fileName: basename(real) };
  } finally {
    await file.close();
  }
}

function ensureDirectoryRealpath(path: string): string {
  try {
    mkdirSync(path, { recursive: true });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('not a safe directory');
    }
    return realpathSync(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot prepare outbound media directory ${path}: ${reason}`,
    );
  }
}

function isInsideDir(filePath: string, dir: string): boolean {
  const windowsStyle = /^[a-zA-Z]:[\\/]/.test(filePath);
  const pathImpl = windowsStyle ? win32 : posix;
  const relative = pathImpl.relative(dir, filePath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !pathImpl.isAbsolute(relative))
  );
}

type SafeInboundMediaUrlResult =
  | { safe: true }
  | { safe: false; reason: string };

async function isSafeInboundMediaUrl(
  rawUrl: string,
): Promise<SafeInboundMediaUrlResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'https:') {
    return { safe: false, reason: 'non-HTTPS protocol' };
  }
  if (url.username || url.password) {
    return { safe: false, reason: 'URL contains embedded credentials' };
  }

  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    return { safe: false, reason: 'local hostname' };
  }
  if (host.endsWith('.local')) {
    return { safe: false, reason: 'local hostname' };
  }

  if (isIP(host)) {
    return isPublicIpAddress(host)
      ? { safe: true }
      : { safe: false, reason: `private address ${host}` };
  }
  if (!host.includes('.')) return { safe: false, reason: 'bare hostname' };
  try {
    const records = await lookup(host, { all: true });
    if (records.length === 0) {
      return { safe: false, reason: 'no DNS records' };
    }
    const privateRecord = records.find(
      (record) => !isPublicIpAddress(record.address),
    );
    return privateRecord
      ? {
          safe: false,
          reason: `${host} resolved to private address ${privateRecord.address}`,
        }
      : { safe: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { safe: false, reason: `DNS lookup failed for ${host}: ${message}` };
  }
}

async function downloadInboundMedia(
  ref: InboundMediaRef,
): Promise<{ buffer: Buffer; filename?: string }> {
  const urlSafety = await isSafeInboundMediaUrl(ref.url);
  if (!urlSafety.safe) {
    throw new Error(`unsafe media URL (${urlSafety.reason})`);
  }
  // Intentionally bypass WSClient.downloadFile(): its axios path follows
  // redirects, lacks a byte cap, and does not pin resolved public IPs.
  const downloaded = await guardedHttpsDownload(ref.url);
  return {
    buffer: ref.aesKey
      ? decryptFile(downloaded.buffer, ref.aesKey)
      : downloaded.buffer,
    ...(ref.fileName || downloaded.filename
      ? { filename: ref.fileName || downloaded.filename }
      : {}),
  };
}

function guardedHttpsDownload(
  rawUrl: string,
): Promise<{ buffer: Buffer; filename?: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup: { absoluteTimeout?: ReturnType<typeof setTimeout> } = {};
    const finish = (
      err?: Error,
      value?: { buffer: Buffer; filename?: string },
    ): void => {
      if (settled) return;
      settled = true;
      if (cleanup.absoluteTimeout) clearTimeout(cleanup.absoluteTimeout);
      if (err) {
        rejectPromise(err);
      } else {
        resolvePromise(value ?? { buffer: Buffer.alloc(0) });
      }
    };

    const req = httpsRequest(
      rawUrl,
      {
        method: 'GET',
        lookup: safePublicLookup,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) {
          req.destroy();
          finish(new Error('redirected media URL'));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          req.destroy();
          finish(new Error(`media download failed: HTTP ${statusCode}`));
          return;
        }

        const contentLength = getHeaderNumber(res.headers, 'content-length');
        if (contentLength !== undefined && contentLength > MAX_MEDIA_BYTES) {
          req.destroy();
          finish(new Error(`oversized attachment (${contentLength} bytes)`));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.byteLength;
          if (total > MAX_MEDIA_BYTES) {
            req.destroy();
            finish(new Error('oversized attachment'));
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (buffer.byteLength === 0) {
            finish(new Error('empty media response'));
            return;
          }
          finish(undefined, {
            buffer,
            ...parseContentDispositionFileName(res.headers),
          });
        });
        res.on('error', (err: Error) => {
          req.destroy();
          finish(err);
        });
      },
    );
    req.setTimeout(10_000, () => {
      req.destroy();
      finish(new Error('media download timed out'));
    });
    cleanup.absoluteTimeout = setTimeout(() => {
      req.destroy();
      finish(new Error('media download absolute timeout'));
    }, 60_000);
    cleanup.absoluteTimeout.unref?.();
    req.on('error', (err: Error) => finish(err));
    req.end();
  });
}

const safePublicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true })
    .then((records) => {
      const unsafeRecord = records.find(
        (record) => !isPublicIpAddress(record.address),
      );
      if (records.length === 0 || unsafeRecord) {
        const reason =
          records.length === 0
            ? `no DNS records for ${hostname}`
            : `${hostname} resolved to private address ${unsafeRecord!.address}`;
        callback(new Error(`unsafe resolved media address: ${reason}`), '', 0);
        return;
      }
      if (options.all) {
        callback(null, records);
        return;
      }
      const record = records[0]!;
      callback(null, record.address, record.family);
    })
    .catch((err: unknown) =>
      callback(err instanceof Error ? err : new Error(String(err)), '', 0),
    );
};

function getHeaderNumber(
  headers: IncomingHttpHeaders,
  name: string,
): number | undefined {
  const value = getHeaderValue(headers, name);
  if (value === undefined) return undefined;
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : undefined;
}

function getHeaderValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseContentDispositionFileName(headers: IncomingHttpHeaders): {
  filename?: string;
} {
  const value = getHeaderValue(headers, 'content-disposition');
  if (!value) return {};
  const encoded = value.match(/filename\*=UTF-8''([^;\s]+)/i)?.[1];
  if (encoded) {
    try {
      return { filename: decodeURIComponent(encoded) };
    } catch {
      return { filename: encoded };
    }
  }
  const plain = value.match(/filename="?([^";]+)"?/i)?.[1];
  return plain ? { filename: plain } : {};
}

function isPublicIpAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const parts = parseIpv4Parts(host);
    return parts ? isPublicIpv4(parts) : false;
  }
  if (ipVersion === 6) {
    const embedded = parseEmbeddedIpv4(host);
    if (embedded) return isPublicIpv4(embedded);
    const groups = expandIpv6Groups(host);
    if (!groups) return false;
    const first = groups[0] ?? 0;
    const isAllZeros = groups.every((group) => group === 0);
    const isLoopback =
      groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
    const lowZeroEmbeddedIpv4 = hexGroupsToIpv4(groups[6], groups[7]);
    const hasLowZeroPrivateIpv4 =
      groups.slice(0, 5).every((group) => group === 0) &&
      lowZeroEmbeddedIpv4 !== undefined &&
      (groups[6] !== 0 || groups[7] !== 0) &&
      !isPublicIpv4(lowZeroEmbeddedIpv4);
    return !(
      isAllZeros ||
      isLoopback ||
      hasLowZeroPrivateIpv4 ||
      (first >= 0xfc00 && first <= 0xfdff) ||
      (first >= 0xff00 && first <= 0xffff) ||
      (first === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) ||
      (first === 0x2001 && groups[1] === 0x0002) ||
      (first === 0x2001 && groups[1] === 0x0db8) ||
      (first === 0x2001 && (groups[1] & 0xfff0) === 0x0010) ||
      (first === 0x2001 && (groups[1] & 0xfff0) === 0x0030) ||
      isIpv6LinkLocalGroup(first)
    );
  }
  return false;
}

function isIpv6LinkLocalGroup(firstGroup: number): boolean {
  return firstGroup >= 0xfe80 && firstGroup <= 0xfeff;
}

function parseIpv4Parts(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  const nums = parts.map((part) => {
    if (!/^(0|[1-9]\d{0,2})$/u.test(part)) return NaN;
    const n = Number(part);
    return n >= 0 && n <= 255 ? n : NaN;
  });
  if (nums.some((part) => Number.isNaN(part))) {
    return undefined;
  }
  return nums;
}

function parseMappedIpv4(host: string): number[] | undefined {
  if (!host.startsWith('::ffff:')) return undefined;
  const suffix = host.slice('::ffff:'.length);
  if (suffix.includes('.')) {
    return parseIpv4Parts(suffix);
  }
  const groups = suffix.split(':');
  if (groups.length !== 2) return undefined;
  const high = parseHexGroup(groups[0]);
  const low = parseHexGroup(groups[1]);
  if (high === undefined || low === undefined) return undefined;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function parseEmbeddedIpv4(host: string): number[] | undefined {
  const mapped = parseMappedIpv4(host);
  if (mapped) return mapped;

  const groups = expandIpv6Groups(host);
  if (!groups) return undefined;
  if (
    groups.slice(0, 4).every((group) => group === 0) &&
    groups[4] === 0xffff &&
    groups[5] === 0 &&
    (groups[6] !== 0 || groups[7] !== 0)
  ) {
    return hexGroupsToIpv4(groups[6], groups[7]);
  }
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff &&
    (groups[6] !== 0 || groups[7] !== 0)
  ) {
    return hexGroupsToIpv4(groups[6], groups[7]);
  }
  if (
    groups.slice(0, 6).every((group) => group === 0) &&
    (groups[6] !== 0 || groups[7] !== 0)
  ) {
    return hexGroupsToIpv4(groups[6], groups[7]);
  }
  if (groups[0] === 0x2002) {
    return hexGroupsToIpv4(groups[1], groups[2]);
  }
  if (groups[0] === 0x2001 && groups[1] === 0) {
    return hexGroupsToIpv4(groups[6]! ^ 0xffff, groups[7]! ^ 0xffff);
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
    return hexGroupsToIpv4(groups[6], groups[7]);
  }
  return undefined;
}

function expandIpv6Groups(host: string): number[] | undefined {
  const normalized = normalizeIpv6DottedSuffix(host);
  if (!normalized) return undefined;

  const parts = normalized.split('::');
  if (parts.length > 2) return undefined;
  const left = parseIpv6GroupList(parts[0]);
  const right = parseIpv6GroupList(parts[1]);
  if (!left || !right) return undefined;

  if (parts.length === 1) {
    return left.length === 8 ? left : undefined;
  }

  const fill = 8 - left.length - right.length;
  if (fill < 1) return undefined;
  return [...left, ...Array<number>(fill).fill(0), ...right];
}

function normalizeIpv6DottedSuffix(host: string): string | undefined {
  if (!host.includes('.')) return host;
  const lastColon = host.lastIndexOf(':');
  if (lastColon === -1) return undefined;
  const ipv4 = parseIpv4Parts(host.slice(lastColon + 1));
  if (!ipv4) return undefined;
  const high = (ipv4[0] << 8) | ipv4[1];
  const low = (ipv4[2] << 8) | ipv4[3];
  return `${host.slice(0, lastColon + 1)}${high.toString(
    16,
  )}:${low.toString(16)}`;
}

function parseIpv6GroupList(value: string | undefined): number[] | undefined {
  if (!value) return [];
  const groups: number[] = [];
  for (const group of value.split(':')) {
    const parsed = parseHexGroup(group);
    if (parsed === undefined) return undefined;
    groups.push(parsed);
  }
  return groups;
}

function hexGroupsToIpv4(
  high: number | undefined,
  low: number | undefined,
): number[] | undefined {
  if (high === undefined || low === undefined) return undefined;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function parseHexGroup(value: string | undefined): number | undefined {
  if (!value || !/^[\da-f]{1,4}$/i.test(value)) return undefined;
  const parsed = Number.parseInt(value, 16);
  return parsed >= 0 && parsed <= 0xffff ? parsed : undefined;
}

function isPublicIpv4(parts: number[]): boolean {
  const [a = 0, b = 0, c = 0] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function extractMediaId(value: unknown): string | undefined {
  const record = asRecord(value);
  return (
    getString(record, 'media_id') ||
    getString(record, 'mediaId') ||
    getString(getRecord(record, 'body'), 'media_id') ||
    undefined
  );
}

function detectImageMime(data: Buffer): string {
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  return 'application/octet-stream';
}

function mediaTypeToMime(type: WeComMediaType): string {
  switch (type) {
    case 'video':
      return 'video/mp4';
    case 'voice':
      return 'audio/amr';
    default:
      return 'application/octet-stream';
  }
}

function sanitizeFileName(name: string | undefined): string {
  const base = basename(name || '').replace(/\0/g, '');
  return base.replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '_');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(value?.[key]);
}

function getArray(
  value: Record<string, unknown> | undefined,
  key: string,
): unknown[] {
  const raw = value?.[key];
  return Array.isArray(raw) ? raw : [];
}

function getString(
  value: Record<string, unknown> | undefined,
  key: string,
): string {
  const raw = value?.[key];
  return typeof raw === 'string' ? raw : '';
}
