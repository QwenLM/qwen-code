import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Telegraf } from 'telegraf';
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

// Commands handled locally by the Telegram adapter (not forwarded to ACP)
const LOCAL_COMMANDS = new Set(['start', 'help', 'reset']);

export class TelegramChannel extends ChannelBase {
  private bot: Telegraf;
  private botId: number = 0;
  private botUsername: string = '';

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: AcpBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.bot = new Telegraf(config.token);
  }

  async connect(): Promise<void> {
    const botInfo = await this.bot.telegram.getMe();
    this.botId = botInfo.id;
    this.botUsername = botInfo.username ?? '';
    // Register local-only commands
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        `Hi ${ctx.from.first_name}! I'm a Qwen Code agent.\n\nSend any message to chat, or use slash commands like /compress, /summary.\n\nType /help for more info.`,
      );
    });

    this.bot.command('help', async (ctx) => {
      const lines = [
        'Local commands:',
        '/start — Welcome message',
        '/help — Show this help',
        '/reset — Reset your session (start fresh)',
      ];

      const agentCommands = this.bridge.availableCommands;
      if (agentCommands.length > 0) {
        lines.push('', 'Agent commands (forwarded to Qwen Code):');
        for (const cmd of agentCommands) {
          lines.push(`/${cmd.name} — ${cmd.description}`);
        }
      }

      lines.push('', 'Send any text to chat with the agent.');
      await ctx.reply(lines.join('\n'));
    });

    this.bot.command('reset', async (ctx) => {
      const senderId = String(ctx.from.id);
      const removed = this.router.removeSession(this.name, senderId);
      if (removed) {
        await ctx.reply(
          'Session reset. Your next message will start a fresh conversation.',
        );
      } else {
        await ctx.reply('No active session to reset.');
      }
    });

    // All other messages (including non-local slash commands) go through handleInbound
    this.bot.on('text', async (ctx) => {
      const msg = ctx.message;
      const text = msg.text;

      // Skip if it's a local command (already handled above)
      if (text.startsWith('/')) {
        const command = text.slice(1).split(/[\s@]/)[0]?.toLowerCase();
        if (command && LOCAL_COMMANDS.has(command)) {
          return;
        }
      }

      const envelope = this.buildEnvelope(msg, text, msg.entities);

      // Don't await — Telegraf has a 90s handler timeout that would kill long prompts
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
    this.bot.on('photo', async (ctx) => {
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
        const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
        const resp = await fetch(fileUrl.href);
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
    this.bot.on('document', async (ctx) => {
      const msg = ctx.message;
      const doc = msg.document;
      const fileName = doc.file_name || `file_${Date.now()}`;

      const envelope = this.buildEnvelope(
        msg,
        msg.caption || `(file: ${fileName})`,
        msg.caption_entities,
      );

      try {
        const fileUrl = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileUrl.href);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());

        // Save to temp dir so the agent can read it via read-file tool
        const dir = join(tmpdir(), 'channel-files');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const filePath = join(dir, fileName);
        writeFileSync(filePath, buf);

        envelope.text =
          (msg.caption ? msg.caption + '\n\n' : '') +
          `User sent a file. It has been saved to: ${filePath}`;
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

    this.bot.launch({ dropPendingUpdates: true }).catch((err) => {
      process.stderr.write(
        `[Telegram:${this.name}] Bot launch error: ${err}\n`,
      );
    });

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  override async handleInbound(envelope: Envelope): Promise<void> {
    // Check group gate before showing "Working..." indicator
    const groupResult = this.groupGate.check(envelope);
    if (!groupResult.allowed) {
      return;
    }

    // Send "Working..." immediately for instant feedback
    const workingMsg = await this.bot.telegram
      .sendMessage(envelope.chatId, 'Working...')
      .catch(() => null);

    try {
      await super.handleInbound(envelope);
    } finally {
      // Always delete "Working..." — even on error/timeout
      if (workingMsg) {
        this.bot.telegram
          .deleteMessage(envelope.chatId, workingMsg.message_id)
          .catch(() => {});
      }
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const html = telegramFormat(text);
    const chunks = splitHtmlForTelegram(html);
    for (const chunk of chunks) {
      try {
        await this.bot.telegram.sendMessage(chatId, chunk, {
          parse_mode: 'HTML',
        });
      } catch {
        // Fallback to plain text if HTML parsing fails
        await this.bot.telegram.sendMessage(chatId, text);
        return;
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
      reply_to_message?: { from?: { id: number } };
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
    };
  }
}
