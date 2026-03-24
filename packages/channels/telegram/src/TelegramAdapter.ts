import { Telegraf } from 'telegraf';
import {
  telegramFormat,
  splitHtmlForTelegram,
} from 'telegram-markdown-formatter';
import { ChannelBase } from '@qwen-code/channel-base';
import type { ChannelConfig, Envelope } from '@qwen-code/channel-base';
import type { AcpBridge } from '@qwen-code/channel-base';

export class TelegramChannel extends ChannelBase {
  private bot: Telegraf;

  constructor(name: string, config: ChannelConfig, bridge: AcpBridge) {
    super(name, config, bridge);
    this.bot = new Telegraf(config.token);
  }

  async connect(): Promise<void> {
    this.bot.on('text', async (ctx) => {
      const msg = ctx.message;
      const envelope: Envelope = {
        channelName: this.name,
        senderId: String(msg.from.id),
        senderName:
          msg.from.first_name +
          (msg.from.last_name ? ` ${msg.from.last_name}` : ''),
        chatId: String(msg.chat.id),
        text: msg.text,
      };

      try {
        await this.handleInbound(envelope);
      } catch (err) {
        console.error(`[Telegram:${this.name}] Error handling message:`, err);
        try {
          await ctx.reply(
            'Sorry, something went wrong processing your message.',
          );
        } catch {
          // ignore send failure
        }
      }
    });

    this.bot.launch({ dropPendingUpdates: true }).catch((err) => {
      console.error(`[Telegram:${this.name}] Bot launch error:`, err);
    });

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
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
}
