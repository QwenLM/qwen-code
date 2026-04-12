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
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  AcpBridge,
} from '@qwen-code/channel-base';

export class TelegramChannel extends ChannelBase {
  private bot: Bot;
  private botId: number = 0;
  private botUsername: string = '';

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: AcpBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
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

  protected override onPromptStart(chatId: string): void {
    // Clear any stale interval (shouldn't happen, but safe)
    const existing = this.typingIntervals.get(chatId);
    if (existing) clearInterval(existing);

    const sendTyping = () =>
      this.bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    sendTyping();
    this.typingIntervals.set(chatId, setInterval(sendTyping, 4000));
  }

  protected override onPromptEnd(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const html = telegramFormat(text);
    const chunks = splitHtmlForTelegram(html);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: 'HTML',
        });
      } catch {
        // Fallback to plain text for the failed chunk only
        await this.bot.api.sendMessage(chatId, chunk.replace(/<[^>]*>/g, ''));
      }
    }
  }

  disconnect(): void {
    this.bot.stop();
  }

  private buildEnvelope(
    msg: {
      from: { id: number; first_name: string; last_name?: string };
      chat: { id: number; type: string };
      reply_to_message?: { from?: { id: number }; text?: string };
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
      isGroup,
      isMentioned,
      isReplyToBot,
      referencedText,
    };
  }
}
