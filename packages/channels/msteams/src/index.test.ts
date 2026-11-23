import type { ChannelAgentBridge } from '@qwen-code/channel-base';
import { SessionRouter } from '@qwen-code/channel-base';
import { describe, expect, it, vi } from 'vitest';
import { plugin } from './index.js';

function bridge(): ChannelAgentBridge {
  let sessions = 0;
  return {
    newSession: vi.fn(async () => `session-${++sessions}`),
    loadSession: vi.fn(async (sessionId: string) => sessionId),
    on: vi.fn(),
    off: vi.fn(),
    availableCommands: [],
    prompt: vi.fn(async () => ''),
    cancelSession: vi.fn(async () => {}),
  };
}

describe('Microsoft Teams channel plugin', () => {
  it('defaults to thread-isolated shared sessions', async () => {
    expect(plugin.channelType).toBe('msteams');
    expect(plugin.defaultSessionScope).toBe('chat_thread');

    const router = new SessionRouter(
      bridge(),
      '/tmp',
      plugin.defaultSessionScope,
    );
    const first = await router.resolve('teams', 'alice', 'chat-1', 'root-1');
    const sameThread = await router.resolve('teams', 'bob', 'chat-1', 'root-1');
    const otherThread = await router.resolve(
      'teams',
      'alice',
      'chat-1',
      'root-2',
    );
    expect(first).toBe(sameThread);
    expect(first).not.toBe(otherThread);
  });
});
