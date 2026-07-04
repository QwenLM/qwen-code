import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MARKDOWN_CHUNK_BYTES = 3800;
const AUTHENTICATION_TIMEOUT_MS = 30_000;
const KICK_RECONNECT_MAX_ATTEMPTS = 3;
const KICK_RECONNECT_BASE_DELAY_MS = 1_000;
const KICK_RECONNECT_RESET_MS = 60_000;
const KICK_RECONNECT_RETRY_MS = 5 * 60 * 1000;

export class WeComChannel extends ChannelBase {
  private readonly wecom: WeComConfig;
  private client?: WeComClient;
  private readonly seenMessages = new Map<string, number>();
  private readonly inFlightMessages = new Set<string>();
  private readonly attachmentDirsByMessage = new Map<string, string[]>();
  private readonly attachmentDirsBySession = new Map<string, string[]>();
  private attachmentDirsWithoutMessage: string[] = [];
  private readonly bufferedAttachmentMessages = new Set<string>();
  private readonly coalescedAttachmentMessages = new Map<string, string[]>();
  private dedupTimer?: ReturnType<typeof setInterval>;
  private kickReconnectReset?: ReturnType<typeof setTimeout>;
  private kickReconnectRetry?: ReturnType<typeof setTimeout>;
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
  private kickReconnectAttempts = 0;

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
    const messageHandler = (payload: unknown) => {
      if (!authenticated) {
        process.stderr.write(
          `[WeCom:${this.name}] dropping message before authentication.\n`,
        );
        return;
      }
      this.onMessage(payload).catch((err: unknown) => {
        process.stderr.write(
          `[WeCom:${this.name}] message handling failed: ${sanitizeLogText(
            formatSdkError(err),
            200,
          )}\n`,
        );
      });
    };
    const errorHandler = (err: unknown) => {
      process.stderr.write(
        `[WeCom:${this.name}] SDK error: ${sanitizeLogText(formatSdkError(err), 200)}\n`,
      );
    };
    const disconnectedHandler = (reason: unknown) => {
      process.stderr.write(
        `[WeCom:${this.name}] WebSocket ${formatDisconnectReason(reason)}; waiting for SDK reconnect.\n`,
      );
    };
    const kickedHandler = (reason: unknown) => {
      void this.reconnectAfterKick(reason);
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
      const connected = client.connect();
      if (isPromiseLike(connected)) await connected;
      await authentication.promise;
      authenticated = true;
      if (this.connectingClient !== client) {
        throw new Error('WeCom connection was replaced before authentication.');
      }
      this.client = client;
      this.connectingClient = undefined;
      this.authentication = undefined;
    } catch (err) {
      authentication.cancel();
      this.detachClientHandlers(client, handlers);
      if (this.connectingClient === client) this.connectingClient = undefined;
      if (this.authentication === authentication)
        this.authentication = undefined;
      client.disconnect();
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
    if (this.kickReconnectReset) {
      clearTimeout(this.kickReconnectReset);
      this.kickReconnectReset = undefined;
    }
    if (this.kickReconnectRetry) {
      clearTimeout(this.kickReconnectRetry);
      this.kickReconnectRetry = undefined;
    }
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

    for (const item of media) {
      if (item.type !== 'image') {
        process.stderr.write(
          `[WeCom:${this.name}] skipping unsupported outbound media marker: ${item.type}\n`,
        );
        continue;
      }
      try {
        const file = readOutboundMedia(item.path, this.config.cwd);
        const upload = await client.uploadMedia(file.data, {
          type: item.type,
          filename: file.fileName,
        });
        const mediaId = extractMediaId(upload);
        if (!mediaId) {
          process.stderr.write(
            `[WeCom:${this.name}] upload returned no media_id, skipping.\n`,
          );
          continue;
        }
        await client.sendMediaMessage(chatId, item.type, mediaId);
      } catch (err) {
        process.stderr.write(
          `[WeCom:${this.name}] media send failed for ${item.type}: ${sanitizeLogText(
            formatSdkError(err),
            200,
          )}\n`,
        );
      }
    }
  }

  private async onMessage(payload: unknown): Promise<void> {
    const body = extractBody(payload);
    if (!body) {
      process.stderr.write(
        `[WeCom:${this.name}] dropping message with unrecognized payload structure.\n`,
      );
      return;
    }

    const messageId = getString(body, 'msgid') || undefined;
    const logMessageId = sanitizeLogText(messageId || '(no id)', 100);
    if (messageId && this.seenMessages.has(messageId)) {
      process.stderr.write(
        `[WeCom:${this.name}] dropping duplicate message ${logMessageId} (already seen).\n`,
      );
      return;
    }

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
    if (messageId) {
      if (this.inFlightMessages.has(messageId)) {
        process.stderr.write(
          `[WeCom:${this.name}] dropping duplicate message ${logMessageId} (already in flight).\n`,
        );
        return;
      }
      this.inFlightMessages.add(messageId);
    }

    const text = extractText(body);
    const explicitMention = getExplicitMention(body, this.wecom.botId);
    const envelope: Envelope = {
      channelName: this.name,
      senderId,
      senderName,
      chatId,
      text,
      messageId,
      isGroup,
      isMentioned: !isGroup || (explicitMention ?? true),
      isReplyToBot: false,
      referencedText: extractQuoteText(body),
    };
    let attachments: Attachment[] = [];
    let processingStarted = false;
    try {
      if (!(await this.preflightInbound(envelope))) return;
      attachments = await this.downloadAttachments(
        body,
        attachments,
        messageId,
      );
      if (messageId) this.seenMessages.set(messageId, Date.now());
      if (attachments.length) {
        envelope.attachments = attachments;
      }
      if (!envelope.text && attachments.length) {
        envelope.text = attachments.some((a) => a.type === 'image')
          ? '(image)'
          : `(file: ${attachments[0]?.fileName ?? 'file'})`;
      }
      processingStarted = true;
      await this.processInbound(envelope);
    } catch (err) {
      if (messageId && !processingStarted) this.seenMessages.delete(messageId);
      else if (messageId) {
        process.stderr.write(
          `[WeCom:${this.name}] message ${logMessageId} failed after processing started; dedup entry retained.\n`,
        );
      }
      throw err;
    } finally {
      if (messageId) this.inFlightMessages.delete(messageId);
      if (
        messageId &&
        !this.bufferedAttachmentMessages.has(messageId) &&
        this.attachmentDirsByMessage.has(messageId)
      ) {
        this.cleanupAttachmentDirsForMessage(messageId);
      }
      if (!messageId) this.cleanupAttachmentDirsWithoutMessage();
    }
  }

  private async downloadAttachments(
    body: Record<string, unknown>,
    attachments: Attachment[] = [],
    messageId?: string,
  ): Promise<Attachment[]> {
    const refs = collectInboundMediaRefs(body);
    for (const ref of refs) {
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
        mkdirSync(dir, { recursive: true });
        this.rememberAttachmentDir(dir, messageId);
        const safeName = fileName || `wecom_${ref.type}`;
        const filePath = join(dir, safeName);
        writeFileSync(filePath, data);
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
    _sessionId: string,
    messageIds: string[],
  ): void {
    for (const messageId of messageIds) {
      this.cleanupAttachmentDirsForMessage(messageId);
    }
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
      return;
    }
    this.cleanupAttachmentDirsForMessage(messageId);
  }

  private rememberAttachmentDir(dir: string, messageId?: string): void {
    if (messageId) {
      const messageDirs = this.attachmentDirsByMessage.get(messageId) ?? [];
      messageDirs.push(dir);
      this.attachmentDirsByMessage.set(messageId, messageDirs);
    } else {
      this.attachmentDirsWithoutMessage.push(dir);
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
    this.removeAttachmentDirsFromSessions(dirs);
    cleanupAttachmentDirs(dirs);
  }

  private cleanupAttachmentDirsForSession(sessionId: string): void {
    const dirs = this.attachmentDirsBySession.get(sessionId);
    if (!dirs) return;
    this.attachmentDirsBySession.delete(sessionId);
    this.removeAttachmentDirsFromMessages(dirs);
    cleanupAttachmentDirs(dirs);
  }

  private rememberUntrackedDirsForSession(sessionId: string): void {
    if (this.attachmentDirsWithoutMessage.length === 0) return;
    const sessionDirs = this.attachmentDirsBySession.get(sessionId) ?? [];
    for (const dir of this.attachmentDirsWithoutMessage) {
      if (!sessionDirs.includes(dir)) sessionDirs.push(dir);
    }
    this.attachmentDirsBySession.set(sessionId, sessionDirs);
    this.attachmentDirsWithoutMessage = [];
  }

  private cleanupAttachmentDirsWithoutMessage(): void {
    const dirs = this.attachmentDirsWithoutMessage;
    if (dirs.length === 0) return;
    this.attachmentDirsWithoutMessage = [];
    cleanupAttachmentDirs(dirs);
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
  }

  private cleanupAllAttachmentDirs(): void {
    const dirs = Array.from(
      new Set([
        ...Array.from(this.attachmentDirsBySession.values()).flat(),
        ...Array.from(this.attachmentDirsByMessage.values()).flat(),
        ...this.attachmentDirsWithoutMessage,
      ]),
    );
    this.attachmentDirsBySession.clear();
    this.attachmentDirsByMessage.clear();
    this.attachmentDirsWithoutMessage = [];
    this.bufferedAttachmentMessages.clear();
    this.coalescedAttachmentMessages.clear();
    cleanupAttachmentDirs(dirs);
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
    if (client) this.detachClientHandlers(client);
    client?.disconnect();
  }

  private async reconnectAfterKick(reason: unknown): Promise<void> {
    if (this.reconnectingAfterKick) return;
    if (this.kickReconnectRetry) {
      clearTimeout(this.kickReconnectRetry);
      this.kickReconnectRetry = undefined;
    }
    this.reconnectingAfterKick = true;
    const previousConnecting = this.connecting;
    const disconnectGeneration = this.disconnectGeneration;
    process.stderr.write(
      `[WeCom:${this.name}] WebSocket ${formatDisconnectReason(reason)}; reconnecting after server kick.\n`,
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
        if (this.disconnectGeneration !== disconnectGeneration) return;
        try {
          await this.connect();
          this.kickReconnectAttempts = 0;
          this.scheduleKickReconnectReset();
          return;
        } catch (err) {
          process.stderr.write(
            `[WeCom:${this.name}] reconnect after server kick attempt ${attempt} failed: ${sanitizeLogText(
              formatSdkError(err),
              200,
            )}\n`,
          );
        }
      }
      process.stderr.write(
        `[WeCom:${this.name}] reconnect after server kick gave up after ${KICK_RECONNECT_MAX_ATTEMPTS} attempts; retrying later.\n`,
      );
      this.scheduleKickReconnectRetry(reason, disconnectGeneration);
    } finally {
      this.reconnectingAfterKick = false;
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
      this.kickReconnectReset = undefined;
    }, KICK_RECONNECT_RESET_MS);
    this.kickReconnectReset.unref?.();
  }

  private scheduleKickReconnectRetry(
    reason: unknown,
    disconnectGeneration: number,
  ): void {
    this.kickReconnectRetry = setTimeout(() => {
      this.kickReconnectRetry = undefined;
      if (this.disconnectGeneration !== disconnectGeneration) return;
      this.kickReconnectAttempts = 0;
      void this.reconnectAfterKick(reason);
    }, KICK_RECONNECT_RETRY_MS);
    this.kickReconnectRetry.unref?.();
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

function cleanupAttachmentDirs(dirs: string[]): void {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
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
      return `errcode=${String(errcode)} errmsg=${String(errmsg)}`;
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
        typeof reason === 'string' ? `reason=${reason}` : undefined,
        typeof wasClean === 'boolean' ? `wasClean=${wasClean}` : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' ');
    }
    try {
      return JSON.stringify(record);
    } catch {
      // Fall through to String below.
    }
  }
  return String(err);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
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

function extractQuoteText(body: Record<string, unknown>): string | undefined {
  const quote = getRecord(body, 'quote');
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
  const markerRe = /\[(IMAGE|FILE|VIDEO|VOICE):\s*([^\]]+)\]/gi;
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
  for (const match of text.matchAll(/```[\s\S]*?```|`[^`]*`/g)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

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
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (Buffer.byteLength(candidate, 'utf8') <= MARKDOWN_CHUNK_BYTES) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    let slice = '';
    let sliceBytes = 0;
    for (const char of line) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (sliceBytes + charBytes > MARKDOWN_CHUNK_BYTES) {
        if (slice) chunks.push(slice);
        slice = char;
        sliceBytes = charBytes;
      } else {
        slice += char;
        sliceBytes += charBytes;
      }
    }
    current = slice;
  }

  if (current) chunks.push(current);
  return chunks;
}

function readOutboundMedia(
  rawPath: string,
  cwd: string,
): {
  data: Buffer;
  fileName: string;
} {
  const resolved = resolve(cwd, rawPath);
  const real = realpathSync(resolved);
  const stat = statSync(real);
  if (!stat.isFile())
    throw new Error(`Not a regular file: ${basename(rawPath)}`);
  if (stat.size > MAX_MEDIA_BYTES) {
    throw new Error(`Media file too large: ${stat.size} bytes`);
  }

  const allowedDirs = [
    ensureDirectoryRealpath(join(tmpdir(), 'channel-files')),
  ].filter((dir): dir is string => Boolean(dir));
  if (!allowedDirs.some((dir) => isInsideDir(real, dir))) {
    throw new Error('Media path outside allowed outbound directory');
  }
  return { data: readFileSync(real), fileName: basename(real) };
}

function ensureDirectoryRealpath(path: string): string | undefined {
  try {
    mkdirSync(path, { recursive: true });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return realpathSync(path);
  } catch {
    return undefined;
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

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
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
          reason: `resolved to private address ${privateRecord.address}`,
        }
      : { safe: true };
  } catch {
    return { safe: false, reason: 'DNS lookup failed' };
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
    const finish = (
      err?: Error,
      value?: { buffer: Buffer; filename?: string },
    ): void => {
      if (settled) return;
      settled = true;
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
          res.resume();
          finish(new Error('redirected media URL'));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
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
        res.on('error', (err: Error) => finish(err));
      },
    );
    req.setTimeout(10_000, () => {
      req.destroy();
      finish(new Error('media download timed out'));
    });
    req.on('error', (err: Error) => finish(err));
    req.end();
  });
}

const safePublicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true })
    .then((records) => {
      if (
        records.length === 0 ||
        records.some((record) => !isPublicIpAddress(record.address))
      ) {
        callback(new Error('unsafe resolved media address'), '', 0);
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
    return !(
      isAllZeros ||
      isLoopback ||
      (first >= 0xfc00 && first <= 0xfdff) ||
      (first >= 0xff00 && first <= 0xffff) ||
      isIpv6LinkLocalGroup(first)
    );
  }
  return false;
}

function isIpv6LinkLocalGroup(firstGroup: number): boolean {
  return firstGroup >= 0xfe80 && firstGroup <= 0xfeff;
}

function parseIpv4Parts(host: string): number[] | undefined {
  const parts = host.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return parts;
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
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
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
  return base.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_');
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

function getBoolean(
  value: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const raw = value?.[key];
  return typeof raw === 'boolean' ? raw : undefined;
}

function getExplicitMention(
  body: Record<string, unknown>,
  botId: string,
): boolean | undefined {
  const botSpecificMention =
    getBoolean(body, 'isInAtList') ?? getBoolean(body, 'is_in_at_list');
  if (botSpecificMention !== undefined) return botSpecificMention;

  const mentions = collectMentionValues(body);
  if (!mentions.present) return getBoolean(body, 'isMentioned');

  return mentions.values.some(
    (mention) => mention === botId || mention === '@all' || mention === 'all',
  );
}

function collectMentionValues(body: Record<string, unknown>): {
  present: boolean;
  values: string[];
} {
  const values: string[] = [];
  let present = false;
  for (const key of [
    'mentions',
    'mentioned_list',
    'mentionedList',
    'at_list',
    'atList',
    'at_userids',
    'atUserIds',
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      present = true;
    }
    for (const item of getArray(body, key)) {
      if (typeof item === 'string') {
        values.push(item);
        continue;
      }
      const record = asRecord(item);
      if (!record) continue;
      for (const itemKey of ['userid', 'userId', 'id', 'open_id', 'openId']) {
        const value = getString(record, itemKey);
        if (value) values.push(value);
      }
    }
  }
  return { present, values };
}
