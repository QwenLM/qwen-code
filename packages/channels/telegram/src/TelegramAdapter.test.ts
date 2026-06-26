import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './TelegramAdapter.js';
import type { AcpBridge, ChannelConfig } from '@qwen-code/channel-base';

class TestTelegramChannel extends TelegramChannel {
  startTyping(chatId: string): void {
    this.onPromptStart(chatId);
  }
}

const config: ChannelConfig = {
  type: 'telegram',
  token: 'token',
  senderPolicy: 'open',
  allowedUsers: [],
  sessionScope: 'user',
  cwd: process.cwd(),
  groupPolicy: 'disabled',
  groups: {},
};

function createChannel(): TestTelegramChannel {
  return new TestTelegramChannel('telegram', config, {} as AcpBridge, {
    router: {} as never,
  });
}

function installFakeBot(channel: TelegramChannel): {
  api: { sendChatAction: ReturnType<typeof vi.fn> };
  stop: ReturnType<typeof vi.fn>;
} {
  const bot = {
    api: {
      sendChatAction: vi.fn().mockResolvedValue(undefined),
    },
    stop: vi.fn(),
  };
  (channel as unknown as { bot: typeof bot }).bot = bot;
  return bot;
}

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('clears active typing intervals on disconnect', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const channel = createChannel();
    const bot = installFakeBot(channel);

    channel.startTyping('chat-1');
    channel.startTyping('chat-2');
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);

    channel.disconnect();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(bot.stop).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4000);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);
  });
});
