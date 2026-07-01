import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WeixinChannel } from './WeixinAdapter.js';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  ChannelTaskLifecycleEvent,
} from '@qwen-code/channel-base';

class TestWeixinChannel extends WeixinChannel {
  emitLifecycle(event: ChannelTaskLifecycleEvent): void {
    this.onTaskLifecycle(event);
  }
}

const config: ChannelConfig = {
  type: 'weixin',
  token: 'token',
  senderPolicy: 'open',
  allowedUsers: [],
  sessionScope: 'user',
  cwd: process.cwd(),
  groupPolicy: 'disabled',
  groups: {},
};

function createChannel(
  configOverrides: Partial<ChannelConfig> = {},
): TestWeixinChannel {
  const bridge = Object.assign(new EventEmitter(), {
    newSession: vi.fn(),
    loadSession: vi.fn(),
    prompt: vi.fn(),
    cancelSession: vi.fn(),
    availableCommands: [],
  });

  return new TestWeixinChannel(
    'weixin',
    { ...config, ...configOverrides },
    bridge as unknown as ChannelAgentBridge,
  );
}

describe('WeixinChannel', () => {
  it('maps lifecycle start and terminal events to typing state', () => {
    const channel = createChannel();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    (channel as unknown as { setTyping: typeof setTyping }).setTyping =
      setTyping;

    const baseEvent = {
      channelName: 'weixin',
      chatId: 'user-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      identity: { id: 'channel:weixin', displayName: 'weixin' },
      memoryScope: { namespace: 'channel:weixin', mode: 'metadata-only' },
    } satisfies Omit<ChannelTaskLifecycleEvent, 'type'>;

    channel.emitLifecycle({ ...baseEvent, type: 'started' });
    channel.emitLifecycle({ ...baseEvent, type: 'started' });
    channel.emitLifecycle({ ...baseEvent, type: 'cancelled', reason: 'clear' });
    channel.emitLifecycle({ ...baseEvent, type: 'completed' });

    expect(setTyping).toHaveBeenNthCalledWith(1, 'user-1', true);
    expect(setTyping).toHaveBeenNthCalledWith(2, 'user-1', false);
    expect(setTyping).toHaveBeenCalledTimes(2);
  });
});
