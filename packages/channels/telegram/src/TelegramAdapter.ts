import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bot } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  telegramFormat,
  splitHtmlForTelegram,
} from 'telegram-markdown-formatter';
import {
  ChannelBase,
  isTerminalTaskLifecycleType,
} from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  ChannelTaskLifecycleEvent,
  Envelope,
  SessionTarget,
} from '@qwen-code/channel-base';

const TELEGRAM_BOT_COMMANDS = [
  { command: 'start', description: 'Show quick-start help' },
  { command: 'help', description: 'Show available commands' },
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'cancel', description: 'Cancel the running request' },
  { command: 'status', description: 'Show session info' },
] as const;
const TELEGRAM_MESSAGE_LIMIT = 4096;

const TELEGRAM_START_MESSAGE = [
  'Qwen Code Telegram bot',
  '',
  'Send any message to chat with Qwen Code.',
  'Use /new to start a fresh conversation.',
  'Use /cancel to stop a running request.',
  'Use /help to see available commands.',
].join('\n');

export class TelegramChannel extends ChannelBase {
  private bot: Bot;
  private botId: number = 0;
  private botUsername: string = '';
  private hasConnectedOnce = false;
  private signalHandlersRegistered = false;
  private readonly inboundRoute = new AsyncLocalStorage<{
    threadId?: string;
  }>();

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.bot = this.createBot();
    this.registerCommand('start', async (envelope) => {
      await this.sendMessage(envelope.chatId, TELEGRAM_START_MESSAGE);
      return true;
    });
    this.registerCancelCommand();
  }

  override supportsProactiveSend(): boolean {
    return true;
  }

  protected override supportsProactiveTarget(target: SessionTarget): boolean {
    return target.threadId === undefined || /^\d+$/u.test(target.threadId);
  }

  private createBot(): Bot {
    const botConfig = this.proxy
      ? {
          client: {
            baseFetchConfig: { agent: new HttpsProxyAgent(this.proxy) },
          },
        }
      : undefined;
    return new Bot(this.config.token, botConfig);
  }

  private getFileUrl(filePath: string): string {
    return `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`;
  }

  private reportInboundError(
    envelope: Envelope,
    error: unknown,
    reply: () => Promise<unknown>,
  ): void {
    process.stderr.write(
      `[Telegram:${this.name}] Error handling message: ${error}\n`,
    );
    const sourceLabel = this.getInboundErrorSourceLabel(envelope);
    const delivery = sourceLabel
      ? this.sendThreadMessage(
          envelope.chatId,
          envelope.threadId,
          'Sorry, something went wrong processing your message.',
          sourceLabel,
        )
      : reply();
    delivery.catch(() => {});
  }

  async connect(): Promise<void> {
    if (this.hasConnectedOnce) {
      this.bot = this.createBot();
    }
    this.hasConnectedOnce = true;
    const botInfo = await this.bot.api.getMe();
    this.botId = botInfo.id;
    this.botUsername = botInfo.username ?? '';
    await this.registerBotCommands();
    // All messages (including slash commands) go through handleInbound
    // where ChannelBase dispatches shared commands (/help, /clear, /status, etc.)
    this.bot.on('message:text', async (ctx) => {
      const msg = ctx.message;
      const text = msg.text;

      const envelope = this.buildEnvelope(msg, text, msg.entities);

      // Don't await — long prompts would block the update loop
      this.handleInbound(envelope).catch((err) => {
        this.reportInboundError(envelope, err, () =>
          ctx.reply('Sorry, something went wrong processing your message.'),
        );
      });
    });

    // Photo messages
    this.bot.on('message:photo', async (ctx) => {
      const msg = ctx.message;
      const envelope = this.buildEnvelope(
        msg,
        msg.caption || '(image)',
        msg.caption_entities,
      );

      // Pick the largest photo size (last in array)
      const photo = msg.photo[msg.photo.length - 1];
      if (!photo) return;

      this.prepareThenHandleInbound(envelope, async () => {
        try {
          const file = await ctx.api.getFile(photo.file_id);
          const fileUrl = this.getFileUrl(file.file_path!);
          const resp = await fetch(fileUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          envelope.imageBase64 = buf.toString('base64');
          envelope.imageMimeType = 'image/jpeg'; // Telegram always converts photos to JPEG
        } catch (err) {
          process.stderr.write(
            `[Telegram:${this.name}] Failed to download photo: ${err instanceof Error ? err.message : err}\n`,
          );
        }
      }).catch((err) => {
        this.reportInboundError(envelope, err, () =>
          ctx.reply('Sorry, something went wrong processing your message.'),
        );
      });
    });

    // Document/file messages
    this.bot.on('message:document', async (ctx) => {
      const msg = ctx.message;
      const doc = msg.document;
      const fileName = doc.file_name || `file_${Date.now()}`;

      const envelope = this.buildEnvelope(
        msg,
        msg.caption || `(file: ${fileName})`,
        msg.caption_entities,
      );

      this.prepareThenHandleInbound(envelope, async () => {
        try {
          const file = await ctx.api.getFile(doc.file_id);
          const fileUrl = this.getFileUrl(file.file_path!);
          const resp = await fetch(fileUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());

          // Save to temp dir so the agent can read it via read-file tool
          const dir = join(tmpdir(), 'channel-files', randomUUID());
          mkdirSync(dir, { recursive: true });
          const filePath = join(
            dir,
            basename(fileName) || `file_${Date.now()}`,
          );
          writeFileSync(filePath, buf);

          envelope.text = msg.caption || '';
          envelope.attachments = [
            {
              type: 'file',
              filePath,
              mimeType: doc.mime_type || 'application/octet-stream',
              fileName,
            },
          ];
        } catch (err) {
          process.stderr.write(
            `[Telegram:${this.name}] Failed to download document: ${err instanceof Error ? err.message : err}\n`,
          );
          envelope.text =
            (msg.caption || '') +
            `\n\n(User sent a file "${fileName}" but download failed)`;
        }
      }).catch((err) => {
        this.reportInboundError(envelope, err, () =>
          ctx.reply('Sorry, something went wrong processing your message.'),
        );
      });
    });

    // Voice messages
    this.bot.on('message:voice', async (ctx) => {
      const msg = ctx.message;
      const voice = msg.voice;
      const fileName = `voice_${Date.now()}.ogg`;

      const envelope = this.buildEnvelope(
        msg,
        msg.caption || '(voice message)',
        msg.caption_entities,
      );

      this.prepareThenHandleInbound(envelope, async () => {
        try {
          const file = await ctx.api.getFile(voice.file_id);
          const fileUrl = this.getFileUrl(file.file_path!);
          const resp = await fetch(fileUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());

          // Save to temp dir so the agent can read it via read-file tool
          const dir = join(tmpdir(), 'channel-files', randomUUID());
          mkdirSync(dir, { recursive: true });
          const filePath = join(dir, fileName);
          writeFileSync(filePath, buf);

          envelope.text = msg.caption || '';
          envelope.attachments = [
            {
              type: 'audio',
              filePath,
              mimeType: voice.mime_type || 'audio/ogg',
              fileName,
            },
          ];
        } catch (err) {
          process.stderr.write(
            `[Telegram:${this.name}] Failed to download voice message: ${err instanceof Error ? err.message : err}\n`,
          );
          envelope.text =
            (msg.caption || '') +
            `\n\n(User sent a voice message but download failed)`;
        }
      }).catch((err) => {
        this.reportInboundError(envelope, err, () =>
          ctx.reply('Sorry, something went wrong processing your message.'),
        );
      });
    });

    this.bot.start({ drop_pending_updates: true }).catch((err) => {
      process.stderr.write(
        `[Telegram:${this.name}] Bot launch error: ${err}\n`,
      );
    });

    if (!this.signalHandlersRegistered) {
      process.once('SIGINT', () => this.bot.stop());
      process.once('SIGTERM', () => this.bot.stop());
      this.signalHandlersRegistered = true;
    }
  }

  private async registerBotCommands(): Promise<void> {
    try {
      await this.bot.api.setMyCommands(TELEGRAM_BOT_COMMANDS);
    } catch (err) {
      process.stderr.write(
        `[Telegram:${this.name}] Failed to register bot commands: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }

  /** Per-chat typing interval — repeats every 4s since Telegram expires it after 5s. */
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private activeTypingSessions = new Map<string, Set<string>>();

  private sendTyping(chatId: string): void {
    try {
      void this.bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    } catch {
      // Best-effort typing indicator.
    }
  }

  private startTyping(chatId: string, sessionId = chatId): void {
    const sessions = this.activeTypingSessions.get(chatId) ?? new Set();
    sessions.add(sessionId);
    this.activeTypingSessions.set(chatId, sessions);
    if (this.typingIntervals.has(chatId)) return;
    this.sendTyping(chatId);
    this.typingIntervals.set(
      chatId,
      setInterval(() => this.sendTyping(chatId), 4000),
    );
  }

  private stopTyping(chatId: string, sessionId = chatId): void {
    const sessions = this.activeTypingSessions.get(chatId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size > 0) return;
      this.activeTypingSessions.delete(chatId);
    }
    const interval = this.typingIntervals.get(chatId);
    if (!interval) return;
    clearInterval(interval);
    this.typingIntervals.delete(chatId);
  }

  protected override onTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
    if (event.type === 'started') {
      this.startTyping(event.chatId, event.sessionId);
      return;
    }
    if (isTerminalTaskLifecycleType(event.type)) {
      this.stopTyping(event.chatId, event.sessionId);
    }
  }

  protected override onPromptStart(chatId: string, sessionId?: string): void {
    this.startTyping(chatId, sessionId);
  }

  protected override onPromptEnd(chatId: string, sessionId?: string): void {
    this.stopTyping(chatId, sessionId);
  }

  override onSessionDied(sessionId: string): void {
    for (const [chatId, sessions] of this.activeTypingSessions) {
      if (sessions.has(sessionId)) {
        this.stopTyping(chatId, sessionId);
      }
    }
    super.onSessionDied(sessionId);
  }

  override async handleInbound(envelope: Envelope): Promise<void> {
    const route =
      envelope.threadId === undefined ? {} : { threadId: envelope.threadId };
    await this.inboundRoute.run(route, () => super.handleInbound(envelope));
  }

  protected override async prepareThenHandleInbound(
    envelope: Envelope,
    prepare: () => Promise<boolean | void>,
  ): Promise<void> {
    const route =
      envelope.threadId === undefined ? {} : { threadId: envelope.threadId };
    await this.inboundRoute.run(route, () =>
      super.prepareThenHandleInbound(envelope, prepare),
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.sendTelegramMessage(
      chatId,
      text,
      this.inboundRoute.getStore()?.threadId,
    );
  }

  protected override async sendThreadMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
    sourceLabel?: string,
  ): Promise<void> {
    await this.sendTelegramMessage(chatId, text, threadId, sourceLabel);
  }

  protected override async sendResponseMessage(
    chatId: string,
    text: string,
    sessionId: string,
    sourceLabel?: string,
  ): Promise<void> {
    const inboundRoute = this.inboundRoute.getStore();
    const target = this.router.getTarget(sessionId);
    const threadId =
      inboundRoute !== undefined
        ? inboundRoute.threadId
        : target?.channelName === this.name && target.chatId === chatId
          ? target.threadId
          : undefined;
    await this.sendTelegramMessage(
      chatId,
      text,
      threadId,
      sourceLabel ?? this.getResponseSourceLabel(sessionId),
    );
  }

  protected override async pushProactive(
    target: SessionTarget,
    text: string,
    sourceLabel?: string,
  ): Promise<void> {
    await this.sendTelegramMessage(
      target.chatId,
      text,
      target.threadId,
      sourceLabel,
    );
  }

  private async sendTelegramMessage(
    chatId: string,
    text: string,
    threadId?: string,
    sourceLabel?: string,
  ): Promise<void> {
    const html = telegramFormat(text);
    const prefix =
      sourceLabel && text.trim().length > 0
        ? `${escapeTelegramHtml(sourceLabel)} `
        : undefined;
    const chunks = splitAttributedTelegramHtml(html, prefix, sourceLabel);
    for (const chunk of chunks) {
      const options = chunk.isHtml
        ? threadId === undefined
          ? { parse_mode: 'HTML' as const }
          : {
              parse_mode: 'HTML' as const,
              message_thread_id: Number(threadId),
            }
        : threadId === undefined
          ? undefined
          : { message_thread_id: Number(threadId) };
      if (!chunk.isHtml) {
        await this.bot.api.sendMessage(chatId, chunk.text, options);
        continue;
      }
      try {
        await this.bot.api.sendMessage(chatId, chunk.text, options);
      } catch {
        // Fallback to plain text for the failed chunk only
        const withoutTags = chunk.text.replace(/<[^>]*>/g, '');
        const plainText =
          prefix && sourceLabel && withoutTags.startsWith(prefix)
            ? `${sourceLabel} ${withoutTags.slice(prefix.length)}`
            : withoutTags;
        await this.bot.api.sendMessage(
          chatId,
          plainText,
          threadId === undefined
            ? undefined
            : { message_thread_id: Number(threadId) },
        );
      }
    }
  }

  disconnect(): void {
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    this.activeTypingSessions.clear();
    this.bot.stop();
  }

  private buildEnvelope(
    msg: {
      from: { id: number; first_name: string; last_name?: string };
      chat: { id: number; type: string; title?: string };
      message_thread_id?: number;
      reply_to_message?: { from?: { id: number }; text?: string };
    },
    text: string,
    entities?: Array<{ type: string; offset: number; length: number }>,
  ): Envelope {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    const isMentioned =
      entities?.some((e) => {
        if (!this.botUsername) return false;
        const value = text.slice(e.offset, e.offset + e.length).toLowerCase();
        const username = this.botUsername.toLowerCase();
        if (e.type === 'mention') {
          return value === `@${username}`;
        }
        if (e.type === 'bot_command') {
          const mentionIndex = value.indexOf('@');
          return (
            mentionIndex !== -1 && value.slice(mentionIndex + 1) === username
          );
        }
        return false;
      }) ?? false;

    const isReplyToBot = msg.reply_to_message?.from?.id === this.botId;

    let cleanText = text;
    if (isMentioned && this.botUsername) {
      cleanText = text
        .replace(new RegExp(`@${this.botUsername}`, 'gi'), '')
        .trim();
    }

    // Extract referenced message text (when user replies to a message)
    const referencedText = msg.reply_to_message?.text || undefined;

    return {
      channelName: this.name,
      senderId: String(msg.from.id),
      senderName:
        msg.from.first_name +
        (msg.from.last_name ? ` ${msg.from.last_name}` : ''),
      chatId: String(msg.chat.id),
      ...(isGroup && msg.chat.title ? { chatName: msg.chat.title } : {}),
      threadId:
        typeof msg.message_thread_id === 'number'
          ? String(msg.message_thread_id)
          : undefined,
      text: cleanText,
      isGroup,
      isMentioned,
      isReplyToBot,
      referencedText,
    };
  }
}

function splitAttributedTelegramHtml(
  html: string,
  prefix: string | undefined,
  sourceLabel: string | undefined,
): Array<{ text: string; isHtml: boolean }> {
  const chunks = splitHtmlForTelegram(html);
  const contentLimit = TELEGRAM_MESSAGE_LIMIT - (prefix?.length ?? 0);
  if (contentLimit <= 0) {
    throw new Error('Telegram source label exceeds the message limit.');
  }

  const attributed: Array<{ text: string; isHtml: boolean }> = [];
  for (const chunk of chunks) {
    const split = splitTelegramHtmlAtLimit(chunk, contentLimit);
    if (split) {
      attributed.push(
        ...split.map((part) => ({
          text: `${prefix ?? ''}${part}`,
          isHtml: true,
        })),
      );
      continue;
    }
    attributed.push(
      ...splitAttributedTelegramText(
        chunk.replace(/<[^>]*>/g, ''),
        sourceLabel,
      ).map((text) => ({ text, isHtml: false })),
    );
  }
  return attributed;
}

function splitTelegramHtmlAtLimit(
  html: string,
  limit: number,
): string[] | undefined {
  const tokens = html.match(
    /<[^>]+>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|[\s\S]/giu,
  );
  if (!tokens) return [];

  const chunks: string[] = [];
  const openTags: Array<{ name: string; html: string }> = [];
  let current = '';
  let hasContent = false;
  const closingTags = () =>
    [...openTags]
      .reverse()
      .map(({ name }) => `</${name}>`)
      .join('');
  const reopenedTags = () => openTags.map(({ html }) => html).join('');
  const flush = () => {
    if (!hasContent) return false;
    chunks.push(`${current}${closingTags()}`);
    current = reopenedTags();
    hasContent = false;
    return true;
  };

  for (const token of tokens) {
    const closingMatch = token.match(/^<\/([a-z\d]+)/iu);
    if (closingMatch) {
      current += token;
      const index = openTags.findLastIndex(
        ({ name }) => name === closingMatch[1]?.toLowerCase(),
      );
      if (index !== -1) openTags.splice(index, 1);
      continue;
    }

    const openingMatch = token.match(/^<([a-z\d]+)/iu);
    const isSelfClosing = /^<br\b|\/>$/iu.test(token);
    if (openingMatch && !isSelfClosing) {
      const tag = { name: openingMatch[1].toLowerCase(), html: token };
      const required = `${current}${token}</${tag.name}>${closingTags()}`;
      if (required.length > limit && !flush()) return undefined;
      if (`${current}${token}</${tag.name}>${closingTags()}`.length > limit) {
        return undefined;
      }
      current += token;
      openTags.push(tag);
      continue;
    }

    if (`${current}${token}${closingTags()}`.length > limit && !flush()) {
      return undefined;
    }
    if (`${current}${token}${closingTags()}`.length > limit) return undefined;
    current += token;
    hasContent = true;
  }

  if (hasContent) chunks.push(`${current}${closingTags()}`);
  return chunks;
}

function splitAttributedTelegramText(
  text: string,
  sourceLabel: string | undefined,
): string[] {
  if (text.length === 0) return [];
  const prefix = sourceLabel ? `${sourceLabel} ` : '';
  const contentLimit = TELEGRAM_MESSAGE_LIMIT - prefix.length;
  if (contentLimit <= 0) {
    throw new Error('Telegram source label exceeds the message limit.');
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + contentLimit, text.length);
    if (
      end < text.length &&
      /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '') &&
      /[\uDC00-\uDFFF]/u.test(text[end] ?? '')
    ) {
      end--;
    }
    chunks.push(`${prefix}${text.slice(offset, end)}`);
    offset = end;
  }
  return chunks;
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
