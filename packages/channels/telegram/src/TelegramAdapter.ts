import { Telegraf } from 'telegraf';
import { ChannelBase } from '@qwen-code/channel-base';
import type { ChannelConfig, Envelope } from '@qwen-code/channel-base';
import type { AcpBridge } from '@qwen-code/channel-base';

const TELEGRAM_MSG_LIMIT = 4096;

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

    console.log(`[Telegram:${this.name}] Launching bot (polling)...`);
    this.bot.launch({ dropPendingUpdates: true }).catch((err) => {
      console.error(`[Telegram:${this.name}] Bot launch error:`, err);
    });
    console.log(`[Telegram:${this.name}] Bot started (polling)`);

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    // Split long messages at Telegram's 4096 char limit
    const chunks = splitMessage(text, TELEGRAM_MSG_LIMIT);
    for (const chunk of chunks) {
      await this.bot.telegram.sendMessage(chatId, chunk);
    }
  }

  disconnect(): void {
    this.bot.stop();
  }
}

function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) {
      splitAt = limit;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).replace(/^\n/, '');
  }
  return chunks;
}
