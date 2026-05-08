import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bot } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  telegramFormat,
  splitHtmlForTelegram,
} from 'telegram-markdown-formatter';
import { ChannelBase } from '@qwen-code/channel-base';
import { BusinessConnectionStore } from './BusinessConnectionStore.js';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  AcpBridge,
} from '@qwen-code/channel-base';
import type { StoredBusinessConnection } from './BusinessConnectionStore.js';

interface TelegramMessageLike {
  message_id?: number;
  business_connection_id?: string;
  from?: { id: number; first_name: string; last_name?: string };
  chat: { id: number; type: string; first_name?: string; last_name?: string };
  reply_to_message?: { from?: { id: number }; text?: string };
}

export class TelegramChannel extends ChannelBase {
  private bot: Bot;
  private botId: number = 0;
  private botUsername: string = '';
  private businessConnections: BusinessConnectionStore;
  private businessByMessage = new Map<string, StoredBusinessConnection>();
  private businessBySession = new Map<string, StoredBusinessConnection>();

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: AcpBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.businessConnections = new BusinessConnectionStore(name);
    const botConfig = this.proxy
      ? {
          client: {
            baseFetchConfig: { agent: new HttpsProxyAgent(this.proxy) },
          },
        }
      : undefined;
    this.bot = new Bot(config.token, botConfig);
  }

  private getFileUrl(filePath: string): string {
    return `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`;
  }

  async connect(): Promise<void> {
    const botInfo = await this.bot.api.getMe();
    this.botId = botInfo.id;
    this.botUsername = botInfo.username ?? '';

    if (this.config.businessAutomation?.enabled) {
      if (!botInfo.can_connect_to_business) {
        process.stderr.write(
          `[Telegram:${this.name}] Business automation is enabled, but this bot is not allowed to connect to business accounts. Enable Business Mode in BotFather.\n`,
        );
      }

      this.bot.on('business_connection', (ctx) => {
        const connection = ctx.businessConnection;
        if (!connection) return;
        this.businessConnections.upsert(connection);
      });

      this.bot.on('business_message:text', async (ctx) => {
        const msg = ctx.businessMessage;
        if (!msg?.text) return;

        const connection = await this.resolveBusinessConnection(
          msg.business_connection_id,
        );
        if (!connection || !this.canReply(connection)) {
          return;
        }

        const envelope = this.buildBusinessEnvelope(
          msg,
          msg.text,
          msg.entities,
          connection,
        );
        const messageKey = this.messageKey(envelope.chatId, envelope.messageId);
        if (messageKey) {
          this.businessByMessage.set(messageKey, connection);
        }

        if (
          this.config.businessAutomation?.markRead &&
          connection.rights?.can_read_messages
        ) {
          this.bot.api
            .readBusinessMessage(
              connection.id,
              Number(envelope.chatId),
              msg.message_id,
            )
            .catch(() => {});
        }

        this.handleInbound(envelope)
          .catch((err) => {
            process.stderr.write(
              `[Telegram:${this.name}] Error handling business message: ${err}\n`,
            );
          })
          .finally(() => {
            if (messageKey) {
              this.businessByMessage.delete(messageKey);
            }
          });
      });
    }

    // All messages (including slash commands) go through handleInbound
    // where ChannelBase dispatches shared commands (/help, /clear, /status, etc.)
    this.bot.on('message:text', async (ctx) => {
      const msg = ctx.message;
      const text = msg.text;

      const envelope = this.buildEnvelope(msg, text, msg.entities);

      // Don't await — long prompts would block the update loop
      this.handleInbound(envelope).catch((err) => {
        process.stderr.write(
          `[Telegram:${this.name}] Error handling message: ${err}\n`,
        );
        ctx
          .reply('Sorry, something went wrong processing your message.')
          .catch(() => {});
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

      this.handleInbound(envelope).catch((err) => {
        process.stderr.write(
          `[Telegram:${this.name}] Error handling message: ${err}\n`,
        );
        ctx
          .reply('Sorry, something went wrong processing your message.')
          .catch(() => {});
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

      try {
        const file = await ctx.api.getFile(doc.file_id);
        const fileUrl = this.getFileUrl(file.file_path!);
        const resp = await fetch(fileUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());

        // Save to temp dir so the agent can read it via read-file tool
        const dir = join(tmpdir(), 'channel-files', randomUUID());
        mkdirSync(dir, { recursive: true });
        const filePath = join(dir, basename(fileName) || `file_${Date.now()}`);
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

      this.handleInbound(envelope).catch((err) => {
        process.stderr.write(
          `[Telegram:${this.name}] Error handling message: ${err}\n`,
        );
        ctx
          .reply('Sorry, something went wrong processing your message.')
          .catch(() => {});
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

      this.handleInbound(envelope).catch((err) => {
        process.stderr.write(
          `[Telegram:${this.name}] Error handling message: ${err}\n`,
        );
        ctx
          .reply('Sorry, something went wrong processing your message.')
          .catch(() => {});
      });
    });

    this.bot.start({ drop_pending_updates: true }).catch((err) => {
      process.stderr.write(
        `[Telegram:${this.name}] Bot launch error: ${err}\n`,
      );
    });

    process.once('SIGINT', () => this.bot.stop());
    process.once('SIGTERM', () => this.bot.stop());
  }

  /** Per-chat typing interval — repeats every 4s since Telegram expires it after 5s. */
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  protected override onPromptStart(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    const business = this.consumePendingBusiness(chatId, messageId);
    if (business) {
      this.businessBySession.set(sessionId, business);
    }

    // Clear any stale interval (shouldn't happen, but safe)
    const existing = this.typingIntervals.get(chatId);
    if (existing) clearInterval(existing);

    const sendTyping = () =>
      this.sendChatAction(chatId, sessionId).catch(() => {});
    sendTyping();
    this.typingIntervals.set(chatId, setInterval(sendTyping, 4000));
  }

  protected override onPromptEnd(chatId: string, sessionId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
    this.businessBySession.delete(sessionId);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.sendTelegramMessage(chatId, text);
  }

  protected override async onResponseBlock(
    chatId: string,
    text: string,
    sessionId: string,
  ): Promise<void> {
    await this.sendTelegramMessage(
      chatId,
      text,
      this.businessBySession.get(sessionId),
    );
  }

  protected override async onResponseComplete(
    chatId: string,
    fullText: string,
    sessionId: string,
  ): Promise<void> {
    await this.sendTelegramMessage(
      chatId,
      fullText,
      this.businessBySession.get(sessionId),
    );
  }

  private async sendTelegramMessage(
    chatId: string,
    text: string,
    business?: StoredBusinessConnection,
  ): Promise<void> {
    const html = telegramFormat(text);
    const chunks = splitHtmlForTelegram(html);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: 'HTML',
          ...(business ? { business_connection_id: business.id } : undefined),
        });
      } catch {
        // Fallback to plain text for the failed chunk only
        await this.bot.api.sendMessage(chatId, chunk.replace(/<[^>]*>/g, ''), {
          ...(business ? { business_connection_id: business.id } : undefined),
        });
      }
    }
  }

  disconnect(): void {
    this.bot.stop();
  }

  private buildEnvelope(
    msg: TelegramMessageLike & {
      from: { id: number; first_name: string; last_name?: string };
    },
    text: string,
    entities?: Array<{ type: string; offset: number; length: number }>,
  ): Envelope {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    const isMentioned =
      entities?.some(
        (e) =>
          e.type === 'mention' &&
          this.botUsername &&
          text.slice(e.offset, e.offset + e.length).toLowerCase() ===
            `@${this.botUsername.toLowerCase()}`,
      ) ?? false;

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
      text: cleanText,
      messageId:
        msg.message_id === undefined ? undefined : String(msg.message_id),
      isGroup,
      isMentioned,
      isReplyToBot,
      referencedText,
    };
  }

  private buildBusinessEnvelope(
    msg: TelegramMessageLike,
    text: string,
    entities:
      | Array<{ type: string; offset: number; length: number }>
      | undefined,
    connection: StoredBusinessConnection,
  ): Envelope {
    const otherUserName = msg.from
      ? msg.from.first_name +
        (msg.from.last_name ? ` ${msg.from.last_name}` : '')
      : undefined;
    const envelope = this.buildEnvelope(
      {
        ...msg,
        from: {
          id: Number(connection.userId),
          first_name: connection.userName || 'Business user',
        },
      },
      text,
      entities,
    );

    if (otherUserName) {
      envelope.text = `[Business chat message from ${otherUserName}]\n\n${envelope.text}`;
    }

    return envelope;
  }

  private async resolveBusinessConnection(
    connectionId: string | undefined,
  ): Promise<StoredBusinessConnection | undefined> {
    if (!connectionId) return undefined;

    const stored = this.businessConnections.get(connectionId);
    if (stored) return stored;

    try {
      const connection = await this.bot.api.getBusinessConnection(connectionId);
      return this.businessConnections.upsert(connection);
    } catch {
      return undefined;
    }
  }

  private canReply(connection: StoredBusinessConnection): boolean {
    return connection.isEnabled && connection.rights?.can_reply === true;
  }

  private messageKey(
    chatId: string,
    messageId: string | undefined,
  ): string | undefined {
    if (!messageId) return undefined;
    return `${chatId}:${messageId}`;
  }

  private consumePendingBusiness(
    chatId: string,
    messageId: string | undefined,
  ): StoredBusinessConnection | undefined {
    const key = this.messageKey(chatId, messageId);
    if (!key) return undefined;
    const business = this.businessByMessage.get(key);
    this.businessByMessage.delete(key);
    return business;
  }

  private async sendChatAction(
    chatId: string,
    sessionId: string,
  ): Promise<void> {
    const business = this.businessBySession.get(sessionId);
    await this.bot.api.sendChatAction(chatId, 'typing', {
      ...(business ? { business_connection_id: business.id } : undefined),
    });
  }
}
